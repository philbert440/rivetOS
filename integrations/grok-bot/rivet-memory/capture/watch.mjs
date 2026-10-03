#!/usr/bin/env node
// Event-driven Grok Bot transcript capture (fs.watch, no polling).
// Paths come from env; nothing here names a host, IP, port, or lab layout.
import {
  watch,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeIdentityLookup } from './discover-models.mjs'
import {
  captureStateKey,
  resolveIdentityWithRefresh,
  shouldIngest,
  storeCursor,
  STORE_WATCH_RE,
  writeStoreCursor,
} from './live-state.mjs'
import { loadPublishLagConfig, runPublishLagPass } from './publish-lag.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.HOME || homedir()
const CAPTURE_DIR = resolve(process.env.GROKBOT_CAPTURE_DIR || HERE)
const TRANSCRIPTS =
  process.env.GROKBOT_TRANSCRIPTS ||
  process.env.GROKBOT_TRANSCRIPT_ROOT ||
  join(HOME, 'agent-data', 'agent-transcripts')
const AGENTS = process.env.GROKBOT_AGENTS || join(HOME, 'agent-data', 'agents')
const CONVERTER = process.env.CONVERTER || join(HERE, 'convert-transcript.py')
const INGEST = process.env.GROKBOT_INGEST || join(CAPTURE_DIR, 'ingest.mjs')
const CLI = join(HERE, 'dist', 'cli.js')
const SPOOL = join(CAPTURE_DIR, 'spool')
const SESSION_SUFFIX = process.env.GROKBOT_SESSION_SUFFIX ?? '-v3'
const STORE_SUFFIX = `${SESSION_SUFFIX}-store`
const VOICE_SUFFIX = `${SESSION_SUFFIX}-voice`
const NEW_STATE = join(HOME, '.rivetos', `grokbot-capture-state${SESSION_SUFFIX}.json`)
const LEGACY_STATE = join(HOME, '.rivetos', 'grokbot-capture-state.json')
const OLD_STATE = join(HOME, '.rivetos', 'capture', 'state.json')

function resolveStateFile() {
  if (process.env.GROKBOT_CAPTURE_STATE) return process.env.GROKBOT_CAPTURE_STATE
  if (existsSync(NEW_STATE)) return NEW_STATE
  // Only -v3 inherits unsuffixed watcher state. -v4+ starts empty.
  if (SESSION_SUFFIX === '-v3') {
    const inherit = existsSync(LEGACY_STATE) ? LEGACY_STATE : existsSync(OLD_STATE) ? OLD_STATE : ''
    if (inherit) {
      try {
        mkdirSync(dirname(NEW_STATE), { recursive: true })
        writeFileSync(NEW_STATE, readFileSync(inherit))
        return NEW_STATE
      } catch {
        return inherit
      }
    }
  }
  return NEW_STATE
}
const STATE_FILE = resolveStateFile()
const AGENT_DATA = process.env.GROKBOT_AGENT_DATA || dirname(AGENTS)
const PUBLISH_DIR = process.env.GROKBOT_PUBLISH_DIR || join(AGENT_DATA, 'transcript-publish')
const PUBLISH_LAG_STATE =
  process.env.GROKBOT_PUBLISH_LAG_STATE ||
  join(dirname(STATE_FILE), `grokbot-publish-lag${SESSION_SUFFIX}.json`)
const PUBLISH_LAG_INTERVAL_MS = Number(process.env.GROKBOT_PUBLISH_LAG_INTERVAL_MS ?? 60_000)
const DEBOUNCE_MS = 20_000
const PYTHON = process.env.PYTHON || 'python3'
const log = (...a) => console.log(new Date().toISOString(), ...a)

const BUILD_FIRST =
  'watch: build the capture package first (npx nx build @rivetos/grok-bot-rivet-memory-capture).'
if (!existsSync(CLI)) {
  console.error(BUILD_FIRST)
  process.exit(2)
}

for (const p of [TRANSCRIPTS, CONVERTER, INGEST]) {
  if (!existsSync(p)) {
    console.error(`watch: missing ${p}`)
    process.exit(2)
  }
}
mkdirSync(SPOOL, { recursive: true })
mkdirSync(dirname(STATE_FILE), { recursive: true })

let lookup = makeIdentityLookup()
function identity(id) {
  const next = resolveIdentityWithRefresh(lookup, id, makeIdentityLookup)
  lookup = next.lookup
  return next.who
}
log(`models: ${lookup.catalog.models.length} bots from agent profiles`)
if (lookup.catalog.unmappedTranscripts?.length) {
  log(
    `WARN unmapped transcripts (not on the discovered roster): ${lookup.catalog.unmappedTranscripts.join(', ')}`,
  )
}

let state = {}
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} catch {
  state = {}
}
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1))
const transcriptPath = (id) => join(TRANSCRIPTS, id, `${id}.jsonl`)
const sig = (p) => {
  const s = statSync(p)
  return `${s.size}:${Math.floor(s.mtimeMs)}`
}

const timers = new Map()
const queue = []
let busy = false
function enqueue(job) {
  clearTimeout(timers.get(job))
  timers.set(
    job,
    setTimeout(() => {
      timers.delete(job)
      if (!queue.includes(job)) queue.push(job)
      drain()
    }, DEBOUNCE_MS),
  )
}
function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RIVETOS_ROOT: process.env.RIVETOS_ROOT || '/opt/rivetos' },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }))
    p.on('error', (e) => res({ code: -1, out, err: String(e) }))
  })
}
async function ingestSpool(session, who, dst) {
  const i = await run(process.execPath, [
    INGEST,
    'ingest',
    '--session-id',
    session,
    '--agent',
    who.agent,
    '--persona',
    who.persona,
    dst,
  ])
  if (i.code !== 0) {
    log(`ingest FAIL ${session} exit=${i.code}: ${(i.err || i.out).slice(0, 300)}`)
    return false
  }
  log(`ok ${session} agent=${who.agent} ${i.out.split('\n').pop()?.slice(0, 200) || ''}`)
  return true
}

async function processTranscript(id) {
  const src = transcriptPath(id)
  if (!existsSync(src)) return
  const s = sig(src)
  if (!shouldIngest(state, id, SESSION_SUFFIX, s)) return
  const who = identity(id)
  const session =
    !SESSION_SUFFIX || who.session.endsWith(SESSION_SUFFIX)
      ? who.session
      : `${who.session}${SESSION_SUFFIX}`
  const dst = join(SPOOL, `${session}.jsonl`)
  const c = await run(PYTHON, [
    CONVERTER,
    src,
    dst,
    '--agent-id',
    id,
    '--session',
    session,
    `--session-suffix=${SESSION_SUFFIX}`,
  ])
  if (c.code !== 0) {
    log(`convert FAIL ${id} (${who.persona}): ${c.err.slice(0, 300)}`)
    return
  }
  if (await ingestSpool(session, who, dst)) {
    state[captureStateKey(id, SESSION_SUFFIX)] = s
    saveState()
  }
}

async function processStore(id) {
  const src = join(AGENTS, id, 'store.db')
  if (!existsSync(src)) return
  const who = identity(id)
  const session = who.session.endsWith(STORE_SUFFIX)
    ? who.session
    : `${who.session}${STORE_SUFFIX}`
  const after = storeCursor(state, id, STORE_SUFFIX)
  const dst = join(SPOOL, `${session}.jsonl`)
  const c = await run(process.execPath, [
    CLI,
    'convert-store',
    src,
    dst,
    '--agent-id',
    id,
    '--session',
    session,
    `--after-seq=${after}`,
  ])
  if (c.code !== 0) {
    log(`store convert FAIL ${id}: ${(c.err || c.out).slice(0, 300)}`)
    return
  }
  let info = {}
  try {
    info = JSON.parse(c.out.split('\n').pop() || '{}')
  } catch {
    info = {}
  }
  if (!info.out) return
  if (!(await ingestSpool(session, who, dst))) return
  writeStoreCursor(state, id, STORE_SUFFIX, info.max_seq ?? after)
  saveState()
}

async function processVoice(id, fileName) {
  const src = join(AGENTS, id, 'voice-calls', fileName)
  if (!existsSync(src)) return
  const s = sig(src)
  const suffix = `${VOICE_SUFFIX}:${fileName}`
  if (!shouldIngest(state, id, suffix, s)) return
  const who = identity(id)
  const stem = fileName.replace(/\.json$/i, '')
  const session = `${who.session}${VOICE_SUFFIX}-${stem}`
  const dst = join(SPOOL, `${session}.jsonl`)
  const c = await run(process.execPath, [
    CLI,
    'convert-voice',
    src,
    dst,
    '--agent-id',
    id,
    '--session',
    session,
  ])
  if (c.code !== 0) {
    log(`voice convert FAIL ${id} ${fileName}: ${(c.err || c.out).slice(0, 300)}`)
    return
  }
  if (await ingestSpool(session, who, dst)) {
    state[captureStateKey(id, suffix)] = s
    saveState()
  }
}

async function process1(job) {
  if (job.startsWith('store:')) return processStore(job.slice('store:'.length))
  if (job.startsWith('voice:')) {
    const rest = job.slice('voice:'.length)
    const slash = rest.indexOf(':')
    if (slash < 0) return
    return processVoice(rest.slice(0, slash), rest.slice(slash + 1))
  }
  return processTranscript(job)
}
function checkPublishLag() {
  try {
    runPublishLagPass({
      publishDir: PUBLISH_DIR,
      statusPath: PUBLISH_LAG_STATE,
      config: loadPublishLagConfig(process.env),
      log,
    })
  } catch (e) {
    log(`publish-lag: ${e instanceof Error ? e.message : e}`)
  }
}

let publishLagTimer
function enqueuePublishLag() {
  clearTimeout(publishLagTimer)
  publishLagTimer = setTimeout(checkPublishLag, 1_000)
}

async function drain() {
  if (busy) return
  busy = true
  try {
    checkPublishLag()
    while (queue.length) {
      const id = queue.shift()
      try {
        await process1(id)
      } catch (e) {
        log(`error ${id}: ${e.message}`)
      }
    }
  } finally {
    busy = false
  }
}

let pending = 0
try {
  for (const id of readdirSync(TRANSCRIPTS)) {
    const p = transcriptPath(id)
    if (!existsSync(p)) continue
    try {
      if (shouldIngest(state, id, SESSION_SUFFIX, sig(p))) {
        queue.push(id)
        pending++
      }
    } catch {
      /* skip */
    }
  }
} catch (e) {
  console.error(`watch: cannot read transcripts dir: ${e.message}`)
  process.exit(2)
}
if (existsSync(AGENTS)) {
  try {
    for (const id of readdirSync(AGENTS)) {
      const store = join(AGENTS, id, 'store.db')
      if (existsSync(store)) {
        queue.push(`store:${id}`)
        pending++
      }
      const voiceDir = join(AGENTS, id, 'voice-calls')
      if (existsSync(voiceDir)) {
        for (const name of readdirSync(voiceDir)) {
          if (!name.endsWith('.json')) continue
          const p = join(voiceDir, name)
          try {
            if (shouldIngest(state, id, `${VOICE_SUFFIX}:${name}`, sig(p))) {
              queue.push(`voice:${id}:${name}`)
              pending++
            }
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* optional */
  }
}
log(
  `watch: ${Object.keys(state).length} known, ${pending} changed/new sources; watching transcripts + store.db + voice-calls`,
)
drain()

const re = /^([0-9a-f-]{36})[\\/]\1\.jsonl$/
const storeRe = STORE_WATCH_RE
const voiceRe = /^([0-9a-f-]{36})[\\/]voice-calls[\\/]([^/]+\.json)$/
const w = watch(TRANSCRIPTS, { recursive: true }, (_ev, file) => {
  const m = file && String(file).match(re)
  if (m) enqueue(m[1])
})
w.on('error', (e) => {
  console.error('watch error, exiting for restart:', e.message)
  process.exit(1)
})
if (existsSync(AGENTS)) {
  const aw = watch(AGENTS, { recursive: true }, (_ev, file) => {
    const s = file && String(file)
    if (!s) return
    const sm = s.match(storeRe)
    if (sm) enqueue(`store:${sm[1]}`)
    const vm = s.match(voiceRe)
    if (vm) enqueue(`voice:${vm[1]}:${vm[2]}`)
  })
  aw.on('error', (e) => {
    console.error('agents watch error, exiting for restart:', e.message)
    process.exit(1)
  })
}
checkPublishLag()
if (Number.isFinite(PUBLISH_LAG_INTERVAL_MS) && PUBLISH_LAG_INTERVAL_MS > 0) {
  setInterval(checkPublishLag, PUBLISH_LAG_INTERVAL_MS).unref?.()
}
if (existsSync(PUBLISH_DIR)) {
  const pw = watch(PUBLISH_DIR, { recursive: true }, () => enqueuePublishLag())
  pw.on('error', (e) => {
    log(`publish-lag watch: ${e.message}`)
  })
}
process.on('SIGTERM', () => {
  log('SIGTERM')
  saveState()
  process.exit(0)
})
