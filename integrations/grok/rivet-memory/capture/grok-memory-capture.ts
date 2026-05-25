#!/usr/bin/env node
/**
 * Grok Memory Capture — production-ready capture for RivetOS memory from Grok Build.
 *
 * This module is designed to be invoked from Grok's hook system.
 *
 * Usage patterns:
 *   - From Grok hooks: node .../grok-memory-capture.ts --hook <event-name>
 *     (hook payload is read from stdin, like Claude Code hooks)
 *
 *   - Worker mode (internal): node .../grok-memory-capture.ts --worker <spool-file>
 *
 * Design:
 * - Extremely fast on the hot path: spool + detach worker, exit immediately.
 * - Worker does the actual DB work out of band.
 * - Supports rich events: turns, tool calls, pre-compaction bulk, delegations, session end.
 * - Reuses the same insert patterns and idempotency as the Claude capture.
 * - Best effort: never throws to the calling Grok session.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

// ---------------------------------------------------------------------------
// Constants (must match other Rivet agents)
// ---------------------------------------------------------------------------
export const CAPTURE_AGENT = 'rivet-grok'
export const CAPTURE_CHANNEL = 'grok-build'

const LOG_FILE = path.join(os.homedir(), '.rivetos', 'grok-memory-capture.log')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-grok-capture')
const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 15000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HookPayload {
  hook_event_name?: string
  session_id?: string
  prompt?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  tool_result?: unknown
  messages?: Array<{ role: string; content: string }>
  // Grok-specific fields can be added here
}

interface CaptureOp {
  kind: 'turn' | 'tool' | 'pre_compact' | 'session_end'
  sessionKey: string
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Logging (never throws)
// ---------------------------------------------------------------------------
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Env / DB helpers (adapted from Claude capture)
// ---------------------------------------------------------------------------
function resolvePgUrl(): string {
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {}
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
}

function trunc(s: string | null | undefined): string | null {
  if (!s) return null
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + '\n…[truncated]' : s
}

function deriveSessionKey(sessionId: string): string {
  return `grok-build:${sessionId}`
}

// ---------------------------------------------------------------------------
// DB primitives (adapted from transcript-capture.ts)
// ---------------------------------------------------------------------------
async function findOrCreateConversation(
  client: PoolClient,
  sessionKey: string,
  init: { title: string; settings: Record<string, unknown>; active: boolean }
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
    [sessionKey, CAPTURE_AGENT]
  )
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const conv = await client.query<{ id: string }>(
    `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     RETURNING id`,
    [
      sessionKey,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      init.title.slice(0, 120),
      JSON.stringify(init.settings),
      init.active,
    ]
  )
  return { id: conv.rows[0].id, created: true }
}

async function insertMessage(
  client: PoolClient,
  conversationId: string,
  m: {
    role: string
    content: string
    toolName?: string | null
    toolArgs?: unknown
    toolResult?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      conversationId,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      m.role,
      m.content,
      m.toolName ?? null,
      m.toolArgs != null ? JSON.stringify(m.toolArgs) : null,
      m.toolResult ?? null,
      JSON.stringify(m.metadata ?? {}),
    ]
  )
}

// ---------------------------------------------------------------------------
// Hot path: Enqueue (very fast, non-blocking)
// ---------------------------------------------------------------------------
export function enqueue(op: CaptureOp): void {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const spoolFile = path.join(SPOOL_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
    fs.writeFileSync(spoolFile, JSON.stringify(op))

    const self = process.argv[1] ?? import.meta.url.replace('file://', '')
    const child = spawn(process.execPath, [self, '--worker'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (err) {
    log(`enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Worker: actual DB work
// ---------------------------------------------------------------------------
async function processOp(op: CaptureOp): Promise<void> {
  const pgUrl = resolvePgUrl()
  const pool = new Pool({ connectionString: pgUrl, max: 1 })
  const client = await pool.connect()

  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('BEGIN')

    const sessionKey = op.sessionKey
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])

    const settings = { source: 'grok-hook', event: op.kind, ...op.payload }

    if (op.kind === 'turn') {
      const { user, assistant, title } = op.payload as any
      const conv = await findOrCreateConversation(client, sessionKey, {
        title: title || 'Grok Build session',
        settings,
        active: true,
      })

      if (user) {
        await insertMessage(client, conv.id, { role: 'user', content: trunc(user) ?? '', metadata: { source: 'grok-hook' } })
      }
      if (assistant) {
        await insertMessage(client, conv.id, { role: 'assistant', content: trunc(assistant) ?? '', metadata: { source: 'grok-hook' } })
      }
    } else if (op.kind === 'tool') {
      const { tool_name, tool_input, tool_result } = op.payload as any
      const conv = await findOrCreateConversation(client, sessionKey, {
        title: `Grok tool: ${tool_name}`,
        settings,
        active: true,
      })
      await insertMessage(client, conv.id, {
        role: 'tool',
        content: `[tool] ${tool_name}`,
        toolName: tool_name,
        toolArgs: tool_input,
        toolResult: trunc(tool_result),
        metadata: { source: 'grok-hook' },
      })
    } else if (op.kind === 'pre_compact') {
      const messages = (op.payload.messages as any[]) || []
      const conv = await findOrCreateConversation(client, sessionKey, {
        title: 'Grok session (pre-compact)',
        settings,
        active: true,
      })
      for (const m of messages) {
        if (m.content) {
          await insertMessage(client, conv.id, {
            role: m.role || 'system',
            content: trunc(m.content) ?? '',
            metadata: { source: 'grok-pre-compact' },
          })
        }
      }
    } else if (op.kind === 'session_end') {
      // Mark conversation inactive
      await client.query(
        `UPDATE ros_conversations SET active = false, updated_at = now() WHERE session_key = $1 AND agent = $2 AND active = true`,
        [sessionKey, CAPTURE_AGENT]
      )
    }

    await client.query('COMMIT')
    log(`${op.kind} ${sessionKey}: captured`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log(`processOp ${op.kind} failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    client.release()
    await pool.end()
  }
}

async function runWorker(spoolFile?: string) {
  const files = spoolFile
    ? [spoolFile]
    : fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SPOOL_DIR, f))

  for (const file of files) {
    try {
      const op = JSON.parse(fs.readFileSync(file, 'utf8')) as CaptureOp
      await processOp(op)
      fs.unlinkSync(file)
    } catch (e) {
      log(`worker failed on ${file}: ${e}`)
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint (for hooks and worker)
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)

  if (args[0] === '--worker') {
    await runWorker(args[1])
    return
  }

  // Hook mode — read payload from stdin (Grok hook contract)
  if (args[0] === '--hook') {
    const event = args[1] || 'unknown'
    let payload: HookPayload = {}
    try {
      const input = await new Promise<string>((resolve) => {
        let data = ''
        process.stdin.on('data', chunk => (data += chunk))
        process.stdin.on('end', () => resolve(data))
      })
      if (input.trim()) payload = JSON.parse(input)
    } catch {}

    const sessionId = payload.session_id || 'unknown-' + Date.now()
    const sessionKey = deriveSessionKey(sessionId)

    let kind: CaptureOp['kind'] = 'turn'
    if (event.includes('Tool') || event.includes('tool')) kind = 'tool'
    if (event.includes('Compact') || event.includes('compact')) kind = 'pre_compact'
    if (event.includes('End') || event.includes('end')) kind = 'session_end'

    enqueue({ kind, sessionKey, payload: { ...payload, hook_event_name: event } as any })
    process.exit(0) // always succeed fast
  }

  console.log('Usage: node grok-memory-capture.ts --hook <event>  |  --worker [file]')
}

main().catch(err => {
  log(`fatal: ${err}`)
  process.exit(0) // never fail the caller
})
