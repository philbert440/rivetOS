import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { contentTupleHash, eventIdFromContent, occurrenceIndex } from './event-id.js'

const base = {
  sessionKey: 'claude-code:sess',
  role: 'user',
  content: 'hello',
  toolName: 'Bash',
  toolArgs: { command: 'ls' },
}

it('is stable across calls and changes when any field changes', () => {
  const id = eventIdFromContent(base)
  expect(id).toMatch(/^[0-9a-f]{64}$/)
  expect(eventIdFromContent({ ...base })).toBe(id)
  expect(eventIdFromContent({ ...base, sessionKey: 'other' })).not.toBe(id)
  expect(eventIdFromContent({ ...base, role: 'assistant' })).not.toBe(id)
  expect(eventIdFromContent({ ...base, content: 'hello!' })).not.toBe(id)
  expect(eventIdFromContent({ ...base, toolName: 'Read' })).not.toBe(id)
  expect(eventIdFromContent({ ...base, toolArgs: { command: 'pwd' } })).not.toBe(id)
  expect(eventIdFromContent({ ...base, toolName: undefined })).not.toBe(id)
  expect(eventIdFromContent({ ...base, toolArgs: undefined })).not.toBe(id)
})

it('folds occurrence into the hash without changing the hash that omits it', () => {
  const id = eventIdFromContent(base)
  expect(eventIdFromContent({ ...base })).toBe(id)
  const zero = eventIdFromContent({ ...base, occurrence: 0 })
  const one = eventIdFromContent({ ...base, occurrence: 1 })
  expect(zero).not.toBe(id)
  expect(one).not.toBe(zero)
  expect(eventIdFromContent({ ...base, occurrence: 1 })).toBe(one)
})

it('hashes a tool-less row as role, content, and two empty fields', () => {
  expect(contentTupleHash({ role: 'user', content: 'ship it' })).toBe(
    createHash('sha256').update('user\0ship it\0\0', 'utf8').digest('hex'),
  )
})

it('hashes the content tuple without session or occurrence', () => {
  const hash = contentTupleHash(base)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(contentTupleHash({ ...base })).toBe(hash)
  expect(hash).not.toBe(eventIdFromContent(base))
  expect(contentTupleHash({ ...base, content: 'other' })).not.toBe(hash)
})

it('returns the index of the last matching row in the inclusive prefix', () => {
  const row = { role: 'user', content: 'continue' }
  const other = { role: 'assistant', content: 'ok' }
  expect(occurrenceIndex([], row)).toBe(0)
  expect(occurrenceIndex([row], row)).toBe(0)
  expect(occurrenceIndex([row, other, row], row)).toBe(1)
  expect(occurrenceIndex([{ role: 'user', content: 'other' }], row)).toBe(0)
  const tool = {
    role: 'tool',
    content: '[tool call] Bash',
    toolName: 'Bash',
    toolArgs: { command: 'ls' },
  }
  const otherTool = { ...tool, toolArgs: { command: 'pwd' } }
  expect(occurrenceIndex([tool, otherTool], otherTool)).toBe(0)
  expect(occurrenceIndex([tool, tool], tool)).toBe(1)
})
