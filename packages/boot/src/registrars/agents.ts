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
import { join } from 'node:path'
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
  createWikiApiRoute,
  createWikiHtmlRoute,
  createEvaluationCoordinator,
  createChannelEscalationNotifier,
  createLogEscalationNotifier,
  createGatewayEscalationNotifier,
  composeEscalationNotifiers,
  createNotificationsChannel,
  criteriaPolicyFromConfig,
  createCatalogApiRoute,
  createTaskHandler,
  InMemoryTaskStore,
  type TaskStore,
  type TaskCompletionWaiter,
  type NotificationsChannelHandle,
  PgTaskStore,
  createChatLoopExecutor,
  createExecutorRegistry,
  createNotImplementedHarnessExecutor,
  harnessExecutorGap,
  createTaskRunner,
  SkillManagerImpl,
  createSkillListTool,
  createSkillManageTool,
  createHostExecutorRegistry,
  createWorkflowApiRouteList,
  createWorkflowTools,
} from '@rivetos/core'
import { WorkflowEngine } from '@rivetos/workflows'
import type { DelegationRunsRecorder, EscalationNotifier } from '@rivetos/core'
import pg from 'pg'
import {
  parseUserDbs,
  sharedDir,
  sharedPath,
  type GatewayRoute,
  type HarnessId,
  type MeshConfig,
  type MeshRegistry,
} from '@rivetos/types'
import { WikiIndex, createMemoryApiRoute } from '@rivetos/memory-postgres'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'
import { denTlsConfigured } from './gateway.js'

const log = logger('Boot:Agents')

/** Compose the configured escalation notifier with the 4e gateway push. */
function composeNotifiers(
  notifications: NotificationsChannelHandle | undefined,
  base: EscalationNotifier,
): EscalationNotifier {
  if (!notifications) return base
  return composeEscalationNotifiers(
    base,
    createGatewayEscalationNotifier((frame) => notifications.broadcast(frame)),
  )
}

export interface AgentToolsResult {
  /** Route families for the embedded gateway (G1+): mounted by registerGateway. */
  gatewayRoutes: GatewayRoute[]
  /** Extra WS upgrade handlers for the gateway (4e notifications). */
  gatewayUpgrades: NonNullable<NotificationsChannelHandle['upgrade']>[]
}

export async function registerAgentTools(
  runtime: Runtime,
  config: RivetConfig,
  workspaceDir: string,
  /** Install / repo root — used for default workflows.defs_roots. */
  installRoot?: string,
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
  let userPools: Map<string, pg.Pool | null> | undefined

  if (pgUrl) {
    pool = new pg.Pool({ connectionString: pgUrl, max: 4 })
    // /api/memory answers with the den-stamped user's database, so build a
    // pool per RIVETOS_USER_DBS entry alongside the owner pool. An entry with
    // an unparseable URL (pg defers parsing to first connect) is tombstoned
    // (null): the route refuses that user rather than 500ing into the owner
    // path. max 2: the panel's search+browse+stats burst queues its third
    // query briefly rather than holding a wider pool per user open forever.
    const userDbs = parseUserDbs(process.env.RIVETOS_USER_DBS)
    if (userDbs) {
      const pools = new Map<string, pg.Pool | null>()
      userPools = pools
      for (const [userId, entry] of Object.entries(userDbs)) {
        try {
          new URL(entry.pgUrl)
          pools.set(userId, new pg.Pool({ connectionString: entry.pgUrl, max: 2 }))
        } catch (err) {
          log.warn(
            `memory api: pool for user "${userId}" failed to construct — requests will be refused: ${String(err)}`,
          )
          pools.set(userId, null)
        }
      }
      runtime.addShutdownHook(async () => {
        await Promise.all(
          [...pools.values()].flatMap((p) => (p ? [p.end().catch(() => undefined)] : [])),
        )
      })
    }
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

    const storageDir = meshConfig.storage_dir ?? sharedDir()
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
    // With gateway TLS (#491) the den answers https only — advertise a full
    // denUrl so peer mesh views and the hub node-switcher probe/connect with
    // the right scheme instead of the http:// fallback built from denPort.
    // Never advertise a loopback denUrl: every peer would probe/connect to
    // ITSELF under this node's id (phildesk registers host 127.0.0.1).
    const denHost = resolveAdvertiseHost(meshConfig)
    const denHostIsLoopback =
      denHost === '127.0.0.1' || denHost === '::1' || denHost === 'localhost'
    const denUrl =
      denEnabled && !denHostIsLoopback && denTlsConfigured(config)
        ? `https://${denHost}:${String(config.den?.port ?? 5174)}`
        : ''
    // Per-agent provider/model so REMOTE catalog entries (RivetHub node
    // switcher + picker) show more than id@node (#272). Node-level
    // providers/models stay for coarse capability queries.
    const agentDetails: Record<string, { provider: string; model?: string }> = {}
    for (const [id, a] of Object.entries(config.agents)) {
      agentDetails[id] = a.model
        ? { provider: a.provider, model: a.model }
        : { provider: a.provider }
    }
    const localNode = buildLocalNode({
      existingId: nodeName,
      name: nodeName,
      agents: localAgents,
      host: denHost,
      port: agentChannelPort,
      providers: Object.keys(config.providers ?? {}),
      models: Object.values(config.agents)
        .map((a) => a.model)
        .filter((m): m is string => !!m),
      capabilities: denEnabled ? ['den'] : undefined,
      metadata: {
        ...(denEnabled ? { denPort: config.den?.port ?? 5174 } : {}),
        ...(denUrl ? { denUrl } : {}),
        agentDetails,
      },
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
  // runner idles on an empty queue. chat-loop always registers; the
  // `claude-code` harness executor registers when its binary probe passes,
  // and EVERY other harness id registers an explicit rejection so a task
  // aimed at one fails with a reason instead of an anonymous registry miss.
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
  await registerHarnessTaskExecutors(runtime, config, executors, workspaceDir)

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

  // 4e: escalations push to connected RivetHub clients when the gateway is
  // on. Created here (before registerGateway) and the upgrade handed through
  // AgentToolsResult; broadcast composes with the configured channel/log
  // notifier — /api/outcomes stays the durable inbox.
  const notifications = config.den?.enabled === true ? createNotificationsChannel() : undefined
  if (notifications) {
    runtime.addShutdownHook(async () => {
      await notifications.close()
    })
  }
  const gatewayUpgrades = notifications ? [notifications.upgrade] : []

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
            escalation: composeNotifiers(
              notifications,
              evalSection.escalation?.channel
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
            ),
            nodeId: config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local',
            config: {
              maxRetries: evalSection.max_retries,
              agentId: evalSection.verifier?.agent_id,
              executor: evalSection.verifier?.executor,
              executorTarget: evalSection.verifier?.executor_target,
              budget: evalSection.verifier?.budget
                ? {
                    maxUsd: evalSection.verifier.budget.max_usd,
                    // Floor 2: the runner's >= between-turns check makes
                    // maxTurns 1 kill the verifier at its only turn's end.
                    maxTurns:
                      evalSection.verifier.budget.max_turns !== undefined
                        ? Math.max(2, evalSection.verifier.budget.max_turns)
                        : undefined,
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
    // Pin heartbeats to this node (same name the task runner listens on) so
    // foreign mesh workers cannot claim them — G4 affinity parity with
    // POST /api/tasks (2026-07-26 fleet failure: unpinned heartbeats raced
    // on the global run-task queue and failed where the agent was missing).
    if (taskWaiter) {
      runtime.setHeartbeatTaskStore(
        taskEngineStore,
        taskWaiter,
        config.mesh?.node_name ?? process.env.HOSTNAME ?? 'local',
      )
    }
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
  // Wire hook pipeline so skill:before / skill:after actually fire on load.
  // setPipeline had zero callers before this — dead path at boot.
  const hooks = runtime.getHooks()
  if (hooks) {
    skillManager.setPipeline(hooks)
  }
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
  // Phase 3e: wiki routes — read-only over the PG index + NFS repo files.
  // Mounted whenever the shared pool exists; degrade to empty results until
  // 0005 is applied (WikiIndex.isReady guards nothing here — reads fail soft).
  if (pool) {
    const wikiIndex = new WikiIndex(pool)
    // WIKI_DIR matches the compaction-worker's writer env (same default), so
    // a node whose extractor targets a custom root reads from it too. Routed
    // users get their own index (their #571 pool) and their own file root
    // under <root>/users/<userId> — point that user's extractor WIKI_DIR at
    // the same directory. Unknown/tombstoned users are refused by the routes.
    const wikiRoot = process.env.WIKI_DIR ?? sharedPath('wiki')
    const wikiFor = makeWikiFor(userPools, wikiRoot, (p) => new WikiIndex(p))
    gatewayRoutes.push(
      createWikiApiRoute({ index: wikiIndex, wikiDir: wikiRoot, forUser: wikiFor }),
      createWikiHtmlRoute({
        index: wikiIndex,
        wikiDir: wikiRoot,
        nodeName: config.mesh?.node_name,
        forUser: wikiFor,
      }),
      createMemoryApiRoute({
        pool,
        userPools,
        embedEndpoint: embedEndpoint || undefined,
      }),
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

  // Workflows v1 — gateway API + agent start door over the journal-replay engine.
  // Executors live here (not in @rivetos/workflows): script child_process +
  // task-backed agent when the durable engine is available.
  const workflowsEnabled = config.workflows?.enabled !== false
  if (workflowsEnabled) {
    const caseDirRoot = config.workflows?.runs_dir?.trim() || sharedPath('workflows', 'runs')
    const configuredRoots = config.workflows?.defs_roots?.filter(
      (r) => typeof r === 'string' && r.trim(),
    )
    // Default: shared defs first so deployment recipes (and RivetHub edits)
    // shadow shipped examples at <installRoot>/workflows on id collision.
    // Explicit defs_roots replaces the default entirely (no silent merge).
    const workflowsRoots =
      configuredRoots && configuredRoots.length > 0
        ? configuredRoots
        : [sharedPath('workflows', 'defs'), ...(installRoot ? [join(installRoot, 'workflows')] : [])]
    const defaultAgentId =
      Object.keys(config.agents ?? {})[0] ?? runtime.getRouter().getAgents()[0]?.id ?? 'rivet'
    // Prefer durable task store; fall back to in-memory subagent store so
    // agent steps can still dispatch when pg is absent (dev).
    const agentTaskStore: TaskStore | undefined = taskEngineStore ?? subagentTaskStore
    const agentWaiter: TaskCompletionWaiter | undefined =
      taskWaiter ??
      (agentTaskStore
        ? createTaskCompletionWaiter({ store: agentTaskStore, pollFallbackMs: 500 })
        : undefined)
    if (agentWaiter && !taskWaiter) {
      runtime.addShutdownHook(async () => {
        await agentWaiter.stop()
      })
    }
    const hostExecutors = createHostExecutorRegistry({
      taskStore: agentTaskStore,
      taskWaiter: agentWaiter,
      defaultAgentId,
      nodeId: nodeName,
    })
    const workflowEngine = new WorkflowEngine({
      caseDirRoot,
      workflowsRoots,
      executors: hostExecutors,
    })
    // filesRoot for editPath: den.files_root when set, else product default
    // (/rivet-shared). Empty string in config disables editPath.
    const filesRoot =
      typeof config.den?.files_root === 'string' ? config.den.files_root.trim() : sharedDir()
    gatewayRoutes.push(
      ...createWorkflowApiRouteList({
        engine: workflowEngine,
        workflowsRoots,
        caseDirRoot,
        filesRoot,
        onGatePaused: notifications ? (frame) => notifications.broadcast(frame) : undefined,
      }),
    )

    // Agent start door — same engine instance as the gateway API.
    // Fail-closed allowlist: empty/absent → agents start nothing.
    const agentAllowlist = config.workflows?.agent_allowlist
    for (const tool of createWorkflowTools({
      engine: workflowEngine,
      caseDirRoot,
      workflowsRoots,
      agentAllowlist,
      allowlistConfigPath: 'config.workflows.agent_allowlist',
    })) {
      runtime.registerTool(tool)
    }

    log.info(
      `Workflows API + agent tools mounted (defs=${workflowsRoots.join(',')}, runs=${caseDirRoot}, agent=${defaultAgentId}, allowlist=${
        agentAllowlist?.length ? agentAllowlist.join('|') : '(empty/fail-closed)'
      })`,
    )
  }

  return { gatewayRoutes, gatewayUpgrades }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register one `harness-session` executor per harness id (Phase 3).
 *
 * `claude-code` and `kimi-code` get the real thing — the claude-cli plugin's
 * headless `claude -p` executor and `@rivetos/harness-kimi-code`'s `kimi -p`
 * one — when their binary probes pass. Every id left over (including those two
 * when the probe fails, with the probe's own reason rather than the generic
 * one) gets an explicit rejecting executor carrying that reason, so the
 * registry answers "no, and here is why" rather than going silent. That is
 * deliberate: an unregistered target fails with the runner's anonymous
 * `executor_not_registered`, which tells an operator nothing about whether the
 * harness is unsupported, not installed, or misspelled.
 */
async function registerHarnessTaskExecutors(
  runtime: Runtime,
  config: RivetConfig,
  executors: ReturnType<typeof createExecutorRegistry>,
  workspaceDir: string,
): Promise<void> {
  // A harness that failed for a KNOWN reason here (an unresolvable binary, a
  // provider package that would not load) overrides the generic recorded gap:
  // the task row's error should name the actual cause, which only boot knows.
  const gapOverrides = new Map<HarnessId, string>()
  await registerClaudeCodeTaskExecutor(runtime, config, executors, workspaceDir, gapOverrides)
  await registerKimiCodeTaskExecutor(runtime, config, executors, workspaceDir, gapOverrides)
  // Exact per-harness lookup (not resolve(), whose kind-level fallback would
  // report every harness as covered once any one of them registered).
  for (const { harnessId, registered } of executors.harnesses()) {
    if (registered) continue
    const reason = gapOverrides.get(harnessId) ?? harnessExecutorGap(harnessId)
    executors.register(
      'harness-session',
      createNotImplementedHarnessExecutor(harnessId, { reason }),
      harnessId,
    )
    log.info(`Task executor for (harness-session, ${harnessId}): not implemented — ${reason}`)
  }
}

/**
 * Register the `claude-code` harness-session executor (phase 1 step (b)) when
 * the `claude` binary is resolvable. Binary resolution mirrors the claude-cli
 * provider: config.providers['claude-cli'].binary, falling back to PATH — the
 * PROVIDER is still named `claude-cli`; only the executor target was renamed.
 * If the binary (or the provider package) is missing, record WHY in
 * `gapOverrides` and return — the caller registers the rejecting executor, and
 * the operator-facing reason on a failing task row is then the real cause
 * ("binary X not resolvable") rather than the generic "not wired here".
 */
async function registerClaudeCodeTaskExecutor(
  runtime: Runtime,
  config: RivetConfig,
  executors: ReturnType<typeof createExecutorRegistry>,
  workspaceDir: string,
  gapOverrides: Map<HarnessId, string>,
): Promise<void> {
  const providerCfg = config.providers?.['claude-cli'] ?? {}
  const binary = (providerCfg.binary as string | undefined) ?? 'claude'

  // 3s probe timeout: a hung binary must never stall boot — kill it, warn,
  // and skip registration.
  const available = await probeBinaryVersion(binary, {
    harnessId: 'claude-code',
    scrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  })
  if (!available) {
    const reason =
      `the \`claude\` binary is not resolvable on this node (tried "${binary}"): install ` +
      `Claude Code, or set providers.claude-cli.binary to its path`
    gapOverrides.set('claude-code', reason)
    log.info(`claude binary "${binary}" not resolvable — claude-code task executor not registered`)
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
    const { ClaudeCliExecutor, CLAUDE_HARNESS_ID } = await import('@rivetos/provider-claude-cli')
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
      CLAUDE_HARNESS_ID,
    )
    log.info(`Task executor registered: (harness-session, ${CLAUDE_HARNESS_ID}) via ${binary}`)
  } catch (err: unknown) {
    const message = (err as Error).message
    gapOverrides.set(
      'claude-code',
      `the @rivetos/provider-claude-cli package did not load on this node: ${message}`,
    )
    log.warn(
      `@rivetos/provider-claude-cli not loadable — claude-code task executor skipped: ` + message,
    )
  }
}

/**
 * Register the `kimi-code` harness-session executor when the `kimi` binary is
 * resolvable.
 *
 * Same probe-or-record-why shape as claude, one difference in where the
 * settings come from: kimi-code is NOT a RivetOS provider (there is no
 * LanguageModel wrapper and no `providers.kimi-code` slice), so its binary,
 * model, effort, cwd and CLI home live under `tasks.harnesses.kimi-code`.
 *
 * `home` is worth setting on a node that also runs kimi interactively only if
 * the task spawns should be isolated from it: sharing the default
 * `~/.kimi-code` is what keeps the deployed rivet-memory capture hooks and the
 * `mcp.json` server list in play for task turns.
 */
async function registerKimiCodeTaskExecutor(
  runtime: Runtime,
  config: RivetConfig,
  executors: ReturnType<typeof createExecutorRegistry>,
  workspaceDir: string,
  gapOverrides: Map<HarnessId, string>,
): Promise<void> {
  const harnessCfg = config.tasks?.harnesses?.['kimi-code'] ?? {}
  const binary = harnessCfg.binary ?? 'kimi'

  const available = await probeBinaryVersion(binary, { harnessId: 'kimi-code' })
  if (!available) {
    const reason =
      `the \`kimi\` binary is not resolvable on this node (tried "${binary}"): install ` +
      `Kimi Code, or set tasks.harnesses.kimi-code.binary to its path`
    gapOverrides.set('kimi-code', reason)
    log.info(`kimi binary "${binary}" not resolvable — kimi-code task executor not registered`)
    return
  }

  try {
    const { KimiCodeExecutor, KIMI_HARNESS_ID } = await import('@rivetos/harness-kimi-code')
    executors.register(
      'harness-session',
      new KimiCodeExecutor({
        binary,
        modelId: harnessCfg.model,
        effort: harnessCfg.effort,
        cwd: harnessCfg.cwd ?? workspaceDir,
        kimiHome: harnessCfg.home,
        // Resume rehydration: kimi resumes its own native session between
        // turns, so this only feeds a cross-process resume or a session kimi
        // refuses to reopen.
        memory: runtime.getMemory(),
      }),
      KIMI_HARNESS_ID,
    )
    log.info(`Task executor registered: (harness-session, ${KIMI_HARNESS_ID}) via ${binary}`)
  } catch (err: unknown) {
    const message = (err as Error).message
    gapOverrides.set(
      'kimi-code',
      `the @rivetos/harness-kimi-code package did not load on this node: ${message}`,
    )
    log.warn(
      `@rivetos/harness-kimi-code not loadable — kimi-code task executor skipped: ${message}`,
    )
  }
}

/**
 * `<binary> --version`, true when it exits 0.
 *
 * 3s timeout: a hung binary must never stall boot — kill the probe, warn, and
 * skip registration. `scrub` drops env vars that would make the probe (or the
 * spawns after it) authenticate as something other than the operator intends.
 */
async function probeBinaryVersion(
  binary: string,
  opts: { harnessId: HarnessId; scrub?: string[] },
): Promise<boolean> {
  const PROBE_TIMEOUT_MS = 3_000
  return new Promise<boolean>((resolve) => {
    try {
      const env = { ...process.env }
      for (const name of opts.scrub ?? []) Reflect.deleteProperty(env, name)
      const proc = spawn(binary, ['--version'], { env, stdio: ['ignore', 'ignore', 'ignore'] })
      const timer = setTimeout(() => {
        log.warn(
          `${binary} --version probe timed out after ${String(PROBE_TIMEOUT_MS)}ms — ` +
            `killing probe, skipping the ${opts.harnessId} task executor`,
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
/** Per-user wiki surface factory (#579/#584). Unsafe ids — anything that
 *  could influence a path join ('..', separators, absolute paths, leading
 *  dots) — are refused BEFORE the pool lookup or any join: den + USER_DBS
 *  gate real ids, but this seam must not depend on them. Extracted and
 *  exported so the refusal order is pinned by tests.
 */
export function makeWikiFor<T>(
  userPools: ReadonlyMap<string, pg.Pool | null> | undefined,
  wikiRoot: string,
  buildIndex: (pool: pg.Pool) => T,
): (userId: string) => { index: T; wikiDir: string } | null {
  const cache = new Map<string, { index: T; wikiDir: string }>()
  return (userId) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(userId) || userId.includes('..')) return null
    const userPool = userPools?.get(userId)
    if (!userPool) return null
    let entry = cache.get(userId)
    if (!entry) {
      entry = { index: buildIndex(userPool), wikiDir: join(wikiRoot, 'users', userId) }
      cache.set(userId, entry)
    }
    return entry
  }
}

export function resolveAdvertiseHost(mesh: { advertise_host?: string } | undefined): string {
  const advertised = mesh?.advertise_host?.trim()
  return advertised && advertised.length > 0 ? advertised : getLocalHost()
}
