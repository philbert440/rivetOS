import { describe, expect, it } from 'vitest'
import {
  compactTokens,
  contextWindowFor,
  estimatePromptTokens,
} from './context-window.js'

describe('contextWindowFor', () => {
  it('matches known families', () => {
    expect(contextWindowFor('claude-opus-4')).toBe(200_000)
    expect(contextWindowFor('grok-4')).toBe(256_000)
    expect(contextWindowFor('qwen2.5-27b')).toBe(128_000)
    expect(contextWindowFor('local-vllm')).toBe(32_768)
  })

  it('defaults when unknown', () => {
    expect(contextWindowFor(undefined)).toBe(200_000)
    expect(contextWindowFor('mystery-model')).toBe(200_000)
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
    expect(compactTokens(1_000_000)).toBe('1M')
  })
})
