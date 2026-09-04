import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HERDR_SHA256,
  HERDR_VERSION,
  herdrBinPath,
  herdrManifestCacheDir,
  installHerdr,
  parseHerdrVersion,
  herdrOptedIn,
  planHerdrInstall,
  readDotEnvValue,
  resolveHerdrMux,
} from './herdr.js'

const FAKE_BINARY = `#!/bin/sh\necho 'herdr ${HERDR_VERSION}'\n`
const FAKE_SHA = createHash('sha256').update(FAKE_BINARY).digest('hex')
const MANIFEST_V1 = 'id = "grok"\nversion = "2099.01.01.1"\n'
const MANIFEST_V2 = 'id = "grok"\nversion = "2099.01.01.2"\n'

describe('parseHerdrVersion', () => {
  it('parses the pinned version string', () => {
    expect(parseHerdrVersion('herdr 0.8.2')).toBe('0.8.2')
    expect(parseHerdrVersion('herdr 0.8.2\n')).toBe('0.8.2')
  })

  it('returns null for anything else', () => {
    expect(parseHerdrVersion('')).toBeNull()
    expect(parseHerdrVersion('herdr')).toBeNull()
    expect(parseHerdrVersion('0.8.2')).toBeNull()
    expect(parseHerdrVersion('herd 0.8.2')).toBeNull()
  })
})

describe('planHerdrInstall', () => {
  const base = { stagedAvailable: true, allowUpstream: false, manifests: [] }

  it('reports current when the pinned version is already installed', () => {
    const plan = planHerdrInstall({ ...base, installedVersion: HERDR_VERSION })
    expect(plan.binary).toBe('current')
  })

  it('installs from the staged binary when absent or on the wrong version', () => {
    expect(planHerdrInstall({ ...base, installedVersion: null }).binary).toBe('install-staged')
    expect(planHerdrInstall({ ...base, installedVersion: '0.8.1' }).binary).toBe('install-staged')
  })

  it('uses upstream only as an explicit opt-in fallback', () => {
    expect(
      planHerdrInstall({ ...base, stagedAvailable: false, installedVersion: null }).binary,
    ).toBe('unavailable')
    expect(
      planHerdrInstall({
        ...base,
        stagedAvailable: false,
        allowUpstream: true,
        installedVersion: null,
      }).binary,
    ).toBe('install-upstream')
    // staged always wins over upstream — it is the sha-verified pin path
    expect(planHerdrInstall({ ...base, allowUpstream: true, installedVersion: null }).binary).toBe(
      'install-staged',
    )
  })

  it('plans manifest actions from installed vs desired content', () => {
    const plan = planHerdrInstall({
      ...base,
      installedVersion: HERDR_VERSION,
      manifests: [
        { agent: 'current', installed: 'x', desired: 'x', origExists: false },
        { agent: 'fresh', installed: null, desired: 'x', origExists: false },
        { agent: 'stale', installed: 'old', desired: 'new', origExists: false },
        { agent: 'staleBackedUp', installed: 'old', desired: 'new', origExists: true },
      ],
    })
    expect(plan.manifests).toEqual([
      { agent: 'current', action: 'current' },
      { agent: 'fresh', action: 'install' },
      { agent: 'stale', action: 'update-backup' },
      { agent: 'staleBackedUp', action: 'update-overwrite' },
    ])
  })
})

describe('installHerdr', () => {
  let home: string
  let repoRoot: string
  let shared: string

  function stageBinary(): void {
    const staged = join(shared, 'fidelity', 'bin', `herdr-${HERDR_VERSION}`)
    mkdirSync(join(staged, '..'), { recursive: true })
    writeFileSync(staged, FAKE_BINARY)
    chmodSync(staged, 0o755)
  }

  function writeRepoManifest(content: string): void {
    const dir = join(repoRoot, 'integrations', 'herdr', 'manifests')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'grok.toml'), content)
  }

  function run() {
    return installHerdr({
      home,
      repoRoot,
      sharedDir: shared,
      expectedSha256: FAKE_SHA,
      log: () => {},
    })
  }

  beforeEach(() => {
    delete process.env.RIVETOS_HERDR_STAGED
    home = mkdtempSync(join(tmpdir(), 'herdr-home-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'herdr-repo-'))
    shared = mkdtempSync(join(tmpdir(), 'herdr-shared-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  })

  it('installs the pinned binary and manifest, then is idempotent', () => {
    stageBinary()
    writeRepoManifest(MANIFEST_V1)

    const first = run()
    expect(first.plan.binary).toBe('install-staged')
    expect(first.plan.manifests).toEqual([{ agent: 'grok', action: 'install' }])
    expect(first.version).toBe(HERDR_VERSION)
    expect(readFileSync(herdrBinPath(home), 'utf-8')).toBe(FAKE_BINARY)
    expect(readFileSync(join(herdrManifestCacheDir(home), 'grok.toml'), 'utf-8')).toBe(MANIFEST_V1)

    const second = run()
    expect(second.plan.binary).toBe('current')
    expect(second.plan.manifests).toEqual([{ agent: 'grok', action: 'current' }])
    expect(existsSync(join(herdrManifestCacheDir(home), 'grok.toml.orig'))).toBe(false)
  })

  it('refuses a staged binary whose sha256 does not match the pin', () => {
    stageBinary()
    writeRepoManifest(MANIFEST_V1)
    expect(() =>
      installHerdr({
        home,
        repoRoot,
        sharedDir: shared,
        expectedSha256: HERDR_SHA256,
        log: () => {},
      }),
    ).toThrow(/sha256 mismatch/)
    expect(existsSync(herdrBinPath(home))).toBe(false)
  })

  it('backs up a diverging installed manifest once, then overwrites', () => {
    stageBinary()
    writeRepoManifest(MANIFEST_V1)
    run()

    // upstream rewrote the cached manifest → first update backs it up
    const cache = join(herdrManifestCacheDir(home), 'grok.toml')
    writeFileSync(cache, 'id = "grok"\nversion = "1.0.0"\n')
    writeRepoManifest(MANIFEST_V2)
    const second = run()
    expect(second.plan.manifests).toEqual([{ agent: 'grok', action: 'update-backup' }])
    expect(readFileSync(`${cache}.orig`, 'utf-8')).toBe('id = "grok"\nversion = "1.0.0"\n')
    expect(readFileSync(cache, 'utf-8')).toBe(MANIFEST_V2)

    // diverges again → overwrite, the original backup is preserved
    writeFileSync(cache, 'id = "grok"\nversion = "2.0.0"\n')
    writeRepoManifest(MANIFEST_V1)
    const third = run()
    expect(third.plan.manifests).toEqual([{ agent: 'grok', action: 'update-overwrite' }])
    expect(readFileSync(`${cache}.orig`, 'utf-8')).toBe('id = "grok"\nversion = "1.0.0"\n')
    expect(readFileSync(cache, 'utf-8')).toBe(MANIFEST_V1)
  })

  it('fails with staging instructions when nothing can install the binary', () => {
    writeRepoManifest(MANIFEST_V1)
    expect(() => run()).toThrow(/no staged binary/)
  })
})

describe('herdrOptedIn (rivetos update only provisions opted-in nodes)', () => {
  it('env RIVETOS_DEN_TERM_MUX=herdr opts in; other values never do', async () => {
    const { herdrOptedIn } = await import('./herdr.js')
    expect(herdrOptedIn({ RIVETOS_DEN_TERM_MUX: 'herdr' }, null)).toBe(true)
    expect(
      herdrOptedIn({ RIVETOS_DEN_TERM_MUX: 'tmux' }, null, 'den:\n  terminal:\n    mux: herdr\n'),
    ).toBe(false)
    expect(herdrOptedIn({}, null, 'den:\n  terminal:\n    mux: herdr\n')).toBe(true)
    expect(herdrOptedIn({}, null, 'den:\n  terminal:\n    mux: tmux\n')).toBe(false)
    expect(herdrOptedIn({}, null)).toBe(false)
  })
})

describe('readDotEnvValue (systemd EnvironmentFile semantics)', () => {
  it('finds a plain, quoted, exported, and last-wins assignment', () => {
    expect(readDotEnvValue('A', 'A=1\n')).toBe('1')
    expect(readDotEnvValue('A', 'A="quoted value"\n')).toBe('quoted value')
    expect(readDotEnvValue('A', "export A='x'\n")).toBe('x')
    expect(readDotEnvValue('A', 'A=first\nB=2\nA=last\n')).toBe('last')
  })

  it('handles = inside the value, CRLF, trailing spaces, inline comments, and # inside quotes', () => {
    expect(readDotEnvValue('A', 'A="a=b"\n')).toBe('a=b')
    expect(readDotEnvValue('A', 'A=a=b\n')).toBe('a=b')
    expect(readDotEnvValue('A', 'A=herdr\r\nB=2\r\n')).toBe('herdr')
    expect(readDotEnvValue('A', 'A=herdr   \n')).toBe('herdr')
    expect(readDotEnvValue('A', 'A=herdr # the mux\n')).toBe('herdr')
    expect(readDotEnvValue('A', 'A="herdr" # the mux\n')).toBe('herdr')
    expect(readDotEnvValue('A', 'A="b#c"\n')).toBe('b#c')
    expect(readDotEnvValue('A', "A='b # c'\n")).toBe('b # c')
  })

  it('ignores comments, other keys, and missing input', () => {
    expect(readDotEnvValue('A', '# A=1\nAB=2\n')).toBeUndefined()
    expect(readDotEnvValue('A', null)).toBeUndefined()
    expect(readDotEnvValue('A', '')).toBeUndefined()
  })
})

describe('resolveHerdrMux / herdrOptedIn — env → ~/.rivetos/.env → YAML', () => {
  it('process env wins over the EnvironmentFile and YAML', () => {
    expect(
      resolveHerdrMux(
        { RIVETOS_DEN_TERM_MUX: 'tmux' },
        'RIVETOS_DEN_TERM_MUX=herdr\n',
        'den:\n  terminal:\n    mux: herdr\n',
      ),
    ).toBe('tmux')
  })

  it('reads the EnvironmentFile when the process env is silent (shell-launched update/doctor)', () => {
    expect(resolveHerdrMux({}, 'XAI_API_KEY=x\nRIVETOS_DEN_TERM_MUX=herdr\n', null)).toBe('herdr')
    expect(herdrOptedIn({}, 'RIVETOS_DEN_TERM_MUX=herdr\n', null)).toBe(true)
    expect(herdrOptedIn({}, 'RIVETOS_DEN_TERM_MUX=tmux\n', null)).toBe(false)
    // same argument order as resolveHerdrMux: a .env of tmux must not be read as YAML and fail open
    expect(
      herdrOptedIn({}, 'RIVETOS_DEN_TERM_MUX=tmux\n', 'den:\n  terminal:\n    mux: herdr\n'),
    ).toBe(false)
  })

  it('falls back to the scoped YAML key, never a whole-file mux: match', () => {
    expect(resolveHerdrMux({}, null, 'den:\n  terminal:\n    mux: herdr\n')).toBe('herdr')
    expect(resolveHerdrMux({}, null, 'other:\n  mux: herdr\n')).toBeUndefined()
    expect(herdrOptedIn({}, null, null)).toBe(false)
  })
})
