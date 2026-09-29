import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TermRoster } from '../term/roster.js'
import {
  INSTALLED_TTL_MS,
  createInstalledProbe,
  harnessSpawnPath,
  rosterEntrySpawnable,
  withUserLocalBin,
} from './installed.js'

let dir: string
let home: string
let sysBin: string

function exe(path: string): void {
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
}

function roster(commands: TermRoster['commands'], env: Record<string, string> = {}): TermRoster {
  return { default: 'claude', cwd: home, env, commands }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'installed-'))
  home = join(dir, 'home')
  sysBin = join(dir, 'usr-bin')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  mkdirSync(sysBin)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('withUserLocalBin', () => {
  it('appends ~/.local/bin once', () => {
    expect(withUserLocalBin('/usr/bin', '/h')).toBe('/usr/bin:/h/.local/bin')
    expect(withUserLocalBin('/h/.local/bin:/usr/bin', '/h')).toBe('/h/.local/bin:/usr/bin')
    expect(withUserLocalBin(undefined, '/h')).toBe('/h/.local/bin')
  })
})

describe('harnessSpawnPath', () => {
  it('entry env beats roster env beats service PATH + ~/.local/bin', () => {
    expect(harnessSpawnPath({ env: {} }, {}, '/usr/bin', '/h')).toBe('/usr/bin:/h/.local/bin')
    expect(harnessSpawnPath({ env: { PATH: '/r' } }, {}, '/usr/bin', '/h')).toBe('/r')
    expect(harnessSpawnPath({ env: { PATH: '/r' } }, { env: { PATH: '/e' } }, '/usr/bin')).toBe(
      '/e',
    )
  })
})

describe('rosterEntrySpawnable', () => {
  it('finds argv[0] on the service PATH or ~/.local/bin, not elsewhere', () => {
    exe(join(sysBin, 'claude'))
    exe(join(home, '.local', 'bin', 'hermes'))
    // A login-shell-only dir (mise shims) is invisible to the den.
    const shims = join(home, '.local', 'share', 'mise', 'shims')
    mkdirSync(shims, { recursive: true })
    exe(join(shims, 'kimi'))
    const r = roster({
      claude: { label: 'Claude', cmd: ['claude'], room: true },
      hermes: { label: 'Hermes', cmd: ['hermes', '--yolo'], room: true },
      kimi: { label: 'Kimi', cmd: ['kimi'], room: true },
    })
    expect(rosterEntrySpawnable(r, 'claude', sysBin, home)).toBe(true)
    expect(rosterEntrySpawnable(r, 'hermes', sysBin, home)).toBe(true)
    expect(rosterEntrySpawnable(r, 'kimi', sysBin, home)).toBe(false)
    expect(rosterEntrySpawnable(r, 'grok', sysBin, home)).toBe(false)
  })

  it('checks an absolute argv[0] directly and rejects non-executables', () => {
    const abs = join(dir, 'custom-agent')
    exe(abs)
    writeFileSync(join(sysBin, 'grok'), 'not executable')
    const r = roster({
      cursor: { label: 'Cursor', cmd: [abs], room: true },
      grok: { label: 'Grok', cmd: ['grok'], room: true },
    })
    expect(rosterEntrySpawnable(r, 'cursor', sysBin, home)).toBe(true)
    expect(rosterEntrySpawnable(r, 'grok', sysBin, home)).toBe(false)
  })
})

describe('createInstalledProbe', () => {
  it('maps harness ids to roster keys and re-checks after the TTL', () => {
    let t = 0
    const r = roster({ cursor: { label: 'Cursor', cmd: ['agent'], room: true } })
    const probe = createInstalledProbe({
      roster: () => r,
      basePath: () => sysBin,
      home,
      now: () => t,
      alwaysInstalled: (id) => id === 'codex',
    })
    expect(probe('cursor')).toBe(false)
    expect(probe('codex')).toBe(true)
    exe(join(sysBin, 'agent'))
    expect(probe('cursor')).toBe(false) // cached
    t += INSTALLED_TTL_MS
    expect(probe('cursor')).toBe(true)
  })
})
