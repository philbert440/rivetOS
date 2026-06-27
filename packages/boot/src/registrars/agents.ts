/**
 * Agent Registrar — registers delegation, sub-agent, and skill tools.
 *
 * These are domain services that the runtime previously created in start().
 * Moving them to boot keeps the runtime focused on lifecycle management
 * and makes registration consistent with providers, channels, and tools.
 *
 * When mesh config is present, uses MeshDelegationEngine instead of the
 * plain DelegationEngine. Also starts the AgentChannelServer (receives
 * incoming mesh delegations) and FileMeshRegistry (tracks all nodes).
 */

import type { Runtime } from '@rivetos/core'
import { loadTlsConfig } from '@rivetos/core'
import {
  DelegationEngine,
  MeshDelegationEngine,
  FileMeshRegistry,
  buildLocalNode,
  AgentChannelServer,
  SubagentManagerImpl,
  createSubagentTools,
  InMemorySubagentStore,
  PgSubagentStore,
  createSubagentExecutor,
  createSubagentWorker,
  createPgDelegationRecorder,
  SkillManagerImpl,
  createSkillListTool,
  createSkillManageTool,
  type SubagentStore,
} from '@rivetos/core'
import type { DelegationRunsRecorder, SubagentWorker } from '@rivetos/core'
import pg from 'pg'
import type { MeshConfig } from '@rivetos/types'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Agents')

export async function registerAgentTools(
  runtime: Runtime,
  config: RivetConfig,
  workspaceDir: string,
): Promise<void> {
  // Build tool filter from agent configs
  const toolFilter: Record<string, { exclude?: string[]; include?: string[] }> = {}
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.tools) {
      toolFilter[id] = agent.tools
    }
  }
  const hasFilters = Object.keys(toolFilter).length > 0

  // Context config — convert snake_case YAML to camelCase for the engine
  const contextConfig = config.runtime.context
    ? {
        softNudgePct: config.runtime.context.soft_nudge_pct,
        hardNudgePct: config.runtime.context.hard_nudge_pct,
      }
    : undefined

  // ------------------------------------------------------------------
  // Durability — Postgres-backed if pgUrl is configured, in-memory otherwise.
  //
  // Substrate touches three things: subagent sessions, the delegation runs
  // audit log, and the graphile-worker job queue for run-subagent-turn.
  // All three share the same Postgres connection pool.
  // ------------------------------------------------------------------
  const pgUrl = runtime.getPgUrl()
  let pool: pg.Pool | undefined
  let subagentStore: SubagentStore
  let delegationRecorder: DelegationRunsRecorder | undefined
  let subagentWorker: SubagentWorker | undefined

  if (pgUrl) {
    pool = new pg.Pool({ connectionString: pgUrl, max: 4 })
    subagentStore = new PgSubagentStore(pool)
    delegationRecorder = createPgDelegationRecorder(pool)
  } else {
    subagentStore = new InMemorySubagentStore()
    log.info('No pgUrl — subagent sessions + delegation runs are process-local (in-memory)')
  }

  // Build the local delegation engine (always needed — mesh wraps it)
  const localDelegation = new DelegationEngine({
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: () => runtime.getTools(),
    hooks: runtime.getHooks(),
    toolFilter: hasFilters ? toolFilter : undefined,
    workspaceDir,
    turnTimeout: config.runtime.turn_timeout,
    contextConfig,
    recorder: delegationRecorder,
  })

  // Determine if mesh is enabled
  const meshConfig = config.mesh
  const meshEnabled = meshConfig?.enabled === true && !!meshConfig.tls

  if (meshEnabled) {
    // ------------------------------------------------------------------
    // Mesh mode — MeshDelegationEngine + AgentChannel + FileMeshRegistry
    // ------------------------------------------------------------------

    const storageDir = meshConfig.storage_dir ?? '/rivet-shared'
    const agentChannelPort = meshConfig.agent_channel_port ?? 3000
    const localAgents = Object.keys(config.agents)
    const nodeName = meshConfig.node_name ?? 'unknown'

    // Load TLS material — required for mesh (no plaintext fallback)
    // Convert YAML snake_case paths to camelCase for loadTlsConfig
    const rawTls = meshConfig.tls!
    const tlsInput: boolean | { caPath?: string; certPath?: string; keyPath?: string } =
      rawTls === true
        ? true
        : {
            caPath: (rawTls as { ca_path?: string }).ca_path,
            certPath: (rawTls as { cert_path?: string }).cert_path,
            keyPath: (rawTls as { key_path?: string }).key_path,
          }
    const tlsConfig = loadTlsConfig(tlsInput, nodeName)

    // Convert snake_case YAML config to the MeshConfig interface
    const meshCfg: MeshConfig = {
      enabled: true,
      nodeName,
      // secret retained in type but not used for agent-channel auth
      secret: meshConfig.secret ? resolveEnv(meshConfig.secret) : undefined,
      heartbeatIntervalMs: meshConfig.heartbeat_interval_ms,
      staleThresholdMs: meshConfig.stale_threshold_ms,
      tls:
        meshConfig.tls === true
          ? true
          : meshConfig.tls
            ? {
                caPath: meshConfig.tls.ca_path,
                certPath: meshConfig.tls.cert_path,
                keyPath: meshConfig.tls.key_path,
              }
            : undefined,
      discovery: meshConfig.discovery
        ? {
            mode: meshConfig.discovery.mode,
            seedHost: meshConfig.discovery.seed_host,
            seedPort: meshConfig.discovery.seed_port,
          }
        : undefined,
      peers: meshConfig.peers?.map((p) => ({
        name: p.name,
        host: p.host,
        port: p.port,
      })),
    }

    // Mesh registry
    const meshRegistry = new FileMeshRegistry({
      storageDir,
      mesh: meshCfg,
      tls: tlsConfig,
    })

    // Build and register the local node
    const localNode = buildLocalNode({
      existingId: nodeName,
      name: nodeName,
      agents: localAgents,
      host: resolveAdvertiseHost(meshConfig),
      port: agentChannelPort,
      providers: Object.keys(config.providers ?? {}),
      models: Object.values(config.agents)
        .map((a) => a.model)
        .filter((m): m is string => !!m),
      version: '0.1.0',
    })

    await meshRegistry.start(localNode)
    log.info(`Mesh registry started — node "${localNode.name}" registered`)

    // Mesh delegation engine
    const { Agent: UndiciAgent } = await import('undici')
    const httpsDispatcher = new UndiciAgent({
      connect: {
        ca: tlsConfig.ca,
        cert: tlsConfig.cert,
        key: tlsConfig.key,
        rejectUnauthorized: true,
      },
    })

    const meshDelegation = new MeshDelegationEngine({
      localEngine: localDelegation,
      router: runtime.getRouter(),
      meshRegistry,
      tls: tlsConfig,
      httpsDispatcher,
      localAgents,
    })

    // Register the mesh-aware delegation tool
    runtime.registerTool(meshDelegation.createDelegationTool())

    // Agent channel server — receives incoming mesh delegations
    const agentChannel = new AgentChannelServer({
      port: agentChannelPort,
      tls: tlsConfig,
      delegationEngine: localDelegation,
      meshRegistry,
      router: runtime.getRouter(),
      localAgents,
    })

    await agentChannel.start()
    log.info(`Agent channel started on port ${agentChannelPort}`)
  } else {
    // ------------------------------------------------------------------
    // Local-only mode — plain DelegationEngine
    // ------------------------------------------------------------------
    runtime.registerTool(localDelegation.createDelegationTool())
  }

  // ------------------------------------------------------------------
  // Sub-agents — graphile-worker driven (Postgres) or in-process executor.
  //
  // On startup the worker sweeps any stale 'running' rows from a prior
  // crash and flips them to 'failed' with error='worker_restarted'
  // (turn-level resume is out of scope — session state is durable, but
  // a mid-flight turn does not resume).
  // ------------------------------------------------------------------
  const executorCfg = {
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    store: subagentStore,
    tools: () => runtime.getTools(),
    hooks: runtime.getHooks(),
    toolFilter: hasFilters ? toolFilter : undefined,
    workspaceDir,
    turnTimeout: config.runtime.turn_timeout,
    contextConfig,
  }

  let enqueueTurn: (sessionId: string) => Promise<void>
  if (pgUrl) {
    subagentWorker = createSubagentWorker({ ...executorCfg, pgUrl })
    await subagentWorker.start()
    enqueueTurn = (sessionId) => subagentWorker!.enqueue(sessionId)
    runtime.addShutdownHook(async () => {
      await subagentWorker?.stop()
      await pool?.end()
    })
  } else {
    const executor = createSubagentExecutor(executorCfg)
    // In-memory mode: fire the turn in the background so spawn/send return
    // immediately (matches the prior void-runInBackground semantics).
    enqueueTurn = (sessionId) => {
      void executor.executeTurn(sessionId).catch((err: unknown) => {
        log.error(`In-memory subagent turn failed: ${(err as Error).message}`)
      })
      return Promise.resolve()
    }
  }

  const subagentManager = new SubagentManagerImpl({
    router: runtime.getRouter(),
    store: subagentStore,
    enqueueTurn,
  })
  for (const tool of createSubagentTools(subagentManager)) {
    runtime.registerTool(tool)
  }

  // Skills — discover, list, and manage
  const skillManager = new SkillManagerImpl()
  const defaultSkillDirs = [`${process.env.HOME ?? '~'}/.rivetos/workspace/skills`]
  const skillDirs = config.runtime.skill_dirs ?? defaultSkillDirs
  await skillManager.discover(skillDirs)
  runtime.registerTool(createSkillListTool(skillManager))

  // Pass embed endpoint for dedup checks — uses environment variable
  // (embedding service runs on Datahub/GERTY, not configured per-agent)
  const embedEndpoint = process.env.RIVETOS_EMBED_URL ?? ''
  runtime.registerTool(
    createSkillManageTool(skillManager, {
      skillDirs,
      embedEndpoint: embedEndpoint || undefined,
    }),
  )

  // Progressive discovery: inject the live skill catalog into the system prompt
  // so the agent sees what skills it has and reaches for them instead of
  // hand-rolling shell/SQL. Invoking a skill loads its full SKILL.md on demand.
  const skills = skillManager.list()
  if (skills.length > 0) {
    const catalog = [
      '## Available skills',
      'These are loadable skills for specific domains. When a request matches one — brokerage/investments, bank/net-worth, email, calendar, drive, memory, voice — USE the matching skill (load and invoke it) instead of improvising shell commands or guessing a database schema. Invoking a skill loads its full instructions and tools.',
      ...skills.map((s) => `- **${s.name}**: ${s.description}`),
    ].join('\n')
    runtime.registerSkillCatalog(catalog)
    log.info(`Skill catalog injected into system prompt (${skills.length} skills)`)
  }

  log.info(
    meshEnabled
      ? 'Delegation (mesh), sub-agent, and skill tools registered'
      : 'Delegation, sub-agent, and skill tools registered',
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve ${ENV_VAR} in a string value */
function resolveEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    return process.env[name] ?? ''
  })
}

/** Get the local IP — reads from environment or falls back to hostname */
function getLocalHost(): string {
  return process.env.RIVETOS_HOST ?? process.env.HOSTNAME ?? '127.0.0.1'
}

/**
 * Resolve the host this node advertises to the mesh. An explicit
 * `mesh.advertise_host` wins (for nodes whose hostname isn't resolvable
 * mesh-wide); otherwise fall back to the auto-detected local host.
 */
export function resolveAdvertiseHost(mesh: { advertise_host?: string } | undefined): string {
  const advertised = mesh?.advertise_host?.trim()
  return advertised && advertised.length > 0 ? advertised : getLocalHost()
}
