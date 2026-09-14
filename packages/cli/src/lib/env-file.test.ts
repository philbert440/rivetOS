import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRivetEnv, parseRivetEnv, upsertEnvVars } from './env-file.js'

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

describe('upsertEnvVars', () => {
  it('creates a 0600 file and keeps unrelated lines when updating keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-env-upsert-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'KEEP=yes\nRIVETOS_PG_URL=old\n')

    const result = upsertEnvVars(path, {
      RIVETOS_PG_URL: 'postgres://n',
      RIVETOS_EMBED_URL: 'https://rivetos.cloud/embed/t',
    })

    const body = readFileSync(path, 'utf8')
    expect(body).toContain('KEEP=yes')
    expect(body).toContain('RIVETOS_PG_URL=postgres://n')
    expect(body).toContain('RIVETOS_EMBED_URL=https://rivetos.cloud/embed/t')
    expect(result.written).toBe(true)
    expect(result.diff.find((d) => d.key === 'RIVETOS_PG_URL')).toEqual({
      key: 'RIVETOS_PG_URL',
      from: 'old',
      to: 'postgres://n',
    })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })

  it('dry-run does not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-env-dry-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'FOO=bar\n')
    const result = upsertEnvVars(path, { FOO: 'baz' }, { dryRun: true })
    expect(readFileSync(path, 'utf8')).toBe('FOO=bar\n')
    expect(result.written).toBe(false)
    expect(result.next).toContain('FOO=baz')
    rmSync(dir, { recursive: true, force: true })
  })
})
