// rivet-den hook for the Hermes agent — maps Hermes lifecycle events to the
// rivet-den protocol v1 and POSTs them to den-server, so a Hermes conversation
// streams into RivetHub chat / the den exactly like Claude Code and grok Build.
//
// Unlike Claude/grok (which need transcript tailing to recover the reply),
// Hermes hands the reply straight to the hook: `post_llm_call` carries
// `assistant_response`. So this translator reads the payload only — no file
// parsing.
//
// Configured in ~/.hermes/config.yaml (see ../config.hooks.yaml). The event
// name arrives BOTH as the payload's `hook_event_name` and as argv[1] (belt
// and suspenders, matching the grok wrapper). Best-effort: ALWAYS exits 0.
//
// Env (injected by the den-server PTY spawner):
//   RIVET_DEN_SESSION  the conversation join key — the den room to report into
//   RIVET_DEN_URL      den-server base(s), comma-separated (default :5174)
//   RIVET_DEN_TOKEN    bearer token when the gateway is authed
//   RIVET_DEN_NAME     display name (host:harness)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEN_URLS = (process.env.RIVET_DEN_URL ?? 'http://127.0.0.1:5174')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
const TOKEN = process.env.RIVET_DEN_TOKEN ?? ''
const NAME = process.env.RIVET_DEN_NAME ?? os.hostname()

/** content may be a string or a list of blocks ({text} / strings). */
const asText = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
          .join('')
      : ''

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let p
  try {
    p = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return
  }

  const event = p.hook_event_name ?? process.argv[2] ?? ''
  // The PTY spawner injects RIVET_DEN_SESSION (the join key) so a Hermes it
  // launched reports into the pre-created room, beating Hermes's own id.
  const session = process.env.RIVET_DEN_SESSION ?? p.session_id ?? p.sessionId ?? `unknown-${process.ppid}`
  const extra = p.extra ?? {}

  // Per-session state: dedup the user message (pre_llm_call fires once per
  // LLM call in the tool loop, but the user turn is stable across it).
  const stateDir = path.join(os.homedir(), '.cache', 'rivet-den')
  fs.mkdirSync(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, `hermes-${session.replace(/[^\w.-]/g, '_')}.json`)
  let st = { lastUser: '' }
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  } catch {
    /* fresh session */
  }

  const events = []
  const emit = (body) =>
    events.push({ v: 1, session, name: NAME, harness: 'hermes', ts: Date.now() + events.length, ...body })

  switch (event) {
    case 'on_session_start':
    case 'session:start':
      // the room is usually pre-created by the PTY spawner; this is harmless
      // reinforcement and covers Hermes launched outside RivetHub.
      emit({ type: 'session.start', title: 'Hermes' })
      break
    case 'pre_llm_call': {
      const hist = extra.conversation_history ?? p.conversation_history ?? []
      const lastUser = [...hist].reverse().find((m) => m?.role === 'user')
      const text = lastUser ? asText(lastUser.content) : ''
      if (text && text !== st.lastUser) {
        emit({ type: 'message.user', text })
        st.lastUser = text
      }
      emit({ type: 'activity', activity: 'thinking' })
      break
    }
    case 'pre_tool_call':
      emit({ type: 'tool.start', tool: p.tool_name ?? 'tool' })
      break
    case 'post_tool_call':
    case 'post_tool_call_failure':
      emit({ type: 'tool.end', tool: p.tool_name ?? undefined })
      break
    case 'post_llm_call': {
      // the reply, straight from the payload — no transcript needed
      const reply = asText(extra.assistant_response ?? p.assistant_response ?? '')
      emit({ type: 'thinking.end' })
      if (reply.trim()) emit({ type: 'message.agent', text: reply })
      break
    }
    case 'on_session_end':
    case 'session:end':
      emit({ type: 'session.end' })
      try {
        fs.unlinkSync(stateFile)
      } catch {
        /* already gone */
      }
      break
    default:
      break
  }

  if (event !== 'on_session_end' && event !== 'session:end') {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(st))
    } catch {
      /* non-fatal */
    }
  }

  if (events.length === 0) return
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  await Promise.allSettled(
    DEN_URLS.map(async (base) => {
      try {
        const res = await fetch(`${base}/events`, {
          method: 'POST',
          headers,
          body: JSON.stringify(events),
          signal: AbortSignal.timeout(1500),
        })
        if (res.status !== 404) return
      } catch {
        return
      }
      for (const ev of events) {
        await fetch(`${base}/event`, {
          method: 'POST',
          headers,
          body: JSON.stringify(ev),
          signal: AbortSignal.timeout(1000),
        }).catch(() => {})
      }
    }),
  )
}

main().catch(() => {})
