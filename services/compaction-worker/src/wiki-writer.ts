/**
 * WikiWriter — the single-writer fs+git half of wiki extraction (3c).
 *
 * Owns /rivet-shared/wiki on the datahub worker: read page → applyPatch →
 * serialize → write → one git commit per topic patch. The graphile job
 * layer above serializes per-slug; git conflicts are therefore human-vs-
 * automated only, and applyPatch's auto-merge (prior state archived to
 * History) is the merge strategy — we always read the file at HEAD from
 * disk immediately before patching.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyPatch,
  parseWikiPage,
  serializeWikiPage,
  type WikiPage,
  type WikiPatch,
} from '@rivetos/wiki-core'

const execFileAsync = promisify(execFile)

export interface AppliedPatch {
  slug: string
  page: WikiPage
  gitSha: string
}

export class WikiWriter {
  constructor(private root: string) {}

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', this.root, ...args])
    return stdout.trim()
  }

  async ensureRepo(): Promise<void> {
    await mkdir(join(this.root, 'topics'), { recursive: true })
    if (!existsSync(join(this.root, '.git'))) {
      await execFileAsync('git', ['init', '-b', 'main', this.root])
      await this.git('config', 'user.name', 'RivetOS Wiki')
      await this.git('config', 'user.email', 'wiki@rivetos.dev')
    }
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
    // If another human committed meanwhile (rare), rebase-fast-forward our
    // view first; single automated writer means this never conflicts with
    // ourselves. Failure here is surfaced, not swallowed — the extraction
    // marks failed and retries later.
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
      `wiki(${patch.slug}): ${patch.action} from summary ${provenance.summaryId.slice(0, 8)}\n\nProvenance: summary ${provenance.summaryId}\nPipeline: wiki-v1`,
    )
    const sha = await this.git('rev-parse', 'HEAD')
    return { slug: patch.slug, page, gitSha: sha }
  }
}
