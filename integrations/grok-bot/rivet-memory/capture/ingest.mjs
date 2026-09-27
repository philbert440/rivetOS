#!/usr/bin/env node
// Thin ingest wrapper for grokbot capture. Search/browse/stats live in the
// memory tools — this file only writes a session. Never print secrets.
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
    agent: { type: 'string' },
    session: { type: 'string' },
    persona: { type: 'string' },
    'session-id': { type: 'string' },
  },
})

const cmd = positionals[0] || 'help'
if (values.help || cmd === 'help') {
  console.log('Usage: ingest.mjs ingest --session-id ID [--agent NAME] [--persona P] FILE.jsonl')
  process.exit(0)
}

if (cmd === 'search' || cmd === 'browse' || cmd === 'stats') {
  console.error(`capture/ingest: ${cmd} was removed — use memory_search / memory_browse / memory_stats`)
  process.exit(2)
}

if (cmd !== 'ingest') {
  console.error(`capture/ingest: unknown command ${cmd}`)
  process.exit(2)
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

const sessionId = values['session-id'] || values.session
const file = positionals[1]
if (!sessionId || !file) {
  console.error('capture/ingest: ingest needs --session-id and FILE.jsonl')
  process.exit(2)
}

const memoryMod = await import(pathToFileURL(memoryEntry).href)
const memory = new memoryMod.PostgresMemory({
  connectionString: process.env.RIVETOS_PG_URL,
  embedEndpoint: process.env.RIVETOS_EMBED_URL,
  embedModel: process.env.RIVETOS_EMBED_MODEL,
})

try {
  const writeMod = await import(pathToFileURL(writeEntry).href)
  const raw = readFileSync(file, 'utf8').trim()
  const parsed = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const result = await writeMod.ingestSession(memory, {
    sessionId,
    messages: parsed,
    agent: values.agent || 'rivet-grokbot',
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
} finally {
  await memory.close?.()
}
