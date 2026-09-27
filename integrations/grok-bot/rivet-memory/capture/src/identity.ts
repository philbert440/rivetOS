import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_NODE_ID, SUBAGENT_AGENT, type BotIdentity } from './types.js'

const UUID_RE = /^[0-9a-f-]{36}$/i
const DEFAULT_EXCLUDE = ['new bot']

export const HISTORICAL_OVERRIDES: Record<
  string,
  { persona: string; session: string; agent: string }
> = {
  '6a155e75-0dd5-4c8a-8391-994878ed683a': {
    persona: 'Rivet',
    session: 'grokbot-rivet-grokbot',
    agent: 'rivet-grokbot',
  },
  'fe09510f-c3ce-49bc-9d93-8c5ab5705809': {
    persona: 'dr eggbot',
    session: 'grokbot-eggbot',
    agent: 'rivet-eggbot',
  },
}

export interface IdentityConfig {
  nodeId: string
  excludeNames: Set<string>
  overrides: Record<
    string,
    Partial<BotIdentity> & {
      name?: string
      sessionId?: string
      agentId?: string
      transcript?: string
    }
  >
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

export function loadIdentityConfig(modelsPath?: string): IdentityConfig {
  const cfg: IdentityConfig = {
    nodeId: process.env.GROKBOT_NODE_ID || DEFAULT_NODE_ID,
    excludeNames: new Set(DEFAULT_EXCLUDE),
    overrides: { ...HISTORICAL_OVERRIDES },
  }
  const path = modelsPath ?? defaultModelsPath()
  if (!path || !existsSync(path)) return cfg
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof raw.nodeId === 'string' && raw.nodeId) cfg.nodeId = raw.nodeId
    if (Array.isArray(raw.excludeNames)) {
      for (const n of raw.excludeNames) cfg.excludeNames.add(String(n).toLowerCase())
    }
    if (raw.overrides && typeof raw.overrides === 'object') {
      for (const [id, o] of Object.entries(
        raw.overrides as Record<string, Record<string, unknown>>,
      )) {
        cfg.overrides[id] = o
      }
    }
    if (Array.isArray(raw.models)) {
      for (const m of raw.models as Array<Record<string, unknown>>) {
        if (typeof m.id === 'string') {
          cfg.overrides[m.id] = {
            persona: typeof m.name === 'string' ? m.name : undefined,
            session:
              typeof m.sessionId === 'string'
                ? m.sessionId
                : typeof m.session === 'string'
                  ? m.session
                  : undefined,
            agent:
              typeof m.agentId === 'string'
                ? m.agentId
                : typeof m.agent === 'string'
                  ? m.agent
                  : undefined,
            id: m.id,
          }
        }
      }
    }
  } catch {
    /* ignore bad file */
  }
  return cfg
}

export function defaultModelsPath(): string {
  return join(fileDir(), 'models.json')
}

function fileDir(): string {
  return resolve(new URL('..', import.meta.url).pathname)
}

export function defaultAgentsDir(): string {
  return process.env.GROKBOT_AGENTS || join(homedir(), 'agent-data', 'agents')
}

export function defaultTranscriptsDir(): string {
  return (
    process.env.GROKBOT_TRANSCRIPTS ||
    process.env.GROKBOT_TRANSCRIPT_ROOT ||
    join(homedir(), 'agent-data', 'agent-transcripts')
  )
}

export function discoverModels(opts?: {
  agentsDir?: string
  modelsPath?: string
  transcriptsDir?: string
}): { nodeId: string; models: Array<BotIdentity & { transcript: string }> } {
  const cfg = loadIdentityConfig(opts?.modelsPath)
  const agentsDir = opts?.agentsDir ?? defaultAgentsDir()
  const transcriptsDir = opts?.transcriptsDir ?? defaultTranscriptsDir()
  const out: Array<BotIdentity & { transcript: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch (e) {
    const err = e instanceof Error ? e : new Error('unknown error')
    throw new Error(`discover-models: cannot read agents dir: ${err.message}`, { cause: e })
  }
  for (const id of entries) {
    const dir = join(agentsDir, id)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (!UUID_RE.test(id)) continue
    if (existsSync(join(dir, 'group.json'))) continue
    const profPath = join(dir, 'profile.json')
    if (!existsSync(profPath)) continue
    let name: string
    try {
      const prof = JSON.parse(readFileSync(profPath, 'utf8')) as { name?: string }
      name = prof.name || id.slice(0, 8)
    } catch {
      continue
    }
    if (cfg.excludeNames.has(name.toLowerCase())) continue
    const identity = resolveIdentity(id, { config: cfg, name })
    const ov = cfg.overrides[id] ?? {}
    const transcript =
      typeof ov.transcript === 'string' && ov.transcript
        ? ov.transcript
        : join(transcriptsDir, id, `${id}.jsonl`)
    out.push({
      ...identity,
      transcript: isAbsolute(transcript) ? transcript : join(transcriptsDir, transcript),
    })
  }
  out.sort((a, b) => a.persona.localeCompare(b.persona))
  return { nodeId: cfg.nodeId, models: out }
}

export function resolveIdentity(
  id: string,
  opts?: { config?: IdentityConfig; name?: string; modelsPath?: string },
): BotIdentity {
  const cfg = opts?.config ?? loadIdentityConfig(opts?.modelsPath)
  const ov = cfg.overrides[id] ?? {}
  const persona = ov.persona || ov.name || opts?.name || id.slice(0, 8)
  const s = slug(persona)
  return {
    id,
    persona,
    session: ov.session || ov.sessionId || `${cfg.nodeId}-${s}`,
    agent: ov.agent || ov.agentId || `rivet-${s}`,
  }
}

export function identityFor(
  id: string,
  opts?: { config?: IdentityConfig; modelsPath?: string },
): BotIdentity {
  const cfg = opts?.config ?? loadIdentityConfig(opts?.modelsPath)
  if (Object.hasOwn(cfg.overrides, id)) return resolveIdentity(id, { config: cfg })
  return {
    id,
    persona: 'run',
    session: `${cfg.nodeId}-run-${id}`,
    agent: SUBAGENT_AGENT,
  }
}

export function makeIdentityLookup(opts?: { agentsDir?: string; modelsPath?: string }) {
  let catalog: { nodeId: string; models: Array<BotIdentity & { transcript: string }> }
  try {
    catalog = discoverModels(opts)
  } catch {
    const cfg = loadIdentityConfig(opts?.modelsPath)
    catalog = { nodeId: cfg.nodeId, models: [] }
  }
  const byId = new Map(catalog.models.map((m) => [m.id, m]))
  const cfg = loadIdentityConfig(opts?.modelsPath)
  return {
    catalog,
    identity(id: string): BotIdentity {
      const m = byId.get(id)
      if (m) return { id: m.id, persona: m.persona, session: m.session, agent: m.agent }
      if (Object.hasOwn(cfg.overrides, id)) return resolveIdentity(id, { config: cfg })
      return {
        id,
        persona: 'run',
        session: `${catalog.nodeId}-run-${id}`,
        agent: SUBAGENT_AGENT,
      }
    },
  }
}
