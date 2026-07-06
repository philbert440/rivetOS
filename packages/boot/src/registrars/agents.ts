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

import { spawn } from 'node:child_process'
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
  PgTaskStore,
  createChatLoopExecutor,
  createExecutorRegistry,
  createTaskRunner,
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

    // Build and register the local node.
    //
    // Capabilities/metadata are derived from config on every startup because
    // register() wholesale-replaces this node's roster entry — hand-edited
    // tags in mesh.json don't survive a restart. den.enabled here is what
    // makes den-node discovery (viewer /mesh.json) restart-proof.
    const denEnabled = config.den?.enabled === true
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
      capabilities: denEnabled ? ['den'] : undefined,
      metadata: denEnabled ? { denPort: config.den?.port ?? 5174 } : undefined,
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
      nodeName,
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

  // ------------------------------------------------------------------
  // Task engine (phase 1a) — durable ros_tasks + embedded run-task runner.
  //
  // Enabled by default and inert: nothing creates task rows yet, so the
  // runner idles on an empty queue. Only the chat-loop executor is
  // registered for now; CLI harness executors land at cutover step (b).
  // On startup the runner crash-sweeps rows this node left 'running'.
  // ------------------------------------------------------------------
  const tasksEnabled = config.tasks?.enabled !== false
  if (tasksEnabled && pgUrl && pool) {
    const taskStore = new PgTaskStore(pool)
    const executors = createExecutorRegistry()
    executors.register('chat-loop', createChatLoopExecutor(executorCfg))
    await registerClaudeCliTaskExecutor(runtime, config, executors, workspaceDir)
    const taskRunner = createTaskRunner({
      pgUrl,
      store: taskStore,
      executors,
      nodeId: config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local',
      workspaceDir,
      // Context-refs resolution (step (b) checklist) — the runner folds
      // memory context into TaskSpec.resolvedContext when refs are present.
      memory: runtime.getMemory(),
    })
    await taskRunner.start()
    runtime.addShutdownHook(async () => {
      await taskRunner.stop()
    })
    log.info('Task engine started — run-task runner listening (inert until tasks are created)')
  } else if (tasksEnabled) {
    log.info('No pgUrl — task engine not started (requires Postgres)')
  }

  // Pool teardown LAST: hooks run in registration order, and both the
  // subagent worker and the task runner must stop before Postgres goes away
  // (in-flight PgTaskStore/PgSubagentStore calls would otherwise fail).
  if (pool) {
    runtime.addShutdownHook(async () => {
      await pool?.end()
    })
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

/**
 * Register the claude-cli harness-session executor (phase 1 step (b)) when
 * the `claude` binary is resolvable. Binary resolution mirrors the claude-cli
 * provider: config.providers['claude-cli'].binary, falling back to PATH.
 * If the binary (or the provider package) is missing, log and skip — the
 * task engine simply has no ('harness-session','claude-cli') executor.
 */
async function registerClaudeCliTaskExecutor(
  runtime: Runtime,
  config: RivetConfig,
  executors: ReturnType<typeof createExecutorRegistry>,
  workspaceDir: string,
): Promise<void> {
  const providerCfg = config.providers?.['claude-cli'] ?? {}
  const binary = (providerCfg.binary as string | undefined) ?? 'claude'

  // 3s probe timeout: a hung binary must never stall boot — kill it, warn,
  // and skip registration.
  const PROBE_TIMEOUT_MS = 3_000
  const available = await new Promise<boolean>((resolve) => {
    try {
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      const proc = spawn(binary, ['--version'], { env, stdio: ['ignore', 'ignore', 'ignore'] })
      const timer = setTimeout(() => {
        log.warn(
          `claude --version probe timed out after ${String(PROBE_TIMEOUT_MS)}ms — ` +
            `killing probe, skipping claude-cli task executor`,
        )
        proc.kill('SIGKILL')
        resolve(false)
      }, PROBE_TIMEOUT_MS)
      timer.unref()
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    } catch {
      resolve(false)
    }
  })
  if (!available) {
    log.info(`claude binary "${binary}" not resolvable — claude-cli task executor not registered`)
    return
  }

  try {
    const { ClaudeCliExecutor } = await import('@rivetos/provider-claude-cli')
    executors.register(
      'harness-session',
      new ClaudeCliExecutor({
        binary,
        modelId: providerCfg.model as string | undefined,
        toolsArg: providerCfg.tools as string | undefined,
        effort: providerCfg.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
        permissionMode: providerCfg.permission_mode as string | undefined,
        cwd: (providerCfg.cwd as string | undefined) ?? workspaceDir,
        tools: () => runtime.getTools(),
      }),
      'claude-cli',
    )
    log.info(`Task executor registered: (harness-session, claude-cli) via ${binary}`)
  } catch (err: unknown) {
    log.warn(
      `@rivetos/provider-claude-cli not loadable — claude-cli task executor skipped: ` +
        (err as Error).message,
    )
  }
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
