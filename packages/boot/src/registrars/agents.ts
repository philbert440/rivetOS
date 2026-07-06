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
  TaskBackedSubagentManager,
  createSubagentTools,
  createTaskDelegationRecorder,
  createTaskCompletionWaiter,
  createTaskApiRoute,
  createOutcomesApiRoute,
  createEvaluationCoordinator,
  createChannelEscalationNotifier,
  createLogEscalationNotifier,
  criteriaPolicyFromConfig,
  createCatalogApiRoute,
  createTaskHandler,
  InMemoryTaskStore,
  type TaskStore,
  type TaskCompletionWaiter,
  PgTaskStore,
  createChatLoopExecutor,
  createExecutorRegistry,
  createTaskRunner,
  SkillManagerImpl,
  createSkillListTool,
  createSkillManageTool,
} from '@rivetos/core'
import type { DelegationRunsRecorder } from '@rivetos/core'
import pg from 'pg'
import type { GatewayRoute, MeshConfig, MeshRegistry } from '@rivetos/types'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Agents')

export interface AgentToolsResult {
  /** Route families for the embedded gateway (G1+): mounted by registerGateway. */
  gatewayRoutes: GatewayRoute[]
}

export async function registerAgentTools(
  runtime: Runtime,
  config: RivetConfig,
  workspaceDir: string,
): Promise<AgentToolsResult> {
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
  // Substrate is the task engine: ros_tasks + the graphile-worker run-task
  // queue + the completion waiter, all on one Postgres connection pool.
  // ------------------------------------------------------------------
  const pgUrl = runtime.getPgUrl()
  let pool: pg.Pool | undefined

  // Task engine substrate (g2a: the ONLY orchestration engine — the legacy
  // subagent store/worker and ros_delegation_runs recorder are deleted).
  // On an unmigrated PG node the engine is degraded: subagent tools run over
  // an in-memory store (process-local), delegation audit is a noop, and
  // heartbeats are skipped until rivetos-memory-migrate runs.
  const tasksEnabled = config.tasks?.enabled !== false
  // Phase 2b: one criteria policy for every task creator on this node.
  const criteriaPolicy = criteriaPolicyFromConfig(config.tasks?.eval)
  let taskEngineStore: PgTaskStore | undefined
  let taskWaiter: TaskCompletionWaiter | undefined
  let meshRegistryRef: MeshRegistry | undefined
  let delegationRecorder: DelegationRunsRecorder | undefined

  if (pgUrl) {
    pool = new pg.Pool({ connectionString: pgUrl, max: 4 })
    if (tasksEnabled) {
      const taskStore = new PgTaskStore(pool)
      if (await taskStore.isReady()) {
        taskEngineStore = taskStore
      } else {
        log.warn(
          'ros_tasks missing — task engine degraded (in-memory subagents, no heartbeats) until rivetos-memory-migrate runs',
        )
      }
    }
    if (taskEngineStore) {
      delegationRecorder = createTaskDelegationRecorder(taskEngineStore)
      // Shared completion waiter (LISTEN ros_task_done + poll) — mesh
      // transport and task-backed heartbeats wait on it (step g1).
      taskWaiter = createTaskCompletionWaiter({ store: taskEngineStore, pgUrl })
      runtime.addShutdownHook(async () => {
        await taskWaiter?.stop()
      })
    }
  } else {
    log.info('No pgUrl — subagent sessions are process-local; delegation audit disabled')
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
    meshRegistryRef = meshRegistry

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
      criteriaPolicy,
      localEngine: localDelegation,
      router: runtime.getRouter(),
      meshRegistry,
      tls: tlsConfig,
      httpsDispatcher,
      localAgents,
      nodeName,
      // Cutover step (g1): postgres mesh transport when the task engine is
      // live; config mesh.delegation_transport: 'http' forces the legacy
      // undici path (phone-android / nodes off the shared datahub PG).
      taskStore: taskEngineStore,
      waiter: taskWaiter,
      transport: meshConfig.delegation_transport,
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

  const executorCfg = {
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: () => runtime.getTools(),
    hooks: runtime.getHooks(),
    toolFilter: hasFilters ? toolFilter : undefined,
    workspaceDir,
    turnTimeout: config.runtime.turn_timeout,
    contextConfig,
  }

  // ------------------------------------------------------------------
  // Task engine (phase 1a) — durable ros_tasks + embedded run-task runner.
  //
  // Enabled by default and inert: nothing creates task rows yet, so the
  // runner idles on an empty queue. chat-loop always registers; claude-cli
  // registers when its binary probe passes; further CLI harness executors
  // (grok, hermes) are still pending.
  // On startup the runner crash-sweeps rows this node left 'running'.
  // ------------------------------------------------------------------
  // Executor registry — shared by the durable runner and the in-memory
  // fallback path.
  const executors = createExecutorRegistry()
  // Task-conversation persistence + resume rehydration (step (c)) — turns
  // file under session_key task:<id> alongside the harness executors' rows.
  const taskPricing = config.tasks?.pricing
    ? Object.fromEntries(
        Object.entries(config.tasks.pricing).map(([provider, p]) => [
          provider,
          { inputPerMTok: p.input_per_mtok, outputPerMTok: p.output_per_mtok },
        ]),
      )
    : undefined
  executors.register(
    'chat-loop',
    createChatLoopExecutor({ ...executorCfg, memory: runtime.getMemory(), pricing: taskPricing }),
  )
  await registerClaudeCliTaskExecutor(runtime, config, executors, workspaceDir)

  // Subagent tool store: durable when the engine is live, else process-local
  // (g2a: the in-memory task store replaces the deleted InMemorySubagentStore;
  // its enqueue callback runs the same task handler in-process).
  let subagentTaskStore: TaskStore = taskEngineStore as TaskStore
  if (!taskEngineStore) {
    const handlerRef: { run?: (taskId: string) => Promise<void> } = {}
    const inMemoryStore: InMemoryTaskStore = new InMemoryTaskStore((taskId) => {
      void handlerRef.run?.(taskId).catch((err: unknown) => {
        log.error(`In-memory task turn failed: ${(err as Error).message}`)
      })
    })
    handlerRef.run = createTaskHandler({
      store: inMemoryStore,
      executors,
      nodeId: config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local',
      workspaceDir,
      memory: runtime.getMemory(),
    })
    subagentTaskStore = inMemoryStore
  }

  if (tasksEnabled && pgUrl && pool && taskEngineStore) {
    // Phase 2d: verifier pass on completed evaluable tasks. Durable engine
    // only — the in-memory fallback has no waiter and nothing evaluable
    // (criteria derivation is also eval-gated).
    const evalSection = config.tasks?.eval
    // Late-bound to taskRunner.handler below — the coordinator runs verifier
    // children inline in the parent's worker slot (deadlock-free, see #280).
    const runTaskRef: { current?: (taskId: string) => Promise<void> } = {}
    const evaluation =
      evalSection?.enabled && taskWaiter
        ? createEvaluationCoordinator({
            store: taskEngineStore,
            waiter: taskWaiter,
            runTask: (taskId) => runTaskRef.current?.(taskId) ?? Promise.resolve(),
            escalation: evalSection.escalation?.channel
              ? createChannelEscalationNotifier(
                  (channelId, text) => runtime.broadcastToChannel(channelId, text),
                  {
                    channelId: evalSection.escalation.channel,
                    gatewayBase:
                      config.den?.enabled !== false
                        ? `http://${config.mesh?.node_name ?? 'localhost'}:${String(config.den?.port ?? 5174)}`
                        : undefined,
                  },
                )
              : createLogEscalationNotifier(),
            nodeId: config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local',
            config: {
              maxRetries: evalSection.max_retries,
              agentId: evalSection.verifier?.agent_id,
              executor: evalSection.verifier?.executor,
              executorTarget: evalSection.verifier?.executor_target,
              budget: evalSection.verifier?.budget
                ? {
                    maxUsd: evalSection.verifier.budget.max_usd,
                    maxTurns: evalSection.verifier.budget.max_turns,
                  }
                : undefined,
              skipOrigins: evalSection.skip_origins ?? ['heartbeat'],
            },
          })
        : undefined
    const taskRunner = createTaskRunner({
      pgUrl,
      store: taskEngineStore,
      executors,
      nodeId: config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local',
      workspaceDir,
      evaluation,
      // Context-refs resolution (step (b) checklist) — the runner folds
      // memory context into TaskSpec.resolvedContext when refs are present.
      memory: runtime.getMemory(),
    })
    runTaskRef.current = taskRunner.handler
    await taskRunner.start()
    runtime.addShutdownHook(async () => {
      await taskRunner.stop()
    })
    // Cutover step (f): heartbeat runs are durable ros_tasks rows.
    if (taskWaiter) runtime.setHeartbeatTaskStore(taskEngineStore, taskWaiter)
    log.info('Task engine started — subagent tools, delegation audit + heartbeats are task-backed')
  } else if (tasksEnabled && pgUrl) {
    log.info('Task engine degraded — ros_tasks missing; subagent tools run in-memory')
  } else if (tasksEnabled) {
    log.info('No pgUrl — task engine in-memory (subagent tools only)')
  }

  // Pool teardown LAST: hooks run in registration order, and the task
  // runner + waiter must stop before Postgres goes away (in-flight
  // PgTaskStore calls would otherwise fail).
  if (pool) {
    runtime.addShutdownHook(async () => {
      await pool?.end()
    })
  }

  // g2a: the task-backed manager is the only subagent engine — durable rows
  // when the engine is live, process-local otherwise. One-way cutover: the
  // legacy store/worker engine is deleted (0003 archived its tables).
  const subagentManager = new TaskBackedSubagentManager({
    router: runtime.getRouter(),
    store: subagentTaskStore,
    memory: runtime.getMemory(),
    criteriaPolicy,
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

  // G1/G4: gateway route families — mounted by registerGateway. Tasks only
  // when the durable engine is live (the API over the in-memory fallback
  // would lie about durability); catalog always (it describes the node).
  const nodeName = config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local'
  const registry = meshRegistryRef

  // Agent-aware dispatch (G4, from the G1 smoke followup): unpinned creates
  // resolve to the agent's home node — local agents pin here, mesh agents to
  // their (online) host, unknown agents 400 instead of a doomed global row.
  const resolveAffinity = async (
    agentId: string,
  ): Promise<string | { error: string } | undefined> => {
    if (
      runtime
        .getRouter()
        .getAgents()
        .some((a) => a.id === agentId)
    )
      return nodeName
    if (registry) {
      const nodes = await registry.findByAgent(agentId)
      const online = nodes.filter((n) => n.status === 'online' && n.name !== nodeName)
      if (online.length > 0) {
        return online.sort((a, b) => b.lastSeen - a.lastSeen)[0].name
      }
    }
    return { error: `agent "${agentId}" not found locally${registry ? ' or on the mesh' : ''}` }
  }

  const gatewayRoutes: GatewayRoute[] = []
  if (taskEngineStore && taskWaiter) {
    gatewayRoutes.push(
      createTaskApiRoute({
        store: taskEngineStore,
        waiter: taskWaiter,
        resolveAffinity,
        criteriaPolicy,
      }),
      createOutcomesApiRoute({ store: taskEngineStore }),
    )
  }
  gatewayRoutes.push(
    createCatalogApiRoute({
      nodeName,
      router: runtime.getRouter(),
      tools: () => runtime.getTools(),
      executors,
      skills: () => skillManager.list(),
      meshRegistry: registry,
    }),
  )
  return { gatewayRoutes }
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

  // Capability probe: --json-schema on an old CLI hard-fails every spawn
  // (unknown flag) before the fence fallback could ever run — detect support
  // up front and fall back to the fenced TASK_RESULT contract when absent.
  const structuredResult = await new Promise<boolean>((resolve) => {
    try {
      const env = { ...process.env }
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      const proc = spawn(binary, ['--help'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()))
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve(false)
      }, 3_000)
      timer.unref()
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      proc.on('close', () => {
        clearTimeout(timer)
        resolve(out.includes('--json-schema'))
      })
    } catch {
      resolve(false)
    }
  })
  if (!structuredResult) {
    log.warn('claude CLI lacks --json-schema — TASK_RESULT falls back to the fenced block')
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
        // Resume rehydration (step-(c) parity with chat-loop).
        memory: runtime.getMemory(),
        structuredResult,
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
