import type { HiddenKind } from './types.js'

const AGENT_ARRIVED_RE =
  /A message just arrived from another of your user's agents:\s*([^(]+?)\s*\(id:\s*([0-9a-f-]{36})\)/i

export interface AgentMessage {
  fromAgent: string
  fromAgentId: string
  text: string
}

export function classifyHidden(text: string): HiddenKind | undefined {
  if (AGENT_ARRIVED_RE.test(text) || /\[agent\]/.test(text)) return 'agent_message'
  if (/\[first run\]/i.test(text)) return 'first_run'
  if (
    /\[A background task just completed\]/i.test(text) ||
    /A background task you started has finished/i.test(text)
  ) {
    return 'background_task'
  }
  if (/\[routine\]/i.test(text) || /\[SAND_TRUSTED_AUTOMATION_PROMPT\]/.test(text)) {
    return 'routine'
  }
  if (
    /treat it as skipped/i.test(text) ||
    /Earlier you prompted the user and they moved on without responding/i.test(text)
  ) {
    return 'skipped_prompt'
  }
  if (/\[The user reacted/i.test(text)) return 'reaction'
  if (/<instructions_update>/i.test(text)) return 'instructions_update'
  if (/\[event\]/.test(text)) return 'event'
  if (/<<SAND_AGENT_PROFILE_UPDATE/.test(text) || /<agent_profile_update>/i.test(text)) {
    return 'profile_update'
  }
  return undefined
}

export function extractAgentMessage(text: string): AgentMessage | undefined {
  const header = AGENT_ARRIVED_RE.exec(text)
  if (!header) return undefined
  const fromAgent = header[1].trim()
  const fromAgentId = header[2]
  const after = text.split(/your user can already see it in this chat\.\s*/i)[1] ?? ''
  const named = new RegExp(
    `^\\s*${escapeRe(fromAgent)}:\\s*([\\s\\S]*?)(?:\\n\\s*If it needs a reply[\\s\\S]*|\\s*$)`,
    'i',
  ).exec(after)
  const body = (named?.[1] ?? after).replace(/\n\s*If it needs a reply[\s\S]*$/i, '').trim()
  if (!body) return undefined
  return { fromAgent, fromAgentId, text: body }
}

export function systemMarker(kind: HiddenKind, extra?: string): string {
  const tail = extra ? ` ${extra}` : ''
  return `[grokbot.${kind}]${tail}`.trim()
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
