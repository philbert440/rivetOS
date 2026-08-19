#!/usr/bin/env node
// Offline ingest: same ingestSession() as the sidecar write tool.
// Usage: node ingest-session.mjs --session-id ID --agent NAME [--persona P] [file]
import { readFileSync } from 'node:fs'
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
    'session-id': { type: 'string' },
    agent: { type: 'string' },
    persona: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(
    'Usage: ingest-session.mjs --session-id <id> --agent <name> [--persona <name>] [file.json|file.jsonl]',
  )
  process.exit(0)
}

const sessionId = values['session-id']
if (!sessionId) {
  console.error('ingest-session: --session-id is required')
  process.exit(2)
}
if (!process.env.RIVETOS_PG_URL) {
  console.error('ingest-session: RIVETOS_PG_URL is required')
  process.exit(1)
}

const file = positionals[0]
const raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
const t = raw.trim()
const parsed = t.startsWith('[')
  ? JSON.parse(t)
  : t.split('\n').filter(Boolean).map((line) => JSON.parse(line))

const root = process.env.RIVETOS_ROOT || '/opt/rivetos'
const memoryMod = await import(
  pathToFileURL(resolve(root, 'node_modules/@rivetos/memory-postgres/dist/index.js')).href
)
const writeMod = await import(
  pathToFileURL(resolve(root, 'services/mcp-sidecar/dist/memory-write.js')).href
)

const memory = new memoryMod.PostgresMemory({
  connectionString: process.env.RIVETOS_PG_URL,
  embedEndpoint: process.env.RIVETOS_EMBED_URL,
  embedModel: process.env.RIVETOS_EMBED_MODEL,
})
try {
  const result = await writeMod.ingestSession(memory, {
    sessionId,
    messages: parsed,
    agent: values.agent || 'grokbot',
    persona: values.persona,
    source: process.env.RIVETOS_MEMORY_SOURCE || 'grokbot',
    channel: process.env.RIVETOS_MEMORY_CHANNEL || 'grokbot',
  })
  console.log(JSON.stringify(result))
} finally {
  await memory.close?.()
}
