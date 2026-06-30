/**
 * Unit tests for chat-stream-aisdk — message folding, tool building,
 * and error handling for AI SDK streaming.
 */

import { describe, it, expect } from 'vitest'
import { splitAndFoldSystem } from './chat-stream-aisdk.js'
import type { Message, ContentPart } from '@rivetos/types'

describe('splitAndFoldSystem', () => {
  describe('leading system messages', () => {
    it('preserves a single leading system message', () => {
      const messages: Message[] = [{ role: 'system', content: 'Be terse' }]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('Be terse')
      expect(rest).toEqual([])
    })

    it('concatenates multiple contiguous leading system messages with double newline', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System A' },
        { role: 'system', content: 'System B' },
        { role: 'system', content: 'System C' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('System A\n\nSystem B\n\nSystem C')
      expect(rest).toEqual([])
    })

    it('stops concatenating system at first non-system message', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System 1' },
        { role: 'system', content: 'System 2' },
        { role: 'user', content: 'User message' },
        { role: 'system', content: 'System 3' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('System 1\n\nSystem 2')
      expect(rest).toHaveLength(2)
      expect(rest[0]).toEqual({ role: 'user', content: 'User message' })
    })
  })

  describe('mid-conversation system messages', () => {
    it('folds mid-conversation system into [SYSTEM NOTICE] user message', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Initial' },
        { role: 'system', content: 'Important notice' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('')
      expect(rest).toHaveLength(2)
      expect(rest[1]).toEqual({
        role: 'user',
        content: '[SYSTEM NOTICE]\nImportant notice',
      })
    })

    it('prefixes with [SYSTEM NOTICE] even when system content is empty', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: '' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(rest[1]).toEqual({
        role: 'user',
        content: '[SYSTEM NOTICE]\n(empty system message)',
      })
    })

    it('multiple mid-conversation system messages each become separate user messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q1' },
        { role: 'system', content: 'Notice 1' },
        { role: 'assistant', content: 'A1' },
        { role: 'system', content: 'Notice 2' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(rest).toHaveLength(4)
      expect(rest[1]).toEqual({
        role: 'user',
        content: '[SYSTEM NOTICE]\nNotice 1',
      })
      expect(rest[3]).toEqual({
        role: 'user',
        content: '[SYSTEM NOTICE]\nNotice 2',
      })
    })
  })

  describe('complex message histories', () => {
    it('handles realistic assistant + tool call + tool result + system + user flow', () => {
      const messages: Message[] = [
        { role: 'system', content: 'Initial system' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'I will use a tool' },
        { role: 'system', content: 'Context reminder' },
        { role: 'user', content: 'Second message' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('Initial system')
      expect(rest).toHaveLength(4)
      // rest[0]: user, rest[1]: assistant, rest[2]: folded system, rest[3]: user
      expect(rest[2]).toEqual({
        role: 'user',
        content: '[SYSTEM NOTICE]\nContext reminder',
      })
    })

    it('preserves original non-system messages in order', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'system', content: 'Notice' },
        { role: 'user', content: 'Q2' },
        { role: 'assistant', content: 'A2' },
      ]
      const { rest } = splitAndFoldSystem(messages)

      expect(rest[0]).toEqual({ role: 'user', content: 'Q1' })
      expect(rest[1]).toEqual({ role: 'assistant', content: 'A1' })
      expect(rest[2]).toHaveProperty('role', 'user')
      expect(rest[2]).toHaveProperty('content', '[SYSTEM NOTICE]\nNotice')
      expect(rest[3]).toEqual({ role: 'user', content: 'Q2' })
      expect(rest[4]).toEqual({ role: 'assistant', content: 'A2' })
    })
  })

  describe('content extraction from message parts', () => {
    it('extracts text from string content', () => {
      const messages: Message[] = [
        { role: 'system', content: 'Simple text' },
        { role: 'user', content: 'Hello' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('Simple text')
      expect(rest[0].content).toBe('Hello')
    })

    it('extracts text from content array with text parts', () => {
      const messages: Message[] = [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Part A' },
            { type: 'text', text: 'Part B' },
          ] as ContentPart[],
        },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      // Should concatenate text parts
      expect(system).toContain('Part A')
      expect(system).toContain('Part B')
    })

    it('ignores non-text parts in content array', () => {
      const messages: Message[] = [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Only text' },
            { type: 'image', data: 'base64data' },
          ] as ContentPart[],
        },
      ]
      const { system } = splitAndFoldSystem(messages)

      expect(system).toBe('Only text')
    })

    it('handles empty content gracefully', () => {
      const messages: Message[] = [{ role: 'system', content: '' }]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('')
      expect(rest).toEqual([])
    })

    it('handles system message with only non-text parts', () => {
      const messages: Message[] = [
        { role: 'system', content: [{ type: 'image', data: 'data' }] as ContentPart[] },
        { role: 'user', content: 'Hello' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('')
      expect(rest).toHaveLength(1)
    })
  })

  describe('edge cases', () => {
    it('empty message list returns empty results', () => {
      const { system, rest } = splitAndFoldSystem([])

      expect(system).toBe('')
      expect(rest).toEqual([])
    })

    it('only non-system messages returns empty system', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('')
      expect(rest).toEqual(messages)
    })

    it('only system messages returns no rest messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'S1' },
        { role: 'system', content: 'S2' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('S1\n\nS2')
      expect(rest).toEqual([])
    })

    it('single mid-conversation system with no leading system', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        { role: 'system', content: 'Mid notice' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('')
      expect(rest).toHaveLength(2)
      expect(rest[1].role).toBe('user')
      expect(rest[1].content).toContain('[SYSTEM NOTICE]')
    })

    it('alternating system and non-system preserves all messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'S1' },
        { role: 'user', content: 'U1' },
        { role: 'system', content: 'S2' },
        { role: 'assistant', content: 'A1' },
        { role: 'system', content: 'S3' },
      ]
      const { system, rest } = splitAndFoldSystem(messages)

      expect(system).toBe('S1')
      expect(rest).toHaveLength(4)
      expect(rest.filter((m) => m.role === 'user')).toHaveLength(3)
    })
  })

  describe('no-op safe guards', () => {
    it('does not mutate input messages array', () => {
      const messages: Message[] = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ]
      const original = JSON.stringify(messages)

      splitAndFoldSystem(messages)

      expect(JSON.stringify(messages)).toBe(original)
    })

    it('does not modify original message objects', () => {
      const userMsg = { role: 'user' as const, content: 'Hello' }
      const systemMsg = { role: 'system' as const, content: 'Notice' }
      const messages: Message[] = [userMsg, systemMsg]

      splitAndFoldSystem(messages)

      expect(userMsg.content).toBe('Hello')
      expect(systemMsg.content).toBe('Notice')
    })
  })
})
