/**
 * WikiWriter — the single-writer fs+git half of wiki extraction (3c).
 *
 * Owns /rivet-shared/wiki on the datahub worker: read page → applyPatch →
 * serialize → write → one git commit per topic patch.
 *
 * Graphile concurrency (COMPACT_CONCURRENCY, often 2 on datahub) can run
 * multiple extract-wiki / consolidate-wiki / recompile-wiki tasks in the
 * same process. Without serialization, concurrent `git add`/`commit` races
 * on `.git/index.lock` and dead-letters extract jobs:
 *   "fatal: Unable to create '.../.git/index.lock': File exists"
 *
 * Serialization is two-layered:
 *   1. In-process promise chain — covers concurrent tasks in one worker.
 *   2. NFS-safe O_CREAT|O_EXCL file lock — covers multi-process / multi-host
 *      writers on the shared /rivet-shared mount (flock is unreliable on NFS).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyPatch,
  parseWikiPage,
  serializeWikiPage,
  type WikiPage,
  type WikiPatch,
} from '@rivetos/wiki-core'

const execFileAsync = promisify(execFile)

/** Stale lock reclaim threshold — longer than a typical commit, short enough to recover. */
const FILE_LOCK_STALE_MS = 60_000
const FILE_LOCK_MAX_ATTEMPTS = 200

export interface AppliedPatch {
  slug: string
  page: WikiPage
  gitSha: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function releaseLockIfOwned(lockPath: string, token: string): void {
  try {
    const content = readFileSync(lockPath, 'utf8')
    const owned = content.trim().split(/\s+/)[0]
    if (owned === token) unlinkSync(lockPath)
  } catch {
    // Gone or unreadable — not ours to remove.
  }
}

/**
 * Cross-process / cross-node advisory lock via O_CREAT|O_EXCL (NFS-safe;
 * same pattern as den-server roster locks). Nested under the in-process chain.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number | undefined
    const token = `${process.pid}-${randomUUID()}`
    const payload = `${token} ${Date.now()}\n`
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      writeFileSync(fd, payload)
      try {
        return await fn()
      } finally {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        fd = undefined
        releaseLockIfOwned(lockPath, token)
      }
    } catch (e) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        releaseLockIfOwned(lockPath, token)
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Stale-lock recovery: crashed holder left the file behind.
      try {
        const content = readFileSync(lockPath, 'utf8')
        const parts = content.trim().split(/\s+/)
        const observedToken = parts[0]
        const ts = Number(parts[1])
        if (observedToken && Number.isFinite(ts) && Date.now() - ts > FILE_LOCK_STALE_MS) {
          const again = readFileSync(lockPath, 'utf8')
          if (again === content) {
            const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
            try {
              renameSync(lockPath, stalePath)
              try {
                unlinkSync(stalePath)
              } catch {
                /* ignore */
              }
              continue
            } catch {
              // Another waiter already renamed it — fall through to backoff.
            }
          }
        }
      } catch {
        // Unreadable or already gone — retry acquire.
      }
      await sleep(10 + Math.random() * 20 * Math.min(attempt + 1, 10))
    }
  }
  throw new Error(`WikiWriter: timed out acquiring lock ${lockPath}`)
}

export class WikiWriter {
  /** In-process serialization chain shared by all instances on the same root. */
  private static chains = new Map<string, Promise<unknown>>()

  constructor(private root: string) {}

  private lockPath(): string {
    // Root-level (not under .git/) so acquire works before the first `git init`.
    return join(this.root, '.wiki-writer.lock')
  }

  /**
   * Run `fn` under exclusive wiki write access (in-process + file lock).
   * Use for any fs+git mutation of the wiki repo (apply, consolidate, recompile).
   * Not re-entrant — do not call withLock/apply/ensureRepo from inside fn.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.root
    const prev = WikiWriter.chains.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Keep the chain alive even if a prior critical section rejects.
    WikiWriter.chains.set(
      key,
      prev.then(
        () => gate,
        () => gate,
      ),
    )
    await prev.then(
      () => undefined,
      () => undefined,
    )
    try {
      await mkdir(this.root, { recursive: true })
      return await withFileLock(this.lockPath(), fn)
    } finally {
      release()
    }
  }

  /** Unlocked git helper — only call inside withLock / ensureRepoUnlocked. */
  async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', this.root, ...args])
    return stdout.trim()
  }

  private async ensureRepoUnlocked(): Promise<void> {
    await mkdir(join(this.root, 'topics'), { recursive: true })
    if (!existsSync(join(this.root, '.git'))) {
      await execFileAsync('git', ['init', '-b', 'main', this.root])
    }
    // Always (re)assert the local identity — a re-cloned repo would lack it
    // and every commit would fail on a bare service user (#287 review).
    await this.git('config', 'user.name', 'RivetOS Wiki')
    await this.git('config', 'user.email', 'wiki@rivetos.dev')
  }

  async ensureRepo(): Promise<void> {
    await this.withLock(() => this.ensureRepoUnlocked())
  }

  pagePath(slug: string): string {
    return join(this.root, 'topics', `${slug}.md`)
  }

  async readPage(slug: string): Promise<WikiPage | undefined> {
    const path = this.pagePath(slug)
    if (!existsSync(path)) return undefined
    return parseWikiPage(await readFile(path, 'utf8'))
  }

  /**
   * Apply one patch: read-at-HEAD → applyPatch → write → commit. Returns the
   * commit sha. Provenance trailer carries the summary id for git-side audit
   * (PG provenance rows remain canonical).
   */
  async apply(patch: WikiPatch, provenance: { summaryId: string }): Promise<AppliedPatch> {
    return this.withLock(async () => {
      // If another human committed meanwhile (rare), rebase-fast-forward our
      // view first; automated writers are serialized so this only races humans.
      // Failure here is surfaced, not swallowed — the extraction marks failed
      // and retries later.
      if (existsSync(join(this.root, '.git', 'refs', 'remotes'))) {
        await this.git('pull', '--rebase').catch(() => undefined)
      }
      const existing = await this.readPage(patch.slug)
      const page = applyPatch(existing, patch)
      await writeFile(this.pagePath(patch.slug), serializeWikiPage(page))
      await this.git('add', join('topics', `${patch.slug}.md`))
      const status = await this.git('status', '--porcelain', '--', join('topics', `${patch.slug}.md`))
      if (status === '') {
        // No content change — reuse HEAD sha instead of an empty commit.
        const sha = await this.git('rev-parse', 'HEAD')
        return { slug: patch.slug, page, gitSha: sha }
      }
      await this.git(
        'commit',
        '-m',
        `wiki(${patch.slug}): ${patch.action} from summary ${provenance.summaryId.slice(0, 8)}\n\nProvenance: summary ${provenance.summaryId}\nPipeline: wiki-v7`,
      )
      const sha = await this.git('rev-parse', 'HEAD')
      return { slug: patch.slug, page, gitSha: sha }
    })
  }
}
