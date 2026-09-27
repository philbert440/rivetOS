import { EMPTY_NOISE, type NoiseCounts } from './types.js'

const INJECTED_TAGS = [
  'timestamp',
  'system_reminder',
  'automation_status',
  'agent_profile_update',
  'memory_context',
  'user_info',
  'agent_skills',
  'dynamic_tool_catalog',
  'mcp_server_catalog',
  'instructions_update',
  'attached_files',
] as const

const PROFILE_BLOB_RE = /<<SAND_AGENT_PROFILE_UPDATE:v\d+:[A-Za-z0-9+/=_-]+>>/g
const SAND_HIDDEN_RE = /\[SAND_HIDDEN_PROMPT\]/g
const SAND_TRUSTED_RE = /\[SAND_TRUSTED_AUTOMATION_PROMPT\]/g
const ADDRESS_TAG_RE = /\[t\d+u\]/g
const SENT_FROM_RE = /\[Sent from machine[^\]]*\]/gi
const IMAGE_RE = /\[Image\]/g
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi
const INJECTED_TAG_ALT = INJECTED_TAGS.join('|')
const SIMILAR_BLOCK_RE = new RegExp(`<(${INJECTED_TAG_ALT})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi')

export function countNoise(text: string): NoiseCounts {
  const c: NoiseCounts = { ...EMPTY_NOISE }
  c.timestamp = countRe(text, /<timestamp>/gi)
  c.user_query = countRe(text, /<user_query>/gi)
  c.SAND_HIDDEN_PROMPT = countRe(text, SAND_HIDDEN_RE)
  c.SAND_TRUSTED_AUTOMATION_PROMPT = countRe(text, SAND_TRUSTED_RE)
  c.system_reminder = countRe(text, /<system_reminder>/gi)
  c.automation_status = countRe(text, /<automation_status>/gi)
  c.address_tag = countRe(text, ADDRESS_TAG_RE)
  c.sent_from_machine = countRe(text, SENT_FROM_RE)
  c.profile_blob = countRe(text, PROFILE_BLOB_RE)
  c.agent_profile_update = countRe(text, /<agent_profile_update>/gi)
  c.memory_context = countRe(text, /<memory_context>/gi)
  c.user_info = countRe(text, /<user_info>/gi)
  c.agent_skills = countRe(text, /<agent_skills>/gi)
  c.dynamic_tool_catalog = countRe(text, /<dynamic_tool_catalog>/gi)
  c.mcp_server_catalog = countRe(text, /<mcp_server_catalog>/gi)
  c.instructions_update = countRe(text, /<instructions_update>/gi)
  c.attached_files = countRe(text, /<attached_files>/gi)
  c.image = countRe(text, IMAGE_RE)
  return c
}

export function addNoise(a: NoiseCounts, b: NoiseCounts): NoiseCounts {
  const out: NoiseCounts = { ...EMPTY_NOISE }
  for (const key of Object.keys(EMPTY_NOISE) as (keyof NoiseCounts)[]) {
    out[key] = a[key] + b[key]
  }
  return out
}

function countRe(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

function stripNamedBlocks(text: string, tag: string, keepInner: boolean): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  return keepInner ? text.replace(re, '$1') : text.replace(re, '')
}

/**
 * Unwrap `<user_query>` (keep inner text) and drop the rest of the Grok Bot
 * injection wrappers. `[Image]` stays as a short marker.
 */
export function stripWrappers(text: string): string {
  let out = text
  out = out.replace(USER_QUERY_RE, '$1')
  out = out.replace(PROFILE_BLOB_RE, '')
  out = out.replace(SAND_HIDDEN_RE, '')
  out = out.replace(SAND_TRUSTED_RE, '')
  for (const tag of INJECTED_TAGS) {
    out = stripNamedBlocks(out, tag, false)
  }
  out = out.replace(SIMILAR_BLOCK_RE, '')
  out = out.replace(SENT_FROM_RE, '')
  out = out.replace(ADDRESS_TAG_RE, '')
  out = out.replace(/[ \t]+\n/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

const HIDDEN_BODY_RES: RegExp[] = [
  /\[first run\][\s\S]*/i,
  /\[A background task just completed\][\s\S]*/i,
  /A background task you started has finished\.[\s\S]*/i,
  /\[routine\][\s\S]*/i,
  /\[agent\][\s\S]*?(?:If it needs a reply[\s\S]*$|$)/i,
  /A message just arrived from another of your user's agents:[\s\S]*?(?:If it needs a reply[\s\S]*$|$)/i,
  /Earlier you prompted the user and they moved on without responding[\s\S]*/i,
  /treat it as skipped\.[\s\S]*/i,
  /\[The user reacted[^\]]*\][\s\S]*/i,
  /\[event\][\s\S]*/i,
]

/**
 * After wrapper strip, drop hidden-turn bodies so mixed user turns keep only
 * the real typed text.
 */
export function extractUserText(text: string): string {
  let out = stripWrappers(text)
  for (const re of HIDDEN_BODY_RES) {
    out = out.replace(re, '')
  }
  out = out.replace(/^\s*This is another assistant reaching out[\s\S]*?in this chat\.\s*/i, '')
  out = out.replace(/^\s*This is your own standing order[\s\S]*/i, '')
  out = out.replace(/^\s*This is a system event recorded in your timeline[\s\S]*/i, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
