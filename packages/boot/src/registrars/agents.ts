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
import {
  DelegationEngine,
  MeshDelegationEngine,
  FileMeshRegistry,
  buildLocalNode,
  AgentChannelServer,
  SubagentManagerImpl,
  createSubagentTools,
  SkillManagerImpl,
  createSkillListTool,
  createSkillManageTool,
} from '@rivetos/core'
import type { MeshConfig } from '@rivetos/types'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Agents')

export async function registerAgentTools(
  runtime: Runtime,
  config: RivetConfig,
  _workspaceDir: string,
): Promise<void> {
  // Build tool filter from agent configs
  const toolFilter: Record<string, { exclude?: string[]; include?: string[] }> = {}
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.tools) {
      toolFilter[id] = agent.tools
    }
  }
  const hasFilters = Object.keys(toolFilter).length > 0

  // Build the local delegation engine (always needed — mesh wraps it)
  const localDelegation = new DelegationEngine({
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: () => runtime.getTools(),
    hooks: runtime.getHooks(),
    toolFilter: hasFilters ? toolFilter : undefined,
  })

  // Determine if mesh is enabled
  const meshConfig = config.mesh
  const meshEnabled = meshConfig?.enabled === true && meshConfig.secret

  if (meshEnabled) {
    // ------------------------------------------------------------------
    // Mesh mode — MeshDelegationEngine + AgentChannel + FileMeshRegistry
    // ------------------------------------------------------------------

    const secret = resolveEnv(meshConfig.secret ?? '')
    const storageDir = meshConfig.storage_dir ?? '/shared'
    const agentChannelPort = meshConfig.agent_channel_port ?? 3000
    const localAgents = Object.keys(config.agents)

    // Convert snake_case YAML config to the MeshConfig interface
    const meshCfg: MeshConfig = {
      enabled: true,
      nodeName: meshConfig.node_name,
      secret,
      heartbeatIntervalMs: meshConfig.heartbeat_interval_ms,
      staleThresholdMs: meshConfig.stale_threshold_ms,
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
    })

    // Build and register the local node
    const localNode = buildLocalNode({
      existingId: meshConfig.node_name ?? 'unknown',
      name: meshConfig.node_name ?? 'unknown',
      agents: localAgents,
      host: getLocalHost(),
      port: agentChannelPort,
      providers: Object.keys(config.providers),
      models: Object.values(config.agents)
        .map((a) => a.model)
        .filter((m): m is string => !!m),
      version: '0.1.0',
    })

    await meshRegistry.start(localNode)
    log.info(`Mesh registry started — node "${localNode.name}" registered`)

    // Mesh delegation engine
    const meshDelegation = new MeshDelegationEngine({
      localEngine: localDelegation,
      router: runtime.getRouter(),
      meshRegistry,
      secret,
      localAgents,
    })

    // Register the mesh-aware delegation tool
    runtime.registerTool(meshDelegation.createDelegationTool())

    // Agent channel server — receives incoming mesh delegations
    const agentChannel = new AgentChannelServer({
      port: agentChannelPort,
      secret,
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

  // Sub-agents — spawn/send/kill child sessions (late-bound tools + filtering)
  const subagentManager = new SubagentManagerImpl({
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: () => runtime.getTools(),
    hooks: runtime.getHooks(),
    toolFilter: hasFilters ? toolFilter : undefined,
  })
  for (const tool of createSubagentTools(subagentManager)) {
    runtime.registerTool(tool)
  }

  // Skills — discover, list, and manage
  const skillManager = new SkillManagerImpl()
  const defaultSkillDirs = [`${process.env.HOME ?? '~'}/.rivetos/skills`]
  const skillDirs = config.runtime.skill_dirs ?? defaultSkillDirs
  await skillManager.discover(skillDirs)
  runtime.registerTool(createSkillListTool(skillManager))

  // Pass embed endpoint for dedup checks (if configured)
  const pgConfig = config.memory?.postgres as Record<string, unknown> | undefined
  const rawEmbed = pgConfig?.embed_endpoint
  const embedEndpoint =
    (typeof rawEmbed === 'string' ? rawEmbed : undefined) ?? process.env.RIVETOS_EMBED_URL ?? ''
  runtime.registerTool(
    createSkillManageTool(skillManager, {
      skillDirs,
      embedEndpoint: embedEndpoint || undefined,
    }),
  )

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
