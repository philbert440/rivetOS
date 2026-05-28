/**
 * Unit tests for chat-stream-aisdk helpers
 *
 * Tests pure helper functions: system message splitting, orphaned tool-result
 * stripping, tool set building, and model classification. These functions
 * have deterministic outputs and no side effects.
 */

import { describe, it, expect } from 'vitest'
import type { Message, ToolDefinition, ContentPart } from '@rivetos/types'

// Re-export these helpers as public exports so we can test them
import {
  splitSystem,
  stripOrphanedToolResults,
  buildToolSet,
  isClaude4Model,
} from './chat-stream-aisdk.js'

describe('isClaude4Model', () => {
  it('matches claude-opus-4-7', () => {
    expect(isClaude4Model('claude-opus-4-7')).toBe(true)
  })

  it('matches claude-sonnet-4-20250514', () => {
    expect(isClaude4Model('claude-sonnet-4-20250514')).toBe(true)
  })

  it('matches claude-haiku-4-20250514', () => {
    expect(isClaude4Model('claude-haiku-4-20250514')).toBe(true)
  })

  it('matches with -4 suffix variations', () => {
    expect(isClaude4Model('claude-opus-4-1')).toBe(true)
    expect(isClaude4Model('claude-opus-4')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isClaude4Model('CLAUDE-OPUS-4-7')).toBe(true)
    expect(isClaude4Model('Claude-Opus-4-7')).toBe(true)
  })

  it('rejects Claude 3.5 models', () => {
    expect(isClaude4Model('claude-3-5-sonnet-20241022')).toBe(false)
  })

  it('rejects Claude 3 models', () => {
    expect(isClaude4Model('claude-3-opus-20250219')).toBe(false)
  })

  it('rejects non-claude models', () => {
    expect(isClaude4Model('gpt-4')).toBe(false)
    expect(isClaude4Model('claude-2')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isClaude4Model('')).toBe(false)
  })
})

describe('splitSystem', () => {
  it('extracts single system message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ]
    const { system, rest } = splitSystem(messages)
    expect(system).toBe('You are a helpful assistant.')
    expect(rest).toEqual([{ role: 'user', content: 'Hello' }])
  })

  it('concatenates multiple system messages with newlines', () => {
    const messages: Message[] = [
      { role: 'system', content: 'First instruction.' },
      { role: 'system', content: 'Second instruction.' },
      { role: 'user', content: 'Hello' },
    ]
    const { system, rest } = splitSystem(messages)
    expect(system).toBe('First instruction.\n\nSecond instruction.')
    expect(rest).toHaveLength(1)
  })

  it('handles system messages with content parts (array)', () => {
    const messages: Message[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: 'System text' }],
      },
      { role: 'user', content: 'Hello' },
    ]
    const { system, rest } = splitSystem(messages)
    expect(system).toBe('System text')
  })

  it('preserves order: system messages first, then others', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User 1' },
      { role: 'system', content: 'More system' },
      { role: 'assistant', content: 'Response' },
    ]
    const { system, rest } = splitSystem(messages)
    expect(system).toBe('System\n\nMore system')
    expect(rest).toEqual([
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Response' },
    ])
  })

  it('returns empty string if no system messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]
    const { system, rest } = splitSystem(messages)
    expect(system).toBe('')
    expect(rest).toEqual(messages)
  })

  it('handles empty messages array', () => {
    const { system, rest } = splitSystem([])
    expect(system).toBe('')
    expect(rest).toEqual([])
  })

  it('handles multiple content parts in system message', () => {
    const messages: Message[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    ]
    const { system, rest } = splitSystem(messages)
    expect(system).toBe('Part 1Part 2')
  })
})

describe('stripOrphanedToolResults', () => {
  it('keeps tool results with matching tool_use_id', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [{ id: 'tc1', name: 'shell', arguments: { cmd: 'ls' } }],
      },
      {
        role: 'tool',
        content: 'output',
        toolCallId: 'tc1',
        toolName: 'shell',
      },
    ]
    const result = stripOrphanedToolResults(messages)
    expect(result).toHaveLength(2)
  })

  it('removes tool results with orphaned toolCallId', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [{ id: 'tc1', name: 'shell', arguments: { cmd: 'ls' } }],
      },
      {
        role: 'tool',
        content: 'output',
        toolCallId: 'orphaned-id',
        toolName: 'shell',
      },
    ]
    const result = stripOrphanedToolResults(messages)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
  })

  it('removes tool results without toolCallId field (no matching tool_use)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'result' },
    ]
    const result = stripOrphanedToolResults(messages)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
  })

  it('collects all tool_use ids from all assistant messages', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'First',
        toolCalls: [{ id: 'tc1', name: 'tool1', arguments: {} }],
      },
      {
        role: 'assistant',
        content: 'Second',
        toolCalls: [{ id: 'tc2', name: 'tool2', arguments: {} }],
      },
      { role: 'tool', content: 'r1', toolCallId: 'tc1', toolName: 'tool1' },
      { role: 'tool', content: 'r2', toolCallId: 'tc2', toolName: 'tool2' },
      { role: 'tool', content: 'r3', toolCallId: 'orphaned', toolName: 'tool3' },
    ]
    const result = stripOrphanedToolResults(messages)
    expect(result).toHaveLength(4)
    expect(result.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('preserves non-tool messages unchanged', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'system', content: 'instructions' },
    ]
    const result = stripOrphanedToolResults(messages)
    expect(result).toEqual(messages)
  })

  it('handles empty messages', () => {
    const result = stripOrphanedToolResults([])
    expect(result).toEqual([])
  })

  it('handles assistant message with no toolCalls', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'just text' },
      { role: 'tool', content: 'orphaned', toolCallId: 'tc1', toolName: 'tool1' },
    ]
    const result = stripOrphanedToolResults(messages)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
  })
})

describe('buildToolSet', () => {
  it('returns empty object when tools undefined', () => {
    const result = buildToolSet(undefined)
    expect(result).toEqual({})
  })

  it('returns empty object when tools empty array', () => {
    const result = buildToolSet([])
    expect(result).toEqual({})
  })

  it('builds tool set with single tool', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'shell',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
        },
      },
    ]
    const result = buildToolSet(tools)
    expect(Object.keys(result)).toEqual(['shell'])
    expect(result.shell.description).toBe('Execute shell command')
    expect(result.shell.inputSchema).toBeDefined()
  })

  it('builds tool set with multiple tools', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'shell',
        description: 'Execute shell',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'fetch',
        description: 'Fetch URL',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const result = buildToolSet(tools)
    expect(Object.keys(result)).toHaveLength(2)
    expect(result.shell).toBeDefined()
    expect(result.fetch).toBeDefined()
  })

  it('preserves tool name as key', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'my_tool',
        description: 'A tool',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const result = buildToolSet(tools)
    expect('my_tool' in result).toBe(true)
  })

  it('includes tool description', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'test_tool',
        description: 'Test description',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const result = buildToolSet(tools)
    expect(result.test_tool.description).toBe('Test description')
  })

  it('includes inputSchema from parameters', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'test',
        description: 'Test',
        parameters: {
          type: 'object',
          properties: {
            arg1: { type: 'string' },
            arg2: { type: 'number' },
          },
        },
      },
    ]
    const result = buildToolSet(tools)
    expect(result.test.inputSchema).toBeDefined()
  })
})
