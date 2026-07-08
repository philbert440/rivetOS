// rivet-den event protocol, version 1.
// Normalized agent events emitted by harness adapters (Claude Code, Grok
// Build, rivetos-native) and consumed by the den reducer/renderer.
// See PROTOCOL.md for the full contract.

export const PROTOCOL_VERSION = 1 as const

/** Coarse activity vocabulary. Packs key pose sets on these; per-tool
 *  overrides refine them (tool → activity → 'idle' fallback chain). */
export type Activity =
  | 'idle'
  | 'thinking'
  | 'searching_web'
  | 'editing_code'
  | 'running_command'
  | 'writing_plan'
  | 'listening'
  | 'speaking'
  | 'sleeping'

export const ACTIVITIES: readonly Activity[] = [
  'idle',
  'thinking',
  'searching_web',
  'editing_code',
  'running_command',
  'writing_plan',
  'listening',
  'speaking',
  'sleeping',
]

/** Harness that produced an event. Free-form for forward-compat; well-known
 *  values are listed. */
export type Harness = 'claude-code' | 'grok-build' | 'rivetos' | (string & {})

/** Event payloads, discriminated on `type`. */
export type AgentEventBody =
  | { type: 'session.start'; title: string }
  | { type: 'session.end' }
  | { type: 'task.plan'; tasks: string[] }
  | { type: 'task.check'; index: number }
  | { type: 'activity'; activity: Activity }
  /** Raw tool invocation. `tool` is the harness's tool name verbatim
   *  (e.g. 'Bash', 'WebSearch', 'mcp:rivetos:memory_search'). Adapters may
   *  suggest a coarse `activity`; the reducer otherwise derives one. */
  | { type: 'tool.start'; tool: string; activity?: Activity }
  | { type: 'tool.end'; tool?: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'thinking.end' }
  | { type: 'speech.stt'; active: boolean }
  | { type: 'message.user'; text: string }
  /** Assistant text block. On the FINAL block of a turn the adapter may attach
   *  `usage`/`model`/`durationMs` (Claude Code reads them from its transcript);
   *  the den reducer ignores them, but the RivetHub bridge threads them onto
   *  the committed chat message. Interim blocks omit them. */
  | {
      type: 'message.agent'
      text: string
      usage?: TokenUsage
      model?: string
      durationMs?: number
    }
  | { type: 'term.line'; text: string }

/** Per-turn token accounting attachable to a final message.agent event.
 *  `promptTokens` includes cached input; `cachedTokens` is its cache-read
 *  portion. */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

/** Envelope common to every event. */
export interface AgentEventMeta {
  /** Protocol version. Always 1 for this schema. */
  v: typeof PROTOCOL_VERSION
  /** Stable session identifier — one den room per session. */
  session: string
  /** Optional human-readable session display name. */
  name?: string
  /** Producing harness. */
  harness?: Harness
  /** Milliseconds since epoch at emit time. */
  ts?: number
}

export type AgentEvent = AgentEventMeta & AgentEventBody

/** Default mapping from raw tool names to coarse activities, used when the
 *  adapter didn't supply one. Unknown tools fall back to 'running_command'. */
export function toolActivity(name: string): Activity {
  const n = name.toLowerCase()
  if (
    n.includes('websearch') ||
    n.includes('webfetch') ||
    n.includes('web_search') ||
    n.includes('web_fetch') ||
    n.includes('internet_search')
  )
    return 'searching_web'
  if (n === 'edit' || n === 'write' || n === 'notebookedit' || n.includes('applypatch'))
    return 'editing_code'
  if (n === 'taskcreate' || n === 'taskupdate' || n === 'exitplanmode' || n === 'enterplanmode')
    return 'writing_plan'
  if (n === 'read' || n === 'grep' || n === 'glob') return 'thinking'
  // CLI/shell runs happen at the computer — the desk terminal is already
  // echoing the command. The toolbox (running_command) is for plugin/MCP
  // tools and anything else without a station of its own.
  if (n === 'bash' || n === 'run_terminal_cmd' || n === 'shell' || n.includes('terminal'))
    return 'editing_code'
  return 'running_command'
}

/** Runtime validation for events arriving over the wire (POST /hook, WS).
 *  Returns the typed event, or null if the value is not a valid v1 event. */
export function parseEvent(raw: unknown): AgentEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e.v !== PROTOCOL_VERSION) return null
  if (typeof e.session !== 'string' || e.session.length === 0) return null
  if (typeof e.type !== 'string') return null
  // envelope optionals: wrong-typed metadata (ts: "abc", name: 42) would
  // otherwise flow into the recency sort / display untouched
  if (e.name !== undefined && typeof e.name !== 'string') return null
  if (e.harness !== undefined && typeof e.harness !== 'string') return null
  if (e.ts !== undefined && (typeof e.ts !== 'number' || !Number.isFinite(e.ts))) return null
  const str = (k: string) => typeof e[k] === 'string'
  switch (e.type) {
    case 'session.start':
      return str('title') ? (raw as AgentEvent) : null
    case 'session.end':
    case 'thinking.end':
      return raw as AgentEvent
    case 'task.plan':
      return Array.isArray(e.tasks) && e.tasks.every((t) => typeof t === 'string')
        ? (raw as AgentEvent)
        : null
    case 'task.check':
      return typeof e.index === 'number' && Number.isInteger(e.index) && e.index >= 0
        ? (raw as AgentEvent)
        : null
    case 'activity':
      return (ACTIVITIES as readonly string[]).includes(e.activity as string)
        ? (raw as AgentEvent)
        : null
    case 'tool.start':
      if (!str('tool')) return null
      if (
        e.activity !== undefined &&
        !(ACTIVITIES as readonly string[]).includes(e.activity as string)
      )
        return null
      return raw as AgentEvent
    case 'tool.end':
      return e.tool === undefined || str('tool') ? (raw as AgentEvent) : null
    case 'speech.stt':
      return typeof e.active === 'boolean' ? (raw as AgentEvent) : null
    case 'thinking.delta':
    case 'message.user':
    case 'term.line':
      return str('text') ? (raw as AgentEvent) : null
    case 'message.agent': {
      if (!str('text')) return null
      // optional turn stats — reject malformed rather than pass junk downstream
      if (e.model !== undefined && typeof e.model !== 'string') return null
      if (
        e.durationMs !== undefined &&
        (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs))
      )
        return null
      if (e.usage !== undefined) {
        const u = e.usage as Record<string, unknown> | null
        const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
        if (
          typeof u !== 'object' ||
          u === null ||
          !num(u.promptTokens) ||
          !num(u.completionTokens) ||
          !num(u.cachedTokens)
        )
          return null
      }
      return raw as AgentEvent
    }
    default:
      return null
  }
}
