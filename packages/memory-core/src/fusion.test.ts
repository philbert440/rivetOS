import { describe, expect, it } from 'vitest'
import {
  GATE_FRACTION,
  HYBRID_POOL_MAX,
  HYBRID_POOL_MIN,
  HYBRID_RRF_K,
  SUMMARY_FUSION_BONUS,
  hybridPoolSize,
  looksLiteral,
  shouldTrigramFallback,
} from './fusion.js'

describe('hybrid fusion policy', () => {
  it('fetches three candidates per requested result, within the pool bounds', () => {
    expect(hybridPoolSize(1)).toBe(HYBRID_POOL_MIN)
    expect(hybridPoolSize(20)).toBe(60)
    expect(hybridPoolSize(500)).toBe(HYBRID_POOL_MAX)
  })

  it('pins the constants every backend ranks with', () => {
    expect({ HYBRID_RRF_K, GATE_FRACTION, SUMMARY_FUSION_BONUS }).toEqual({
      HYBRID_RRF_K: 20,
      GATE_FRACTION: 0.5,
      SUMMARY_FUSION_BONUS: 1.3,
    })
  })

  it('a literal-looking query joins the literal arm; hyphenated prose only falls back', () => {
    for (const q of ['families.app', '10.0.0.5', 'host:8080', 'src/index.ts', 'qwen3']) {
      expect(looksLiteral(q)).toBe(true)
    }
    expect(looksLiteral('state-of-the-art model')).toBe(false)
    expect(shouldTrigramFallback('state-of-the-art model')).toBe(true)
    expect(shouldTrigramFallback('plain words only')).toBe(false)
  })
})
