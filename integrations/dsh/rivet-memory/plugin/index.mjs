/**
 * @rivetos/dsh-rivet-memory
 *
 * Cordis plugin for DeepSeek Harness. Listens to the official post-commit
 * session/event firehose and spools user/assistant/tool turns into the
 * RivetOS memory store under agent=rivet-deepseek.
 *
 * dsh has no Claude/kimi-style hooks. This is the hook analogue.
 * Best-effort: never throw from a session/event listener.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'rivet-memory'
export const inject = ['sessions']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CAPTURE = path.resolve(HERE, '..', 'capture', 'deepseek-memory-capture.mjs')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-deepseek-capture')
const INTERESTING = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/end',
  'compaction/start',
  'session/title',
])

function sessionIdOf(session) {
  try {
    return session?.id || session?.header?.id || null
  } catch {
    return null
  }
}

function cwdOf(session) {
  try {
    return session?.header?.cwd || session?.cwd || null
  } catch {
    return null
  }
}

function sessionJsonlPathOf(session) {
  try {
    const hinted =
      session?.logPath ||
      session?.file ||
      session?.path ||
      session?.header?.logPath ||
      session?.persistencePath
    // dsh names its transcript `session.v4.jsonl.zstd`; a bare `session.jsonl`
    // substring test drops the pointer and disables disk-backed recovery.
    if (typeof hinted === 'string' && /session(\.[a-z0-9]+)?\.jsonl/.test(hinted)) return hinted
  } catch {
    // ignore
  }
  return null
}

const EVENT_ENTRY = 'event'
const RECONCILE_ENTRY = 'reconcile'

/**
 * Spool one capture operation for a detached worker.
 *
 * The spool is written with 0600 because payloads carry prompts and tool
 * output. A failure here must not reach the session append path.
 */
function spool(session, op) {
  if (!fs.existsSync(CAPTURE)) return
  fs.mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 })
  const spoolFile = path.join(
    SPOOL_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  )
  fs.writeFileSync(spoolFile, JSON.stringify(op), { mode: 0o600 })
  const child = spawn(process.execPath, [CAPTURE, '--worker', spoolFile], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || !INTERESTING.has(event.type)) return
      const sessionId = sessionIdOf(session)
      if (!sessionId) return
      const sessionJsonlPath = sessionJsonlPathOf(session)

      spool(session, {
        kind: EVENT_ENTRY,
        sessionId,
        cwd: cwdOf(session),
        event,
        finalize: event.type === 'turn/end',
        sessionJsonlPath,
      })

      // Turn end is the reconcile point: the live event stream can miss rows
      // when a listener drops or a worker dies, and the transcript is the
      // complete record. This mirrors Claude Code's Stop/SessionEnd pass, so a
      // missed live event self-heals on the next turn boundary instead of
      // leaving a permanent hole in the conversation.
      if (event.type === 'turn/end') {
        spool(session, {
          kind: RECONCILE_ENTRY,
          sessionId,
          cwd: cwdOf(session),
          sessionJsonlPath,
        })
      }
    } catch {
      // never break the session append path
    }
  })
}
