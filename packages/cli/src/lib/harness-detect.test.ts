import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_IDS } from '@rivetos/types'
import {
  HARNESS_BINARIES,
  WATCHER_CAPTURE_HARNESSES,
  detectHarnesses,
  execFileAsync,
  findOnPath,
  isWatcherCaptureHarness,
} from './harness-detect.js'

const ADAPTERS_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../services/den-server/src/harness/adapters/index.ts',
)

function byCommandKeysFromSource(): string[] {
  const src = readFileSync(ADAPTERS_SRC, 'utf-8')
  const block = src.match(/const BY_COMMAND[^=]*=\s*\{([^}]+)\}/)
  if (!block) throw new Error(`BY_COMMAND object not found in ${ADAPTERS_SRC}`)
  return [...block[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1])
}

describe('HARNESS_BINARIES', () => {
  it('has a binary for every HARNESS_IDS entry', () => {
    for (const id of HARNESS_IDS) {
      expect(HARNESS_BINARIES[id], id).toBeTruthy()
    }
    expect(Object.keys(HARNESS_BINARIES).sort()).toEqual([...HARNESS_IDS].sort())
  })

  it('matches den-server BY_COMMAND binary names (read from source)', () => {
    expect(Object.values(HARNESS_BINARIES).sort()).toEqual(byCommandKeysFromSource().sort())
  })
})

describe('WATCHER_CAPTURE_HARNESSES', () => {
  it('covers codex, pi and opencode', () => {
    expect(WATCHER_CAPTURE_HARNESSES).toEqual(['codex', 'pi', 'opencode'])
    expect(isWatcherCaptureHarness('codex')).toBe(true)
    expect(isWatcherCaptureHarness('pi')).toBe(true)
    expect(isWatcherCaptureHarness('opencode')).toBe(true)
    expect(isWatcherCaptureHarness('claude-code')).toBe(false)
  })
})

describe('findOnPath + detectHarnesses', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function fakeBin(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, name)
    writeFileSync(p, '#!/bin/sh\necho 1.0.0\n')
    chmodSync(p, 0o755)
    return p
  }

  it('finds a fake executable on a fake PATH and ignores extra dirs', () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    const binDir = join(root, 'bin')
    const grok = fakeBin(binDir, 'grok')
    expect(findOnPath('grok', { pathEnv: binDir, extraDirs: [], home: root })).toBe(grok)
    expect(findOnPath('claude', { pathEnv: binDir, extraDirs: [], home: root })).toBeNull()
  })

  it('falls back to extraDirs after PATH', () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    const pathDir = join(root, 'path')
    const extraDir = join(root, 'extra')
    mkdirSync(pathDir, { recursive: true })
    const claude = fakeBin(extraDir, 'claude')
    expect(findOnPath('claude', { pathEnv: pathDir, extraDirs: [extraDir], home: root })).toBe(
      claude,
    )
  })

  it('prefers PATH over extraDirs', () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    const pathDir = join(root, 'path')
    const extraDir = join(root, 'extra')
    const onPath = fakeBin(pathDir, 'kimi')
    fakeBin(extraDir, 'kimi')
    expect(findOnPath('kimi', { pathEnv: pathDir, extraDirs: [extraDir], home: root })).toBe(onPath)
  })

  it('skips directories named like the binary', () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    const pathDir = join(root, 'path')
    mkdirSync(join(pathDir, 'hermes'), { recursive: true })
    expect(findOnPath('hermes', { pathEnv: pathDir, extraDirs: [], home: root })).toBeNull()
  })

  it('returns an absolute path even when PATH has a relative entry', () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    const binDir = join(root, 'bin')
    fakeBin(binDir, 'grok')
    const relDir = relative(process.cwd(), binDir)
    expect(isAbsolute(relDir)).toBe(false)
    const found = findOnPath('grok', { pathEnv: relDir, extraDirs: [], home: root })
    expect(found).toBe(resolve(relDir, 'grok'))
    expect(isAbsolute(found!)).toBe(true)
  })

  it('detectHarnesses returns only binaries present, with configHome + providerKey', async () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    const binDir = join(root, 'bin')
    const grok = fakeBin(binDir, 'grok')
    const hermes = fakeBin(binDir, 'hermes')
    mkdirSync(join(root, '.hermes', 'hermes-agent', 'venv'), { recursive: true })

    const found = await detectHarnesses({
      pathEnv: binDir,
      extraDirs: [],
      home: root,
      skipVersion: true,
    })
    const byId = Object.fromEntries(found.map((h) => [h.id, h]))

    expect(Object.keys(byId).sort()).toEqual(['grok-build', 'hermes'])
    expect(byId['grok-build']).toMatchObject({
      command: 'grok',
      binary: grok,
      providerKey: 'grok-cli',
      configHome: join(root, '.grok'),
    })
    expect(byId.hermes).toMatchObject({
      command: 'hermes',
      binary: hermes,
      providerKey: 'hermes-cli',
      configHome: join(root, '.hermes'),
      venv: join(root, '.hermes', 'hermes-agent', 'venv'),
    })
    expect(byId['claude-code']).toBeUndefined()
  })

  it('does not report a hermes venv when the directory is absent', async () => {
    root = mkdtempSync(join(tmpdir(), 'harness-detect-'))
    fakeBin(join(root, 'bin'), 'hermes')
    const found = await detectHarnesses({
      pathEnv: join(root, 'bin'),
      extraDirs: [],
      home: root,
      skipVersion: true,
    })
    expect(found).toHaveLength(1)
    expect(found[0].venv).toBeUndefined()
  })
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(pid)
}

describe('execFileAsync timeout', () => {
  let root: string | undefined
  let strayPid: number | undefined

  afterEach(() => {
    if (strayPid && pidAlive(strayPid)) {
      try {
        process.kill(strayPid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    strayPid = undefined
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('returns timedOut and reaps the grandchild (group kill)', { timeout: 8_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'exec-timeout-'))
    const script = join(root, 'sleep-tree.sh')
    const pidFile = join(root, 'child.pid')
    writeFileSync(script, '#!/bin/sh\nsleep 60 &\necho $! > "$1"\nwait\n')
    chmodSync(script, 0o755)
    const timeoutMs = 400
    const started = Date.now()
    const result = await execFileAsync(script, [pidFile], { timeoutMs })
    const elapsed = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(timeoutMs + 1000)
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(pid).toBeGreaterThan(0)
    strayPid = pid
    await new Promise((r) => setTimeout(r, 100))
    expect(pidAlive(pid), 'grandchild must be dead after group SIGTERM').toBe(false)
  })

  it('SIGKILL-escalates a grandchild that traps TERM', { timeout: 10_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'exec-timeout-trap-'))
    const script = join(root, 'trap-tree.sh')
    const pidFile = join(root, 'child.pid')
    writeFileSync(script, '#!/bin/sh\nsh -c \'trap "" TERM; sleep 60\' &\necho $! > "$1"\nwait\n')
    chmodSync(script, 0o755)
    const timeoutMs = 400
    const started = Date.now()
    const result = await execFileAsync(script, [pidFile], { timeoutMs })
    const elapsed = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(timeoutMs + 1000)
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(pid).toBeGreaterThan(0)
    strayPid = pid
    // Leader already exited; SIGTERM-resistant grandchild dies on the 2 s SIGKILL.
    expect(await waitUntilDead(pid, 3_500)).toBe(true)
  })
})
