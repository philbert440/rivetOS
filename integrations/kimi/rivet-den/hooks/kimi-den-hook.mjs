#!/usr/bin/env node
// rivet-den hook translator for Kimi Code CLI: one lifecycle hook payload on
// stdin → rivet-den protocol v1 events → POST /events on the den-server.
//
// Self-contained (no deps, no rivetos install needed) — the same property the
// Claude Code translator has, so this file alone is enough to light up a den.
//
// Payload-first, like the kimi rivet-memory capture worker: kimi hook payloads
// carry the prompt, tool name, tool input and tool output directly, so nothing
// here tails a transcript. The one thing they do NOT carry is the assistant's
// reply (`Stop` ships `{ stop_hook_active }` and nothing else), so this hook
// emits no `message.agent` — see README § "What the den does not show".
//
// Config (env, or ~/.rivetos/.env sourced by the launcher):
//   RIVET_DEN_URL    den-server base, comma-separated fan-out (default http://127.0.0.1:5174)
//   RIVET_DEN_TOKEN  bearer token, when the server has auth on
//   RIVET_DEN_NAME   session display name (default: os hostname)
//   RIVET_DEN_TERM=off        never send desk-terminal lines
//   RIVETOS_DEN_HOOK_DISABLED=1  stay silent entirely (executor-owned sessions)
//
// Per-session translator state (started flag, todo diff, turn stamp) lives
// under ~/.cache/rivet-den/. Everything is best-effort: exit 0 always.

// Executor-owned sessions (RivetOS task engine) emit den events themselves —
// bail before ANY state or network work so a spawned kimi can't double-report.
if (process.env.RIVETOS_DEN_HOOK_DISABLED === '1') process.exit(0)

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

// comma-separated fan-out: each node posts to its OWN den and to the mesh hub.
// Default lists BOTH loopback schemes: with gateway TLS (#491) the den answers
// https only, and only one listener exists per port — the wrong-scheme
// attempt fails fast and is swallowed.
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
const HARNESS = 'kimi-code'
const TERM_OFF = (process.env.RIVET_DEN_TERM ?? '') === 'off'

// ---------------------------------------------------------------------------
// Payload accessors
// ---------------------------------------------------------------------------
// kimi-code 0.34 snake_cases every TOP-LEVEL hook field on its way to the wire
// (`toHookInputData` runs camelToSnake over the whole input record), so the
// snake spellings are the real ones. The camel spellings are accepted anyway —
// the rivet-memory capture worker has carried the same dual-case accessors
// since day one and they cost nothing. Note the asymmetry: `tool_input` is
// passed through VERBATIM, so its inner keys are whatever the tool's schema
// uses (`path`, `command`, `cmd`, …) and get no case treatment at all.

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

const pickString = (obj, ...keys) => {
  const v = pick(obj, ...keys)
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Prompt text out of a kimi prompt field.
 *
 * `UserPromptSubmit.prompt`, `TurnStarted.prompt` and `UserPromptQueued.prompt`
 * all carry the raw prompt *message content*, which is either a plain string or
 * an array of content parts (`[{ type: 'text', text }, …]`) — kimi's own
 * `matcherValueText` does exactly this join. Treating it as a string only (what
 * the capture worker does) silently drops nearly every user turn.
 */
function promptText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Redaction — value patterns + secret key names (same shapes as the claude-code
// translator; keep the two in sync).
// ---------------------------------------------------------------------------
const SECRET_KEY_RE =
  /^(?:.*(?:password|passwd|secret|token|api[_-]?key|authorization|auth|credential|private[_-]?key).*)$/i

function redact(s) {
  return (
    String(s)
      // Authorization / Bearer headers FIRST (the key=/: rule below would
      // otherwise consume the word "Bearer" and leave the token standing)
      .replace(/\b(bearer|basic)\s+[\w+./=-]{8,}/gi, '$1 [redacted]')
      // KEY=value / key: value where the key names a credential
      .replace(
        /\b([\w-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[\w-]*\s*[=:]\s*)\S+/gi,
        '$1[redacted]',
      )
      // well-known token prefixes (AWS, GitHub, Slack, OpenAI/Stripe-style) + bare JWTs
      .replace(
        /\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[a-z]-[\w-]{10,}|sk-[A-Za-z0-9_-]{16,}|eyJ[\w-]{8,}\.[\w-]+\.[\w-]+)\b/g,
        '[redacted]',
      )
  )
}

function capStr(s) {
  const r = redact(s)
  return r.length > 200 ? r.slice(0, 200) + '…' : r
}

/** Cap tool_input fields for den/Hub (value-pattern redact + secret keys). */
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const out = {}
  let n = 0
  for (const [k, v] of Object.entries(input)) {
    if (n++ > 40) break
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[redacted]'
      continue
    }
    if (typeof v === 'string') out[k] = capStr(v)
    else if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((item) => (typeof item === 'string' ? capStr(item) : item))
    } else if (v !== undefined && typeof v === 'object') {
      // nested plain object — one level only
      const o = {}
      for (const [ik, iv] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(ik)) o[ik] = '[redacted]'
        else if (typeof iv === 'string') o[ik] = capStr(iv)
        else if (typeof iv === 'number' || typeof iv === 'boolean' || iv === null) o[ik] = iv
        else o[ik] = '[omitted]'
      }
      out[k] = o
    } else if (v !== undefined) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** Content-hash dedup (capture worker idiom). */
const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

const STATE_DIR = path.join(os.homedir(), '.cache', 'rivet-den')

/**
 * Cache file for the no-payload-id fallback, keyed by the session's cwd.
 *
 * Not by pid: kimi spawns hooks with `shell: true, detached: true`, and the
 * shell does NOT exec the command, so every fire gets a fresh shell and a
 * fresh node — neither `process.ppid` nor the launcher's `$PPID` survives from
 * one fire to the next. cwd is the only thing on a payload that is stable
 * across a session when the session id itself is missing.
 *
 * The trade: two concurrent id-less sessions in the same directory share a
 * room. That is acceptable for a path that only triggers when the harness
 * fails to identify itself at all (kimi 0.34 always sends `session_id`; the
 * older in-process engine could send an empty one).
 */
const fallbackFile = (cwd) =>
  path.join(STATE_DIR, `fallback-${crypto.createHash('sha1').update(cwd, 'utf8').digest('hex').slice(0, 16)}.id`)

/**
 * Session id for a payload that carries none.
 *
 * The contract forbids low-entropy session ids, so the id is a random 8 bytes
 * — minted once and cached, because re-rolling on every fire would scatter one
 * session across a dozen rooms.
 */
function fallbackNativeId(cwd) {
  const file = fallbackFile(cwd)
  try {
    const cached = fs.readFileSync(file, 'utf8').trim()
    if (cached) return cached
  } catch {
    /* first fire for this cwd */
  }
  const minted = `unknown-${crypto.randomBytes(8).toString('hex')}`
  try {
    // the state dir may not exist yet: this runs BEFORE the per-session state
    // is written, and without the mkdir the write fails, the cache never
    // lands, and every fire mints a new id — the exact scatter this prevents
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(file, minted)
  } catch {
    /* cache unwritable — the id is still valid, just not stable */
  }
  return minted
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let p = {}
  try {
    p = JSON.parse(raw)
  } catch {
    /* payload-less fire — the argv event name still applies */
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {}

  const hookEvent = pickString(p, 'hook_event_name', 'hookEventName') ?? process.argv[2] ?? ''

  // ---- session identity ------------------------------------------------
  // Canonical form is `<harness-id>:<native-session-id>`
  // (docs/plans/harness-control-plane.md § Session identity) — the SAME key
  // the rivet-memory capture worker writes, so the den room and the memory
  // conversation join on one identity instead of two.
  //
  // kimi's native ids are `session_<uuidv4>` (verified in
  // ~/.kimi-code/session_index.jsonl and in captured `ros_conversations`
  // rows), i.e. UUID-class entropy, so plain namespacing satisfies the
  // contract's collision-resistance rule. RIVET_DEN_SESSION, injected by the
  // den-server PTY spawner, is already canonical and is used verbatim.
  const native =
    pickString(p, 'session_id', 'sessionId') ??
    process.env.KIMI_SESSION_ID ??
    process.env.KIMI_CODE_SESSION_ID
  // an exported-but-empty RIVET_DEN_SESSION means "not set" — an empty
  // `session` is rejected by the server's parseEvent and would drop the batch
  const pinned = process.env.RIVET_DEN_SESSION
  const cwd = pickString(p, 'cwd') ?? ''
  const usedFallback = !pinned && !native
  const session = pinned ? pinned : `${HARNESS}:${native ?? fallbackNativeId(cwd)}`
  // kimi's OWN session id, carried alongside the room key on every event.
  //
  // The two are the same string only when this hook picked the room itself.
  // Under `RIVET_DEN_SESSION` — a kimi the den-server PTY spawner started — the
  // room is a key den chose, and kimi has no flag to be told what to call its
  // session (`-S/--session` resumes an existing one; there is no
  // `--session-id`), so the two ids genuinely differ and BOTH have to travel.
  // The `kimi-code` HarnessDriver keys sessions on this field, exactly as the
  // hermes driver does — `harnessSession` is an existing optional field on the
  // protocol envelope (`AgentEventMeta`), added for that harness for this same
  // reason. Without it a den-spawned kimi is a room the control plane cannot
  // name a session for.
  const harnessSession = native ?? ''

  // ---- per-session translator state ------------------------------------
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const stateFile = path.join(STATE_DIR, `${session.replace(/[^\w.-]/g, '_')}.json`)
  let st = { started: false, title: '', labels: [], done: [], turnStart: 0, lastUserHash: '' }
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  } catch {
    /* fresh session */
  }

  const events = []
  // ts ticks up per event so a batch keeps its order through the reducer's
  // monotonic lastEventTs even though it is emitted within one millisecond
  const emit = (body) =>
    events.push({
      v: 1,
      session,
      name: NAME,
      harness: HARNESS,
      ...(harnessSession ? { harnessSession } : {}),
      ts: Date.now() + events.length,
      ...body,
    })

  const termLine = (text) => {
    if (TERM_OFF) return
    const t = redact(String(text).replace(/[\r\t]/g, ' ').trimEnd()).slice(0, 80)
    if (t.trim()) emit({ type: 'term.line', text: t })
  }

  const title = pickString(p, 'session_title', 'sessionTitle')
  if (title) st.title = title

  // A session becomes a den room only once a HUMAN prompt arrives. kimi fires
  // UserPromptSubmit exclusively for `origin.kind === 'user'` turns, so this
  // gate is exact: subagent turns, task-triggered turns and stop-hook
  // continuations never open a ghost room in the picker.
  if (!st.started) {
    if (hookEvent !== 'UserPromptSubmit') {
      fs.writeFileSync(stateFile, JSON.stringify(st))
      return
    }
    st.started = true
    const first = promptText(pick(p, 'prompt', 'user_prompt', 'userPrompt', 'text'))
    emit({
      type: 'session.start',
      title: (st.title || first.replace(/\s+/g, ' ').trim() || 'kimi session').slice(0, 48),
    })
  }

  const toolName = pickString(p, 'tool_name', 'toolName') ?? ''
  const rawToolInput = pick(p, 'tool_input', 'toolInput')
  const toolInput = rawToolInput && typeof rawToolInput === 'object' ? rawToolInput : {}
  const toolOutput = pick(p, 'tool_output', 'toolOutput')

  // Planning tools drive the whiteboard instead of tool.start/tool.end —
  // PreToolUse and PostToolUse must agree on this set or the room gets a
  // tool.end with no matching tool.start. kimi's todo tool is `TodoList`
  // (observed in capture); the claude-side names are accepted as aliases.
  const isPlanningTool = /^(TodoList|TodoWrite|TaskCreate|TaskUpdate)$/.test(toolName)
  // kimi 0.34's shell tool is `Bash` ({ command }) — the only one in its tool
  // set. `Shell` ({ cmd }) is a defensive alias, not a shipped tool: one such
  // call shows up in captured history (older release or an MCP-provided tool),
  // so the branch stays, in the same spirit as the file-tool aliases below.
  const isShellTool = toolName === 'Bash' || toolName === 'Shell'
  // kimi has Edit and Write; MultiEdit/NotebookEdit are claude-side aliases
  const isEditTool = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)
  // kimi file tools key the target as `path`; the claude spellings are aliases
  const editTarget = () => pickString(toolInput, 'path', 'file_path', 'filePath')
  const shellCommand = () => pickString(toolInput, 'command', 'cmd')

  /** kimi TodoList items are `{ title, status }` with status done|in_progress|pending. */
  const handleTodos = (todos) => {
    if (!Array.isArray(todos) || !todos.length) return
    const labels = todos.map((t) => String(t?.title ?? t?.content ?? t?.activeForm ?? '').slice(0, 60))
    const done = todos.map((t) => t?.status === 'done' || t?.status === 'completed')
    const sameList = labels.length === st.labels.length && labels.every((l, i) => l === st.labels[i])
    if (!sameList) {
      emit({ type: 'task.plan', tasks: labels })
      done.forEach((d, i) => d && emit({ type: 'task.check', index: i }))
    } else {
      done.forEach((d, i) => {
        if (d && !st.done[i]) emit({ type: 'task.check', index: i })
      })
    }
    st.labels = labels
    st.done = done
  }

  // Turn boundary. kimi routes a finished turn to exactly ONE of Stop
  // (completed), StopFailure (failed) or Interrupt (cancelled), so turn.end
  // fires once — but only when a turn is actually open, so a stray Stop
  // can't clear a room that has nothing running.
  const endTurn = () => {
    emit({ type: 'thinking.end' })
    if (st.turnStart) {
      emit({ type: 'turn.end' })
      st.turnStart = 0
    }
    st.lastUserHash = ''
  }

  switch (hookEvent) {
    case 'SessionStart':
      break // title stashed above; the room opened on the first user prompt

    case 'UserPromptSubmit': {
      const text = promptText(pick(p, 'prompt', 'user_prompt', 'userPrompt', 'text'))
        .replace(/\r/g, '')
        .trim()
        .slice(0, 2000)
      // Harness-injected wrappers (reminders, command echoes) are not
      // something the user typed and must never reach the chat as a user
      // bubble (mirrors the den-server transcript parser's filter).
      const isWrapper = /^(<command-|<local-command|<system-reminder|<task-notification|<user_info|Caveat:)/.test(
        text,
      )
      const h = text ? hash(text) : ''
      if (text && !isWrapper && h !== st.lastUserHash) {
        st.lastUserHash = h
        emit({ type: 'message.user', text })
      }
      emit({ type: 'speech.stt', active: true })
      emit({ type: 'speech.stt', active: false }) // reducer lands on 'thinking'
      st.turnStart = Date.now()
      break
    }

    case 'TurnStarted':
      // TurnStarted repeats the prompt, but UserPromptSubmit already put it in
      // the chat — emitting it here too would double every user bubble. This
      // event exists in the map for the turn boundary of NON-user origins
      // (task / system_trigger), which never fire UserPromptSubmit.
      emit({ type: 'activity', activity: 'thinking' })
      if (!st.turnStart) st.turnStart = Date.now()
      break

    case 'PreToolUse': {
      if (isPlanningTool) {
        emit({ type: 'activity', activity: 'writing_plan' })
      } else {
        const args = summarizeToolInput(toolInput)
        emit({ type: 'tool.start', tool: toolName || 'unknown', ...(args ? { args } : {}) })
        const cmd = isShellTool ? shellCommand() : undefined
        if (cmd) termLine('$ ' + cmd.replace(/\s+/g, ' '))
      }
      break
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (isPlanningTool) {
        // no tool.start was emitted for these — no tool.end either
        handleTodos(pick(toolInput, 'todos'))
      } else {
        if (isShellTool) {
          // kimi sends tool_output as pre-rendered text (capped at 2k) on
          // success and omits it entirely on failure, where `error` carries
          // `{ name, message }` instead.
          const out =
            typeof toolOutput === 'string'
              ? toolOutput
              : [toolOutput?.stdout, toolOutput?.stderr].filter(Boolean).join('\n')
          for (const l of String(out ?? '')
            .split('\n')
            .filter((l) => l.trim())
            .slice(-4))
            termLine(l)
        } else if (isEditTool && editTarget()) {
          termLine('✎ ' + path.basename(editTarget()))
        }
        if (hookEvent === 'PostToolUseFailure') {
          // kimi's error payload is `{ code, message, retryable }` plus `name`
          // and `details` when the throw was an Error — a non-Error throw has
          // no `name`, so `message` (always present) is read first
          const err = pick(p, 'error')
          const msg =
            typeof err === 'string' ? err : pickString(err, 'message', 'name', 'code') ?? 'failed'
          termLine(`✗ ${toolName || 'tool'}: ${msg}`)
        }
        emit({ type: 'tool.end', tool: toolName || undefined })
      }
      break
    }

    case 'Stop':
      // kimi's Stop payload is `{ stop_hook_active }` (+ session_title) — it
      // carries no assistant reply, so there is no message.agent to emit.
      endTurn()
      break

    case 'StopFailure': {
      const msg = pickString(p, 'error_message', 'errorMessage', 'error_type', 'errorType')
      if (msg) termLine(`✗ turn failed: ${msg}`)
      endTurn()
      break
    }

    case 'Interrupt':
      // Stop does not fire on a cancelled turn — this IS the turn boundary
      endTurn()
      break

    case 'PreCompact':
      emit({ type: 'thinking.end' })
      emit({ type: 'activity', activity: 'sleeping' }) // compaction nap
      break

    case 'PostCompact':
      emit({ type: 'activity', activity: 'thinking' }) // wake from the nap
      break

    case 'SessionEnd':
      emit({ type: 'session.end' })
      try {
        fs.unlinkSync(stateFile)
      } catch {
        /* already gone */
      }
      if (usedFallback) {
        // the id cache outlives the state file otherwise, and the next id-less
        // session in this directory would inherit a dead session's room
        try {
          fs.unlinkSync(fallbackFile(cwd))
        } catch {
          /* already gone */
        }
      }
      break

    default:
      // UserPromptQueued / PermissionRequest / PermissionResult /
      // SessionHeartbeat / SubagentStart / SubagentStop / TaskStarted /
      // Notification are deliberately unmapped — see README § Event mapping.
      break
  }

  // never resurrect state that SessionEnd deleted
  if (hookEvent !== 'SessionEnd') fs.writeFileSync(stateFile, JSON.stringify(st))

  if (events.length === 0) return
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  // fan out to every server; per server, one ordered POST /events batch
  // (reduced atomically server-side). 404 = pre-batch server → sequential
  // /event fallback, which still preserves order. First failure per server
  // drops the rest of its batch: later events without predecessors are worse
  // than none.
  await Promise.allSettled(
    DEN_URLS.map(async (base) => {
      try {
        const status = await postJson(`${base}/events`, headers, JSON.stringify(events), 1500)
        if (status !== 404) return
      } catch {
        return // server unreachable — retrying event-by-event won't help
      }
      for (const ev of events) {
        await postJson(`${base}/event`, headers, JSON.stringify(ev), 1000)
      }
    }),
  )
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
