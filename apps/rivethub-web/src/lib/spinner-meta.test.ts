import { describe, expect, it } from 'vitest'
import { formatSpinnerMeta, parseSpinnerMeta } from './spinner-meta.js'

describe('parseSpinnerMeta', () => {
  it('parses seconds-only and minute forms', () => {
    expect(parseSpinnerMeta('✳ Wrangling… (0s · ↓ 0 tokens)')).toEqual({
      pre: '✳ Wrangling… (',
      secs: 0,
      suf: ' · ↓ 0 tokens)',
    })
    expect(parseSpinnerMeta('✢ Architecting… (1m 22s · ↓ 4.8k tokens)')).toEqual({
      pre: '✢ Architecting… (',
      secs: 82,
      suf: ' · ↓ 4.8k tokens)',
    })
  })

  it('rejects real thinking text', () => {
    expect(parseSpinnerMeta('the parser needs a lookahead here because…')).toBeNull()
    expect(parseSpinnerMeta('✳ no meta suffix')).toBeNull()
  })
})

describe('formatSpinnerMeta', () => {
  it('advances elapsed time and rolls into minutes', () => {
    const meta = parseSpinnerMeta('✳ Wrangling… (55s · ↓ 12 tokens)')
    expect(meta).not.toBeNull()
    if (!meta) return
    expect(formatSpinnerMeta(meta, 0)).toBe('✳ Wrangling… (55s · ↓ 12 tokens)')
    expect(formatSpinnerMeta(meta, 10)).toBe('✳ Wrangling… (1m 5s · ↓ 12 tokens)')
  })
})
