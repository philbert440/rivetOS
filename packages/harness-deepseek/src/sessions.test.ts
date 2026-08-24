import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DSH_ID_PREFIX,
  adoptFreshSessionId,
  dshHome,
  isDshNativeId,
  listSessionIds,
  listSessions,
  resolveSessionDir,
  sessionsRoot,
} from './sessions.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const NAT = 'session-86ffe759-cd7b-49a7-955d-c282631a935d'
const NAT2 = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function fakeStore(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sess-'))
  dirs.push(home)
  const dir = path.join(home, 'sessions', 'home-rivet-workspace', NAT)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), '')
  return home
}

describe('native id shape', () => {
  it('accepts session-<uuid> and rejects kimi’s underscore form', () => {
    expect(isDshNativeId(NAT)).toBe(true)
    expect(isDshNativeId('session_86ffe759-cd7b-49a7-955d-c282631a935d')).toBe(false)
    expect(isDshNativeId('86ffe759-cd7b-49a7-955d-c282631a935d')).toBe(false)
    expect(DSH_ID_PREFIX).toBe('session-')
  })
})

describe('dshHome / sessionsRoot', () => {
  it('prefers an explicit override, then DSH_HOME, then ~/.dsh', () => {
    const previous = process.env.DSH_HOME
    try {
      expect(dshHome('/tmp/explicit')).toBe('/tmp/explicit')
      process.env.DSH_HOME = '/tmp/from-env'
      expect(dshHome()).toBe('/tmp/from-env')
      expect(sessionsRoot('/tmp/explicit')).toBe(path.join('/tmp/explicit', 'sessions'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('list / resolve / adopt', () => {
  it('lists session dirs across cwd slugs', () => {
    const home = fakeStore()
    const listed = listSessions(home)
    expect(listed.map((s) => s.id)).toEqual([NAT])
    expect(listed[0].dir.endsWith(path.join('home-rivet-workspace', NAT))).toBe(true)
    expect(listSessionIds(home)).toEqual(new Set([NAT]))
  })

  it('resolves a native id and rejects path-shaped junk', () => {
    const home = fakeStore()
    expect(resolveSessionDir(home, NAT)?.endsWith(NAT)).toBe(true)
    expect(resolveSessionDir(home, 'session-nope')).toBeUndefined()
    expect(resolveSessionDir(home, '../etc/passwd')).toBeUndefined()
    expect(resolveSessionDir(home, 'foo/bar')).toBeUndefined()
  })

  it('adopts exactly one fresh id', () => {
    const home = fakeStore()
    expect(adoptFreshSessionId(new Set(), home)).toBe(NAT)
    expect(adoptFreshSessionId(new Set([NAT]), home)).toBeUndefined()
    fs.mkdirSync(path.join(home, 'sessions', 'other-slug', NAT2), { recursive: true })
    expect(adoptFreshSessionId(new Set(), home)).toBeUndefined()
  })

  it('treats a dir without a transcript as a session (create-then-flush)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sess-'))
    dirs.push(home)
    fs.mkdirSync(path.join(home, 'sessions', 'wd', NAT), { recursive: true })
    expect(listSessionIds(home)).toEqual(new Set([NAT]))
  })

  it('yields [] when the home has no sessions tree', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-'))
    dirs.push(home)
    expect(listSessions(home)).toEqual([])
    expect(listSessionIds(home).size).toBe(0)
  })
})
