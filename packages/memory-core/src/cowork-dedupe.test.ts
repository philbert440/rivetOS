import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { coworkContentHash, pickCoworkHookRewrite, type CoworkHookRow } from './cowork-dedupe.js'

const hook = (id: string, content: string, role = 'user'): CoworkHookRow => ({
  id,
  role,
  content,
  eventId: `cowork:s:hook:${coworkContentHash(role, content)}`,
})

describe('coworkContentHash', () => {
  it('matches contentTupleHash for a user or assistant row with no tool fields', () => {
    const hash = coworkContentHash('user', 'ship it')
    expect(hash).toBe(createHash('sha256').update('user\0ship it\0\0', 'utf8').digest('hex'))
  })
})

describe('pickCoworkHookRewrite', () => {
  it('claims one hook row of the same role and content, then leaves a repeat', () => {
    const rows = [hook('a', 'ship it'), hook('b', 'ship it')]
    const consumed = new Set<string>()
    const first = pickCoworkHookRewrite(
      { role: 'user', content: 'ship it', source: 'cowork-transcript' },
      rows,
      consumed,
    )
    expect(first?.id).toBe('a')
    consumed.add(first!.id)
    const second = pickCoworkHookRewrite(
      { role: 'user', content: 'ship it', source: 'cowork-transcript' },
      rows,
      consumed,
    )
    expect(second?.id).toBe('b')
    consumed.add(second!.id)
    expect(
      pickCoworkHookRewrite(
        { role: 'user', content: 'ship it', source: 'cowork-transcript' },
        rows,
        consumed,
      ),
    ).toBeUndefined()
  })

  it('ignores hook rows and a different role, and honors replaces_event_id', () => {
    const rows = [hook('a', 'ship it'), hook('c', 'done', 'assistant')]
    expect(
      pickCoworkHookRewrite({ role: 'user', content: 'ship it', source: 'cowork-hook' }, rows, new Set()),
    ).toBeUndefined()
    expect(
      pickCoworkHookRewrite(
        { role: 'assistant', content: 'ship it', source: 'cowork-transcript' },
        rows,
        new Set(),
      ),
    ).toBeUndefined()
    expect(
      pickCoworkHookRewrite(
        {
          role: 'user',
          content: 'other',
          source: 'cowork-transcript',
          replacesEventId: rows[0]?.eventId,
        },
        rows,
        new Set(),
      )?.id,
    ).toBe('a')
  })
})
