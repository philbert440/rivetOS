import { describe, expect, it } from 'vitest'
import { parseArgs } from './opencode-theme-cli.js'

describe('parseArgs', () => {
  it('accepts a bare input path', () => {
    expect(parseArgs(['in.toml'])).toEqual({
      ok: true,
      input: 'in.toml',
      out: undefined,
      noSet: false,
      transparent: false,
    })
  })

  it('accepts --out x input', () => {
    expect(parseArgs(['--out', 'x', 'input'])).toEqual({
      ok: true,
      input: 'input',
      out: 'x',
      noSet: false,
      transparent: false,
    })
  })

  it('accepts input --no-set', () => {
    expect(parseArgs(['input', '--no-set'])).toEqual({
      ok: true,
      input: 'input',
      out: undefined,
      noSet: true,
      transparent: false,
    })
  })

  it('rejects --out --no-set input as a usage error', () => {
    expect(parseArgs(['--out', '--no-set', 'input'])).toEqual({
      ok: false,
      error: 'usage',
    })
  })
})
