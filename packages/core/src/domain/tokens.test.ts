/**
 * Token estimator tests.
 */

import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { estimateTokens, estimateSystemPromptTokens } from './tokens.js'
import type { Message } from '@rivetos/types'

describe('estimateTokens', () => {
  it('should estimate tokens for simple text messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello world' }, // 4 + ceil(11/4) = 4 + 3 = 7
      { role: 'assistant', content: 'Hi there!' }, // 4 + ceil(9/4) = 4 + 3 = 7
    ]
    const tokens = estimateTokens(messages)
    assert.equal(tokens, 14)
  })

  it('should handle empty messages', () => {
    assert.equal(estimateTokens([]), 0)
  })

  it('should count tool call arguments', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Running command',
        toolCalls: [
          { id: 'tc-1', name: 'shell', arguments: { command: 'echo hello' } },
        ],
      },
    ]
    const tokens = estimateTokens(messages)
    // 4 (overhead) + ceil(15/4) (content) + ceil(JSON.stringify args / 4) + 10
    assert.ok(tokens > 4, 'Should include tool call overhead')
  })

  it('should count image parts as ~1000 tokens', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', data: 'abc' },
        ],
      },
    ]
    const tokens = estimateTokens(messages)
    // 4 (overhead) + ceil(12/4) (text) + 1000 (image) = 1007
    assert.ok(tokens >= 1004, 'Should include image token estimate')
  })
})

describe('estimateSystemPromptTokens', () => {
  it('should estimate system prompt tokens', () => {
    const tokens = estimateSystemPromptTokens('You are a helpful assistant.')
    assert.equal(tokens, Math.ceil(28 / 4) + 4) // 7 + 4 = 11
  })
})
