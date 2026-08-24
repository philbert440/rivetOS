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
// Two ids, deliberately. `session` is the den ROOM — the join key den, chat and
// the PTY share — while `harnessSession` is Hermes's OWN session id from the
// payload. Claude and grok are spawned with `--session-id <room key>` so their
// two ids are one string; Hermes has no flag to pin a new session's id and
// mints `20260802_225647_6ad0b9` for itself, so both have to travel. The
// `hermes` HarnessDriver keys sessions on `harnessSession` (the id the sqlite
// store and rivet-memory capture also use) and reads a ROTATION — /new,
// /branch, a mid-chat /resume, a rewind, a compaction that forks a child — off
// that field changing while the room stays put.
//
// Env (injected by the den-server PTY spawner):
//   RIVET_DEN_SESSION  the conversation join key — the den room to report into
//   RIVET_DEN_URL      den-server base(s), comma-separated (default :5174)
//   RIVET_DEN_TOKEN    bearer token when the gateway is authed
//   RIVET_DEN_NAME     display name (host:harness)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// Default lists BOTH loopback schemes: with gateway TLS (#491) the den
// answers https only, and only one listener exists per port — the
// wrong-scheme attempt fails fast and is swallowed.
const DEN_URLS = (process.env.RIVET_DEN_URL ?? 'http://127.0.0.1:5174,https://127.0.0.1:5174')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
const TOKEN = process.env.RIVET_DEN_TOKEN ?? ''
const NAME = process.env.RIVET_DEN_NAME ?? os.hostname()

// TLS dens are signed by the private Rivet CA — fetch() can't be given a CA,
// so https bases go through node:https with the chain from disk.
const DEN_CA_PATH = process.env.RIVET_DEN_CA ?? '/rivet-shared/rivet-ca/intermediate/chain.pem'
let denCa // lazy — only read when an https base is actually posted to
/** POST json; resolves the HTTP status (http via fetch, https via node:https). */
function postJson(url, headers, body, timeoutMs) {
  if (!url.startsWith('https:')) {
    return fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    }).then((res) => res.status)
  }
  if (denCa === undefined) {
    try {
      denCa = fs.readFileSync(DEN_CA_PATH, 'utf8')
    } catch {
      // System trust only: a private-CA den will refuse the handshake and the
      // post is silently dropped — warn once so vanished events are traceable.
      denCa = null
      console.error(`rivet-den hook: CA chain unreadable at ${DEN_CA_PATH} — posts to https dens may fail`)
    }
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers, ...(denCa ? { ca: denCa } : {}), timeout: timeoutMs },
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

/** content may be a string or a list of blocks ({text} / strings). */
const asText = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
          .join('')
      : ''

// Keep in sync with packages/types/src/hermes-reasoning.ts — this hook is
// copied to ~/.hermes/agent-hooks and cannot import the workspace package.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const HEADER = /^[\s]*[┌╭][─━\s]*\b(Reasoning|Thought|Thinking)\b/i
const FOOTER = /^[\s]*[└╰][─━\s]+[┘╯][\s]*$/
const BODY = /^[\s]*[│┃├┤]/

function splitHermesReasoning(input) {
  if (!input) return { reasoning: '', text: '' }
  const lines = input.split(/\r?\n/)
  const reasoning = []
  const text = []
  let i = 0
  while (i < lines.length) {
    const vis = lines[i].replace(ANSI, '')
    if (!HEADER.test(vis)) {
      text.push(lines[i])
      i += 1
      continue
    }
    i += 1
    let sawBox = false
    while (i < lines.length) {
      const v = lines[i].replace(ANSI, '')
      if (FOOTER.test(v)) {
        i += 1
        break
      }
      if (BODY.test(v)) {
        sawBox = true
        reasoning.push(v.replace(/^[\s]*[│┃├┤]\s?/, ''))
        i += 1
        continue
      }
      if (sawBox) break
      if (!v.trim()) {
        i += 1
        break
      }
      reasoning.push(v)
      i += 1
    }
  }
  return { reasoning: reasoning.join('\n').trim(), text: text.join('\n').trim() }
}

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
  // Hermes's own id, every event, so the driver can key sessions on it and see
  // it rotate. Every shell-hook payload carries session_id at the top level
  // (agent/shell_hooks.py `_serialize_payload`).
  const harnessSession = typeof (p.session_id ?? p.sessionId) === 'string'
    ? (p.session_id ?? p.sessionId)
    : ''
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
    events.push({
      v: 1,
      session,
      name: NAME,
      harness: 'hermes',
      ...(harnessSession ? { harnessSession } : {}),
      ts: Date.now() + events.length,
      ...body,
    })

  switch (event) {
    case 'on_session_start':
    case 'session:start':
      // the room is usually pre-created by the PTY spawner; this is harmless
      // reinforcement and covers Hermes launched outside RivetHub.
      emit({ type: 'session.start', title: 'Hermes' })
      break
    case 'on_session_reset':
    case 'session:reset':
      // Hermes replaced this room's session id in place (/new, /branch, a
      // mid-chat /resume, a rewind). Shell hooks only ever see the NEW id —
      // the previous one is the driver's to remember — and the room itself
      // continues, which is exactly what den's reducer does with session.start
      // (it keeps the conversation log across session boundaries). Reporting it
      // here rather than waiting for the next pre_llm_call means the control
      // plane records the rotation at the boundary, not one turn late.
      emit({ type: 'session.start', title: 'Hermes' })
      // The new session starts with no history, so the user-message dedup must
      // not swallow a first turn that repeats the last one before the reset.
      st.lastUser = ''
      break
    case 'pre_llm_call': {
      // Hermes fires pre_llm_call ONCE per turn (before the tool loop), so
      // the dedup vs st.lastUser is belt-and-suspenders — it only matters if
      // two consecutive turns have identical user text.
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
      // the reply, straight from the payload — no transcript needed.
      // Hermes TUI still paints ┌─ Reasoning ──┐ into assistant_response;
      // peel it off so Rivet Bot never shows the thinking box as chat.
      const reply = asText(extra.assistant_response ?? p.assistant_response ?? '')
      const split = splitHermesReasoning(reply)
      if (split.reasoning) emit({ type: 'thinking.delta', text: split.reasoning })
      emit({ type: 'thinking.end' })
      if (split.text) emit({ type: 'message.agent', text: split.text })
      // post_llm_call fires ONCE per turn, after the tool loop produced the
      // final response (Hermes hooks docs) — so it IS the turn boundary. The
      // bridge commits the reply + emits done here, releasing RivetHub's send
      // queue without waiting for the 120s stale-turn crutch. Emitted even on
      // an empty reply: the turn is over either way.
      emit({ type: 'turn.end' })
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
        const status = await postJson(`${base}/events`, headers, JSON.stringify(events), 1500)
        if (status !== 404) return
      } catch {
        return
      }
      for (const ev of events) {
        await postJson(`${base}/event`, headers, JSON.stringify(ev), 1000).catch(() => {})
      }
    }),
  )
}

main().catch(() => {})
