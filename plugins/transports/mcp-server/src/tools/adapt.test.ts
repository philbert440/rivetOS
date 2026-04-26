/**
 * Unit tests for `adaptRivetTool` and `toolResultToString`.
 *
 * Pure-fn coverage — no server, no DB. Verifies the wire conversion shape
 * holds for both string and `ContentPart[]` results.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import type { Tool } from '@rivetos/types'

import { adaptRivetTool, toolResultToString } from './adapt.js'

describe('toolResultToString', () => {
  it('returns a plain string verbatim', () => {
    expect(toolResultToString('hello')).toBe('hello')
  })

  it('joins text content parts with newlines', () => {
    expect(
      toolResultToString([
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ]),
    ).toBe('line one\nline two')
  })

  it('marks non-text parts with a placeholder', () => {
    expect(
      toolResultToString([
        { type: 'text', text: 'before' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'after' },
      ]),
    ).toBe('before\n[non-text part: image]\nafter')
  })
})

describe('adaptRivetTool', () => {
  const fakeTool: Tool = {
    name: 'fake.tool',
    description: 'A test fixture',
    parameters: { type: 'object', properties: {} },
    async execute(args: Record<string, unknown>) {
      const value = typeof args.value === 'string' ? args.value : ''
      return `received: ${value}`
    },
  }

  const inputSchema = { value: z.string() }

  it('uses the rivet tool name and description by default', () => {
    const reg = adaptRivetTool(fakeTool, inputSchema)
    expect(reg.name).toBe('fake.tool')
    expect(reg.description).toBe('A test fixture')
    expect(reg.inputSchema).toBe(inputSchema)
  })

  it('respects name and description overrides', () => {
    const reg = adaptRivetTool(fakeTool, inputSchema, {
      name: 'rivetos.fake',
      description: 'Wired through MCP',
    })
    expect(reg.name).toBe('rivetos.fake')
    expect(reg.description).toBe('Wired through MCP')
  })

  it('coerces tool execution to a string promise', async () => {
    const reg = adaptRivetTool(fakeTool, inputSchema)
    const result = await reg.execute({ value: 'hi' })
    expect(result).toBe('received: hi')
  })

  it('flattens ContentPart[] tool results to text', async () => {
    const multimodal: Tool = {
      name: 'multi.tool',
      description: 'Returns content parts',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return [
          { type: 'text' as const, text: 'alpha' },
          { type: 'image' as const, data: 'AAAA' },
          { type: 'text' as const, text: 'omega' },
        ]
      },
    }

    const reg = adaptRivetTool(multimodal, {})
    const result = await reg.execute({})
    expect(result).toBe('alpha\n[non-text part: image]\nomega')
  })
})
