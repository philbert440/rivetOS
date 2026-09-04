#!/usr/bin/env node
/**
 * hooks — Claude Code lifecycle-hook handler for real-time transcript capture.
 *
 * Claude Code fires lifecycle hooks during a session and passes a JSON payload
 * on stdin (`hook_event_name`, `session_id`, `transcript_path`, `cwd`, ...).
 * This handler is wired into two families of events. Transcript events
 * (Stop / SubagentStop / SessionEnd) re-parse the JSONL transcript for
 * assistant text. Payload events (UserPromptSubmit / PostToolUse) capture the
 * prompt or tool call straight from the stdin payload — the only path that
 * works for RivetOS agent sessions, which run claude with no usable
 * transcript. Either way, capture happens as it happens, with no dependency
 * on Claude Code's transcript retention window.
 *
 * Latency: a Stop hook runs inline and would otherwise add its full runtime
 * to the user's session. So the hook invocation does almost nothing — it
 * spools the payload to a temp file, spawns a detached worker copy of itself,
 * and exits 0 in single-digit milliseconds. The worker does the DB write out
 * of band. The handler NEVER exits non-zero and never blocks: a capture
 * failure must not disrupt the user's Claude Code session.
 *
 * Modes:
 *   (default)            — hook mode: read stdin payload, detach a worker, exit
 *   --worker <file>      — worker mode: ingest the spooled payload, then exit
 *   --install            — register the hooks in ~/.claude/settings.json
 *   --uninstall          — remove them again
 *   --status             — print whether the hooks are installed
 *
 * All capture activity is appended to ~/.rivetos/claude-capture.log.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ingestTranscript,
  ingestHookEvent,
  resolveTaskContext,
  LEGACY_TASK_KEY_PREFIX,
} from './transcript-capture.js'

const SELF = fileURLToPath(import.meta.url)
const LOG_FILE = path.join(os.homedir(), '.rivetos', 'claude-capture.log')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-claude-hook')
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json')

/**
 * Lifecycle events we capture on, in two families:
 *
 *  - TRANSCRIPT_EVENTS — fire at turn/session boundaries and carry a
 *    `transcript_path`. The worker re-parses the transcript and ingests
 *    assistant text/reasoning. Stop covers main-thread turns; SubagentStop
 *    covers sidechain transcripts; SessionEnd does a final flush + marks the
 *    conversation inactive.
 *
 *  - PAYLOAD_EVENTS — fire per prompt / per tool call and carry the captured
 *    data inline on stdin (prompt, tool_name, tool_input, tool_response). No
 *    transcript read needed — this is the only path that works for RivetOS
 *    agent sessions, which run claude in stream-json mode with no transcript.
 */
const TRANSCRIPT_EVENTS = ['Stop', 'SubagentStop', 'SessionEnd'] as const
const PAYLOAD_EVENTS = ['UserPromptSubmit', 'PostToolUse'] as const
const CAPTURE_EVENTS = [...TRANSCRIPT_EVENTS, ...PAYLOAD_EVENTS] as const

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    /* logging must never throw */
  }
}

// ---------------------------------------------------------------------------
// Hook payload
// ---------------------------------------------------------------------------

interface HookPayload {
  hook_event_name?: string
  session_id?: string
  /**
   * Stamped into the spool at hook time from RIVETOS_SESSION_KEY (den
   * terminals set it to the den session id; task executors used to set
   * `task:<taskId>` — deprecated, still honored). Carried in the payload rather
   * than re-read in the worker so the detached worker never depends on env
   * inheritance.
   */
  rivetos_session_key?: string
  /**
   * Stamped from RIVETOS_TASK_ID — the task that spawned this CLI session.
   * Recorded as the conversation's task association; unlike the key override it
   * does not change where the turns are written.
   */
  rivetos_task_id?: string
  /**
   * herdr pane identity (HERDR_PANE_ID / HERDR_WORKSPACE_ID), stamped at hook
   * time when the session runs inside a herdr pane. Carried in the spool for
   * the same reason as rivetos_session_key: the detached worker must not
   * depend on env inheritance. Merged into message metadata so the federated
   * view can join captured messages to pane/workspace/host.
   */
  herdr_pane_id?: string
  herdr_workspace_id?: string
  herdr_host?: string
  transcript_path?: string
  cwd?: string
  reason?: string
  model?: string
  /** UserPromptSubmit */
  prompt?: string
  /** PostToolUse */
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  tool_result?: unknown
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------------------
// Hook mode — spool payload, detach worker, exit fast
// ---------------------------------------------------------------------------

async function runHook(): Promise<void> {
  let payload: HookPayload
  try {
    payload = JSON.parse(await readStdin()) as HookPayload
  } catch {
    return // malformed payload — nothing to do, never fail the session
  }
  // A payload event needs a session_id; a transcript event needs a path.
  // Anything with neither carries nothing to capture.
  if (!payload.session_id && !payload.transcript_path) return

  // Hooks run inside the spawned CLI's env, so this is where the
  // task↔conversation association is captured. Stamped into the spool because
  // the detached worker does not inherit this env.
  const task = resolveTaskContext(process.env)
  if (task.sessionKeyOverride) payload.rivetos_session_key = task.sessionKeyOverride
  if (task.taskId) payload.rivetos_task_id = task.taskId

  // Same spool-stamping for herdr pane identity (present only when herdr
  // launched this pane).
  if (process.env.HERDR_ENV === '1' && process.env.HERDR_PANE_ID) {
    payload.herdr_pane_id = process.env.HERDR_PANE_ID
    if (process.env.HERDR_WORKSPACE_ID) payload.herdr_workspace_id = process.env.HERDR_WORKSPACE_ID
    payload.herdr_host = os.hostname()
  }

  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const spoolFile = path.join(
      SPOOL_DIR,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    )
    fs.writeFileSync(spoolFile, JSON.stringify(payload))
    const child = spawn(process.execPath, [SELF, '--worker', spoolFile], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (err) {
    log(`hook spool failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Worker mode — ingest the spooled payload out of band
// ---------------------------------------------------------------------------

async function runWorker(spoolFile: string): Promise<void> {
  let payload: HookPayload
  try {
    payload = JSON.parse(fs.readFileSync(spoolFile, 'utf8')) as HookPayload
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log(`worker: unreadable spool ${spoolFile}: ${detail}`)
    return
  } finally {
    fs.rm(spoolFile, { force: true }, () => undefined)
  }

  const event = payload.hook_event_name ?? 'unknown'

  // Deprecation window: a `task:<id>` write-key override means this spawn came
  // from an executor that predates the task-association migration (a task
  // in-flight across a rolling deploy). Honor it — splitting a live task's
  // transcript mid-run is worse than one more row in the legacy namespace —
  // but say so, out of band, where it costs the session nothing.
  if (payload.rivetos_session_key?.startsWith(LEGACY_TASK_KEY_PREFIX)) {
    log(
      `DEPRECATED RIVETOS_SESSION_KEY=${payload.rivetos_session_key} — task spawns should set ` +
        `RIVETOS_TASK_ID and let capture write the canonical session key; honoring the ` +
        `override for this ingest`,
    )
  }

  // herdr pane identity, if the hook spooled it (session runs in a herdr pane).
  const herdr = payload.herdr_pane_id
    ? {
        paneId: payload.herdr_pane_id,
        workspaceId: payload.herdr_workspace_id,
        host: payload.herdr_host,
      }
    : undefined

  // Payload events (UserPromptSubmit / PostToolUse) — ingest straight from
  // the stdin payload; no transcript involved.
  if ((PAYLOAD_EVENTS as readonly string[]).includes(event)) {
    try {
      const res = await ingestHookEvent({
        payload,
        sessionKeyOverride: payload.rivetos_session_key,
        taskId: payload.rivetos_task_id,
        herdr,
      })
      if (res.skipped) {
        log(`${event} ${res.sessionKey}: skipped (${res.skipped})`)
      } else {
        log(
          `${event} ${res.sessionKey}: ${res.created ? 'created' : 'updated'} conv ` +
            `${res.conversationId} — +${res.inserted} msg`,
        )
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log(`${event} ${payload.session_id ?? '?'}: INGEST FAILED — ${detail}`)
    }
    return
  }

  // Transcript events (Stop / SubagentStop / SessionEnd) — re-parse the
  // transcript for assistant text/reasoning.
  const transcript = payload.transcript_path
  if (!transcript) return

  try {
    const res = await ingestTranscript({
      transcriptPath: transcript,
      sessionId: payload.session_id,
      sessionKeyOverride: payload.rivetos_session_key,
      taskId: payload.rivetos_task_id,
      herdr,
      event,
      markInactive: event === 'SessionEnd',
    })
    if (res.skipped) {
      log(`${event} ${res.sessionKey}: skipped (${res.skipped})`)
    } else {
      log(
        `${event} ${res.sessionKey}: ${res.created ? 'created' : 'updated'} conv ` +
          `${res.conversationId} — +${res.inserted} msg (had ${res.alreadyStored})`,
      )
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log(`${event} ${transcript}: INGEST FAILED — ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// Install / uninstall — manage ~/.claude/settings.json
// ---------------------------------------------------------------------------

interface HookCommand {
  type: string
  /** Optional because entries read back from settings.json are untrusted. */
  command?: string
  timeout?: number
}
interface HookMatcher {
  matcher?: string
  /** Optional because entries read back from settings.json are untrusted. */
  hooks?: HookCommand[]
}
type HooksConfig = Record<string, HookMatcher[]>

/** Our hook entries are recognised by this substring in the command. */
const HOOK_MARKER = 'claude-cli/dist/hooks.js'

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
}

/** Drop any previously-installed RivetOS capture entries from an event list. */
function stripOurs(entries: HookMatcher[] | undefined): HookMatcher[] {
  if (!Array.isArray(entries)) return []
  return entries
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !h.command?.includes(HOOK_MARKER)) }))
    .filter((e) => e.hooks.length > 0)
}

function runInstall(): void {
  const settings = readSettings()
  const hooks = (settings.hooks as HooksConfig | undefined) ?? {}
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(SELF)}`

  for (const event of CAPTURE_EVENTS) {
    const cleaned = stripOurs(hooks[event])
    cleaned.push({ hooks: [{ type: 'command', command, timeout: 10 }] })
    hooks[event] = cleaned
  }
  settings.hooks = hooks
  writeSettings(settings)
  console.log(`Installed RivetOS capture hooks for: ${CAPTURE_EVENTS.join(', ')}`)
  console.log(`  settings: ${SETTINGS_FILE}`)
  console.log(`  command:  ${command}`)
  console.log(`  log:      ${LOG_FILE}`)
}

function runUninstall(): void {
  const settings = readSettings()
  const hooks = settings.hooks as HooksConfig | undefined
  if (!hooks) {
    console.log('No hooks configured — nothing to remove.')
    return
  }
  for (const event of CAPTURE_EVENTS) {
    const cleaned = stripOurs(hooks[event])
    if (cleaned.length > 0) hooks[event] = cleaned
    else Reflect.deleteProperty(hooks, event)
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks
  writeSettings(settings)
  console.log('Removed RivetOS capture hooks.')
}

function runStatus(): void {
  const hooks = (readSettings().hooks as HooksConfig | undefined) ?? {}
  let installed = 0
  for (const event of CAPTURE_EVENTS) {
    const has = (hooks[event] ?? []).some((e) =>
      (e.hooks ?? []).some((h) => h.command?.includes(HOOK_MARKER)),
    )
    if (has) installed++
    console.log(`  ${event}: ${has ? 'installed' : 'not installed'}`)
  }
  console.log(installed === CAPTURE_EVENTS.length ? 'Capture hooks active.' : 'Capture incomplete.')
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--worker') {
    if (argv[1]) await runWorker(argv[1])
    return
  }
  if (argv[0] === '--install') return runInstall()
  if (argv[0] === '--uninstall') return runUninstall()
  if (argv[0] === '--status') return runStatus()
  await runHook()
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // A hook must never surface a non-zero exit to the Claude Code session.
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    process.exit(0)
  })
