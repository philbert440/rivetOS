#!/usr/bin/env node
// Event-driven Grok Bot transcript capture (fs.watch, no polling).
// Paths come from env; nothing here names a host, IP, port, or lab layout.
import { watch, statSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeIdentityLookup } from './discover-models.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.HOME || homedir()
const CAPTURE_DIR = resolve(process.env.GROKBOT_CAPTURE_DIR || HERE)
const TRANSCRIPTS =
  process.env.GROKBOT_TRANSCRIPTS ||
  process.env.GROKBOT_TRANSCRIPT_ROOT ||
  join(HOME, 'agent-data', 'agent-transcripts')
const CONVERTER = process.env.CONVERTER || join(HERE, 'convert-transcript.py')
const INGEST = process.env.GROKBOT_INGEST || join(CAPTURE_DIR, 'ingest.mjs')
const SPOOL = join(CAPTURE_DIR, 'spool')
const STATE_FILE = process.env.GROKBOT_CAPTURE_STATE || join(HOME, '.rivetos', 'grokbot-capture-state.json')
const DEBOUNCE_MS = 20_000
const PYTHON = process.env.PYTHON || 'python3'

const log = (...a) => console.log(new Date().toISOString(), ...a)

for (const p of [TRANSCRIPTS, CONVERTER, INGEST]) {
  if (!existsSync(p)) {
    console.error(`watch: missing ${p}`)
    process.exit(2)
  }
}
mkdirSync(SPOOL, { recursive: true })
mkdirSync(dirname(STATE_FILE), { recursive: true })

const { catalog, identity } = makeIdentityLookup()
log(`models: ${catalog.models.length} bots from agent profiles`)

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
function enqueue(id) {
  clearTimeout(timers.get(id))
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      if (!queue.includes(id)) queue.push(id)
      drain()
    }, DEBOUNCE_MS),
  )
}
function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RIVETOS_ROOT: process.env.RIVETOS_ROOT || process.cwd() },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }))
    p.on('error', (e) => res({ code: -1, out, err: String(e) }))
  })
}
async function process1(id) {
  const src = transcriptPath(id)
  if (!existsSync(src)) return
  const s = sig(src)
  if (state[id] === s) return
  const who = identity(id)
  const dst = join(SPOOL, `${who.session}.jsonl`)
  const c = await run(PYTHON, [CONVERTER, src, dst, '--agent-id', id])
  if (c.code !== 0) {
    log(`convert FAIL ${id} (${who.persona}): ${c.err.slice(0, 300)}`)
    return
  }
  const i = await run(process.execPath, [
    INGEST,
    'ingest',
    '--session-id',
    who.session,
    '--agent',
    who.agent,
    '--persona',
    who.persona,
    dst,
  ])
  if (i.code !== 0) {
    log(`ingest FAIL ${who.session} exit=${i.code}: ${(i.err || i.out).slice(0, 300)}`)
    return
  }
  state[id] = s
  saveState()
  log(`ok ${who.session} agent=${who.agent} ${i.out.split('\n').pop()?.slice(0, 200) || ''}`)
}
async function drain() {
  if (busy) return
  busy = true
  try {
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
      if (state[id] !== sig(p)) {
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
log(`watch: ${Object.keys(state).length} known, ${pending} changed/new transcripts; watching transcripts dir`)
drain()

const re = /^([0-9a-f-]{36})[\\/]\1\.jsonl$/
const w = watch(TRANSCRIPTS, { recursive: true }, (_ev, file) => {
  const m = file && String(file).match(re)
  if (m) enqueue(m[1])
})
w.on('error', (e) => {
  console.error('watch error, exiting for restart:', e.message)
  process.exit(1)
})
process.on('SIGTERM', () => {
  log('SIGTERM')
  saveState()
  process.exit(0)
})
