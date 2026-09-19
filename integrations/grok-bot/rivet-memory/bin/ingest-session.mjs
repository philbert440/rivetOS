#!/usr/bin/env node
// Offline ingest: same ingestSession() as the sidecar write tool.
// Usage: node ingest-session.mjs --session-id ID --agent NAME [--persona P] [file]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

function isUnsetVal(val) {
  return val == null || val === '' || /^\$\{[A-Z0-9_]+\}$/.test(val)
}

function applyDatahubUrl() {
  if (!isUnsetVal(process.env.RIVETOS_PG_URL)) return
  const hub = process.env.RIVETOS_DATAHUB_URL || ''
  if (/^postgres(ql)?:\/\//.test(hub)) process.env.RIVETOS_PG_URL = hub
}

function loadEnv() {
  // Empty plugin-dashboard placeholders and leftover ${VAR} tokens count
  // as unset so ~/.rivetos/.env wins.
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('RIVETOS_') && isUnsetVal(val)) delete process.env[key]
  }
  const p = process.env.RIVETOS_ENV_FILE || resolve(homedir(), '.rivetos/.env')
  try {
    for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const rest = /^export\s+/.test(line) ? line.replace(/^export\s+/, '') : line
      const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (m && isUnsetVal(process.env[m[1]])) {
        let v = m[2]
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
          v = v.slice(1, -1)
        }
        process.env[m[1]] = v
      }
    }
  } catch {
    /* optional */
  }
  applyDatahubUrl()
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
    agent: values.agent || 'rivet-grokbot',
    persona: values.persona,
    source: process.env.RIVETOS_MEMORY_SOURCE || 'grokbot',
    channel: process.env.RIVETOS_MEMORY_CHANNEL || 'grokbot',
  })
  console.log(JSON.stringify(result))
} finally {
  await memory.close?.()
}
