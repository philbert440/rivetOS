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
} from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Agents')

export async function registerAgentTools(
  runtime: Runtime,
  config: RivetConfig,
  _workspaceDir: string,
): Promise<void> {
  // Delegation — agent-to-agent task handoff
  const delegation = new DelegationEngine({
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: runtime.getTools(),
    hooks: runtime.getHooks(),
  })
  runtime.registerTool(delegation.createDelegationTool())

  // Sub-agents — spawn/send/kill child sessions
  const subagentManager = new SubagentManagerImpl({
    router: runtime.getRouter(),
    workspace: runtime.getWorkspace(),
    tools: runtime.getTools(),
    hooks: runtime.getHooks(),
  })
  for (const tool of createSubagentTools(subagentManager)) {
    runtime.registerTool(tool)
  }

  // Skills — discover and list available skills
  const skillManager = new SkillManagerImpl()
  const defaultSkillDirs = [`${process.env.HOME ?? '~'}/.rivetos/skills`]
  const skillDirs = config.runtime.skill_dirs ?? defaultSkillDirs
  await skillManager.discover(skillDirs)
  runtime.registerTool(createSkillListTool(skillManager))

  log.info('Delegation, sub-agent, and skill tools registered')
}
