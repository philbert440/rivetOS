/**
 * The rule-based `project:` tag: which project a capture's working directory
 * belongs to. The rule itself is pure (`resolveProjectFromCwd` in
 * `@rivetos/types`); this is its bounded, cached filesystem probe and the
 * planning step every backend runs before it writes the tag its own way.
 */

import { readFile, stat } from 'node:fs/promises'
import {
  NO_FS,
  isSafeAbsolutePath,
  resolveProjectFromCwd,
  type ProjectRuleFs,
  type ProjectRuleResult,
} from '@rivetos/types'

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
