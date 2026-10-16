/**
 * Project tags: every session placed in a canvas project carries a
 * `project:<project name>` memory tag, so Memory → Search (and the
 * `memory_search` tool) can filter by project.
 *
 * Membership is client-only, so the hub applies the tag. The memory backend
 * can only tag a conversation once it has been captured, so a fresh session
 * is retried with backoff until its first capture lands. What has been
 * applied is remembered per session key; a move to another project, a
 * project rename, or a return to History retires the old tag (rejected, so
 * it is never proposed again) — only tags this sync added, never a `project:`
 * the cwd rule derived from the git root.
 */

import { parseTagLiteral, TAG_KEY_PROJECT } from '@rivetos/types'
import type { RivetGateway } from '@rivetos/gateway-client'

const KEY = 'rivethub.projectTags'
/** Bound on remembered sessions; the oldest go first. */
const MAX_ENTRIES = 4000
/** Requests per sync pass — a backfill of many sessions spreads over passes. */
export const PROJECT_TAG_BATCH = 20
/** Marks the tags this sync adds, so retiring one never touches another tagger's. */
export const PROJECT_TAG_REASON = 'RivetHub project'

export interface ProjectTagEntry {
  /** The `project:<name>` literal applied, or pending when `applied` is false. */
  literal: string
  applied: boolean
  /** A literal applied earlier that still has to be retired. */
  retire?: string
  tries: number
  /** Epoch ms before which this entry is not retried. */
  nextAt: number
}

export type ProjectTagLedger = Partial<Record<string, ProjectTagEntry>>

export type ProjectTagStep =
  | { kind: 'add'; sessionKey: string; literal: string }
  | { kind: 'retire'; sessionKey: string; literal: string }

/** `project:<name>`, or undefined when the name has no taggable characters. */
export function projectTagLiteral(name: string): string | undefined {
  const literal = `${TAG_KEY_PROJECT}:${name.trim()}`
  return parseTagLiteral(literal) ? literal : undefined
}

/** Same tag after normalization (`Android Stuff` and `android-stuff` are one). */
export function sameTag(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const pa = parseTagLiteral(a)
  const pb = parseTagLiteral(b)
  return pa !== null && pb !== null && pa.key === pb.key && pa.value === pb.value
}

/** Membership key `${baseUrl}::${sessionKey}` → the session key memory knows. */
export function sessionKeyOf(membershipKey: string): string | undefined {
  const at = membershipKey.indexOf('::')
  const key = at < 0 ? membershipKey : membershipKey.slice(at + 2)
  return key.trim() || undefined
}

/** Session key → the tag literal it should carry now. */
export function desiredProjectTags(
  membership: Record<string, string>,
  spaces: readonly { id: string; name: string }[],
): Map<string, string> {
  const names = new Map(spaces.map((space) => [space.id, space.name]))
  const out = new Map<string, string>()
  for (const [rowKey, spaceId] of Object.entries(membership)) {
    const sessionKey = sessionKeyOf(rowKey)
    const name = names.get(spaceId)
    const literal = name === undefined ? undefined : projectTagLiteral(name)
    if (sessionKey && literal) out.set(sessionKey, literal)
  }
  return out
}

/**
 * Bring the ledger in line with what should be tagged, without any I/O:
 * new or changed sessions become pending adds (carrying the old literal to
 * retire), sessions that left every project become pending retires.
 */
export function reconcileLedger(
  ledger: ProjectTagLedger,
  desired: Map<string, string>,
  now: number,
): ProjectTagLedger {
  const next: ProjectTagLedger = {}
  for (const [sessionKey, entry] of Object.entries(ledger)) {
    if (!entry) continue
    const want = desired.get(sessionKey)
    if (want === undefined) {
      // Left its project. An applied tag is retired; a pending one is dropped.
      const retire = entry.applied ? entry.literal : entry.retire
      if (retire)
        next[sessionKey] = { literal: retire, applied: false, retire, tries: 0, nextAt: now }
      continue
    }
    if (sameTag(entry.literal, want) && !(entry.retire && sameTag(entry.retire, want))) {
      next[sessionKey] = entry
      continue
    }
    const retire = entry.applied ? entry.literal : entry.retire
    next[sessionKey] = {
      literal: want,
      applied: false,
      ...(retire && !sameTag(retire, want) ? { retire } : {}),
      tries: 0,
      nextAt: now,
    }
  }
  for (const [sessionKey, literal] of desired) {
    if (!next[sessionKey]) next[sessionKey] = { literal, applied: false, tries: 0, nextAt: now }
  }
  return next
}

/** The steps due now, at most `limit` sessions, adds before retires. */
export function dueSteps(
  ledger: ProjectTagLedger,
  desired: Map<string, string>,
  now: number,
  limit = PROJECT_TAG_BATCH,
): ProjectTagStep[] {
  const steps: ProjectTagStep[] = []
  let sessions = 0
  for (const [sessionKey, entry] of Object.entries(ledger)) {
    if (sessions >= limit) break
    if (!entry || entry.nextAt > now) continue
    const wanted = desired.has(sessionKey)
    if (wanted && !entry.applied) {
      sessions += 1
      steps.push({ kind: 'add', sessionKey, literal: entry.literal })
      if (entry.retire) steps.push({ kind: 'retire', sessionKey, literal: entry.retire })
    } else if (!wanted && entry.retire) {
      sessions += 1
      steps.push({ kind: 'retire', sessionKey, literal: entry.retire })
    }
  }
  return steps
}

/** Not captured yet (or any failure): back off 1, 2, 4 … minutes, capped at an hour. */
export function backoffMs(tries: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, tries - 1))
}

export function loadLedger(): ProjectTagLedger {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ProjectTagLedger = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<ProjectTagEntry> | null
      if (!entry || typeof entry.literal !== 'string') continue
      out[key] = {
        literal: entry.literal,
        applied: entry.applied === true,
        ...(typeof entry.retire === 'string' ? { retire: entry.retire } : {}),
        tries: typeof entry.tries === 'number' ? entry.tries : 0,
        nextAt: typeof entry.nextAt === 'number' ? entry.nextAt : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveLedger(ledger: ProjectTagLedger): void {
  const entries = Object.entries(ledger)
  const kept = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage full or blocked: the next pass re-adds, which is idempotent.
  }
}

async function retireTag(
  endpoint: { gateway: RivetGateway },
  sessionKey: string,
  literal: string,
): Promise<void> {
  const parsed = parseTagLiteral(literal)
  if (!parsed) return
  const found = await endpoint.gateway.memoryTagsLookup({ session_keys: [sessionKey] })
  const ids = (found.sessions[sessionKey] ?? [])
    .filter(
      (tag) =>
        tag.key === TAG_KEY_PROJECT &&
        tag.value === parsed.value &&
        tag.state === 'accepted' &&
        tag.reason === PROJECT_TAG_REASON,
    )
    .map((tag) => tag.id)
  if (ids.length > 0) await endpoint.gateway.memoryTagsDecide({ ids, state: 'rejected' })
}

/** One pass. Returns the ledger to keep. */
export async function syncProjectTags(
  endpoint: { gateway: RivetGateway },
  ledger: ProjectTagLedger,
  desired: Map<string, string>,
  now: number,
): Promise<ProjectTagLedger> {
  const reconciled = reconcileLedger(ledger, desired, now)
  const next = new Map(Object.entries(reconciled))
  for (const step of dueSteps(reconciled, desired, now)) {
    const entry = next.get(step.sessionKey)
    if (!entry) continue
    try {
      if (step.kind === 'add') {
        await endpoint.gateway.memoryTagsAdd({
          entity_type: 'conversation',
          session_key: step.sessionKey,
          tag: step.literal,
          reason: PROJECT_TAG_REASON,
        })
        next.set(step.sessionKey, { ...entry, applied: true, tries: 0, nextAt: 0 })
      } else {
        await retireTag(endpoint, step.sessionKey, step.literal)
        if (desired.has(step.sessionKey)) {
          const { retire: _done, ...rest } = next.get(step.sessionKey) ?? entry
          next.set(step.sessionKey, rest)
        } else {
          next.delete(step.sessionKey)
        }
      }
    } catch {
      // Usually "no conversation captured" — the session has not run yet.
      const tries = entry.tries + 1
      next.set(step.sessionKey, { ...entry, tries, nextAt: now + backoffMs(tries) })
    }
  }
  return Object.fromEntries(next)
}
