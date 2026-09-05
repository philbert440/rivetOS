import { describe, expect, it } from 'vitest'
import {
  compactAtFor,
  compactTokens,
  contextFill,
  contextWindowFor,
  estimatePromptTokens,
} from './context-window.js'

describe('contextWindowFor', () => {
  it('matches Claude at 200k (not 1M)', () => {
    expect(contextWindowFor('claude')).toBe(200_000)
    expect(contextWindowFor('claude-opus-4')).toBe(200_000)
    expect(contextWindowFor('claude-sonnet-4')).toBe(200_000)
    expect(contextWindowFor('claude-fable-5-1')).toBe(200_000)
    expect(contextWindowFor('anthropic')).toBe(200_000)
    expect(contextWindowFor('fable')).toBe(200_000)
  })

  it('matches 1M only on an explicit [1m] / -1m substring', () => {
    expect(contextWindowFor('fable[1m]')).toBe(1_000_000)
    expect(contextWindowFor('opus[1m]')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(contextWindowFor('fable-1m')).toBe(1_000_000)
  })

  it('matches grok at 500k', () => {
    expect(contextWindowFor('grok')).toBe(500_000)
    expect(contextWindowFor('grok-4')).toBe(500_000)
    expect(contextWindowFor('grok-fast')).toBe(500_000)
  })

  it('matches local at 262_144', () => {
    expect(contextWindowFor('local')).toBe(262_144)
    expect(contextWindowFor('local-vllm')).toBe(262_144)
    expect(contextWindowFor('llama-server')).toBe(262_144)
    expect(contextWindowFor('qwen2.5-27b')).toBe(262_144)
  })

  it('defaults to local window when unknown', () => {
    expect(contextWindowFor(undefined)).toBe(262_144)
    expect(contextWindowFor('mystery-model')).toBe(262_144)
  })
})

describe('compactAtFor', () => {
  it('subtracts the 35k reserve', () => {
    expect(compactAtFor(200_000)).toBe(165_000)
    expect(compactAtFor(1_000_000)).toBe(965_000)
    expect(compactAtFor(500_000)).toBe(465_000)
  })
})

describe('contextFill', () => {
  it('180k of a 200k window is 100% (forced compact), not 18% of 1M', () => {
    // Old bug: contextWindowFor('claude') was 1M, so 180k rendered as 18%.
    expect(Math.round((180_000 / 1_000_000) * 100)).toBe(18)
    const fill = contextFill({ tokens: 180_000, contextWindow: 200_000 })
    // 180_000 / 165_000 ≈ 109% → clamped 100%
    expect(fill.pct).toBe(100)
    expect(fill.hot).toBe(true)
    expect(fill.warn).toBe(true)
  })

  it('150k of 200k is ~91% hot (Playwright 412px case)', () => {
    const fill = contextFill({ tokens: 150_000, contextWindow: 200_000 })
    expect(fill.pct).toBe(91)
    expect(fill.hot).toBe(true)
    expect(fill.warn).toBe(true)
  })

  it('warns at ≥70% and goes hot at ≥90% of compactAt', () => {
    const cool = contextFill({ tokens: 100_000, contextWindow: 200_000 })
    expect(cool.pct).toBe(61)
    expect(cool.warn).toBe(false)
    expect(cool.hot).toBe(false)

    const warn = contextFill({ tokens: 115_500, contextWindow: 200_000 })
    expect(warn.pct).toBe(70)
    expect(warn.warn).toBe(true)
    expect(warn.hot).toBe(false)

    const hot = contextFill({ tokens: 148_500, contextWindow: 200_000 })
    expect(hot.pct).toBe(90)
    expect(hot.hot).toBe(true)
  })

  it('prefers an explicit compactAt over window − 35k', () => {
    const fill = contextFill({
      tokens: 180_000,
      contextWindow: 200_000,
      compactAt: 180_000,
    })
    expect(fill.pct).toBe(100)
  })
})

describe('estimatePromptTokens', () => {
  it('uses chars÷4 plus framing', () => {
    // 4 chars → 1 token + 4 framing = 5
    expect(estimatePromptTokens(['abcd'])).toBe(5)
    expect(estimatePromptTokens(['', 'abcdefgh'])).toBe(4 + 0 + 4 + 2)
  })

  it('sums multiple turns', () => {
    const one = estimatePromptTokens(['hello world'])
    const two = estimatePromptTokens(['hello world', 'reply'])
    expect(two).toBeGreaterThan(one)
  })
})

describe('compactTokens', () => {
  it('formats k and M', () => {
    expect(compactTokens(500)).toBe('500')
    expect(compactTokens(18_400)).toBe('18.4k')
    expect(compactTokens(165_000)).toBe('165k')
    expect(compactTokens(262_144)).toBe('262k')
    expect(compactTokens(500_000)).toBe('500k')
    expect(compactTokens(1_000_000)).toBe('1M')
  })
})
