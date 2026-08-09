/**
 * wire — the on-disk half of the kimi-code executor: finding a session's
 * transcript and reading back what stdout never carried.
 *
 * kimi's `stream-json` has no usage and no result event. Its own transcript
 * does: every session writes append-only `wire.jsonl` files under
 * `$KIMI_CODE_HOME/sessions/<bucket>/<session_id>/agents/<slot>/`, and those
 * carry per-request `usage.record`s and (protocol 1.5+) a terminal
 * `turn.ended` with a reason and a duration.
 *
 * This module is deliberately POST-HOC: the executor reads it after the child
 * has exited. That removes every race a tail would have (fsync happens per
 * batch, not per event; attribution of a freshly created session dir is
 * ambiguous under concurrent same-cwd spawns; a `rewrite()` can swap the inode
 * mid-read). A finished process leaves a complete file, and the one damaged
 * line a SIGKILL can leave behind is tolerated the same way kimi's own reader
 * tolerates it (`allowTruncated`: a corrupt line is skipped, not fatal).
 *
 * Verified shapes (kimi-code 0.34.0, 91 real transcripts on the rivet-kimi node):
 *   {"type":"metadata","protocol_version":"1.5","created_at":1786283856251}
 *   {"type":"usage.record","model":"…","usage":{"inputOther":13412,"output":21,
 *     "inputCacheRead":11264,"inputCacheCreation":0},"usageScope":"turn","time":…}
 *   {"type":"turn.ended","turnId":0,"reason":"completed","durationMs":3465,"time":…}
 *
 * Two facts the numbers depend on:
 *   - `usageScope` is `"turn"` for per-request records and `"session"` for
 *     session-scoped rollups. Summing both double-counts, so only `"turn"`
 *     records are added.
 *   - A turn emits ONE `usage.record` per LLM request, not one per turn
 *     (observed up to 405 in a single long session), so the reconcile sums
 *     every record at or after the spawn clock.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Transcript file name inside an agent slot directory. */
export const WIRE_FILE = 'wire.jsonl'

/** Session-id → session-dir index kimi maintains at the home root. */
export const SESSION_INDEX_FILE = 'session_index.jsonl'

/** `$KIMI_CODE_HOME`, else `~/.kimi-code` — kimi's own `resolveKimiHome`. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.KIMI_CODE_HOME?.trim()
  return explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), '.kimi-code')
}

/** `<home>/sessions`. */
export function sessionsRoot(home: string): string {
  return path.join(home, 'sessions')
}

/**
 * The 12-hex workspace-bucket suffix for a working directory.
 *
 * kimi names a bucket `wd_<slug>_<sha256(root)[:12]>` (`encodeWorkDirKey`).
 * The formula was checked against all nine buckets on the rivet-kimi node and
 * matched every one. Only the HASH is reproduced here — the slug rules are
 * kimi's business, and matching on the suffix keeps this working if they
 * change.
 */
export function workDirHash(cwd: string): string {
  return crypto.createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, 12)
}

/** The bucket directory for `cwd`, if kimi has already created one. */
export function findBucketDir(root: string, cwd: string): string | undefined {
  const suffix = `_${workDirHash(cwd)}`
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return undefined
  }
  const match = entries.find((name) => name.startsWith('wd_') && name.endsWith(suffix))
  return match === undefined ? undefined : path.join(root, match)
}

export interface SessionIndexEntry {
  sessionId: string
  sessionDir: string
  workDir?: string
}

/**
 * Read `session_index.jsonl`. This is the authoritative id → directory map and
 * it survives any future change to the bucket-naming scheme, so it is tried
 * first; the hash formula is the fallback for a home whose index is missing or
 * lagging.
 */
export function readSessionIndex(home: string): SessionIndexEntry[] {
  let text: string
  try {
    text = fs.readFileSync(path.join(home, SESSION_INDEX_FILE), 'utf8')
  } catch {
    return []
  }
  const out: SessionIndexEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row: unknown = JSON.parse(trimmed)
      if (typeof row !== 'object' || row === null) continue
      const { sessionId, sessionDir, workDir } = row as Record<string, unknown>
      if (typeof sessionId !== 'string' || typeof sessionDir !== 'string') continue
      out.push({
        sessionId,
        sessionDir,
        ...(typeof workDir === 'string' ? { workDir } : {}),
      })
    } catch {
      continue
    }
  }
  return out
}

export interface SessionLocation {
  home: string
  cwd: string
  sessionId: string
}

/** Absolute session directory for a known session id, or undefined. */
export function resolveSessionDir(loc: SessionLocation): string | undefined {
  const indexed = readSessionIndex(loc.home).find((e) => e.sessionId === loc.sessionId)
  if (indexed && dirExists(indexed.sessionDir)) return indexed.sessionDir
  const bucket = findBucketDir(sessionsRoot(loc.home), loc.cwd)
  if (bucket === undefined) return undefined
  const guess = path.join(bucket, loc.sessionId)
  return dirExists(guess) ? guess : undefined
}

/**
 * Every session id kimi knows for `cwd`.
 *
 * Used for the failure path only: a turn that throws never reaches
 * `writeResumeHint`, so stdout carries no session id at all. Snapshotting the
 * ids before the spawn and diffing after recovers it — one new id is the
 * spawn's, several means concurrent same-cwd spawns and the executor declines
 * to guess.
 */
export function listSessionIds(home: string, cwd: string): Set<string> {
  const ids = new Set<string>()
  for (const entry of readSessionIndex(home)) {
    if (entry.workDir !== undefined && path.resolve(entry.workDir) !== path.resolve(cwd)) continue
    ids.add(entry.sessionId)
  }
  const bucket = findBucketDir(sessionsRoot(home), cwd)
  if (bucket !== undefined) {
    try {
      for (const name of fs.readdirSync(bucket)) {
        if (name.startsWith('session_')) ids.add(name)
      }
    } catch {
      /* unreadable bucket — the index half still stands */
    }
  }
  return ids
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface WireTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface WireTurnEnd {
  reason: string
  turnId?: number
  durationMs?: number
  timeMs: number
}

export interface WireTurnFacts {
  usage: WireTurnUsage
  /** `usage.record` lines counted into `usage`. Zero means "found nothing". */
  usageRecords: number
  /** Newest `turn.ended` at or after the spawn clock, when the protocol has one. */
  turnEnded?: WireTurnEnd
  /** Agent-slot transcripts read (main plus any subagent slots). */
  files: number
  /** Lines that were not parseable JSON — tolerated, never fatal. */
  malformed: number
}

export function emptyWireTurnFacts(): WireTurnFacts {
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageRecords: 0,
    files: 0,
    malformed: 0,
  }
}

/** `<sessionDir>/agents/<slot>/wire.jsonl` for every slot, `main` first. */
export function wireFilesFor(sessionDir: string): string[] {
  const agents = path.join(sessionDir, 'agents')
  let slots: string[]
  try {
    slots = fs.readdirSync(agents).sort()
  } catch {
    return []
  }
  const files = slots
    .map((slot) => path.join(agents, slot, WIRE_FILE))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })
  return files.sort(
    (a, b) =>
      Number(b.includes(`${path.sep}main${path.sep}`)) -
      Number(a.includes(`${path.sep}main${path.sep}`)),
  )
}

/**
 * Sum one turn's usage out of a session's transcripts.
 *
 * `sinceMs` is the spawn clock: wire records carry the same machine's
 * `Date.now()`, and a resumed session's file holds every previous turn too, so
 * the floor is what separates this turn from its predecessors. Subagent slots
 * are included — a turn that fans out to `agent-0…n` really did spend those
 * tokens, and reading `main` alone would silently under-report it.
 *
 * Never throws: an unreadable file or a torn line degrades the numbers, and
 * zero usage is a truthful "we could not tell", not a failed turn.
 */
export function reconcileTurn(opts: { sessionDir: string; sinceMs: number }): WireTurnFacts {
  const facts = emptyWireTurnFacts()
  for (const file of wireFilesFor(opts.sessionDir)) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    facts.files += 1
    const isMain = file.includes(`${path.sep}main${path.sep}`)
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        // kimi's own reader skips a corrupt line under `allowTruncated`; a
        // SIGKILLed session leaves at most the last one half-written.
        facts.malformed += 1
        continue
      }
      if (typeof row !== 'object' || row === null) {
        facts.malformed += 1
        continue
      }
      const record = row as Record<string, unknown>
      const timeMs = typeof record.time === 'number' ? record.time : undefined
      if (timeMs === undefined || timeMs < opts.sinceMs) continue

      if (record.type === 'usage.record' && record.usageScope === 'turn') {
        const usage = record.usage
        if (typeof usage === 'object' && usage !== null) {
          const u = usage as Record<string, unknown>
          facts.usage.inputTokens +=
            num(u.inputOther) + num(u.inputCacheRead) + num(u.inputCacheCreation)
          facts.usage.outputTokens += num(u.output)
          facts.usageRecords += 1
        }
        continue
      }

      // Subagent slots close their own turns; only the main slot's `turn.ended`
      // is the task turn's terminal marker.
      if (record.type === 'turn.ended' && isMain && typeof record.reason === 'string') {
        const ended: WireTurnEnd = {
          reason: record.reason,
          timeMs,
          ...(typeof record.turnId === 'number' ? { turnId: record.turnId } : {}),
          ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
        }
        if (facts.turnEnded === undefined || ended.timeMs >= facts.turnEnded.timeMs) {
          facts.turnEnded = ended
        }
      }
    }
  }
  facts.usage.totalTokens = facts.usage.inputTokens + facts.usage.outputTokens
  return facts
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
