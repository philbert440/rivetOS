#!/usr/bin/env node
// Thin wrapper over bin/ingest-session.mjs. Search/browse/stats live in the
// memory tools — this file only writes a session. Never print secrets.
import { parseArgs } from 'node:util'
import { runIngest } from '../bin/ingest-session.mjs'

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

const file = positionals[1]
const forwarded = []
if (values['session-id'] || values.session) {
  forwarded.push(`--session-id=${values['session-id'] || values.session}`)
}
if (values.agent) forwarded.push(`--agent=${values.agent}`)
if (values.persona) forwarded.push(`--persona=${values.persona}`)
if (file) forwarded.push(file)

process.exitCode = await runIngest(forwarded)
