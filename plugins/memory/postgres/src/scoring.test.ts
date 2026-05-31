import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion, RRF_K_DEFAULT } from './scoring.js'

const keyOf = (x: { id: string }): string => x.id

describe('reciprocalRankFusion', () => {
  it('scores a single list by 1/(k + rank)', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const fused = reciprocalRankFusion([[a, b]], keyOf, 60)
    expect(fused.get('a')?.rrf).toBeCloseTo(1 / 61, 10)
    expect(fused.get('b')?.rrf).toBeCloseTo(1 / 62, 10)
  })

  it('accumulates contributions for a doc found by multiple lists', () => {
    const a = { id: 'a' }
    // 'a' is rank 1 in list one and rank 2 in list two
    const fused = reciprocalRankFusion([[a], [{ id: 'x' }, a]], keyOf, 60)
    expect(fused.get('a')?.rrf).toBeCloseTo(1 / 61 + 1 / 62, 10)
  })

  it('ranks a doc found by two methods above one found by a single method', () => {
    const shared = { id: 'shared' }
    const lonelyTop = { id: 'lonely' }
    // 'lonely' is rank 1 in list two (strong single signal); 'shared' is rank 3
    // in list one but also rank 2 in list two — fusion should lift it above.
    const fused = reciprocalRankFusion(
      [
        [{ id: 'p' }, { id: 'q' }, shared],
        [lonelyTop, shared],
      ],
      keyOf,
      60,
    )
    const sharedScore = fused.get('shared')!.rrf // 1/63 + 1/62
    const lonelyScore = fused.get('lonely')!.rrf // 1/61
    expect(sharedScore).toBeGreaterThan(lonelyScore)
  })

  it('keeps the first-seen item instance on collision', () => {
    const first = { id: 'a', tag: 'first' }
    const second = { id: 'a', tag: 'second' }
    const fused = reciprocalRankFusion([[first], [second]], keyOf, 60)
    expect(fused.get('a')?.item.tag).toBe('first')
  })

  it('a smaller k sharpens the top-rank advantage', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const sharp = reciprocalRankFusion([[a, b]], keyOf, 1)
    const flat = reciprocalRankFusion([[a, b]], keyOf, 1000)
    const sharpGap = sharp.get('a')!.rrf - sharp.get('b')!.rrf
    const flatGap = flat.get('a')!.rrf - flat.get('b')!.rrf
    expect(sharpGap).toBeGreaterThan(flatGap)
  })

  it('defaults k to the canonical 60', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }]], keyOf)
    expect(RRF_K_DEFAULT).toBe(60)
    expect(fused.get('a')?.rrf).toBeCloseTo(1 / 61, 10)
  })

  it('handles empty and missing lists without error', () => {
    expect(reciprocalRankFusion([], keyOf).size).toBe(0)
    expect(reciprocalRankFusion([[], []], keyOf).size).toBe(0)
  })
})
