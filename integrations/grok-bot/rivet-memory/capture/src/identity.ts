import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_NODE_ID,
  SESSION_SUFFIX_V3,
  SUBAGENT_AGENT,
  stripSessionSuffix,
  type BotIdentity,
} from './types.js'

const UUID_RE = /^[0-9a-f-]{36}$/i
const DEFAULT_EXCLUDE = ['new bot']

/** Historical Rivet/eggbot tags live in models.json `overrides` only. */

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
    overrides: {},
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

export interface DiscoverResult {
  nodeId: string
  models: Array<BotIdentity & { transcript: string }>
  /** Transcript `<uuid>/<uuid>.jsonl` ids not on the roster or overrides. */
  unmappedTranscripts: string[]
}

export function discoverModels(opts?: {
  agentsDir?: string
  modelsPath?: string
  transcriptsDir?: string
}): DiscoverResult {
  const cfg = loadIdentityConfig(opts?.modelsPath)
  const agentsDir = opts?.agentsDir ?? defaultAgentsDir()
  const transcriptsDir = opts?.transcriptsDir ?? defaultTranscriptsDir()
  const out: Array<BotIdentity & { transcript: string }> = []
  const seen = new Set<string>()
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
    seen.add(id)
  }
  for (const id of Object.keys(cfg.overrides)) {
    if (seen.has(id)) continue
    if (!UUID_RE.test(id)) continue
    const identity = resolveIdentity(id, { config: cfg })
    const ov = cfg.overrides[id] ?? {}
    if (ov.persona && cfg.excludeNames.has(ov.persona.toLowerCase())) continue
    const transcript =
      typeof ov.transcript === 'string' && ov.transcript
        ? ov.transcript
        : join(transcriptsDir, id, `${id}.jsonl`)
    out.push({
      ...identity,
      transcript: isAbsolute(transcript) ? transcript : join(transcriptsDir, transcript),
    })
    seen.add(id)
  }
  const unmappedTranscripts = listUnmappedTranscripts(transcriptsDir, seen)
  out.sort((a, b) => a.persona.localeCompare(b.persona))
  return { nodeId: cfg.nodeId, models: out, unmappedTranscripts }
}

export function listUnmappedTranscripts(transcriptsDir: string, knownIds: Set<string>): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(transcriptsDir)
  } catch {
    return out
  }
  for (const id of entries) {
    if (!UUID_RE.test(id) || knownIds.has(id)) continue
    const file = join(transcriptsDir, id, `${id}.jsonl`)
    if (existsSync(file)) out.push(id)
  }
  out.sort()
  return out
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
  opts?: { config?: IdentityConfig; modelsPath?: string; agentsDir?: string },
): BotIdentity {
  if (opts?.config && Object.hasOwn(opts.config.overrides, id)) {
    return resolveIdentity(id, { config: opts.config })
  }
  return makeIdentityLookup({
    agentsDir: opts?.agentsDir,
    modelsPath: opts?.modelsPath,
  }).identity(id)
}

const TRANSCRIPT_PATH_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]\1\.jsonl$/i

/** On-disk agent-transcripts layout: `<uuid>/<uuid>.jsonl`. */
export function agentIdFromTranscriptPath(file: string): string | undefined {
  const m = TRANSCRIPT_PATH_RE.exec(file.replace(/\\/g, '/'))
  return m?.[1]
}

/**
 * Backfill / convert agent id: `--agent-id`, then page header, then
 * `<uuid>/<uuid>.jsonl`. Undefined means the file is unidentified — skip it
 * rather than tagging `grokbot-unknown`.
 */
export function resolveSourceAgentId(opts: {
  file: string
  headerId?: string
  explicitId?: string
}): string | undefined {
  const explicit = opts.explicitId?.trim()
  if (explicit) return explicit
  const header = opts.headerId?.trim()
  if (header) return header
  return agentIdFromTranscriptPath(opts.file)
}

export function listInputFiles(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return [path]
  const out: string[] = []
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name)
    let child: ReturnType<typeof statSync>
    try {
      child = statSync(full)
    } catch {
      continue
    }
    if (child.isDirectory()) out.push(...listInputFiles(full))
    else if (name.endsWith('.jsonl') || name.endsWith('.txt')) out.push(full)
  }
  return out
}

/** Look up a roster/override identity from a session key (with or without -v2/-v3/-v3-rows). */
export function identityForSession(
  session: string,
  opts?: { config?: IdentityConfig; modelsPath?: string; agentsDir?: string },
): BotIdentity | undefined {
  const stripped = stripSessionSuffix(session)
  const lookup = makeIdentityLookup({
    agentsDir: opts?.agentsDir,
    modelsPath: opts?.modelsPath,
  })
  const fromRoster = lookup.catalog.models.find(
    (m) => m.session === session || m.session === stripped,
  )
  if (fromRoster) {
    return {
      id: fromRoster.id,
      persona: fromRoster.persona,
      session: fromRoster.session,
      agent: fromRoster.agent,
    }
  }
  const cfg = opts?.config ?? loadIdentityConfig(opts?.modelsPath)
  for (const id of Object.keys(cfg.overrides)) {
    const ident = resolveIdentity(id, { config: cfg })
    if (ident.session === session || ident.session === stripped) return ident
  }
  return undefined
}

export function applySessionSuffix(session: string, suffix?: string): string {
  const s = suffix ?? process.env.GROKBOT_SESSION_SUFFIX ?? SESSION_SUFFIX_V3
  if (!s) return session
  return session.endsWith(s) ? session : session + s
}

export function makeIdentityLookup(opts?: { agentsDir?: string; modelsPath?: string }) {
  let catalog: DiscoverResult
  try {
    catalog = discoverModels(opts)
  } catch {
    const cfg = loadIdentityConfig(opts?.modelsPath)
    catalog = { nodeId: cfg.nodeId, models: [], unmappedTranscripts: [] }
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
