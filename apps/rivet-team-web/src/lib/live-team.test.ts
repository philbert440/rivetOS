import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveCreateNote, livePersonas, liveSearchNotes } from './live-team.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('live team client', () => {
  it('maps personas from /api/team', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          personas: [
            {
              id: 'p1',
              name: 'Kitchen',
              systemPrompt: 'cook',
              threadId: 't1',
              sample: false,
            },
          ],
        }),
      })),
    )
    const personas = await livePersonas('tok')
    expect(personas).toHaveLength(1)
    expect(personas[0].name).toBe('Kitchen')
    expect(personas[0].systemPrompt).toBe('cook')
  })

  it('posts a note and searches', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (String(url).includes('/notes/search')) {
          return {
            ok: true,
            json: async () => ({ notes: [{ id: 'n1', content: 'hi', userId: 'u', personaId: 'p', role: 'user', createdAt: 1 }] }),
          }
        }
        return {
          ok: true,
          json: async () => ({
            note: { id: 'n1', content: 'hi', userId: 'u', personaId: 'p', role: 'user', createdAt: 1 },
          }),
        }
      }),
    )
    const note = await liveCreateNote('tok', { personaId: 'p', role: 'user', content: 'hi' })
    expect(note.id).toBe('n1')
    const found = await liveSearchNotes('tok', 'hi')
    expect(found).toHaveLength(1)
    expect(calls[0]).toContain('POST')
    expect(calls[1]).toContain('notes/search')
  })
})
