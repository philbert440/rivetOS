import { expect, it } from 'vitest'
import { eventIdFromContent } from './event-id.js'

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
