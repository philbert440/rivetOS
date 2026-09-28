#!/usr/bin/env node
// Offline ingest: grok-bot's own writer (ordinal, event id, tool_result).
// Usage: node ingest-session.mjs --session-id ID --agent NAME [--persona P] [file]
// capture/ingest.mjs is a thin wrapper over this file (ingest subcommand).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { isUnsetVal, parseRivetEnv } from './env-parse.mjs'

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
    const parsed = parseRivetEnv(readFileSync(p, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) {
      if (isUnsetVal(process.env[key])) process.env[key] = value
    }
  } catch {
    /* optional */
  }
  applyDatahubUrl()
}

export async function runIngest(argv = process.argv.slice(2)) {
  loadEnv()
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'session-id': { type: 'string' },
      session: { type: 'string' },
      agent: { type: 'string' },
      persona: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    console.log(
      'Usage: ingest-session.mjs --session-id <id> --agent <name> [--persona <name>] [file.json|file.jsonl]',
    )
    return 0
  }

  const sessionId = values['session-id'] || values.session
  if (!sessionId) {
    console.error('ingest-session: --session-id is required')
    return 2
  }
  if (!process.env.RIVETOS_PG_URL) {
    console.error('ingest-session: RIVETOS_PG_URL is required')
    return 1
  }

  const file = positionals[0]
  const raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  const t = raw.trim()
  const parsed = t.startsWith('[')
    ? JSON.parse(t)
    : t.split('\n').filter(Boolean).map((line) => JSON.parse(line))

  const root = process.env.RIVETOS_ROOT || '/opt/rivetos'
  const here = dirname(fileURLToPath(import.meta.url))
  const memoryEntry = resolve(root, 'node_modules/@rivetos/memory-postgres/dist/index.js')
  const writerEntry = resolve(here, '../capture/dist/ingest-rows.js')
  if (!existsSync(memoryEntry) || !existsSync(writerEntry)) {
    console.error(
      [
        'ingest-session: RivetOS memory package or the grok-bot ingest writer is missing.',
        '  need @rivetos/memory-postgres under RIVETOS_ROOT and capture/dist/ingest-rows.js',
        '  (npx nx build @rivetos/grok-bot-rivet-memory-capture)',
      ].join('\n'),
    )
    return 4
  }

  const memoryMod = await import(pathToFileURL(memoryEntry).href)
  const writer = await import(pathToFileURL(writerEntry).href)

  const memory = new memoryMod.PostgresMemory({
    connectionString: process.env.RIVETOS_PG_URL,
    embedEndpoint: process.env.RIVETOS_EMBED_URL,
    embedModel: process.env.RIVETOS_EMBED_MODEL,
  })
  try {
    const result = await writer.ingestGrokbotSession(memory, {
      sessionId,
      messages: parsed,
      agent: values.agent || process.env.RIVETOS_MEMORY_AGENT || 'grokbot',
      persona: values.persona,
      source: process.env.RIVETOS_MEMORY_SOURCE || 'grokbot',
      channel: process.env.RIVETOS_MEMORY_CHANNEL || 'grokbot',
    })
    console.log(JSON.stringify(result))
  } finally {
    await memory.close?.()
  }
  return 0
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invoked) {
  process.exitCode = await runIngest()
}
