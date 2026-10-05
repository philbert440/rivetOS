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
import { dirname, join } from 'node:path'
import { parseKnownTime, timestampTagsInText } from './timestamps.js'
import {
  DEFAULT_AGENT_PREFIX,
  DEFAULT_NODE_ID,
  SESSION_SUFFIX_V3,
  isBackfillSession,
  stripSessionSuffix,
  type BotIdentity,
} from './types.js'

const UUID_RE = /^[0-9a-f-]{36}$/i
/** Grok Bot unused-slot product name. Not a house-bot list. */
const UNUSED_SLOT_NAME = 'new bot'
const PLACEHOLDER_KINDS = new Set(['placeholder', 'unused'])
const PROFILE_META_KEYS = new Set(['name', 'placeholder', 'unused', 'kind'])

/**
 * Roster tags are derived at runtime from each host agents/<uuid>/profile.json.
 * There is no bot list and no override file. Generic settings are env only:
 * GROKBOT_NODE_ID, GROKBOT_AGENTS, GROKBOT_TRANSCRIPTS /
 * GROKBOT_TRANSCRIPT_ROOT, GROKBOT_AGENT_PREFIX, GROKBOT_SESSION_SUFFIX.
 *
 * Derivation (one rule):
 *   persona = profile.json name
 *   slug    = slugify(name): lowercased, non-alphanumeric runs become "-",
 *             trim "-", empty becomes "agent"
 *   session = `${nodeId}-${slug}`   (nodeId default `grokbot`)
 *   agent   = `${prefix}-${slug}`   (prefix default `grokbot`)
 *
 * Collision: if two or more profiles share a slug, every colliding member
 * is suffixed `${slug}-${compactId.slice(0, 8)}` (more of the id if that
 * is still taken). Solo slugs stay bare. Adding a bot never steals a bare
 * slug via UUID sort order. A new collision (1→2) suffixes the original.
 */

export interface IdentityConfig {
  nodeId: string
  /** First segment of the agent tag. Default `grokbot` → `grokbot-<slug>`. */
  agentPrefix: string
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

/** Always `${base}-<id prefix>`; grows the prefix until the candidate is free. */
export function suffixedSlug(base: string, id: string, used: Set<string>): string {
  const compact = id.replace(/-/g, '')
  for (let n = 8; n <= compact.length; n++) {
    const candidate = `${base}-${compact.slice(0, n)}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${compact}`
}

/** First unused slug; a taken base appends a growing prefix of the UUID. */
export function uniqueSlug(base: string, id: string, used: Set<string>): string {
  if (!used.has(base)) return base
  return suffixedSlug(base, id, used)
}

export function deriveIdentity(
  id: string,
  persona: string,
  cfg: IdentityConfig,
  used?: Set<string>,
  collide = false,
): BotIdentity {
  const base = slug(persona)
  const s = !used ? base : collide ? suffixedSlug(base, id, used) : uniqueSlug(base, id, used)
  used?.add(s)
  return {
    id,
    persona,
    session: sessionTag(cfg.nodeId, s),
    agent: agentTag(cfg.agentPrefix, s),
  }
}

export function loadIdentityConfig(): IdentityConfig {
  return {
    nodeId: process.env.GROKBOT_NODE_ID || DEFAULT_NODE_ID,
    agentPrefix: resolveAgentPrefix(),
  }
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
  /** On-disk transcript ids not on the discovered roster. */
  unmappedTranscripts: string[]
}

export function discoverModels(opts?: {
  agentsDir?: string
  transcriptsDir?: string
}): DiscoverResult {
  const cfg = loadIdentityConfig()
  const agentsDir = opts?.agentsDir ?? defaultAgentsDir()
  const transcriptsDir = opts?.transcriptsDir ?? defaultTranscriptsDir()
  const candidates: Array<{ id: string; name: string }> = []
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
    const name =
      typeof prof.name === 'string' && prof.name.trim() ? prof.name.trim() : id.slice(0, 8)
    candidates.push({ id, name })
    seen.add(id)
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id))
  const slugCounts = new Map<string, number>()
  for (const c of candidates) {
    const s = slug(c.name)
    slugCounts.set(s, (slugCounts.get(s) ?? 0) + 1)
  }
  const used = new Set<string>()
  const out: Array<BotIdentity & { transcript: string }> = candidates.map(({ id, name }) => {
    const collide = (slugCounts.get(slug(name)) ?? 0) > 1
    const identity = deriveIdentity(id, name, cfg, used, collide)
    const transcript = join(transcriptsDir, id, `${id}.jsonl`)
    return { ...identity, transcript }
  })
  const unmappedTranscripts = listUnmappedTranscripts(transcriptsDir, seen)
  out.sort((a, b) => a.persona.localeCompare(b.persona) || a.id.localeCompare(b.id))
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
  opts?: { config?: IdentityConfig; name?: string },
): BotIdentity {
  const cfg = opts?.config ?? loadIdentityConfig()
  const persona = opts?.name || id.slice(0, 8)
  return deriveIdentity(id, persona, cfg)
}

export function identityFor(
  id: string,
  opts?: { config?: IdentityConfig; agentsDir?: string },
): BotIdentity {
  return makeIdentityLookup({
    agentsDir: opts?.agentsDir,
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

/** Slug used in `grokbot-<slug>` session / agent tags (collision suffix included). */
export function personaSlugFromIdentity(ident: BotIdentity, cfg?: IdentityConfig): string {
  const resolved = cfg ?? loadIdentityConfig()
  if (ident.session.startsWith(`${resolved.nodeId}-`)) {
    return ident.session.slice(resolved.nodeId.length + 1)
  }
  if (ident.agent.startsWith(`${resolved.agentPrefix}-`)) {
    return ident.agent.slice(resolved.agentPrefix.length + 1)
  }
  return slug(ident.persona)
}

/**
 * Roster base for a backfill session key. Lookup only — never a write target.
 * `grokbot-alpha-v4-backfill` → `grokbot-alpha`.
 * `grokbot-alpha-v4-backfill-r2` → `grokbot-alpha`.
 */
export function backfillIdentityBase(session: string): string | undefined {
  if (!isBackfillSession(session)) return undefined
  const stripped = session.replace(/-v\d+-backfill(?:-[a-z0-9]+)?$/, '')
  return stripped === session ? undefined : stripped
}

/** Roster lookup by the same slug discovery already derived from profile.json. */
export function identityForSlug(
  want: string,
  opts?: { agentsDir?: string; config?: IdentityConfig; catalog?: DiscoverResult },
): BotIdentity | undefined {
  const cfg = opts?.config ?? loadIdentityConfig()
  const models =
    opts?.catalog?.models ?? makeIdentityLookup({ agentsDir: opts?.agentsDir }).catalog.models
  return models.find((m) => personaSlugFromIdentity(m, cfg) === want)
}

/** Look up a discovered identity from a session key (with or without -v2/-v3/-v3-rows). */
export function identityForSession(
  session: string,
  opts?: { agentsDir?: string },
): BotIdentity | undefined {
  const stripped = backfillIdentityBase(session) ?? stripSessionSuffix(session)
  const lookup = makeIdentityLookup({
    agentsDir: opts?.agentsDir,
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

export function makeIdentityLookup(opts?: { agentsDir?: string }) {
  let catalog: DiscoverResult
  try {
    catalog = discoverModels(opts)
  } catch {
    const cfg = loadIdentityConfig()
    catalog = { nodeId: cfg.nodeId, models: [], unmappedTranscripts: [] }
  }
  const byId = new Map(catalog.models.map((m) => [m.id, m]))
  const cfg = loadIdentityConfig()
  return {
    catalog,
    identity(id: string): BotIdentity {
      const m = byId.get(id)
      if (m) return { id: m.id, persona: m.persona, session: m.session, agent: m.agent }
      return {
        id,
        persona: 'run',
        session: `${catalog.nodeId}-run-${id}`,
        agent: subagentAgent(cfg.agentPrefix),
      }
    },
  }
}
