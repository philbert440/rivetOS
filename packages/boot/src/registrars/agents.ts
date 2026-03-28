/**
 * Agent Registrar — registers delegation, sub-agent, and skill tools.
 *
 * These are domain services that the runtime previously created in start().
 * Moving them to boot keeps the runtime focused on lifecycle management
 * and makes registration consistent with providers, channels, and tools.
 */

import type { Runtime } from '@rivetos/core'
import {
  DelegationEngine,
  SubagentManagerImpl,
  createSubagentTools,
  SkillManagerImpl,
  createSkillListTool,
  createSkillManageTool,
} from '@rivetos/core'
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

  // Delegation — agent-to-agent task handoff (late-bound tools + filtering)
  const delegation = new DelegationEngine({
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: () => runtime.getTools(),
    hooks: runtime.getHooks(),
    toolFilter: hasFilters ? toolFilter : undefined,
  })
  runtime.registerTool(delegation.createDelegationTool())

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
  const pgConfig = config.memory?.postgres
  const rawEmbed = pgConfig?.embed_endpoint
  const embedEndpoint =
    (typeof rawEmbed === 'string' ? rawEmbed : undefined) ?? process.env.RIVETOS_EMBED_URL ?? ''
  runtime.registerTool(
    createSkillManageTool(skillManager, {
      skillDirs,
      embedEndpoint: embedEndpoint || undefined,
    }),
  )

  log.info('Delegation, sub-agent, and skill tools registered')
}
