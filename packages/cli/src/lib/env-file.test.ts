import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRivetEnv, parseRivetEnv } from './env-file.js'

const TRACKED = ['EXISTING', 'NEW'] as const
const ORIGINAL: Record<string, string | undefined> = {}
for (const key of TRACKED) ORIGINAL[key] = process.env[key]

afterEach(() => {
  for (const key of TRACKED) {
    const prev = ORIGINAL[key]
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
})

describe('parseRivetEnv', () => {
  it('parses KEY=VALUE, export prefix, quotes, and # comments', () => {
    const parsed = parseRivetEnv(`
# full-line comment
FOO=bar
export BAZ=qux
QUOTED="hello world"
SINGLE='keep # hash'
INLINE=value # trailing
EMPTY=
DISABLED= # intentionally empty
SPACES = padded
`)
    expect(parsed).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
      QUOTED: 'hello world',
      SINGLE: 'keep # hash',
      INLINE: 'value',
      EMPTY: '',
      DISABLED: '',
      SPACES: 'padded',
    })
  })

  it('decodes common double-quoted escapes and skips malformed lines', () => {
    const parsed = parseRivetEnv(`
A="a\\nb"
B="say \\"hi\\""
NOT A KEY=nope
=nokey
justtext
`)
    expect(parsed.A).toBe('a\nb')
    expect(parsed.B).toBe('say "hi"')
    expect(parsed['NOT A KEY']).toBeUndefined()
    expect(Object.keys(parsed)).toEqual(['A', 'B'])
  })

  it('last assignment of a key wins', () => {
    expect(parseRivetEnv('FOO=one\nFOO=two\n').FOO).toBe('two')
  })
})

describe('loadRivetEnv', () => {
  it('merges without overriding already-set keys and returns applied keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-env-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'EXISTING=fromfile\nNEW=applied\n')
    process.env.EXISTING = 'preset'
    delete process.env.NEW

    const applied = loadRivetEnv(path)

    expect(process.env.EXISTING).toBe('preset')
    expect(process.env.NEW).toBe('applied')
    expect(applied).toEqual(['NEW'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('overrides when override: true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-env-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'EXISTING=fromfile\n')
    process.env.EXISTING = 'preset'

    const applied = loadRivetEnv(path, { override: true })

    expect(process.env.EXISTING).toBe('fromfile')
    expect(applied).toEqual(['EXISTING'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns [] when the file is missing', () => {
    expect(loadRivetEnv(join(tmpdir(), 'no-such-rivet-env-file'))).toEqual([])
  })
})
