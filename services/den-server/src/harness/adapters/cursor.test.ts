import { describe, expect, it } from 'vitest'
import { cursorTurnsFromObjects } from './cursor.js'

describe('cursorTurnsFromObjects', () => {
  it('keeps user text, assistant narration, and SendMessage body', () => {
    const turns = cursorTurnsFromObjects([
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'add cursor to the hub' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will add it.' },
            {
              type: 'tool_use',
              name: 'SendMessage',
              input: { content: 'Cursor is in the harness list.' },
            },
          ],
        },
      },
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'add cursor to the hub', lastBlock: 'text' },
      {
        role: 'assistant',
        text: 'I will add it.\nCursor is in the harness list.',
        lastBlock: 'tool_use',
        complete: true,
        tools: [
          {
            name: 'SendMessage',
            status: 'done',
            args: { content: 'Cursor is in the harness list.' },
          },
        ],
      },
    ])
  })

  it('marks tool calls done because the transcript has no results', () => {
    const turns = cursorTurnsFromObjects([
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Shell',
              input: { command: 'git status', description: 'status' },
            },
          ],
        },
      },
    ])
    expect(turns[0]?.tools?.[0]).toMatchObject({ name: 'Shell', status: 'done' })
    expect(turns[0]?.text).toBe('')
  })
})
