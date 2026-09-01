import { beforeEach, describe, expect, it, vi } from 'vitest'

const HOME = '/home/test'
const ROOT = '/src/rivetos'
const EXCLUDES = [
  '--exclude',
  'node_modules',
  '--exclude',
  '.git',
  '--exclude',
  '__pycache__',
  '--exclude',
  '.pytest_cache',
]

const { execFileSyncMock, mkdirSyncMock, vfs } = vi.hoisted(() => {
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  // A real fs has implicit parent directories: when /a/b/c exists, every
  // ancestor dir exists too, so existsSync('/a/b') is true. Mirror that or
  // the engine's existsSync guards (cacheBase, grokIntegrations) never pass.
  const addParentDirs = (p: string) => {
    for (let i = p.indexOf('/', 1); i > 0; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i))
  }
  return {
    execFileSyncMock: vi.fn((_cmd: string, _args: string[]): string => ''),
    mkdirSyncMock: vi.fn(),
    vfs: {
      dirs,
      files,
      reset() {
        dirs.clear()
        files.clear()
      },
      dir(p: string) {
        dirs.add(p)
        addParentDirs(p)
      },
      file(p: string, content = 'x') {
        files.set(p, content)
        addParentDirs(p)
      },
    },
  }
})

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('node:os', () => ({ homedir: () => '/home/test' }))
vi.mock('node:fs', () => ({
  existsSync: (p: string) => vfs.dirs.has(p) || vfs.files.has(p),
  mkdirSync: mkdirSyncMock,
  writeFileSync: vi.fn(),
  readdirSync: (p: string) => {
    const prefix = p.endsWith('/') ? p : `${p}/`
    const out: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = []
    for (const d of vfs.dirs) {
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (rest && !rest.includes('/')) {
        out.push({ name: rest, isDirectory: () => true, isFile: () => false })
      }
    }
    for (const f of vfs.files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      if (rest && !rest.includes('/')) {
        out.push({ name: rest, isDirectory: () => false, isFile: () => true })
      }
    }
    return out
  },
  readFileSync: (p: string) => {
    const content = vfs.files.get(p)
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return content
  },
}))

import pluginsSync, { parseItemized, rsyncDirArgs, rsyncFileArgs } from './plugins-sync.js'

beforeEach(() => {
  vfs.reset()
  execFileSyncMock.mockClear()
  mkdirSyncMock.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function rsyncCalls(): string[][] {
  return execFileSyncMock.mock.calls
    .filter(([cmd]) => cmd === 'rsync')
    .map(([, args]) => args as string[])
}

describe('rsync argv builders', () => {
  it('builds a managed-dir mirror with --delete and excludes', () => {
    expect(rsyncDirArgs('/a/src', '/b/dest', { deleteExtraneous: true, dryRun: false })).toEqual([
      '-a',
      '-i',
      '--delete',
      ...EXCLUDES,
      '--',
      '/a/src/',
      '/b/dest/',
    ])
  })

  it('omits --delete for shared dirs and adds -n for dry-run', () => {
    expect(rsyncDirArgs('/a/src', '/b/dest', { deleteExtraneous: false, dryRun: true })).toEqual([
      '-a',
      '-i',
      '-n',
      ...EXCLUDES,
      '--',
      '/a/src/',
      '/b/dest/',
    ])
  })

  it('slash-terminates BOTH directory operands so --delete scopes to the managed dir', () => {
    const args = rsyncDirArgs('/a/src', '/b/dest', { deleteExtraneous: true, dryRun: false })
    const [src, dest] = args.slice(-2)
    expect(src).toMatch(/\/$/)
    expect(dest).toMatch(/\/$/)
    // `--` must separate flags from positional paths (a leading '-' path is data)
    expect(args[args.indexOf('--') + 1]).toBe(src)
  })

  it('builds a single-file copy without excludes or --delete', () => {
    expect(rsyncFileArgs('/a/hooks.json', '/b/plugin.json', { dryRun: false })).toEqual([
      '-a',
      '-i',
      '--',
      '/a/hooks.json',
      '/b/plugin.json',
    ])
  })
})

describe('parseItemized', () => {
  it('parses writes, updates, deletions; skips directory lines', () => {
    const out = [
      '>f+++++++++ skills/memory-recall/SKILL.md',
      '>f.st...... hooks/hooks.json',
      '.f..t...... README.md',
      'cd+++++++++ sub/',
      '*deleting   stale/old.md',
      '',
    ].join('\n')
    expect(parseItemized(out)).toEqual([
      { kind: 'written', rel: 'skills/memory-recall/SKILL.md', isNew: true },
      { kind: 'written', rel: 'hooks/hooks.json', isNew: false },
      { kind: 'written', rel: 'README.md', isNew: false },
      { kind: 'removed', rel: 'stale/old.md', isNew: false },
    ])
  })
})

describe('plugins sync — rsync argv per mapping', () => {
  it('claude-code: mirrors each installed cache version with --delete', () => {
    vfs.dir(`${ROOT}/integrations`)
    vfs.dir(`${ROOT}/integrations/claude-code/rivet-memory`)
    vfs.file(
      `${ROOT}/.claude-plugin/marketplace.json`,
      JSON.stringify({ name: 'rivetos', plugins: [{ name: 'rivet-memory' }] }),
    )
    vfs.dir(`${HOME}/.claude`)
    vfs.dir(`${HOME}/.claude/plugins/cache/rivetos/rivet-memory/1.0.0`)

    pluginsSync(['--root', ROOT, '--tui', 'claude-code'])

    expect(rsyncCalls()).toEqual([
      [
        '-a',
        '-i',
        '--delete',
        ...EXCLUDES,
        '--',
        `${ROOT}/integrations/claude-code/rivet-memory/`,
        `${HOME}/.claude/plugins/cache/rivetos/rivet-memory/1.0.0/`,
      ],
    ])
  })

  it('grok: skills --delete, commands without, single-file hooks + GROK.md renames', () => {
    const plugin = `${ROOT}/integrations/grok/rivet-memory`
    vfs.dir(`${ROOT}/integrations`)
    vfs.dir(plugin)
    vfs.dir(`${plugin}/skills`)
    vfs.dir(`${plugin}/skills/memory-recall`)
    vfs.dir(`${plugin}/commands`)
    vfs.dir(`${plugin}/hooks`)
    vfs.file(`${plugin}/commands/memory-recall.md`)
    vfs.file(`${plugin}/hooks/hooks.json`, '{}')
    vfs.file(`${plugin}/GROK.md`, '# grok')
    vfs.dir(`${HOME}/.grok`)

    pluginsSync(['--root', ROOT, '--tui', 'grok'])

    expect(rsyncCalls()).toEqual([
      [
        '-a',
        '-i',
        '--delete',
        ...EXCLUDES,
        '--',
        `${plugin}/skills/memory-recall/`,
        `${HOME}/.grok/skills/memory-recall/`,
      ],
      ['-a', '-i', ...EXCLUDES, '--', `${plugin}/commands/`, `${HOME}/.grok/commands/`],
      ['-a', '-i', '--', `${plugin}/hooks/hooks.json`, `${HOME}/.grok/hooks/rivet-memory.json`],
      ['-a', '-i', '--', `${plugin}/GROK.md`, `${HOME}/.grok/AGENTS.md`],
    ])
  })

  it('hermes: two managed dirs with --delete, no rivet-den when absent', () => {
    vfs.dir(`${ROOT}/integrations`)
    vfs.dir(`${ROOT}/integrations/hermes/rivet-memory`)
    vfs.dir(`${ROOT}/integrations/hermes/memory-recall`)
    vfs.dir(`${HOME}/.hermes`)

    pluginsSync(['--root', ROOT, '--tui', 'hermes'])

    expect(rsyncCalls()).toEqual([
      [
        '-a',
        '-i',
        '--delete',
        ...EXCLUDES,
        '--',
        `${ROOT}/integrations/hermes/rivet-memory/`,
        `${HOME}/.hermes/plugins/rivet_memory/`,
      ],
      [
        '-a',
        '-i',
        '--delete',
        ...EXCLUDES,
        '--',
        `${ROOT}/integrations/hermes/memory-recall/`,
        `${HOME}/.hermes/skills/memory-recall/`,
      ],
    ])
  })

  it('--dry-run maps to rsync -n and never mkdirs', () => {
    vfs.dir(`${ROOT}/integrations`)
    vfs.dir(`${ROOT}/integrations/hermes/rivet-memory`)
    vfs.dir(`${HOME}/.hermes`)

    pluginsSync(['--root', ROOT, '--tui', 'hermes', '--dry-run'])

    const calls = rsyncCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('-n')
    expect(mkdirSyncMock).not.toHaveBeenCalled()
  })

  it('real run creates dest dirs before spawning', () => {
    vfs.dir(`${ROOT}/integrations`)
    vfs.dir(`${ROOT}/integrations/hermes/rivet-memory`)
    vfs.dir(`${HOME}/.hermes`)

    pluginsSync(['--root', ROOT, '--tui', 'hermes'])

    expect(mkdirSyncMock).toHaveBeenCalledWith(`${HOME}/.hermes/plugins/rivet_memory`, {
      recursive: true,
    })
    expect(rsyncCalls()[0]).not.toContain('-n')
  })
})

describe('missing rsync binary', () => {
  it('fails with a clear install hint on ENOENT — real run AND dry-run', () => {
    vfs.dir(`${ROOT}/integrations`)
    vfs.dir(`${ROOT}/integrations/hermes/rivet-memory`)
    vfs.dir(`${HOME}/.hermes`)
    execFileSyncMock.mockImplementation(() => {
      const err = new Error('spawnSync rsync ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    try {
      expect(() => pluginsSync(['--root', ROOT, '--tui', 'hermes'])).toThrow(
        /rsync not found on PATH — install rsync/,
      )
      // dry-run must hit the same binary check (rsync -n still needs rsync)
      expect(() => pluginsSync(['--root', ROOT, '--tui', 'hermes', '--dry-run'])).toThrow(
        /rsync not found on PATH — install rsync/,
      )
    } finally {
      execFileSyncMock.mockImplementation(() => '')
    }
  })
})
