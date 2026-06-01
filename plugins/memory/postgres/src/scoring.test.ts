import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion, RRF_K_DEFAULT, importanceForRole, temporalDecay } from './scoring.js'

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

describe('importanceForRole', () => {
  it('ranks user intent ≥ assistant prose > tool-call stubs', () => {
    expect(importanceForRole('user', false)).toBeGreaterThanOrEqual(
      importanceForRole('assistant', false),
    )
    expect(importanceForRole('assistant', false)).toBeGreaterThan(
      importanceForRole('assistant', true),
    )
  })

  it('no longer lets tool-call stubs outrank prose (regression for the inversion)', () => {
    // The bug: hasToolCall returned 0.7, above user (0.6) and assistant (0.5).
    expect(importanceForRole('assistant', true)).toBeLessThan(importanceForRole('user', false))
    expect(importanceForRole('assistant', true)).toBeLessThan(importanceForRole('assistant', false))
  })
})

describe('temporalDecay', () => {
  it('decays with age', () => {
    expect(temporalDecay(0, 0)).toBeGreaterThan(temporalDecay(30, 0))
  })

  it('baseline (no access) is 1.0 at age 0', () => {
    expect(temporalDecay(0, 0)).toBeCloseTo(1.0, 10)
  })

  it('caps reinforcement so a hot row cannot run away', () => {
    const huge = temporalDecay(0, 100_000)
    const atCap = temporalDecay(0, 25)
    expect(huge).toBeCloseTo(atCap, 10) // both clamp to the cap
    expect(huge).toBeLessThanOrEqual(1.25 + 1e-9) // bounded: 1 + 0.01*25
  })
})
