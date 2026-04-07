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

  // Channels
  lines.push('')
  if (state.channels.length === 0) {
    lines.push('Channels:  terminal only')
  } else {
    lines.push('Channels:')
    for (const ch of state.channels) {
      lines.push(`  ${ch.type}  →  token set, owner: ${ch.ownerId}`)
    }
  }

  // Proxmox details
  if (state.proxmox) {
    lines.push('')
    lines.push('Proxmox:')
    lines.push(`  API: ${state.proxmox.apiUrl}`)
    for (const node of state.proxmox.nodes) {
      lines.push(`  ${node.name} (${node.host}) → ${node.role}`)
    }
    lines.push(`  Network: ${state.proxmox.network.bridge} / ${state.proxmox.network.subnet}`)
  }

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
    lines.push('  Managed via Pulumi → Proxmox LXC containers')
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
