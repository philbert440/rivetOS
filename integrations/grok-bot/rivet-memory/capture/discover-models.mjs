#!/usr/bin/env node
// Discover Grok Bot agents as grokbot capture models.
// Source of truth: $GROKBOT_AGENTS/<id>/profile.json (skips groups).
// Optional overrides in models.json keep historical session/agent tags stable.
// Never prints secrets, hostnames, or IPs.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.HOME || homedir()
const AGENTS = process.env.GROKBOT_AGENTS || join(HOME, 'agent-data', 'agents')
const TRANSCRIPTS =
  process.env.GROKBOT_TRANSCRIPTS ||
  process.env.GROKBOT_TRANSCRIPT_ROOT ||
  join(HOME, 'agent-data', 'agent-transcripts')
const MODELS_FILE = process.env.GROKBOT_MODELS || join(HERE, 'models.json')
const NODE = process.env.GROKBOT_NODE_ID || 'grokbot'
const DEFAULT_EXCLUDE_NAMES = ['new bot']

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

function loadConfig() {
  const cfg = {
    nodeId: NODE,
    excludeNames: new Set(DEFAULT_EXCLUDE_NAMES),
    overrides: {},
  }
  if (!existsSync(MODELS_FILE)) return cfg
  try {
    const raw = JSON.parse(readFileSync(MODELS_FILE, 'utf8'))
    if (raw.nodeId) cfg.nodeId = raw.nodeId
    for (const n of raw.excludeNames || []) cfg.excludeNames.add(String(n).toLowerCase())
    if (raw.overrides && typeof raw.overrides === 'object') {
      for (const [id, o] of Object.entries(raw.overrides)) cfg.overrides[id] = o
    }
    if (Array.isArray(raw.models)) {
      for (const m of raw.models) {
        if (m?.id) cfg.overrides[m.id] = m
      }
    }
  } catch {
    /* ignore bad file */
  }
  return cfg
}

export function discoverModels() {
  const cfg = loadConfig()
  const out = []
  let entries = []
  try {
    entries = readdirSync(AGENTS)
  } catch (e) {
    throw new Error(`discover-models: cannot read agents dir: ${e.message}`)
  }
  for (const id of entries) {
    const dir = join(AGENTS, id)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue
    if (existsSync(join(dir, 'group.json'))) continue
    const profPath = join(dir, 'profile.json')
    if (!existsSync(profPath)) continue
    let name
    try {
      name = JSON.parse(readFileSync(profPath, 'utf8')).name || id.slice(0, 8)
    } catch {
      continue
    }
    if (cfg.excludeNames.has(String(name).toLowerCase())) continue

    const ov = cfg.overrides[id] || {}
    const s = slug(name)
    out.push({
      persona: ov.persona || ov.name || name,
      id,
      session: ov.session || ov.sessionId || `${cfg.nodeId}-${s}`,
      agent: ov.agent || ov.agentId || `rivet-${s}`,
      transcript: ov.transcript || join(TRANSCRIPTS, id, `${id}.jsonl`),
    })
  }
  out.sort((a, b) => String(a.persona).localeCompare(String(b.persona)))
  return { nodeId: cfg.nodeId, models: out }
}

export function makeIdentityLookup() {
  const catalog = discoverModels()
  const byId = new Map(catalog.models.map((m) => [m.id, m]))
  return {
    catalog,
    identity(id) {
      const m = byId.get(id)
      if (m) return { session: m.session, agent: m.agent, persona: m.persona }
      return {
        session: `${catalog.nodeId}-run-${id}`,
        agent: 'rivet-grokbot-run',
        persona: 'run',
      }
    },
  }
}

const selfPath = fileURLToPath(import.meta.url)
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(selfPath)
if (invoked) {
  const catalog = discoverModels()
  if (process.argv[2] === '--json') {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
  } else {
    for (const m of catalog.models) process.stdout.write(`${JSON.stringify(m)}\n`)
  }
}
