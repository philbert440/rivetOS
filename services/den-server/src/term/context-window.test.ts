import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPACT_RESERVE,
  compactAtFor,
  contextWindowFromModel,
  learnCompactAt,
  overlaySessionContext,
  promoteIfExceeded,
  rememberSessionContext,
  resetSessionContextForTest,
  stampDefault,
  stampFromSpawn,
} from './context-window.js'

afterEach(() => resetSessionContextForTest())

describe('contextWindowFromModel', () => {
  it('stamps Claude at 200k unless the [1m] / -1m variant is explicit', () => {
    expect(contextWindowFromModel('fable', 'claude')).toBe(200_000)
    expect(contextWindowFromModel(undefined, 'claude')).toBe(200_000)
    expect(contextWindowFromModel('claude-fable-5-1')).toBe(200_000)
    expect(contextWindowFromModel('claude-opus-4-8')).toBe(200_000)
    expect(contextWindowFromModel(undefined, 'claude-code')).toBe(200_000)
  })

  it('stamps fable[1m] / opus[1m] at 1M', () => {
    expect(contextWindowFromModel('fable[1m]', 'claude')).toBe(1_000_000)
    expect(contextWindowFromModel('opus[1m]', 'claude')).toBe(1_000_000)
    expect(contextWindowFromModel('sonnet[1m]')).toBe(1_000_000)
    expect(contextWindowFromModel('fable-1m')).toBe(1_000_000)
  })

  it('stamps grok at 500k and local/vllm at 262_144', () => {
    expect(contextWindowFromModel('grok-4.6', 'grok')).toBe(500_000)
    expect(contextWindowFromModel(undefined, 'grok-build')).toBe(500_000)
    expect(contextWindowFromModel(undefined, 'hermes')).toBe(262_144)
    expect(contextWindowFromModel('local-vllm')).toBe(262_144)
  })
})

describe('compactAtFor', () => {
  it('subtracts COMPACT_RESERVE (measured-on-1M / provisional-on-200k)', () => {
    expect(COMPACT_RESERVE).toBe(35_000)
    expect(compactAtFor(200_000)).toBe(165_000)
    expect(compactAtFor(1_000_000)).toBe(965_000)
    expect(compactAtFor(500_000)).toBe(465_000)
  })
})

describe('stampFromSpawn / stampDefault', () => {
  it('spawn of fable is 200k spawn; fable[1m] is 1M spawn', () => {
    expect(stampFromSpawn('fable', 'claude')).toEqual({
      contextWindow: 200_000,
      compactAt: 165_000,
      contextSource: 'spawn',
    })
    expect(stampFromSpawn('fable[1m]', 'claude')).toEqual({
      contextWindow: 1_000_000,
      compactAt: 965_000,
      contextSource: 'spawn',
    })
  })

  it('default (attached/resumed) Claude is 200k, not 1M', () => {
    expect(stampDefault(undefined, 'claude')).toEqual({
      contextWindow: 200_000,
      compactAt: 165_000,
      contextSource: 'default',
    })
  })
})

describe('promoteIfExceeded', () => {
  it('promotes a 200k default to 1M observed when promptTokens exceed the window', () => {
    const promoted = promoteIfExceeded(stampDefault(undefined, 'claude'), 200_001)
    expect(promoted.contextWindow).toBe(1_000_000)
    expect(promoted.compactAt).toBe(965_000)
    expect(promoted.contextSource).toBe('observed')
  })

  it('leaves a 200k stamp alone at 180k (about-to-compact on the real window)', () => {
    expect(promoteIfExceeded(stampDefault(undefined, 'claude'), 180_000).contextWindow).toBe(
      200_000,
    )
  })
})

describe('learnCompactAt', () => {
  it('returns the pre-drop size when context drops by more than 50%', () => {
    expect(learnCompactAt(964_285, 300_000, 1_000_000)).toBe(964_285)
    expect(learnCompactAt(180_000, 40_000, 200_000)).toBe(180_000)
  })

  it('ignores drops of 50% or less, growth, and junk', () => {
    expect(learnCompactAt(100, 50, 200_000)).toBeUndefined()
    expect(learnCompactAt(100, 51, 200_000)).toBeUndefined()
    expect(learnCompactAt(100, 120, 200_000)).toBeUndefined()
    expect(learnCompactAt(0, 0, 200_000)).toBeUndefined()
    expect(learnCompactAt(100, 10, 0)).toBeUndefined()
  })
})

describe('overlaySessionContext', () => {
  it('defaults Claude transcripts den did not spawn to 200k', () => {
    const stamp = overlaySessionContext('claude-code:abc', [{ role: 'user' }], 'claude-code')
    expect(stamp).toEqual({
      contextWindow: 200_000,
      compactAt: 165_000,
      contextSource: 'default',
    })
  })

  it('auto-promotes when any observed promptTokens exceed the assumed window', () => {
    const stamp = overlaySessionContext(
      'sess-promote',
      [{ role: 'assistant', usage: { promptTokens: 250_000 } }],
      'claude',
    )
    expect(stamp.contextWindow).toBe(1_000_000)
    expect(stamp.contextSource).toBe('observed')
  })

  it('learns compactAt from a >50% drop and remembers it for that window', () => {
    const first = overlaySessionContext(
      'sess-learn',
      [
        { role: 'assistant', usage: { promptTokens: 964_285 } },
        { role: 'user' },
        { role: 'assistant', usage: { promptTokens: 300_000 } },
      ],
      'claude',
    )
    expect(first.compactAt).toBe(964_285)
    expect(first.contextWindow).toBe(1_000_000) // promoted by 964k > 200k
    expect(first.contextSource).toBe('observed')

    const later = overlaySessionContext('sess-other-1m', [], 'claude')
    // no usage on the new session, but the 1M compactAt was learned globally —
    // this session is still a 200k default (no [1m], no overflow). The learned
    // 1M value must not leak onto a 200k default.
    expect(later.contextWindow).toBe(200_000)
    expect(later.compactAt).toBe(165_000)

    rememberSessionContext('sess-1m-spawn', stampFromSpawn('fable[1m]', 'claude'))
    const inherit = overlaySessionContext('sess-1m-spawn', [], 'claude')
    expect(inherit.contextWindow).toBe(1_000_000)
    expect(inherit.compactAt).toBe(964_285)
    expect(inherit.contextSource).toBe('observed')
  })
})
