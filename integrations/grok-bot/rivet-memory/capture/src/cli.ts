#!/usr/bin/env node
/**
 * Grok Bot capture CLI — convert, backfill, ingest-pages, reclean, compare, discover.
 * Never prints secrets, hostnames, or connection strings.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { coalesceDashArgs } from './argv.js'
import { compareInput, formatCompareTable, formatNoiseBreakdown } from './compare.js'
import {
  agentIdFromTranscriptPath,
  applySessionSuffix,
  discoverModels,
  identityFor,
  identityForSession,
  listInputFiles,
  peekParentLastKnownTime,
  resolveSourceAgentId,
} from './identity.js'
import {
  createPgOverlapStore,
  formatIngestPagesCounts,
  ingestPages,
  type IngestPagesDeps,
} from './ingest-pages.js'
import { ingestGrokbotSession, type GrokbotIngestMemory } from './ingest-rows.js'
import { normalizeRecords, toIngestRows } from './normalize.js'
import { formatMergeConflicts, normalizePages } from './pages.js'
import { parseInput } from './parse.js'
import { connectAndFetchGrokbotRows, loadRivetosPgUrlFromEnv } from './pg-readonly.js'
import {
  FROM_ROWS_LIMITS,
  LIST_CONVERSATIONS_SQL,
  ROWS_BY_CONVERSATION_SQL,
  isRowShapedSession,
  loadStoredRowsJson,
  printRecleanStats,
  recleanFromSource,
  recleanStoredRows,
  v3RowsSession,
  v3Session,
} from './reclean.js'
import { readStoreSince, v3StoreSession } from './store.js'
import { sourceFileTimes } from './timestamps.js'
import {
  SESSION_SUFFIX_V3,
  isBackfillSession,
  sessionStoreSuffix,
  sessionVoiceSuffix,
} from './types.js'
import type { IngestRow, ParsedInput } from './types.js'
import { parseVoiceCall, v3VoiceSession, voiceCallToRecords } from './voice.js'

const HELP = `Usage: grokbot-rivet-memory-capture <command> [opts]

  convert SRC DST [--agent-id UUID] [--session KEY] [--agent NAME]
          [--session-suffix=-v3]
      Normalize one on-disk jsonl or ReadTranscript page to ingest jsonl.
      Live capture defaults to session suffix -v3 (GROKBOT_SESSION_SUFFIX).
      Set GROKBOT_SESSION_SUFFIX=-v4 for a fresh sibling of -v3.
      Use the = form: --session-suffix=-v4 (space form is rewritten).

  convert-store SRC.DB DST [--agent-id UUID] [--session KEY] [--after-seq=-1]
          [--session-suffix=-v3-store]
      Read-only sqlite over agents/<id>/store.db transcript_entries
      (seq INTEGER PRIMARY KEY, id TEXT, entry TEXT). Positions are seq
      (not the on-disk line index). Default suffix -v3-store. First run
      uses --after-seq=-1 (seq is 1..N).

  convert-voice SRC.json DST [--agent-id UUID] [--session KEY]
          [--session-suffix=-v3-voice]
      Normalize one voice-calls/*.json file. Turn indices are not the on-disk
      line index. Default suffix -v3-voice-<stem>.

  parse-page [FILE|-]
      Parse a ReadTranscript page (header + JSON lines) and print JSON
      {header, records, hasOlderFooter, format}. pull-bridge.py calls this.

  backfill --input PATH [--format auto|ondisk|page] [--agent-id UUID]
           [--session-suffix=-v3] [--out DIR] [--write]
      Walk a file or directory (recursive) of transcripts/pages.
      Pages for one agent are merged by position into a single spool.
      On-disk agent id is taken from <uuid>/<uuid>.jsonl when there is no
      header or --agent-id. Files with no id are skipped (not grokbot-unknown).
      Overlapping pages that disagree at a position print CONFLICT and
      refuse --write. --write emits ingest jsonl. Dry by default.

  reclean [--session KEY] [--agent NAME] [--agent-id UUID]
          [--from-transcript FILE] [--from-rows FILE] [--out DIR]
          [--dry-run|--write]
      Re-clean source transcripts into <session>-vN. --from-rows and PG
      reads write <session>-vN-rows. Follows GROKBOT_SESSION_SUFFIX
      / --session-suffix. Refuses already row-shaped sessions and any
      -vN-backfill source (that suffix is never folded into live -vN).
      --dry-run (default) performs zero writes and prints stats.
      Without --from-transcript/--from-rows, reads RIVETOS_PG_URL from the
      environment or ~/.rivetos/.env inside BEGIN TRANSACTION READ ONLY
      (then ROLLBACK). Never pass the URL on argv. Groups by conversation_id
      (a session may have more than one conversation_id).
      Without --agent/--agent-id, the agent filter is derived from the session
      or left NULL (do not force a default agent tag).
      --from-rows cannot restore tool results (old converter ignored result;
      stored tool rows average ~38 chars). Assistant rows keep legacy
      [tool X]/[thinking] text. Full fidelity needs a source-transcript backfill.

  compare [--fixtures DIR]
      Before (legacy convert-transcript + pull-bridge) vs after (normalizer).

  discover [--agents-dir DIR] [--json]

  ingest-pages --input DIR [--commit] [--dry-run] [--overlap-hours 48]
               [--agents-dir DIR]
      ReadTranscript page backfill. Files are <bot-slug>-<before>.txt,
      ordered by numeric <before> then header position.
      Dry-run is the default and writes nothing. An explicit --dry-run
      overrides --commit. --commit INSERTs message rows into
      grokbot-<slug>-v4-backfill only and never deletes. A bot whose
      pages conflict writes nothing; other bots still proceed (exit 3).
      PostgresMemory.append still upserts that session's ros_conversations
      row (updated_at, active) and may queue tool-synthesis jobs. Never
      folds into plain -v4. Timestamps are approximate (ts_approx=true);
      rows before the first <timestamp> tag are skipped.
      --overlap-hours 0 disables -v4 content-hash suppression.
      Unknown slugs and malformed pages are counted and exit 2.
      --input must be a readable directory.
`

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0]
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP)
    return 0
  }
  if (cmd === 'convert') return cmdConvert(argv.slice(1))
  if (cmd === 'convert-store') return cmdConvertStore(argv.slice(1))
  if (cmd === 'convert-voice') return cmdConvertVoice(argv.slice(1))
  if (cmd === 'parse-page') return cmdParsePage(argv.slice(1))
  if (cmd === 'backfill') return cmdBackfill(argv.slice(1))
  if (cmd === 'reclean') return cmdReclean(argv.slice(1))
  if (cmd === 'compare') return cmdCompare(argv.slice(1))
  if (cmd === 'discover') return cmdDiscover(argv.slice(1))
  if (cmd === 'ingest-pages') return cmdIngestPages(argv.slice(1))
  console.error(`unknown command: ${cmd}`)
  console.log(HELP)
  return 2
}

function sessionSuffixFromArgs(explicit?: string): string {
  if (explicit !== undefined) return explicit
  return process.env.GROKBOT_SESSION_SUFFIX ?? SESSION_SUFFIX_V3
}

function cmdConvert(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: coalesceDashArgs(argv),
    allowPositionals: true,
    options: {
      'agent-id': { type: 'string' },
      session: { type: 'string' },
      agent: { type: 'string' },
      format: { type: 'string' },
      'session-suffix': { type: 'string' },
    },
  })
  const src = positionals[0]
  const dst = positionals[1]
  if (!src || !dst) {
    console.error('convert needs SRC DST')
    return 2
  }
  const ident = resolveIdent(
    values['agent-id'] ?? agentIdFromTranscriptPath(src),
    values.session,
    values.agent,
  )
  const suffix = sessionSuffixFromArgs(values['session-suffix'])
  const session = values.session
    ? applySessionSuffix(values.session, suffix)
    : applySessionSuffix(ident.session, suffix)
  const text = readFileSync(src, 'utf8')
  const parsed = parseInput(
    text,
    values.format === 'page' || values.format === 'ondisk' ? values.format : undefined,
  )
  const srcPath = resolve(src)
  const result = normalizeRecords(parsed.records, {
    sessionKey: session,
    agent: ident.agent ?? 'unknown',
    agentId: ident.id ?? parsed.header?.id,
    persona: ident.persona,
    format: parsed.format,
    startPosition: parsed.header?.a ?? 0,
    ...sourceFileTimes(statSync(src)),
    lastKnownTime: peekParentLastKnownTime({
      sourcePath: srcPath,
      records: parsed.records.slice(0, 8),
    }),
    sourcePath: srcPath,
    sourceLines: parsed.sourceLines,
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
      session,
    }),
  )
  if (!result.stats.timeKnown) {
    console.error('created_at: derived from file mtime + position (no inline stamps)')
  }
  return 0
}

function writeIngest(dst: string, rows: IngestRow[]): void {
  mkdirSync(dirname(resolve(dst)), { recursive: true })
  writeFileSync(dst, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

function cmdConvertStore(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: coalesceDashArgs(argv),
    allowPositionals: true,
    options: {
      'agent-id': { type: 'string' },
      session: { type: 'string' },
      agent: { type: 'string' },
      'after-seq': { type: 'string' },
      'session-suffix': { type: 'string' },
    },
  })
  const src = positionals[0]
  const dst = positionals[1]
  if (!src || !dst) {
    console.error('convert-store needs SRC.DB DST')
    return 2
  }
  const ident = resolveIdent(values['agent-id'], values.session, values.agent)
  const suffix = values['session-suffix'] ?? sessionStoreSuffix(sessionSuffixFromArgs())
  const session = values.session
    ? values.session.endsWith(suffix)
      ? values.session
      : `${values.session}${suffix}`
    : v3StoreSession(ident.session, suffix)
  const afterSeq = values['after-seq'] !== undefined ? Number(values['after-seq']) : -1
  const read = readStoreSince(src, { afterSeq })
  const result = normalizeRecords(read.records, {
    sessionKey: session,
    agent: ident.agent ?? 'unknown',
    agentId: ident.id,
    persona: ident.persona,
    format: 'store',
    positions: read.positions,
    useStoredCreatedAt: true,
  })
  writeIngest(
    dst,
    result.messages.map((m) => toIngestRows([m])[0]),
  )
  console.log(
    JSON.stringify({
      in: result.stats.in,
      out: result.stats.out,
      dropped: result.stats.dropped,
      max_seq: read.maxSeq,
      min_seq: read.minSeq,
      after_seq: afterSeq,
      skipped: read.skipped,
      session,
      time_known: result.stats.timeKnown,
    }),
  )
  return 0
}

function cmdConvertVoice(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: coalesceDashArgs(argv),
    allowPositionals: true,
    options: {
      'agent-id': { type: 'string' },
      session: { type: 'string' },
      agent: { type: 'string' },
      'session-suffix': { type: 'string' },
    },
  })
  const src = positionals[0]
  const dst = positionals[1]
  if (!src || !dst) {
    console.error('convert-voice needs SRC.json DST')
    return 2
  }
  const ident = resolveIdent(values['agent-id'], values.session, values.agent)
  const call = parseVoiceCall(readFileSync(src, 'utf8'), src)
  const suffix = values['session-suffix'] ?? sessionVoiceSuffix(sessionSuffixFromArgs())
  const session = values.session
    ? values.session.includes(suffix)
      ? values.session
      : v3VoiceSession(values.session, src, suffix)
    : v3VoiceSession(ident.session, src, suffix)
  const { records, positions } = voiceCallToRecords(call)
  const result = normalizeRecords(records, {
    sessionKey: session,
    agent: ident.agent ?? 'unknown',
    agentId: ident.id,
    persona: ident.persona,
    format: 'voice',
    positions,
    useStoredCreatedAt: true,
  })
  writeIngest(
    dst,
    result.messages.map((m) => toIngestRows([m])[0]),
  )
  console.log(
    JSON.stringify({
      in: result.stats.in,
      out: result.stats.out,
      dropped: result.stats.dropped,
      call_id: call.id,
      session,
      time_known: result.stats.timeKnown,
    }),
  )
  return 0
}

function cmdParsePage(argv: string[]): number {
  const src = argv[0]
  if (!src) {
    console.error('parse-page needs FILE or -')
    return 2
  }
  const text = src === '-' ? readStdin() : readFileSync(src, 'utf8')
  try {
    const parsed = parseInput(text, 'page')
    process.stdout.write(
      `${JSON.stringify({
        header: parsed.header ?? null,
        records: parsed.records,
        hasOlderFooter: parsed.hasOlderFooter,
        format: parsed.format,
      })}\n`,
    )
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse-page failed'
    console.error(message)
    return 2
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf8')
}

function cmdBackfill(argv: string[]): number {
  const { values } = parseArgs({
    args: coalesceDashArgs(argv),
    options: {
      input: { type: 'string' },
      format: { type: 'string' },
      'agent-id': { type: 'string' },
      'session-suffix': { type: 'string' },
      out: { type: 'string', default: 'spool' },
      write: { type: 'boolean', default: false },
    },
  })
  if (!values.input) {
    console.error('backfill needs --input PATH')
    return 2
  }
  const files = listInputFiles(values.input)
  const suffix = sessionSuffixFromArgs(values['session-suffix'])
  const outDir = values.out || 'spool'
  if (values.write) mkdirSync(outDir, { recursive: true })

  type Bucket = {
    session: string
    agent: string
    persona?: string
    id?: string
    parsed: ParsedInput[]
    files: string[]
  }
  const buckets = new Map<string, Bucket>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const parsed = parseInput(
      text,
      values.format === 'page' || values.format === 'ondisk' ? values.format : undefined,
    )
    const id = resolveSourceAgentId({
      file,
      headerId: parsed.header?.id,
      explicitId: values['agent-id'],
    })
    if (!id) {
      console.error(
        `SKIP unidentified: ${file} (no --agent-id, no header id, no <uuid>/<uuid>.jsonl)`,
      )
      continue
    }
    const ident = resolveIdent(id, undefined, undefined)
    const session = applySessionSuffix(ident.session, suffix)
    const agent = ident.agent ?? 'unknown'
    const key = `${session}\0${agent}\0${ident.id ?? ''}`
    const bucket = buckets.get(key) ?? {
      session,
      agent,
      persona: ident.persona,
      id: ident.id,
      parsed: [],
      files: [],
    }
    bucket.parsed.push(parsed)
    bucket.files.push(file)
    buckets.set(key, bucket)
  }

  let n = 0
  let writeConflicts = false
  for (const bucket of buckets.values()) {
    const times = sourceFileTimesFromPaths(bucket.files)
    const result = normalizePages(bucket.parsed, {
      sessionKey: bucket.session,
      agent: bucket.agent,
      agentId: bucket.id,
      persona: bucket.persona,
      ...times,
      lastKnownTime: peekParentLastKnownTime({
        sourcePath: bucket.files[0],
        records: bucket.parsed[0]?.records.slice(0, 8),
      }),
    })
    const dest = join(outDir, `${bucket.session}.jsonl`)
    const conflicts = result.conflicts ?? []
    console.log(
      `${values.write ? 'WRITE' : 'DRY'} files=${String(bucket.files.length)} session=${bucket.session} agent=${bucket.agent} in=${String(result.stats.in)} out=${String(result.stats.out)} dropped=${String(result.stats.dropped)} system=${String(result.stats.systemEvents)} time_known=${String(result.stats.timeKnown)}`,
    )
    if (conflicts.length > 0) {
      console.error(formatMergeConflicts(conflicts))
      if (values.write) writeConflicts = true
    }
    if (values.write && conflicts.length === 0) {
      writeFileSync(
        dest,
        result.messages.map((m) => JSON.stringify(toIngestRows([m])[0])).join('\n') +
          (result.messages.length ? '\n' : ''),
      )
    }
    n += bucket.files.length
  }
  console.log(
    `backfill files=${String(n)} agents=${String(buckets.size)} write=${values.write ? 'true' : 'false'}`,
  )
  return writeConflicts ? 3 : 0
}

async function cmdReclean(argv: string[]): Promise<number> {
  if (argv.includes('--pg-url')) {
    console.error(
      'reclean: do not pass the database URL on argv. Set RIVETOS_PG_URL in the environment or ~/.rivetos/.env',
    )
    return 2
  }
  const { values } = parseArgs({
    args: coalesceDashArgs(argv),
    options: {
      session: { type: 'string' },
      'agent-id': { type: 'string' },
      agent: { type: 'string' },
      'from-transcript': { type: 'string' },
      'from-rows': { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: true },
      write: { type: 'boolean', default: false },
      'session-suffix': { type: 'string' },
    },
  })
  const dry = !values.write
  const ident = resolveIdent(values['agent-id'], values.session, values.agent)
  const sourceSession = values.session || ident.session
  const suffix = sessionSuffixFromArgs(values['session-suffix'])
  if (isRowShapedSession(sourceSession)) {
    console.error(
      `reclean: ${sourceSession} is already row-shaped; refuse to split tool calls again`,
    )
    return 2
  }
  if (isBackfillSession(sourceSession)) {
    console.error(
      `reclean: ${sourceSession} is a -backfill session; refusing to fold it into a live -vN session`,
    )
    return 2
  }
  const fromSource = Boolean(values['from-transcript'])
  const session = fromSource
    ? v3Session(sourceSession, suffix)
    : v3RowsSession(sourceSession, suffix)

  const writeOut = (ingest: IngestRow[], destSession: string) => {
    if (dry || !values.out) return
    mkdirSync(values.out, { recursive: true })
    const dest = join(values.out, `${destSession}.jsonl`)
    writeFileSync(
      dest,
      ingest.map((r) => JSON.stringify(r)).join('\n') + (ingest.length ? '\n' : ''),
    )
    console.log(`wrote ${dest}`)
  }

  if (values['from-transcript']) {
    const text = readFileSync(values['from-transcript'], 'utf8')
    const result = recleanFromSource(text, {
      sessionKey: values.session || ident.session,
      agent: ident.agent ?? 'unknown',
      agentId: ident.id,
      persona: ident.persona,
      dryRun: dry,
      ...sourceFileTimes(statSync(values['from-transcript'])),
      lastKnownTime: peekParentLastKnownTime({
        sourcePath: resolve(values['from-transcript']),
      }),
      sourcePath: resolve(values['from-transcript']),
      sessionSuffix: suffix,
    })
    console.log(printRecleanStats({ ...result, session, dryRun: dry }))
    writeOut(result.ingest, session)
    return 0
  }

  if (values['from-rows']) {
    const rows = loadStoredRowsJson(values['from-rows'])
    try {
      const result = recleanStoredRows(rows, {
        sessionKey: values.session || ident.session,
        agent: ident.agent ?? 'unknown',
        agentId: ident.id,
        persona: ident.persona,
        dryRun: dry,
        sessionSuffix: suffix,
      })
      console.log(printRecleanStats({ ...result, session, dryRun: dry }))
      console.log(FROM_ROWS_LIMITS)
      writeOut(result.ingest, session)
      return 0
    } catch (err) {
      const message = err instanceof Error ? err.message : 'reclean failed'
      console.error(message)
      return 2
    }
  }

  if (!values.session && !ident.id) {
    console.error(
      'reclean needs --from-transcript FILE, --from-rows FILE, or --session (reads RIVETOS_PG_URL, never argv)',
    )
    return 2
  }

  if (dry) {
    console.log(
      `DRY SELECT (read-only txn, then ROLLBACK) session=${values.session || ident.session} -> ${session}`,
    )
    console.log(LIST_CONVERSATIONS_SQL.replace(/\s+/g, ' '))
    console.log(ROWS_BY_CONVERSATION_SQL.replace(/\s+/g, ' '))
    console.log(FROM_ROWS_LIMITS)
  }

  try {
    const groups = await connectAndFetchGrokbotRows(
      values.session || ident.session,
      values.agent || ident.agent,
    )
    if (groups.length === 0) {
      console.log('no conversations matched')
      return 0
    }
    for (const { conversation, rows } of groups) {
      const destSession =
        groups.length > 1 ? `${session}-${conversation.conversation_id.slice(0, 8)}` : session
      const result = recleanStoredRows(rows, {
        sessionKey: values.session || ident.session,
        agent: conversation.agent,
        agentId: ident.id,
        persona: ident.persona,
        dryRun: dry,
        sessionSuffix: suffix,
      })
      console.log(
        `conversation_id=${conversation.conversation_id} agent=${conversation.agent} rows=${String(conversation.n)}`,
      )
      console.log(printRecleanStats({ ...result, session: destSession, dryRun: dry }))
      console.log(FROM_ROWS_LIMITS)
      writeOut(result.ingest, destSession)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error(message)
    return 2
  }
  return 0
}

function cmdCompare(argv: string[]): number {
  const { values } = parseArgs({
    args: coalesceDashArgs(argv),
    options: { fixtures: { type: 'string' } },
  })
  const dir = values.fixtures ?? join(fileDir(), 'test', 'fixtures')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.txt'))
    .sort()
  const rows = files.map((name) => {
    const text = readFileSync(join(dir, name), 'utf8')
    return {
      name,
      result: compareInput(text, {
        sessionKey: 'grokbot-compare',
        agent: 'grokbot-compare',
        agentId: '00000000-0000-4000-8000-000000000001',
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
      `roles after  avg user=${result.after.avgChars.user.toFixed(1)} assistant=${result.after.avgChars.assistant.toFixed(1)} tool=${result.after.avgChars.tool.toFixed(1)} system=${result.after.avgChars.system.toFixed(1)} (empty tool_use excluded from after avg)`,
    )
  }
  return 0
}

function cmdDiscover(argv: string[]): number {
  const { values } = parseArgs({
    args: coalesceDashArgs(argv),
    options: {
      'agents-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const catalog = discoverModels({
    agentsDir: values['agents-dir'],
  })
  if (values.json) {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
  } else {
    for (const m of catalog.models) process.stdout.write(`${JSON.stringify(m)}\n`)
  }
  if (catalog.unmappedTranscripts.length > 0) {
    console.error(
      `unmapped transcripts (not on the discovered roster): ${catalog.unmappedTranscripts.join(', ')}`,
    )
  }
  return 0
}

export async function cmdIngestPages(
  argv: string[],
  hooks?: { loadDeps?: (commit: boolean) => Promise<IngestPagesDeps> },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: coalesceDashArgs(argv),
    allowPositionals: true,
    options: {
      input: { type: 'string' },
      commit: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'overlap-hours': { type: 'string' },
      'agents-dir': { type: 'string' },
    },
  })
  const input = values.input || positionals[0] || process.env.GROKBOT_PAGES_DIR
  if (!input) {
    console.error('ingest-pages needs --input DIR (or GROKBOT_PAGES_DIR)')
    return 2
  }
  try {
    const st = statSync(input)
    if (!st.isDirectory()) {
      console.error(`ingest-pages: --input is not a directory: ${input}`)
      return 2
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unreadable'
    console.error(`ingest-pages: cannot read --input ${input}: ${message}`)
    return 2
  }
  if (values['dry-run'] && values.commit) {
    console.error('ingest-pages: --dry-run overrides --commit; nothing will be written')
  }
  const commit = values.commit && !values['dry-run']
  const overlapHours = Number(
    values['overlap-hours'] ?? process.env.GROKBOT_BACKFILL_OVERLAP_HOURS ?? 48,
  )
  if (!Number.isFinite(overlapHours) || overlapHours < 0) {
    console.error('ingest-pages: --overlap-hours must be a non-negative number')
    return 2
  }
  const deps = hooks?.loadDeps ? await hooks.loadDeps(commit) : await loadIngestPagesDeps(commit)
  try {
    if (commit && !deps.commit) {
      console.error(
        deps.commitError ??
          'ingest-pages --commit needs RIVETOS_PG_URL (environment or ~/.rivetos/.env). Dry-run needs no write.',
      )
      return 2
    }
    const result = await ingestPages(input, {
      commit,
      agentsDir: values['agents-dir'],
      overlapHours,
      overlapUnavailable: deps.overlapUnavailable,
      deps,
    })
    console.log(formatIngestPagesCounts(result))
    const conflicts = result.bots.some((b) => b.conflicts.length > 0)
    const failed = result.bots.some((b) => b.pagesFailed > 0 || b.unknownSlugs > 0)
    if (commit && conflicts) return 3
    if (failed) return 2
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ingest-pages failed'
    console.error(message)
    return 2
  } finally {
    await deps.overlap?.close?.()
  }
}

async function loadIngestPagesDeps(commit: boolean): Promise<IngestPagesDeps> {
  const deps: IngestPagesDeps = {}
  const url = loadRivetosPgUrlFromEnv()
  if (!url) {
    deps.overlapUnavailable = true
    if (commit) {
      deps.commitError =
        'ingest-pages --commit needs RIVETOS_PG_URL (environment or ~/.rivetos/.env). Dry-run needs no write.'
    }
    return deps
  }
  deps.overlap = createPgOverlapStore(url)
  if (!commit) return deps
  try {
    deps.commit = await createPgCommit(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ingest-pages --commit failed'
    deps.commitError = `ingest-pages --commit failed: ${message}`
  }
  return deps
}

/**
 * Deployed installs resolve `@rivetos/memory-postgres` from RIVETOS_ROOT.
 * A dev checkout falls back to the workspace package at
 * `plugins/memory/postgres` (four levels up from this capture package).
 */
export function resolveMemoryPostgresEntry(
  exists: (path: string) => boolean = existsSync,
  dirs?: { root?: string; packageDir?: string },
): string {
  const root = dirs?.root ?? (process.env.RIVETOS_ROOT || '/opt/rivetos')
  const packageDir = dirs?.packageDir ?? fileDir()
  const deployed = resolve(root, 'node_modules/@rivetos/memory-postgres/dist/index.js')
  const local = resolve(packageDir, '../../../..', 'plugins/memory/postgres/dist/index.js')
  if (exists(deployed)) return deployed
  if (exists(local)) return local
  throw new Error(`memory-postgres is not built (looked for ${deployed} and ${local})`)
}

async function createPgCommit(url: string): Promise<IngestPagesDeps['commit']> {
  const { pathToFileURL } = await import('node:url')
  const entry = resolveMemoryPostgresEntry()
  const memoryMod = (await import(pathToFileURL(entry).href)) as {
    PostgresMemory: new (opts: { connectionString: string }) => GrokbotIngestMemory & {
      close?: () => Promise<void>
    }
  }
  return async (input) => {
    const memory = new memoryMod.PostgresMemory({ connectionString: url })
    try {
      return await ingestGrokbotSession(memory, input)
    } finally {
      await memory.close?.()
    }
  }
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
  if (session) {
    const fromSession = identityForSession(session)
    return {
      id: fromSession?.id,
      session,
      agent: agent || fromSession?.agent,
      persona: fromSession?.persona,
    }
  }
  return {
    id: undefined as string | undefined,
    session: 'grokbot-unknown',
    agent,
    persona: undefined as string | undefined,
  }
}

export { resolveIdent }

function sourceFileTimesFromPaths(files: string[]): {
  fileMtimeMs?: number
  fileBirthtimeMs?: number
} {
  let mtime = 0
  let birth: number | undefined
  for (const file of files) {
    try {
      const t = sourceFileTimes(statSync(file))
      if (t.fileMtimeMs) mtime = Math.max(mtime, t.fileMtimeMs)
      if (t.fileBirthtimeMs !== undefined) {
        birth = birth === undefined ? t.fileBirthtimeMs : Math.min(birth, t.fileBirthtimeMs)
      }
    } catch {
      /* skip unreadable */
    }
  }
  return {
    fileMtimeMs: mtime > 0 ? mtime : undefined,
    fileBirthtimeMs: birth !== undefined && (mtime <= 0 || birth < mtime) ? birth : undefined,
  }
}

function fileDir(): string {
  return resolve(new URL('..', import.meta.url).pathname)
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
if (invoked) {
  process.exitCode = await main(process.argv.slice(2))
}

export { main }
