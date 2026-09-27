#!/usr/bin/env node
/**
 * Grok Bot capture CLI — convert, backfill, reclean, compare, discover.
 * Never prints secrets, hostnames, or connection strings.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareInput, formatCompareTable, formatNoiseBreakdown } from './compare.js'
import { discoverModels, identityFor } from './identity.js'
import { normalizeRecords, toIngestRows } from './normalize.js'
import { parseInput } from './parse.js'
import {
  EXISTING_ROWS_SQL,
  loadStoredRowsJson,
  printRecleanStats,
  recleanFromSource,
  recleanStoredRows,
  v3Session,
} from './reclean.js'
import { SESSION_SUFFIX_V3 } from './types.js'

const HELP = `Usage: grokbot-rivet-memory-capture <command> [opts]

  convert SRC DST [--agent-id UUID] [--session KEY] [--agent NAME]
      Normalize one on-disk jsonl or ReadTranscript page to ingest jsonl.

  backfill --input PATH [--format auto|ondisk|page] [--agent-id UUID]
           [--session-suffix -v3] [--out DIR] [--write]
      Walk a file or directory of transcripts/pages through the normalizer.
      --write emits ingest jsonl under --out (default ./spool). Dry by default.

  reclean [--session KEY] [--agent-id UUID] [--from-transcript FILE]
          [--from-rows FILE] [--pg-url URL] [--out DIR] [--dry-run|--write]
      Re-clean existing grokbot rows or source transcripts into <session>-v3.
      --dry-run (default) performs zero writes and prints stats.

  compare [--fixtures DIR]
      Before (legacy convert-transcript + pull-bridge) vs after (normalizer).

  discover [--agents-dir DIR] [--models FILE] [--json]
`

function main(argv: string[]): number {
  const cmd = argv[0]
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP)
    return 0
  }
  if (cmd === 'convert') return cmdConvert(argv.slice(1))
  if (cmd === 'backfill') return cmdBackfill(argv.slice(1))
  if (cmd === 'reclean') return cmdReclean(argv.slice(1))
  if (cmd === 'compare') return cmdCompare(argv.slice(1))
  if (cmd === 'discover') return cmdDiscover(argv.slice(1))
  console.error(`unknown command: ${cmd}`)
  console.log(HELP)
  return 2
}

function cmdConvert(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'agent-id': { type: 'string' },
      session: { type: 'string' },
      agent: { type: 'string' },
      format: { type: 'string' },
    },
  })
  const src = positionals[0]
  const dst = positionals[1]
  if (!src || !dst) {
    console.error('convert needs SRC DST')
    return 2
  }
  const ident = resolveIdent(values['agent-id'], values.session, values.agent)
  const text = readFileSync(src, 'utf8')
  const parsed = parseInput(
    text,
    values.format === 'page' || values.format === 'ondisk' ? values.format : undefined,
  )
  const result = normalizeRecords(parsed.records, {
    sessionKey: ident.session,
    agent: ident.agent,
    agentId: ident.id,
    persona: ident.persona,
    format: parsed.format,
    startPosition: parsed.header?.a ?? 0,
  })
  mkdirSync(dirname(resolve(dst)), { recursive: true })
  writeFileSync(
    dst,
    result.messages.map((m) => JSON.stringify(toIngestRows([m])[0])).join('\n') +
      (result.messages.length ? '\n' : ''),
  )
  console.log(
    JSON.stringify({
      in: result.stats.in,
      out: result.stats.out,
      dropped: result.stats.dropped,
      system_events: result.stats.systemEvents,
      time_known: result.stats.timeKnown,
      last_known: result.stats.lastKnownTime ?? null,
    }),
  )
  if (!result.stats.timeKnown) {
    console.error('created_at: unset (no timestamp in source; DB default on ingest)')
  }
  return 0
}

function cmdBackfill(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      format: { type: 'string' },
      'agent-id': { type: 'string' },
      'session-suffix': { type: 'string', default: SESSION_SUFFIX_V3 },
      out: { type: 'string', default: 'spool' },
      write: { type: 'boolean', default: false },
    },
  })
  if (!values.input) {
    console.error('backfill needs --input PATH')
    return 2
  }
  const files = listInputs(values.input)
  const suffix = values['session-suffix'] || SESSION_SUFFIX_V3
  const outDir = values.out || 'spool'
  if (values.write) mkdirSync(outDir, { recursive: true })
  let n = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const parsed = parseInput(
      text,
      values.format === 'page' || values.format === 'ondisk' ? values.format : undefined,
    )
    const id = values['agent-id'] ?? parsed.header?.id
    const ident = resolveIdent(id, undefined, undefined)
    const session = ident.session.endsWith(suffix) ? ident.session : ident.session + suffix
    const result = normalizeRecords(parsed.records, {
      sessionKey: session,
      agent: ident.agent,
      agentId: ident.id || id,
      persona: ident.persona,
      format: parsed.format,
      startPosition: parsed.header?.a ?? 0,
    })
    const dest = join(outDir, `${session}-${basename(file)}.jsonl`)
    console.log(
      `${values.write ? 'WRITE' : 'DRY'} ${basename(file)} format=${parsed.format} session=${session} agent=${ident.agent} in=${String(result.stats.in)} out=${String(result.stats.out)} dropped=${String(result.stats.dropped)} system=${String(result.stats.systemEvents)} time_known=${String(result.stats.timeKnown)}`,
    )
    if (values.write) {
      writeFileSync(
        dest,
        result.messages.map((m) => JSON.stringify(toIngestRows([m])[0])).join('\n') +
          (result.messages.length ? '\n' : ''),
      )
    }
    n += 1
  }
  console.log(`backfill files=${String(n)} write=${values.write ? 'true' : 'false'}`)
  return 0
}

function cmdReclean(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      'agent-id': { type: 'string' },
      agent: { type: 'string' },
      'from-transcript': { type: 'string' },
      'from-rows': { type: 'string' },
      'pg-url': { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: true },
      write: { type: 'boolean', default: false },
    },
  })
  const dry = !values.write
  const ident = resolveIdent(values['agent-id'], values.session, values.agent)
  const session = v3Session(values.session || ident.session)

  if (values['from-transcript']) {
    const text = readFileSync(values['from-transcript'], 'utf8')
    const result = recleanFromSource(text, {
      sessionKey: values.session || ident.session,
      agent: ident.agent,
      agentId: ident.id,
      persona: ident.persona,
      dryRun: dry,
    })
    console.log(printRecleanStats({ ...result, session, dryRun: dry }))
    if (!dry && values.out) {
      mkdirSync(values.out, { recursive: true })
      const dest = join(values.out, `${session}.jsonl`)
      writeFileSync(
        dest,
        result.ingest.map((r) => JSON.stringify(r)).join('\n') + (result.ingest.length ? '\n' : ''),
      )
      console.log(`wrote ${dest}`)
    }
    return 0
  }

  if (values['from-rows']) {
    const rows = loadStoredRowsJson(values['from-rows'])
    const result = recleanStoredRows(rows, {
      sessionKey: values.session || ident.session,
      agent: ident.agent,
      agentId: ident.id,
      persona: ident.persona,
      dryRun: dry,
    })
    console.log(printRecleanStats({ ...result, session, dryRun: dry }))
    if (!dry && values.out) {
      mkdirSync(values.out, { recursive: true })
      const dest = join(values.out, `${session}.jsonl`)
      writeFileSync(
        dest,
        result.ingest.map((r) => JSON.stringify(r)).join('\n') + (result.ingest.length ? '\n' : ''),
      )
      console.log(`wrote ${dest}`)
    }
    return 0
  }

  if (values['pg-url'] && values.session) {
    if (dry) {
      console.log(`DRY SELECT (no writes) session=${values.session} -> ${session}`)
      console.log(EXISTING_ROWS_SQL.replace(/\s+/g, ' '))
      console.log('created_at: inherited from stored rows / remaining <timestamp> tags, else unset')
      return 0
    }
    console.error(
      'reclean --write against Postgres is a two-step: SELECT then ingest to the -v3 session.',
    )
    console.error('This CLI will not UPDATE or DELETE. Use --from-rows with the SELECT output.')
    return 2
  }

  console.error(
    'reclean needs --from-transcript FILE, --from-rows FILE, or --pg-url + --session (dry-run)',
  )
  return 2
}

function cmdCompare(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { fixtures: { type: 'string' } },
  })
  const dir = values.fixtures ?? join(fileDir(), 'test', 'fixtures')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.txt'))
    .sort()
  const rows = files.map((name) => {
    const text = readFileSync(join(dir, name), 'utf8')
    const ident = identityFor('6a155e75-0dd5-4c8a-8391-994878ed683a')
    return {
      name,
      result: compareInput(text, {
        sessionKey: ident.session,
        agent: ident.agent,
        agentId: ident.id,
      }),
    }
  })
  console.log(formatCompareTable(rows))
  for (const { name, result } of rows) {
    console.log(`\n### ${name} noise`)
    console.log(formatNoiseBreakdown(result))
    console.log(
      `roles before avg user=${result.before.avgChars.user.toFixed(1)} assistant=${result.before.avgChars.assistant.toFixed(1)} tool=${result.before.avgChars.tool.toFixed(1)}`,
    )
    console.log(
      `roles after  avg user=${result.after.avgChars.user.toFixed(1)} assistant=${result.after.avgChars.assistant.toFixed(1)} tool=${result.after.avgChars.tool.toFixed(1)} system=${result.after.avgChars.system.toFixed(1)}`,
    )
  }
  return 0
}

function cmdDiscover(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      'agents-dir': { type: 'string' },
      models: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const catalog = discoverModels({
    agentsDir: values['agents-dir'],
    modelsPath: values.models,
  })
  if (values.json) {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
  } else {
    for (const m of catalog.models) process.stdout.write(`${JSON.stringify(m)}\n`)
  }
  return 0
}

function resolveIdent(agentId?: string, session?: string, agent?: string) {
  if (agentId) {
    const ident = identityFor(agentId)
    return {
      id: agentId,
      session: session || ident.session,
      agent: agent || ident.agent,
      persona: ident.persona,
    }
  }
  return {
    id: undefined as string | undefined,
    session: session || 'grokbot-unknown',
    agent: agent || 'rivet-grokbot',
    persona: undefined as string | undefined,
  }
}

function listInputs(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return [path]
  return readdirSync(path)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.txt'))
    .map((f) => join(path, f))
    .sort()
}

function fileDir(): string {
  return resolve(new URL('..', import.meta.url).pathname)
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
if (invoked) {
  process.exitCode = main(process.argv.slice(2))
}

export { main }
