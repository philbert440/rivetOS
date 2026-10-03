/**
 * Rule-based `project:` tag from a working directory.
 *
 * Pure: filesystem access is injected (sync or async) so this runs anywhere
 * (node capture path, den, tests with a fake tree). The rule, in order of
 * preference:
 *
 *   1. origin remote of the enclosing git repo — `github.com/org/rivetOS.git`
 *      → `rivetOS`. Survives moving or renaming the checkout.
 *   2. basename of the git root — the repo has no origin.
 *   3. basename of cwd — not a git checkout at all.
 *
 * Git worktrees resolve to the main repository (`.git` file →
 * `gitdir: <main>/.git/worktrees/<name>`), so `w-tags` and the main checkout
 * share one project. Submodules resolve to the submodule, not the superproject.
 * Monorepos tag the repo root, not the package directory. The literal config
 * is read: `insteadOf` rewrites and `include`d files are not followed, so the
 * name can differ from `git remote get-url origin` in those setups. A worktree
 * of a bare repository (`gitdir: <bare>.git/worktrees/<name>`) is not
 * recognized as a worktree and tags its own directory name.
 *
 * Input is untrusted (it arrives in a capture batch): only absolute paths
 * without `.`/`..` segments are considered, the ancestor walk is bounded, and
 * nothing derived from the input other than a repo/dir name and a sanitized
 * `host/org/repo` ever leaves this module — never the raw remote URL (it can
 * embed credentials) and never a host path.
 *
 * Returns null for a cwd that carries no project signal: system roots, home
 * directories, generic folders such as `/tmp` or `~/Downloads`.
 */

import { normalizeTagValue, TAG_KEY_PROJECT, TAG_VALUE_MAX, type TagProposal } from './tags.js'

type MaybePromise<T> = T | Promise<T>

export interface ProjectRuleFs {
  /** True when `path` exists and is a directory. */
  isDirectory(path: string): MaybePromise<boolean>
  /** File contents, or null when missing/unreadable/not a file. */
  readFile(path: string): MaybePromise<string | null>
}

/** An fs that sees nothing: only the cwd-basename rule can fire. */
export const NO_FS: ProjectRuleFs = {
  isDirectory: () => false,
  readFile: () => null,
}

export interface ProjectRuleResult extends TagProposal {
  key: typeof TAG_KEY_PROJECT
  /** Which rule fired: for `ros_tags.reason` and the hub tooltip. */
  rule: 'git-remote' | 'git-root' | 'cwd-basename'
  /** Git root when one was found (main repo for a worktree). Not persisted. */
  gitRoot?: string
}

/** Name used in `ros_tags.proposed_by` for this rule. */
export const PROJECT_RULE_NAME = 'cwd-git-root'

/** Ancestors examined for `.git` before giving up. */
export const PROJECT_RULE_MAX_WALK = 16

function normPath(p: string): string {
  // Posix + Windows separators; strip trailing separators except a bare root.
  const s = p.replace(/\\/g, '/')
  const stripped = s.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

function basename(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

function dirname(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return s.slice(0, i)
}

/** Absolute posix or drive-letter path with no `.` / `..` segments. */
export function isSafeAbsolutePath(raw: string): boolean {
  const s = raw.replace(/\\/g, '/')
  if (!(s.startsWith('/') || /^[a-zA-Z]:\//.test(s))) return false
  return !s.split('/').some((seg) => seg === '.' || seg === '..')
}

const SYSTEM_ROOTS = new Set([
  '/',
  '/bin',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/media',
  '/mnt',
  '/opt',
  '/private',
  '/private/tmp',
  '/private/var',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/usr/local',
  '/var',
  '/var/tmp',
  '/Users',
  '/Volumes',
])

/** Directories that name no project: system roots, home dirs, generic home folders. */
export function isRootLike(p: string): boolean {
  const s = normPath(p)
  if (s === '.' || /^[a-zA-Z]:$/.test(s)) return true
  if (SYSTEM_ROOTS.has(s)) return true
  if (s === '/var/root') return true
  // /home/<user>, /Users/<user>, C:/Users/<user> and the generic folders directly under them.
  return /^([a-z]:)?\/(home|users)\/[^/]+(\/(Downloads|Desktop|Documents|tmp|temp))?$/i.test(s)
}

function resolveRelative(base: string, target: string): string {
  const t = target.replace(/\\/g, '/')
  if (t.startsWith('/') || /^[a-zA-Z]:\//.test(t)) return normPath(t)
  const parts = normPath(base).split('/')
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const joined = parts.join('/')
  return joined === '' ? '/' : joined
}

/**
 * Find the git root for `cwd`: the nearest ancestor holding `.git`, looking
 * at most PROJECT_RULE_MAX_WALK levels up. A `.git` *file* is a worktree or
 * submodule pointer; a worktree resolves to its main repository. Returns the
 * root and the directory that holds `config`.
 */
export async function findGitRoot(
  cwd: string,
  fs: ProjectRuleFs,
): Promise<{ root: string; gitDir: string } | null> {
  let dir = normPath(cwd)
  for (let i = 0; i < PROJECT_RULE_MAX_WALK; i += 1) {
    const dotGit = `${dir}/.git`
    if (await fs.isDirectory(dotGit)) return { root: dir, gitDir: dotGit }
    const pointer = await fs.readFile(dotGit)
    if (pointer !== null) {
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer)
      if (m) {
        const gitDir = resolveRelative(dir, m[1])
        // Worktree: <main>/.git/worktrees/<name> → main repo root.
        const wt = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitDir)
        if (wt) return { root: wt[1], gitDir: `${wt[1]}/.git` }
        // Submodule (<super>/.git/modules/<path>) or anything else: this dir is the root.
        return { root: dir, gitDir }
      }
    }
    const parent = dirname(dir)
    if (parent === dir || parent === '.') break
    dir = parent
  }
  return null
}

/** Repo name from a git remote URL: ssh, scp-like, https, file. */
export function repoNameFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  const last = trimmed.split(/[/:]/).pop() ?? ''
  const name = last.replace(/\.git$/i, '')
  return name && name !== '.' && name !== '..' ? name : null
}

/**
 * `host/org/repo` with scheme, userinfo (user, password, token), port, query
 * and `.git` removed. A remote URL may carry credentials
 * (`https://user:ghp_…@github.com/org/repo.git`, `…/repo.git?token=…`); this
 * is the only form of it that is allowed to be stored or shown, and the tag's
 * value is taken from it too.
 *
 * Returns null when the remote is not host-shaped: a local path (`/srv/x.git`,
 * `file:///…`, `C:\repos\app`, `../sibling`) names a place on this machine,
 * not a project identity, and must not be persisted.
 */
export function sanitizeRemote(url: string): string | null {
  let s = url.trim().replace(/\\/g, '/')
  if (!s) return null
  s = s.replace(/[?#].*$/, '')
  // Local remotes, rejected before any scheme or scp-like parsing: absolute,
  // relative, home-relative, any drive-letter form (`C:/x`, `C:x`), `file:`.
  // A one-letter scp host (`h:org/repo`) is given up with them — rare, and the
  // git-root rule still names the project.
  if (/^(\/|\.{1,2}\/|~)/.test(s) || /^[a-zA-Z]:/.test(s) || /^file:/i.test(s)) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s)
  if (scheme) {
    s = s.slice(scheme[0].length)
    const slash = s.indexOf('/')
    const authority = slash < 0 ? s : s.slice(0, slash)
    const path = slash < 0 ? '' : s.slice(slash)
    // Everything up to the LAST @ is userinfo (a password may contain @).
    const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/, '')
    if (host === '') return null
    s = `${host}${path}`
  } else {
    // scp-like: [user@]host:org/repo
    const m = /^(?:[^@/]*@)?([^:/@]+):(.+)$/.exec(s)
    if (!m) return null
    s = `${m[1]}/${m[2]}`
  }
  s = s
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/{2,}/g, '/')
  // host/…/repo: a host segment, at least one path segment, nothing odd.
  return /^[^/\s@]+\/[^\s@]+$/.test(s) ? s : null
}

/** `[remote "origin"] url = …` from a git config body. */
export function originUrlFromConfig(config: string): string | null {
  const lines = config.split(/\r?\n/)
  let inOrigin = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      // Section names are case-insensitive in git config; the remote name is not.
      inOrigin = /^\[remote\s+"origin"\](?:[ \t]*[#;].*)?$/i.test(line) && line.includes('"origin"')
      continue
    }
    if (!inOrigin) continue
    const m = /^url\s*=\s*(.+)$/i.exec(line)
    // Drop a trailing ` # comment` / ` ; comment` (a URL has no space before # or ;).
    if (m) return m[1].replace(/\s+[#;].*$/, '').trim()
  }
  return null
}

export async function resolveProjectFromCwd(
  cwd: string,
  fs: ProjectRuleFs,
): Promise<ProjectRuleResult | null> {
  if (typeof cwd !== 'string') return null
  const trimmed = cwd.trim()
  if (trimmed === '' || !isSafeAbsolutePath(trimmed)) return null
  const normalized = normPath(trimmed)
  if (isRootLike(normalized)) return null

  const git = await findGitRoot(normalized, fs)
  if (git) {
    if (isRootLike(git.root)) return null
    const config = await fs.readFile(`${git.gitDir}/config`)
    const origin = config === null ? null : originUrlFromConfig(config)
    // Everything derived from the remote goes through the sanitized form —
    // the value and display as well as the reason. A local or unparseable
    // remote yields no remote name and the cascade falls to the git root.
    const safe = origin === null ? null : sanitizeRemote(origin)
    const remoteName = safe === null ? null : (safe.split('/').pop() ?? null)
    // Each rule falls through to the next when its name normalizes to nothing
    // (a repo called `---`), instead of ending the cascade.
    if (safe !== null && remoteName) {
      const hit = make(remoteName, 'git-remote', git.root, safe)
      if (hit) return hit
    }
    const rootName = basename(git.root)
    if (rootName) {
      const hit = make(rootName, 'git-root', git.root, rootName)
      if (hit) return hit
    }
  }
  const name = basename(normalized)
  if (!name) return null
  return make(name, 'cwd-basename', undefined, name)
}

function make(
  display: string,
  rule: ProjectRuleResult['rule'],
  gitRoot: string | undefined,
  /** Already sanitized: a repo/dir name or host/org/repo. Never a URL or a path. */
  why: string,
): ProjectRuleResult | null {
  const value = normalizeTagValue(display)
  if (!value) return null
  return {
    key: TAG_KEY_PROJECT,
    value,
    // Display is shown in the hub and fed to prompts: one line, bounded.
    display: Array.from(
      display
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, TAG_VALUE_MAX)
      .join(''),
    rule,
    reason: `${rule}: ${why}`.slice(0, 200),
    ...(gitRoot === undefined ? {} : { gitRoot }),
  }
}
