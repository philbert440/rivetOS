#!/usr/bin/env node
// Thin ingest wrapper for grokbot capture. Never print secrets.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

function loadEnv() {
  const p = process.env.RIVETOS_ENV_FILE || resolve(homedir(), '.rivetos/.env')
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] == null) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {
    /* optional */
  }
}
loadEnv()

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    query: { type: 'string', short: 'q' },
    agent: { type: 'string' },
    session: { type: 'string' },
    limit: { type: 'string' },
    scope: { type: 'string' },
    persona: { type: 'string' },
    'session-id': { type: 'string' },
  },
})

const cmd = positionals[0] || 'help'
if (values.help || cmd === 'help') {
  console.log(
    [
      'Usage: ingest.mjs <search|browse|stats|ingest> [opts]',
      '  search  --query TEXT [--agent NAME] [--limit N] [--scope messages|summaries|both]',
      '  browse  --session KEY [--limit N]',
      '  stats   [--agent NAME]',
      '  ingest  --session-id ID [--agent NAME] [--persona P] FILE.jsonl',
    ].join('\n'),
  )
  process.exit(0)
}

if (!process.env.RIVETOS_PG_URL) {
  console.error('capture/ingest: RIVETOS_PG_URL is required')
  process.exit(1)
}

const root = process.env.RIVETOS_ROOT || '/opt/rivetos'

const memoryEntry = resolve(root, 'node_modules/@rivetos/memory-postgres/dist/index.js')
const writeEntry = resolve(root, 'services/mcp-sidecar/dist/memory-write.js')
if (!existsSync(memoryEntry) || !existsSync(writeEntry)) {
  console.error(
    [
      'capture/ingest: RivetOS memory packages not found on this node.',
      '  need memory package + memory-write under RIVETOS_ROOT',
    ].join('\n'),
  )
  process.exit(4)
}

const memoryMod = await import(pathToFileURL(memoryEntry).href)
const memory = new memoryMod.PostgresMemory({
  connectionString: process.env.RIVETOS_PG_URL,
  embedEndpoint: process.env.RIVETOS_EMBED_URL,
  embedModel: process.env.RIVETOS_EMBED_MODEL,
})

const limit = Math.min(50, Math.max(1, Number(values.limit || 12) || 12))
const agent = values.agent || 'rivet-grokbot'

try {
  if (cmd === 'search') {
    const query = values.query || positionals.slice(1).join(' ')
    if (!query) {
      console.error('capture/ingest: search needs --query')
      process.exit(2)
    }
    const hits = await memory.search(query, {
      agent: values.agent,
      limit,
      scope: values.scope || 'both',
    })
    console.log(
      JSON.stringify(
        hits.map((h) => ({
          id: h.id,
          agent: h.agent,
          role: h.role,
          score: h.relevanceScore,
          createdAt: h.createdAt,
          content: String(h.content || '').slice(0, 500),
        })),
      ),
    )
  } else if (cmd === 'browse') {
    const session = values.session || values['session-id']
    if (!session) {
      console.error('capture/ingest: browse needs --session')
      process.exit(2)
    }
    const rows = await memory.getSessionHistory(session, { limit })
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          role: r.role,
          content: String(r.content || '').slice(0, 500),
        })),
      ),
    )
  } else if (cmd === 'stats') {
    const pool = memory.getPool()
    const r = await pool.query(
      `SELECT c.session_key, c.agent, c.channel, count(m.id)::int AS n, max(m.created_at) AS last_at
       FROM ros_conversations c
       LEFT JOIN ros_messages m ON m.conversation_id = c.id
       WHERE ($1::text IS NULL OR c.agent = $1)
       GROUP BY 1, 2, 3
       ORDER BY last_at DESC NULLS LAST
       LIMIT $2`,
      [values.agent || null, limit],
    )
    console.log(JSON.stringify(r.rows))
  } else if (cmd === 'ingest') {
    const sessionId = values['session-id'] || values.session
    const file = positionals[1]
    if (!sessionId || !file) {
      console.error('capture/ingest: ingest needs --session-id and FILE.jsonl')
      process.exit(2)
    }
    const writeMod = await import(pathToFileURL(writeEntry).href)
    const raw = readFileSync(file, 'utf8').trim()
    const parsed = raw.startsWith('[')
      ? JSON.parse(raw)
      : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const result = await writeMod.ingestSession(memory, {
      sessionId,
      messages: parsed,
      agent,
      persona: values.persona,
      source: process.env.RIVETOS_MEMORY_SOURCE || 'grokbot',
      channel: process.env.RIVETOS_MEMORY_CHANNEL || 'grokbot',
    })
    console.log(
      JSON.stringify({
        session_id: result.session_id,
        ingested: result.ingested,
        skipped: result.skipped,
        agent: result.agent,
        channel: result.channel,
        persona: result.persona,
      }),
    )
  } else {
    console.error(`capture/ingest: unknown command ${cmd}`)
    process.exit(2)
  }
} finally {
  await memory.close?.()
}
