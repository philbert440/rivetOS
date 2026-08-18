#!/usr/bin/env node
// Offline JSON/JSONL ingest into Rivet memory as source=grokbot.
// Usage: node ingest-session.mjs --session-id ID --agent NAME [--persona P] [file]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
function loadEnv() {
  const p = process.env.RIVETOS_ENV_FILE || resolve(homedir(), '.rivetos/.env')
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    /* optional */
  }
}
loadEnv()

function arg(flag, fallback = '') {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] || '' : fallback
}

const sessionId = arg('--session-id')
const agent = arg('--agent', process.env.RIVETOS_MEMORY_AGENT || 'grokbot')
const persona = arg('--persona', process.env.RIVETOS_MEMORY_PERSONA || '')
const file = process.argv.filter((a) => !a.startsWith('--') && a !== process.argv[1] && a !== process.execPath).at(-1)
if (!sessionId) {
  console.error('ingest-session: --session-id is required')
  process.exit(2)
}
if (!process.env.RIVETOS_PG_URL) {
  console.error('ingest-session: RIVETOS_PG_URL is required')
  process.exit(1)
}

const raw = file && !file.endsWith('ingest-session.mjs') ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
const t = raw.trim()
const messages = t.startsWith('[') ? JSON.parse(t) : t.split('\n').filter(Boolean).map((l) => JSON.parse(l))
if (!messages.length) {
  console.error('ingest-session: no messages')
  process.exit(2)
}

const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: process.env.RIVETOS_PG_URL })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const conv = await client.query(
    `INSERT INTO ros_conversations (session_key, agent, channel, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (session_key, agent) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [sessionId, agent, 'grokbot', `grokbot:${sessionId}`.slice(0, 120)],
  )
  const conversationId = conv.rows[0].id
  let n = 0
  for (const [i, m] of messages.entries()) {
    const role = m.role || 'assistant'
    const content = m.content || ''
    if (!content) continue
    const metadata = { source: 'grokbot', ordinal: i }
    if (persona) metadata.persona = persona
    await client.query(
      `INSERT INTO ros_messages (conversation_id, agent, channel, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [conversationId, agent, 'grokbot', role, content, JSON.stringify(metadata)],
    )
    n += 1
  }
  await client.query('COMMIT')
  console.log(JSON.stringify({ session_id: sessionId, ingested: n, agent, persona: persona || null, source: 'grokbot' }))
} catch (err) {
  await client.query('ROLLBACK')
  throw err
} finally {
  client.release()
  await pool.end()
}
