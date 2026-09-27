import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { asString, capForStorage, isRecord, loadEnvFile, safeJson } from './helpers.js'

it('keeps hook helper semantics', () => {
  expect(isRecord({})).toBe(true)
  for (const value of [null, [], 'x', 1]) expect(isRecord(value)).toBe(false)
  expect(asString('')).toBe(null)
  expect(asString(' ')).toBe(' ')
  expect(asString(1)).toBe(null)
  expect(safeJson({ a: 1 })).toBe('{"a":1}')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(safeJson(circular)).toBe('[object Object]')
})
it('caps at the configured limit and reports original length', () => {
  expect(capForStorage('abc')).toEqual({ text: 'abc', fullLength: 3, truncated: false })
  expect(capForStorage('abc', { limit: 2 })).toEqual({ text: 'ab', fullLength: 3, truncated: true })
  expect(capForStorage('x'.repeat(16001)).text).toHaveLength(16000)
})
it('uses hook env parsing without mutating process.env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-env-'))
  try {
    const file = join(dir, '.env')
    writeFileSync(file, '# comment\nA="one"\nB=\'two\'\nA=ignored\nlower=no\nexport C=no\nEMPTY=\n')
    expect(loadEnvFile(file)).toEqual({ A: 'one', B: 'two', EMPTY: '' })
    expect(loadEnvFile(join(dir, 'missing'))).toEqual({})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
