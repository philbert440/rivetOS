import { describe, expect, it } from 'vitest'
import {
  compactTokens,
  contextWindowFor,
  estimatePromptTokens,
} from './context-window.js'

describe('contextWindowFor', () => {
  it('matches Claude at 1M', () => {
    expect(contextWindowFor('claude')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-4')).toBe(1_000_000)
    expect(contextWindowFor('anthropic')).toBe(1_000_000)
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
    expect(compactTokens(262_144)).toBe('262k')
    expect(compactTokens(500_000)).toBe('500k')
    expect(compactTokens(1_000_000)).toBe('1M')
  })
})
