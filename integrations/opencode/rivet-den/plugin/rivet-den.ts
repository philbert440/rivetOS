/**
 * rivet-den plugin for OpenCode — maps OpenCode bus events to the rivet-den
 * protocol v1 and POSTs them to den-server, so an OpenCode conversation streams
 * into RivetHub chat / the den like Claude Code, Hermes and Kimi.
 *
 * Installed as a COPY at ~/.config/opencode/plugins/rivet-den.ts. Runs under
 * Bun inside the OpenCode process; imports node builtins only. This module
 * exports ONLY plugin functions — OpenCode's loader rejects other exports.
 *
 * Two ids, deliberately (same as the Hermes / Kimi hooks). `session` is the den
 * ROOM — `RIVET_DEN_SESSION`, injected by the den PTY spawner — while
 * `harnessSession` is OpenCode's OWN `ses_…` id. OpenCode has no flag to pin a
 * new session's id, so both have to travel: the `opencode` HarnessDriver binds
 * the room to `harnessSession` and reads a ROTATION (/new, a switched session)
 * off that field changing while the room stays put. An OpenCode launched
 * outside den has no room, so it reports under its canonical
 * `opencode:<ses_…>` id, which the driver also accepts.
 *
 * Event mapping:
 *   user text part            → session.start (first prompt only), message.user
 *   assistant text part       → message.agent (deltas; the bridge coalesces)
 *   reasoning part            → thinking.delta, thinking.end at the first text
 *   tool part running / done  → tool.start / tool.end
 *   session.idle / .error     → message.agent '' carrying turn stats, turn.end
 *
 * Sub-agent sessions (a `parentID`) are skipped — they are the task tool's
 * internals, not the conversation. Nothing is sent until a human prompt
 * arrives, so a pane left at its empty prompt makes no ghost room.
 *
 * Env (injected by the den-server PTY spawner):
 *   RIVET_DEN_SESSION          the den room to report into
 *   RIVET_DEN_URL              den-server base(s), comma-separated (default :5174)
 *   RIVET_DEN_TOKEN            bearer token when the gateway is authed
 *   RIVET_DEN_NAME             display name (host:harness)
 *   RIVET_DEN_CA               CA chain for https dens
 *   RIVETOS_DEN_HOOK_DISABLED  `1` turns the plugin off
 *
 * Best-effort: never throws into OpenCode, and a den outage never blocks it.
 */
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'

/** Coalescing window for token-by-token part updates (ms). */
const FLUSH_MS = 80
const POST_TIMEOUT_MS = 1500
const HARNESS = 'opencode'
const WRAPPER = /^(<command-|<local-command|<system-reminder|<task-notification|<user_info|Caveat:)/

type Rec = Record<string, unknown>
type DenEvent = Rec & { type: string }

function rec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

interface Turn {
  startedAt: number
  /** Tokens of the latest step (its input is the context at turn end). */
  prompt: number
  cached: number
  /** Output + reasoning, summed over the turn's steps. */
  completion: number
  model?: string
  /** Reasoning is open: thinking.end not yet sent. */
  thinking: boolean
}

interface SessionState {
  child: boolean
  started: boolean
  /** messageID → role, from message.updated. */
  roles: Map<string, 'user' | 'assistant'>
  /** Parts seen before their message's role — replayed when it arrives. */
  orphans: Map<string, Rec>
  /** partID → characters already sent (text / reasoning parts). */
  sent: Map<string, number>
  /** Parts already reported (user prompts, finished tools). */
  done: Set<string>
  /** Tool parts with a tool.start sent. */
  running: Set<string>
  turn?: Turn
}

export const RivetDen = async () => {
  const noop = { event: async (): Promise<void> => undefined }
  if (process.env.RIVETOS_DEN_HOOK_DISABLED === '1') return noop

  const room = process.env.RIVET_DEN_SESSION?.trim() || undefined
  const name = process.env.RIVET_DEN_NAME ?? os.hostname()
  const token = process.env.RIVET_DEN_TOKEN ?? ''
  // Both loopback schemes by default: with gateway TLS the den answers https
  // only, and the wrong-scheme attempt fails fast and is swallowed.
  const bases = (process.env.RIVET_DEN_URL ?? 'http://127.0.0.1:5174,https://127.0.0.1:5174')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean)
  const caPath = process.env.RIVET_DEN_CA ?? '/rivet-shared/rivet-ca/intermediate/chain.pem'
  let ca: string | null | undefined

  const sessions = new Map<string, SessionState>()
  const stateFor = (id: string): SessionState => {
    let s = sessions.get(id)
    if (!s) {
      s = {
        child: false,
        started: false,
        roles: new Map(),
        orphans: new Map(),
        sent: new Map(),
        done: new Set(),
        running: new Set(),
      }
      sessions.set(id, s)
    }
    return s
  }

  // ---- outbound queue: coalesced, ordered, never blocking OpenCode ----------
  let queue: DenEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let posting: Promise<void> = Promise.resolve()

  const post = (url: string, body: string): Promise<number> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (!url.startsWith('https:')) {
      return fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).then((r) => r.status)
    }
    if (ca === undefined) {
      try {
        ca = fs.readFileSync(caPath, 'utf8')
      } catch {
        ca = null
      }
    }
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        { method: 'POST', headers, ...(ca ? { ca } : {}), timeout: POST_TIMEOUT_MS },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      req.end(body)
    })
  }

  const send = async (events: DenEvent[]): Promise<void> => {
    const body = JSON.stringify(events)
    await Promise.allSettled(
      bases.map(async (base) => {
        try {
          const status = await post(`${base}/events`, body)
          if (status !== 404) return
        } catch {
          return
        }
        // A den without the batch route takes them one at a time, in order.
        for (const ev of events) await post(`${base}/event`, JSON.stringify(ev)).catch(() => 0)
      }),
    )
  }

  const flush = (): void => {
    timer = undefined
    if (queue.length === 0) return
    const batch = queue
    queue = []
    // Chained so batches land in order even when a post is slow.
    posting = posting.then(() => send(batch)).catch(() => undefined)
  }

  const emit = (roomKey: string, native: string, body: DenEvent): void => {
    const ev: DenEvent = {
      v: 1,
      session: roomKey,
      name,
      harness: HARNESS,
      harnessSession: native,
      ts: Date.now(),
      ...body,
    }
    // Token streams arrive as many small deltas: merge adjacent agent text (or
    // reasoning) for the same room and session. A stats-bearing chunk ends the run.
    const last = queue[queue.length - 1]
    if (
      (ev.type === 'message.agent' || ev.type === 'thinking.delta') &&
      last?.type === ev.type &&
      last.session === ev.session &&
      last.harnessSession === ev.harnessSession &&
      last.usage === undefined &&
      ev.usage === undefined
    ) {
      last.text = str(last.text) + str(ev.text)
    } else {
      queue.push(ev)
    }
    const boundary = ev.type === 'turn.end' || ev.type === 'session.start' || ev.type === 'message.user'
    if (boundary) {
      if (timer) clearTimeout(timer)
      flush()
    } else {
      timer ??= setTimeout(flush, FLUSH_MS)
    }
  }

  const roomFor = (native: string): string => room ?? `${HARNESS}:${native}`

  /** End reasoning once, before the first reply text or the turn boundary. */
  const closeThinking = (native: string, s: SessionState): void => {
    if (!s.turn?.thinking) return
    s.turn.thinking = false
    emit(roomFor(native), native, { type: 'thinking.end' })
  }

  const endTurn = (native: string, s: SessionState): void => {
    const turn = s.turn
    if (!turn) return
    closeThinking(native, s)
    for (const partId of s.running) {
      emit(roomFor(native), native, { type: 'tool.end' })
      s.done.add(partId)
    }
    s.running.clear()
    const stats: Rec = { durationMs: Math.max(0, Date.now() - turn.startedAt) }
    if (turn.prompt > 0 || turn.completion > 0) {
      stats.usage = {
        promptTokens: turn.prompt,
        completionTokens: turn.completion,
        cachedTokens: turn.cached,
      }
    }
    if (turn.model) stats.model = turn.model
    emit(roomFor(native), native, { type: 'message.agent', text: '', ...stats })
    emit(roomFor(native), native, { type: 'turn.end' })
    s.turn = undefined
  }

  const onUserText = (native: string, s: SessionState, part: Rec): void => {
    const partId = str(part.id)
    if (!partId || s.done.has(partId)) return
    if (part.synthetic === true || part.ignored === true) return
    const text = str(part.text).replace(/\r/g, '').trim()
    if (!text) return
    s.done.add(partId)
    if (WRAPPER.test(text)) return
    // A new prompt while a turn is still open (an interrupt, a queued send):
    // close the old turn so the bridge commits it before the new bubble.
    if (s.turn) endTurn(native, s)
    if (!s.started) {
      s.started = true
      emit(roomFor(native), native, { type: 'session.start', title: text.slice(0, 48) })
    }
    emit(roomFor(native), native, { type: 'message.user', text: text.slice(0, 2000) })
    s.turn = { startedAt: Date.now(), prompt: 0, cached: 0, completion: 0, thinking: false }
    emit(roomFor(native), native, { type: 'activity', activity: 'thinking' })
  }

  const onAssistantPart = (native: string, s: SessionState, part: Rec): void => {
    if (!s.started || !s.turn) return
    const turn = s.turn
    const partId = str(part.id)
    const type = str(part.type)
    if (type === 'text' || type === 'reasoning') {
      if (part.synthetic === true || part.ignored === true) return
      const text = str(part.text)
      const already = s.sent.get(partId) ?? 0
      const delta = text.length > already ? text.slice(already) : ''
      s.sent.set(partId, Math.max(already, text.length))
      if (type === 'reasoning') {
        if (!delta) return
        turn.thinking = true
        emit(roomFor(native), native, { type: 'thinking.delta', text: delta })
        return
      }
      closeThinking(native, s)
      if (delta) emit(roomFor(native), native, { type: 'message.agent', text: delta })
      return
    }
    if (type === 'tool') {
      if (s.done.has(partId)) return
      const tool = str(part.tool) || 'tool'
      const status = str(rec(part.state)?.status)
      if ((status === 'pending' || status === 'running') && !s.running.has(partId)) {
        closeThinking(native, s)
        s.running.add(partId)
        emit(roomFor(native), native, { type: 'tool.start', tool })
        return
      }
      if (status === 'completed' || status === 'error') {
        if (!s.running.has(partId)) emit(roomFor(native), native, { type: 'tool.start', tool })
        s.running.delete(partId)
        s.done.add(partId)
        emit(roomFor(native), native, { type: 'tool.end', tool })
      }
      return
    }
    if (type === 'step-finish') {
      if (s.done.has(partId)) return
      s.done.add(partId)
      const tokens = rec(part.tokens)
      const cache = rec(tokens?.cache)
      turn.prompt = num(tokens?.input) + num(cache?.read) + num(cache?.write)
      turn.cached = num(cache?.read)
      turn.completion += num(tokens?.output) + num(tokens?.reasoning)
    }
  }

  const onPart = (native: string, s: SessionState, part: Rec): void => {
    const role = s.roles.get(str(part.messageID))
    if (role === 'user') {
      if (str(part.type) === 'text') onUserText(native, s, part)
    } else if (role === 'assistant') {
      onAssistantPart(native, s, part)
    } else {
      // Latest state per part wins; text parts carry their full text so far.
      s.orphans.set(str(part.id), part)
    }
  }

  const sessionIdOf = (props: Rec | undefined): string =>
    str(props?.sessionID) || str(props?.sessionId) || str(rec(props?.info)?.sessionID)

  return {
    event: async ({ event }: { event: unknown }): Promise<void> => {
      try {
        const ev = rec(event)
        const type = str(ev?.type)
        const props = rec(ev?.properties)
        switch (type) {
          case 'session.created':
          case 'session.updated': {
            const info = rec(props?.info)
            const id = str(info?.id)
            if (id && str(info?.parentID)) stateFor(id).child = true
            return
          }
          case 'message.updated': {
            const info = rec(props?.info)
            const native = str(info?.sessionID)
            const id = str(info?.id)
            const role = str(info?.role)
            if (!native || !id || (role !== 'user' && role !== 'assistant')) return
            const s = stateFor(native)
            if (s.child) return
            s.roles.set(id, role)
            for (const [partId, part] of s.orphans) {
              if (str(part.messageID) !== id) continue
              s.orphans.delete(partId)
              onPart(native, s, part)
            }
            if (role === 'assistant' && s.turn) {
              const model = str(info?.modelID)
              const provider = str(info?.providerID)
              if (model) s.turn.model = provider ? `${provider}/${model}` : model
            }
            return
          }
          case 'message.part.updated': {
            const part = rec(props?.part)
            const native = str(part?.sessionID)
            if (!part || !native) return
            const s = stateFor(native)
            if (s.child) return
            onPart(native, s, part)
            return
          }
          case 'session.idle':
          case 'session.error': {
            const native = sessionIdOf(props)
            if (!native) return
            const s = sessions.get(native)
            if (s && !s.child) endTurn(native, s)
            return
          }
          case 'session.deleted': {
            const native = str(rec(props?.info)?.id) || sessionIdOf(props)
            const s = native ? sessions.get(native) : undefined
            if (s && !s.child) endTurn(native, s)
            if (native) sessions.delete(native)
            return
          }
          default:
            return
        }
      } catch {
        // never throw into opencode
      }
    },
  }
}

export default RivetDen
