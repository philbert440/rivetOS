import { describe, expect, it, vi } from 'vitest'
import {
  NO_FS,
  PROJECT_RULE_MAX_WALK,
  findGitRoot,
  isRootLike,
  isSafeAbsolutePath,
  originUrlFromConfig,
  repoNameFromRemote,
  resolveProjectFromCwd,
  sanitizeRemote,
  type ProjectRuleFs,
} from './project-rule.js'

/** Fake tree: dirs is a set of directory paths, files maps path → body. */
function fakeFs(dirs: string[], files: Record<string, string> = {}): ProjectRuleFs {
  const d = new Set(dirs)
  return {
    isDirectory: (p) => d.has(p),
    readFile: (p) => (p in files ? files[p] : null),
  }
}

const ORIGIN_CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:philbert440/rivetOS.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`

describe('resolveProjectFromCwd', () => {
  it('prefers the origin remote name, keeping its casing as display', async () => {
    const fs = fakeFs(['/srv/code/rivetos', '/srv/code/rivetos/.git'], {
      '/srv/code/rivetos/.git/config': ORIGIN_CONFIG,
    })
    expect(await resolveProjectFromCwd('/srv/code/rivetos/packages/types', fs)).toMatchObject({
      key: 'project',
      value: 'rivetos',
      display: 'rivetOS',
      rule: 'git-remote',
      gitRoot: '/srv/code/rivetos',
      reason: 'git-remote: github.com/philbert440/rivetOS',
    })
  })

  it('falls back to the git root basename when there is no origin', async () => {
    const fs = fakeFs(['/srv/My Repo', '/srv/My Repo/.git'], {
      '/srv/My Repo/.git/config': '[core]\n\tbare = false\n',
    })
    expect(await resolveProjectFromCwd('/srv/My Repo/sub', fs)).toMatchObject({
      value: 'my-repo',
      display: 'My Repo',
      rule: 'git-root',
      reason: 'git-root: My Repo',
    })
  })

  it('falls back to the cwd basename outside git, and accepts async fs + padded input', async () => {
    const asyncFs: ProjectRuleFs = {
      isDirectory: async () => false,
      readFile: async () => null,
    }
    expect(await resolveProjectFromCwd('  /home/rivet/notes/  ', asyncFs)).toMatchObject({
      value: 'notes',
      rule: 'cwd-basename',
      reason: 'cwd-basename: notes',
    })
  })

  it('resolves a worktree to the main repository', async () => {
    const fs = fakeFs(['/srv/rivetos', '/srv/rivetos/.git', '/home/rivet/work/w-tags'], {
      '/home/rivet/work/w-tags/.git': 'gitdir: /srv/rivetos/.git/worktrees/w-tags\n',
      '/srv/rivetos/.git/config': ORIGIN_CONFIG,
    })
    expect(await resolveProjectFromCwd('/home/rivet/work/w-tags/plugins', fs)).toMatchObject({
      value: 'rivetos',
      rule: 'git-remote',
      gitRoot: '/srv/rivetos',
    })
  })

  it('resolves a relative worktree gitdir', async () => {
    const fs = fakeFs(['/r/main', '/r/main/.git', '/r/wt'], {
      '/r/wt/.git': 'gitdir: ../main/.git/worktrees/wt',
    })
    expect(await findGitRoot('/r/wt', fs)).toEqual({ root: '/r/main', gitDir: '/r/main/.git' })
  })

  it('treats a submodule as its own project', async () => {
    const fs = fakeFs(['/r/super', '/r/super/.git', '/r/super/vendor/lib'], {
      '/r/super/vendor/lib/.git': 'gitdir: ../../.git/modules/vendor/lib\n',
      '/r/super/.git/modules/vendor/lib/config':
        '[remote "origin"]\n\turl = https://example.com/org/lib.git\n',
    })
    expect(await resolveProjectFromCwd('/r/super/vendor/lib/src', fs)).toMatchObject({
      value: 'lib',
      rule: 'git-remote',
      gitRoot: '/r/super/vendor/lib',
    })
  })

  it('tags the monorepo root, not the package directory', async () => {
    const fs = fakeFs(['/mono', '/mono/.git', '/mono/packages/a'])
    expect(await resolveProjectFromCwd('/mono/packages/a', fs)).toMatchObject({
      value: 'mono',
      gitRoot: '/mono',
    })
  })

  it('never stores credentials or host paths from a credentialed origin', async () => {
    const fs = fakeFs(['/srv/app', '/srv/app/.git'], {
      '/srv/app/.git/config':
        '[remote "origin"]\n\turl = https://phil:ghp_SECRETtoken123@github.com/acme/App.git\n',
    })
    const hit = await resolveProjectFromCwd('/srv/app/src', fs)
    expect(hit).toMatchObject({ value: 'app', display: 'App', rule: 'git-remote' })
    expect(hit?.reason).toBe('git-remote: github.com/acme/App')
    expect(JSON.stringify({ ...hit, gitRoot: undefined })).not.toMatch(/ghp_|phil:|\/srv\//)
  })

  it.each([
    ['https://github.com/org/repo.git?token=ghp_SECRET', 'repo', 'git-remote', 'git-remote: github.com/org/repo'],
    ['https://u:p@github.com/org/Repo#frag', 'repo', 'git-remote', 'git-remote: github.com/org/Repo'],
    ['file:///srv/git/private/bare.git', 'checkout', 'git-root', 'git-root: checkout'],
    ['/srv/git/private/bare.git', 'checkout', 'git-root', 'git-root: checkout'],
    ['C:\\repos\\app', 'checkout', 'git-root', 'git-root: checkout'],
    ['../sibling.git', 'checkout', 'git-root', 'git-root: checkout'],
    ['file:/srv/git/private/bare.git', 'checkout', 'git-root', 'git-root: checkout'],
    ['C:repos\\app', 'checkout', 'git-root', 'git-root: checkout'],
  ])('remote %s → value %s via %s, with nothing unsafe in any field', async (url, value, rule, reason) => {
    const fs = fakeFs(['/work/checkout', '/work/checkout/.git'], {
      '/work/checkout/.git/config': `[remote "origin"]\n\turl = ${url}\n`,
    })
    const hit = await resolveProjectFromCwd('/work/checkout/src', fs)
    expect(hit).toMatchObject({ value, rule, reason })
    const persisted = JSON.stringify({ ...hit, gitRoot: undefined })
    expect(persisted).not.toMatch(/token|ghp_|u:p|\/srv\/|\\\\|repos|frag|sibling/)
  })

  it('bounds the display and keeps it on one line', async () => {
    const long = 'N'.repeat(400)
    const fs = fakeFs([`/work/${long}`, `/work/${long}/.git`])
    const hit = await resolveProjectFromCwd(`/work/${long}`, fs)
    expect(hit?.display).toHaveLength(128)
    expect(hit?.value).toHaveLength(128)
  })

  it('returns null for system roots, home directories and generic folders', async () => {
    for (const p of [
      '/',
      '/home/rivet',
      '/Users/phil/',
      '/root',
      '/tmp',
      '/var/tmp',
      '/opt',
      '/etc',
      '/srv',
      '/mnt',
      '/home/rivet/Downloads',
      '/Users/phil/Desktop',
      '',
      '   ',
    ]) {
      expect(await resolveProjectFromCwd(p, NO_FS), p).toBeNull()
    }
  })

  it('returns null when the git root is itself root-like (dotfiles repo at $HOME, repo at /opt)', async () => {
    expect(
      await resolveProjectFromCwd('/home/rivet/src', fakeFs(['/home/rivet', '/home/rivet/.git'])),
    ).toBeNull()
    expect(await resolveProjectFromCwd('/opt/x', fakeFs(['/opt', '/opt/.git']))).toBeNull()
  })

  it('treats Windows home directories and /var/root as root-like', async () => {
    expect(await resolveProjectFromCwd('C:\\Users\\phil', NO_FS)).toBeNull()
    expect(await resolveProjectFromCwd('C:/Users/phil/Downloads', NO_FS)).toBeNull()
    expect(await resolveProjectFromCwd('/var/root', NO_FS)).toBeNull()
    expect(
      await resolveProjectFromCwd('C:/Users/phil/src', fakeFs(['C:/Users/phil', 'C:/Users/phil/.git'])),
    ).toBeNull()
  })

  it('falls through to the next rule when a name normalizes to nothing', async () => {
    const fs = fakeFs(['/srv/real-name', '/srv/real-name/.git'], {
      '/srv/real-name/.git/config': '[remote "origin"]\n\turl = git@host:org/---.git\n',
    })
    expect(await resolveProjectFromCwd('/srv/real-name/src', fs)).toMatchObject({
      rule: 'git-root',
      value: 'real-name',
    })
  })

  it('rejects relative paths and dot segments without touching the filesystem', async () => {
    const fs = { isDirectory: vi.fn(() => true), readFile: vi.fn(() => null) }
    for (const p of ['..', 'foo', './foo', '../etc', '/srv/app/../../etc', '/srv/./app', 'C:']) {
      expect(await resolveProjectFromCwd(p, fs), p).toBeNull()
    }
    expect(fs.isDirectory).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('bounds the ancestor walk', async () => {
    const deep = '/d' + '/x'.repeat(40)
    const fs = { isDirectory: vi.fn(() => false), readFile: vi.fn(() => null) }
    expect(await resolveProjectFromCwd(deep, fs)).toMatchObject({ rule: 'cwd-basename', value: 'x' })
    expect(fs.isDirectory).toHaveBeenCalledTimes(PROJECT_RULE_MAX_WALK)
  })

  it('NO_FS can only produce the cwd-basename rule', async () => {
    expect(await resolveProjectFromCwd('/srv/code/rivetos', NO_FS)).toMatchObject({
      rule: 'cwd-basename',
      value: 'rivetos',
    })
  })

  it('accepts Windows paths', async () => {
    const fs = fakeFs(['C:/dev/App', 'C:/dev/App/.git'])
    expect(await resolveProjectFromCwd('C:\\dev\\App\\src', fs)).toMatchObject({
      value: 'app',
      display: 'App',
      rule: 'git-root',
    })
  })
})

describe('isSafeAbsolutePath / isRootLike', () => {
  it('accepts absolute posix and drive paths only', () => {
    expect(isSafeAbsolutePath('/a/b')).toBe(true)
    expect(isSafeAbsolutePath('C:\\a\\b')).toBe(true)
    expect(isSafeAbsolutePath('a/b')).toBe(false)
    expect(isSafeAbsolutePath('/a/../b')).toBe(false)
  })
  it('does not treat a project under /tmp or /opt as root-like', () => {
    expect(isRootLike('/tmp/my-proj')).toBe(false)
    expect(isRootLike('/opt/rivetos')).toBe(false)
    expect(isRootLike('/home/rivet/work')).toBe(false)
  })
})

describe('repoNameFromRemote', () => {
  it.each([
    ['git@github.com:org/Repo.git', 'Repo'],
    ['https://github.com/org/repo', 'repo'],
    ['https://github.com/org/repo.git/', 'repo'],
    ['ssh://git@host:2222/org/thing.git', 'thing'],
    ['/srv/git/bare.git', 'bare'],
    ['', null],
  ])('%s → %s', (url, expected) => {
    expect(repoNameFromRemote(url)).toBe(expected)
  })
})

describe('sanitizeRemote', () => {
  it.each([
    ['https://user:ghp_tok@github.com/org/repo.git', 'github.com/org/repo'],
    ['https://x-access-token:p@ss@w0rd@gitlab.example.com:8443/g/sub/repo.git', 'gitlab.example.com/g/sub/repo'],
    ['ssh://git@host:2222/org/thing.git', 'host/org/thing'],
    ['git@github.com:org/Repo.git', 'github.com/org/Repo'],
    ['github.com:org/repo', 'github.com/org/repo'],
    ['https://github.com/org/repo?token=abc#frag', 'github.com/org/repo'],
    // Local remotes name a place on this machine, not a project: never persisted.
    ['/srv/git/private/bare.git', null],
    ['file:///srv/git/private/bare.git', null],
    ['C:\\repos\\app', null],
    ['C:/repos/app', null],
    ['../sibling', null],
    ['file:/srv/git/private/bare.git', null],
    ['FILE://host/share/x.git', null],
    ['C:repos\\app', null],
    ['h:org/repo', null],
    ['~/src/x.git', null],
    ['https://', null],
    ['', null],
  ])('%s → %s', (url, expected) => {
    expect(sanitizeRemote(url)).toBe(expected)
  })
})

describe('originUrlFromConfig', () => {
  it('reads only the origin section', () => {
    const cfg =
      '[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = b\n[remote "x"]\n\turl = c\n'
    expect(originUrlFromConfig(cfg)).toBe('b')
  })
  it('matches the section name case-insensitively and drops trailing comments', () => {
    expect(originUrlFromConfig('[REMOTE "origin"]\n\tURL = git@h:o/r.git ; mirror\n')).toBe('git@h:o/r.git')
    expect(originUrlFromConfig('[remote "Origin"]\n\turl = nope\n')).toBeNull()
    expect(originUrlFromConfig('[remote "origin"] # main\n\turl = a@h:o/r\n')).toBe('a@h:o/r')
  })
  it('returns null without origin', () => {
    expect(originUrlFromConfig('[core]\n\tbare = false\n')).toBeNull()
  })
})
