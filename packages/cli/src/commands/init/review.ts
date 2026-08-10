/**
 * Phase 5: Review configuration and confirm before writing.
 */

import * as p from '@clack/prompts'
import type { WizardState } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

export async function reviewConfig(state: WizardState): Promise<boolean> {
  const lines: string[] = []

  // Deployment
  lines.push(`Deployment:  ${state.deployment}`)

  // Agents
  lines.push('')
  lines.push('Agents:')
  for (const agent of state.agents) {
    const parts = [`  ${agent.name}`, `${agent.provider} / ${agent.model}`]
    if (agent.thinking !== 'off') parts.push(`thinking: ${agent.thinking}`)
    lines.push(parts.join('  →  '))
  }

  // Channels — social bots removed Phase 5; Hub is the human path
  lines.push('')
  lines.push('Channels:  RivetHub / gateway (social bots removed Phase 5)')

  // Infrastructure
  lines.push('')
  if (state.deployment === 'docker') {
    lines.push('Infrastructure:')
    lines.push('  Datahub  → postgres:16 + pgvector + shared volume')
    lines.push(
      `  Agent${state.agents.length > 1 ? ` x${state.agents.length}` : ''}  → rivetos-agent (built from source)`,
    )
  } else if (state.deployment === 'proxmox') {
    lines.push('Infrastructure:')
    lines.push('  Provisioned via infra/scripts/provision-ct.sh on each Proxmox node')
  } else {
    lines.push('Infrastructure:  manual (you handle deployment)')
  }

  p.note(lines.join('\n'), 'Configuration Summary')

  const confirmedResult = await p.confirm({
    message: 'Ready to deploy?',
    initialValue: true,
  })
  bail(confirmedResult)

  return confirmedResult
}
