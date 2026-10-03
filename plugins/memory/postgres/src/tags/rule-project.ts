/**
 * Rule-based `project:` tag on capture.
 *
 * Two phases, split so nothing slow or fallible sits inside the capture
 * transaction:
 *
 *   1. `planProjectRuleTag` — BEFORE `BEGIN`. Turns the hook-recorded
 *      `settings.cwd` into a tag proposal. The filesystem is read only for
 *      owner batches (`allowFilesystem`): a routed user's batch comes from
 *      another machine or another tenant, and its caller-supplied path must
 *      never be resolved against this host — for those only the pure
 *      cwd-basename rule runs. Reads are async, each bounded by a timeout
 *      (a hung NFS mount must not stall capture), the ancestor walk is
 *      bounded, and results are cached per cwd.
 *   2. `applyProjectRuleTag` — inside the transaction, under a SAVEPOINT.
 *      Capture must never lose messages because of tagging: any failure here
 *      (ros_tags missing on a database that has not run 0019, a permission
 *      error, …) is rolled back to the savepoint and logged, and capture
 *      carries on.
 *
 * This runs on every capture batch that carries settings, not only when the
 * session is created; it is idempotent because the rule writes at most ONE
 * project tag per conversation, the first directory it sees. A session that
 * later moves to another repository keeps that first tag: a second project
 * ("integrating two projects") is a judgement, added by a person or accepted
 * from the tagger, not inferred from a `cd`.
 *
 * A fact derived from the session's directory is not a suggestion, so the
 * tag is born accepted (decided_by = the rule name). The review loop still
 * wins: the tag is written at most once per conversation, a rejected row
 * blocks it, a rejected vocabulary value is skipped, and a value that was
 * merged into another resolves to the survivor instead of resurrecting.
 */

import { readFile, stat } from 'node:fs/promises'
import {
  NO_FS,
  PROJECT_RULE_NAME,
  isSafeAbsolutePath,
  resolveProjectFromCwd,
  type ProjectRuleFs,
  type ProjectRuleResult,
} from '@rivetos/types'
import type { PoolClient } from 'pg'

/** Per filesystem call. */
export const PROJECT_RULE_FS_TIMEOUT_MS = 250
/** Whole resolution (bounded walk × two calls per level). */
export const PROJECT_RULE_BUDGET_MS = 1500
const CACHE_TTL_MS = 10 * 60_000
/** A miss (unreadable path, budget exceeded) is retried soon: a filesystem hiccup must not suppress the tag for long. */
const CACHE_NEGATIVE_TTL_MS = 30_000
const CACHE_MAX = 500

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback)
    }, ms)
    timer.unref()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

export const nodeProjectRuleFs: ProjectRuleFs = {
  isDirectory(path) {
    return withTimeout(
      stat(path).then((st) => st.isDirectory()),
      PROJECT_RULE_FS_TIMEOUT_MS,
      false,
    )
  },
  readFile(path) {
    return withTimeout(
      stat(path).then((st) => {
        // A git config or pointer file is tiny; refuse anything that is not.
        if (!st.isFile() || st.size > 256 * 1024) return null
        return readFile(path, 'utf8')
      }),
      PROJECT_RULE_FS_TIMEOUT_MS,
      null,
    )
  },
}

export type ProjectResolver = (
  cwd: string,
) => ProjectRuleResult | null | Promise<ProjectRuleResult | null>

/**
 * The rule over a given fs, time-boxed and cached per cwd. Each resolver owns
 * its cache. On budget expiry the wrapper answers null and the underlying
 * calls are left to finish on their own (each is itself bounded by the
 * per-call timeout); their late result is discarded.
 */
export function createCachedProjectResolver(
  fs: ProjectRuleFs,
): ProjectResolver & { clear: () => void } {
  const cache = new Map<string, { at: number; hit: ProjectRuleResult | null }>()
  const resolve = async (cwd: string): Promise<ProjectRuleResult | null> => {
    const now = Date.now()
    const cached = cache.get(cwd)
    if (cached && now - cached.at < (cached.hit ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS)) {
      return cached.hit
    }
    const hit = await withTimeout(resolveProjectFromCwd(cwd, fs), PROJECT_RULE_BUDGET_MS, null)
    cache.delete(cwd)
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(cwd, { at: now, hit })
    return hit
  }
  return Object.assign(resolve, {
    clear: () => {
      cache.clear()
    },
  })
}

const nodeResolver = createCachedProjectResolver(nodeProjectRuleFs)

/** Test hook: forget what the default resolver cached. */
export function clearProjectRuleCache(): void {
  nodeResolver.clear()
}

/** Default resolver for owner batches: node:fs, time-boxed, cached. */
export const resolveProjectOnNode: ProjectResolver = nodeResolver

/** The rule without any filesystem access: cwd basename only. */
export const resolveProjectWithoutFs: ProjectResolver = (cwd) => resolveProjectFromCwd(cwd, NO_FS)

/** `settings.cwd` when it is a trimmed, safe absolute path, else undefined. */
export function cwdFromSettings(settings: Record<string, unknown> | undefined): string | undefined {
  const raw = settings?.cwd
  if (typeof raw !== 'string') return undefined
  const cwd = raw.trim()
  return cwd !== '' && cwd.length <= 4096 && isSafeAbsolutePath(cwd) ? cwd : undefined
}

export interface ProjectRuleOptions {
  /**
   * Resolver used when the filesystem is allowed (tests inject one), or
   * `null` to disable the rule. Default: `resolveProjectOnNode`.
   */
  resolveProject?: ProjectResolver | null
  /**
   * May `settings.cwd` be resolved against this host's filesystem? True only
   * for the node owner's batches. Default true (in-process callers are the
   * owner); the HTTP capture route passes false for routed users, and then
   * only the basename rule runs, whatever resolver was injected.
   */
  allowFilesystem?: boolean
}

/**
 * Phase 1, outside any transaction. Never throws: a resolver failure means
 * no tag.
 */
export async function planProjectRuleTag(
  settings: Record<string, unknown> | undefined,
  options: ProjectRuleOptions = {},
  log: (line: string) => void = (line) => {
    console.warn(line)
  },
): Promise<ProjectRuleResult | null> {
  if (options.resolveProject === null) return null
  const cwd = cwdFromSettings(settings)
  if (cwd === undefined) return null
  const resolve =
    options.allowFilesystem === false
      ? resolveProjectWithoutFs
      : (options.resolveProject ?? resolveProjectOnNode)
  try {
    return await resolve(cwd)
  } catch (err) {
    log(`[memory] project rule resolve failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

let warnedMissingSchema = false

/** Test hook. */
export function resetProjectRuleWarnings(): void {
  warnedMissingSchema = false
}

/**
 * Phase 2, inside the capture transaction. Returns true when a row was
 * written. Never throws for a tagging problem (see the header).
 */
export async function applyProjectRuleTag(
  client: PoolClient,
  conversationId: string,
  hit: ProjectRuleResult,
  log: (line: string) => void = (line) => {
    console.warn(line)
  },
): Promise<boolean> {
  let savepoint = false
  try {
    await client.query('SAVEPOINT rivet_project_rule')
    savepoint = true
    let wrote = false
    // Once per conversation: a later batch (or a user's rejection of this
    // rule tag, or its re-pointing by a merge) is never overridden.
    const existing = await client.query(
      `SELECT 1 FROM ros_tags
        WHERE entity_type = 'conversation' AND entity_id = $1
          AND key = $2 AND (source = 'rule' OR proposed_by = $3)
        LIMIT 1`,
      // By the rule's identity, not only its source: a person re-adding or
      // re-accepting the rule tag promotes its source to `user`, and that
      // row must still count as "this conversation has its rule tag".
      [conversationId, hit.key, PROJECT_RULE_NAME],
    )
    if ((existing.rowCount ?? existing.rows.length) === 0) {
      // Respect the vocabulary: follow a merge to its survivor, and do not
      // write a value the user rejected.
      const vocab = await client.query<{ value: string; display: string; state: string }>(
        `SELECT value, display, state FROM ros_tag_taxonomy
          WHERE key = $1 AND (value = $2 OR $2 = ANY(aliases))
          ORDER BY (state = 'accepted') DESC, (value = $2) DESC, value
          LIMIT 1`,
        [hit.key, hit.value],
      )
      const entry = vocab.rows.at(0)
      const moved = entry !== undefined && entry.value !== hit.value
      if (entry?.state !== 'rejected') {
        const { rowCount } = await client.query(
          `INSERT INTO ros_tags
             (entity_type, entity_id, key, value, display, source, state,
              proposed_by, reason, decided_by, decided_at)
           VALUES ('conversation', $1, $2, $3, $4, 'rule', 'accepted', $5, $6, $5, now())
           ON CONFLICT (entity_type, entity_id, key, value) DO NOTHING`,
          [
            conversationId,
            hit.key,
            moved ? entry.value : hit.value,
            moved ? entry.display : (hit.display ?? ''),
            PROJECT_RULE_NAME,
            hit.reason ?? '',
          ],
        )
        wrote = (rowCount ?? 0) > 0
      }
    }
    await client.query('RELEASE SAVEPOINT rivet_project_rule')
    return wrote
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // The savepoint undoes the failed statement so the outer transaction is
    // usable again. If even that fails the caller's transaction is already
    // doomed and its own error handling takes over.
    if (savepoint) {
      await client.query('ROLLBACK TO SAVEPOINT rivet_project_rule')
      await client.query('RELEASE SAVEPOINT rivet_project_rule')
    }
    // An unmigrated database fails the same way on every batch: say it once.
    if (/relation "?ros_tag[a-z_]*"? does not exist/i.test(msg)) {
      if (!warnedMissingSchema) {
        warnedMissingSchema = true
        log('[memory] project rule tags are off: tag tables missing (apply migration 0019)')
      }
    } else {
      log(`[memory] project rule tag skipped for ${conversationId.slice(0, 8)}: ${msg}`)
    }
    return false
  }
}
