import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseKnownTime, timestampTagsInText } from './timestamps.js'
import {
  DEFAULT_AGENT_PREFIX,
  DEFAULT_NODE_ID,
  SESSION_SUFFIX_V3,
  stripSessionSuffix,
  type BotIdentity,
} from './types.js'

const UUID_RE = /^[0-9a-f-]{36}$/i
/** Grok Bot unused-slot product name. Not a house-bot list. */
const UNUSED_SLOT_NAME = 'new bot'
const PLACEHOLDER_KINDS = new Set(['placeholder', 'unused'])
const PROFILE_META_KEYS = new Set(['name', 'placeholder', 'unused', 'kind'])

/**
 * Roster tags are derived at runtime from each host profile.json under
 * agent-data/agents. Committed models.json ships no overrides. Per-install
 * pins, prefix, and exclusions live in gitignored models.local.json or env.
 */

export interface IdentityConfig {
  nodeId: string
  /** First segment of the agent tag. Default `grokbot` → `grokbot-<slug>`. */
  agentPrefix: string
  /** Optional per-install exclusions from models.local.json. Default empty. */
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

export function sanitizeAgentPrefix(raw: string): string {
  return raw.replace(/^-+|-+$/g, '') || DEFAULT_AGENT_PREFIX
}

export function resolveAgentPrefix(explicit?: string): string {
  return sanitizeAgentPrefix(explicit || process.env.GROKBOT_AGENT_PREFIX || DEFAULT_AGENT_PREFIX)
}

export function subagentAgent(prefix?: string): string {
  return `${resolveAgentPrefix(prefix)}-run`
}

export function sessionTag(nodeId: string, personaSlug: string): string {
  return `${nodeId}-${personaSlug}`
}

export function agentTag(prefix: string, personaSlug: string): string {
  return `${prefix}-${personaSlug}`
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

function applyModelsFile(cfg: IdentityConfig, raw: Record<string, unknown>): void {
  if (typeof raw.nodeId === 'string' && raw.nodeId) cfg.nodeId = raw.nodeId
  if (typeof raw.agentPrefix === 'string' && raw.agentPrefix) {
    cfg.agentPrefix = sanitizeAgentPrefix(raw.agentPrefix)
  }
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
}

function readModelsObject(path: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  } catch {
    /* ignore bad file */
  }
  return undefined
}

export function localModelsPath(modelsPath?: string): string {
  if (process.env.GROKBOT_MODELS_LOCAL) return process.env.GROKBOT_MODELS_LOCAL
  const base = modelsPath ?? defaultModelsPath()
  return join(dirname(base), 'models.local.json')
}

export function loadIdentityConfig(modelsPath?: string): IdentityConfig {
  const cfg: IdentityConfig = {
    nodeId: process.env.GROKBOT_NODE_ID || DEFAULT_NODE_ID,
    agentPrefix: resolveAgentPrefix(),
    excludeNames: new Set(),
    overrides: {},
  }
  const path = modelsPath ?? defaultModelsPath()
  if (path && existsSync(path)) {
    const raw = readModelsObject(path)
    if (raw) applyModelsFile(cfg, raw)
  }
  const localPath = localModelsPath(path)
  if (localPath && existsSync(localPath) && localPath !== path) {
    const raw = readModelsObject(localPath)
    if (raw) applyModelsFile(cfg, raw)
  }
  return cfg
}

export function defaultModelsPath(): string {
  return process.env.GROKBOT_MODELS || join(fileDir(), 'models.json')
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
  /** On-disk transcript ids not on the roster or overrides. */
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
    const prof = readProfileObject(profPath)
    if (!prof) continue
    if (isPlaceholderProfile(prof) || isSubagentProfile(prof)) continue
    const name = typeof prof.name === 'string' && prof.name.trim() ? prof.name.trim() : id.slice(0, 8)
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
    session: ov.session || ov.sessionId || sessionTag(cfg.nodeId, s),
    agent: ov.agent || ov.agentId || agentTag(cfg.agentPrefix, s),
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

/** On-disk agent-transcripts layout: uuid/uuid.jsonl. */
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

const PARENT_ID_KEYS = [
  'parentId',
  'parent_id',
  'parentSession',
  'parent_session',
  'parentSessionId',
  'parent_session_id',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readProfileObject(profPath: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(readFileSync(profPath, 'utf8')) as unknown
    return isRecord(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

function hasExtraIdentity(prof: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(prof)) {
    if (PROFILE_META_KEYS.has(key)) continue
    if (value == null || value === '' || value === false) continue
    return true
  }
  return false
}

/** Unused-slot / placeholder profiles: flags, kind, or the product unused name. */
export function isPlaceholderProfile(prof: Record<string, unknown>): boolean {
  if (prof.placeholder === true || prof.unused === true) return true
  if (typeof prof.kind === 'string' && PLACEHOLDER_KINDS.has(prof.kind.toLowerCase())) return true
  const name = typeof prof.name === 'string' ? prof.name.trim() : ''
  if (!name) return true
  return name.toLowerCase() === UNUSED_SLOT_NAME && !hasExtraIdentity(prof)
}

/** Child / spawn transcripts: parent id, or an explicit subagent flag. */
export function isSubagentProfile(prof: Record<string, unknown>): boolean {
  if (prof.subagent === true) return true
  if (typeof prof.kind === 'string' && prof.kind.toLowerCase() === 'subagent') return true
  return Boolean(parentSessionIdFromUnknown(prof))
}

/** Cheap parent UUID from a profile / first record (`parentId` and aliases). */
export function parentSessionIdFromUnknown(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  for (const key of PARENT_ID_KEYS) {
    const v = raw[key]
    if (typeof v !== 'string' || !v.trim()) continue
    const m = UUID_RE.exec(v.trim())
    if (m) return m[0]
  }
  return undefined
}

const PARENT_PEEK_BYTES = 32_768

function peekFileWindows(file: string): string[] {
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const fd = openSync(file, 'r')
    try {
      const tailStart = Math.max(0, size - PARENT_PEEK_BYTES)
      const tailLen = Math.min(PARENT_PEEK_BYTES, size - tailStart)
      const tail = Buffer.alloc(tailLen)
      readSync(fd, tail, 0, tailLen, tailStart)
      const windows = [tail.toString('utf8')]
      if (tailStart > 0) {
        const head = Buffer.alloc(Math.min(PARENT_PEEK_BYTES, tailStart))
        readSync(fd, head, 0, head.length, 0)
        windows.push(head.toString('utf8'))
      }
      return windows
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

function profileCreatedAt(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  return parseKnownTime(raw.createdAt ?? raw.created_at ?? raw.createdAtMs ?? raw.timestampMs)
}

function stampAtOrBefore(
  tags: Array<{ time: string; index: number }>,
  mentionIndex: number,
): string | undefined {
  let best: string | undefined
  for (const tag of tags) {
    if (tag.index <= mentionIndex) best = tag.time
  }
  return best
}

function stampNearestSpawn(stamps: string[], spawnMs: number): string | undefined {
  let best: string | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (const stamp of stamps) {
    const t = Date.parse(stamp)
    if (Number.isNaN(t)) continue
    const dist = Math.abs(t - spawnMs)
    if (dist < bestDist) {
      best = stamp
      bestDist = dist
    }
  }
  return best
}

/**
 * Inherit from a parent session only when the child's spawn time is knowable:
 * the parent transcript mentions the child UUID near a `<timestamp>`, or the
 * child profile has createdAt. Never seed from the parent's last stamp alone.
 */
export function peekParentLastKnownTime(opts: {
  sourcePath?: string
  records?: unknown[]
  agentsDir?: string
  transcriptsDir?: string
}): string | undefined {
  let parentId: string | undefined
  let spawnFromRecords: string | undefined
  for (const rec of opts.records ?? []) {
    if (!parentId) {
      parentId = parentSessionIdFromUnknown(rec)
      if (!parentId && isRecord(rec) && isRecord(rec.message)) {
        parentId = parentSessionIdFromUnknown(rec.message)
      }
    }
    if (!spawnFromRecords && isRecord(rec)) {
      spawnFromRecords = parseKnownTime(rec.created_at ?? rec.createdAt ?? rec.timestampMs)
    }
    if (parentId && spawnFromRecords) break
  }
  const childId = opts.sourcePath ? agentIdFromTranscriptPath(opts.sourcePath) : undefined
  let spawnFromProfile: string | undefined
  if (childId) {
    const agentsDir = opts.agentsDir ?? defaultAgentsDir()
    const profPath = join(agentsDir, childId, 'profile.json')
    if (existsSync(profPath)) {
      try {
        const prof = JSON.parse(readFileSync(profPath, 'utf8')) as unknown
        parentId ??= parentSessionIdFromUnknown(prof)
        spawnFromProfile = profileCreatedAt(prof)
      } catch {
        /* ignore bad profile */
      }
    }
  }
  if (!parentId || parentId === childId) return undefined
  const transcriptsDir =
    opts.transcriptsDir ??
    (opts.sourcePath ? dirname(dirname(opts.sourcePath)) : defaultTranscriptsDir())
  const parentFile = join(transcriptsDir, parentId, `${parentId}.jsonl`)
  if (!existsSync(parentFile)) return undefined

  const windows = peekFileWindows(parentFile)
  const stamps: string[] = []
  let mentionStamp: string | undefined
  for (const text of windows) {
    const tags = timestampTagsInText(text)
    for (const tag of tags) stamps.push(tag.time)
    if (!mentionStamp && childId) {
      const mention = text.toLowerCase().indexOf(childId.toLowerCase())
      if (mention >= 0) mentionStamp = stampAtOrBefore(tags, mention) ?? tags[0]?.time
    }
  }
  if (mentionStamp) return mentionStamp
  const spawn = spawnFromProfile ?? spawnFromRecords
  if (!spawn) return undefined
  return stampNearestSpawn(stamps, Date.parse(spawn))
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
        agent: subagentAgent(cfg.agentPrefix),
      }
    },
  }
}
