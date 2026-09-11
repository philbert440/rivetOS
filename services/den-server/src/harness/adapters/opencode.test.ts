import { describe, expect, it } from 'vitest'
import type { HarnessTranscriptTurn } from '@rivetos/types'
import { opencodeAdapter, opencodeTurnsFromMessages } from './opencode.js'
import { createTurnTracker } from '../turn-tracker.js'

describe('opencodeTurnsFromMessages', () => {
  it('marks a finished assistant message complete and copies tokens', () => {
    const turns = opencodeTurnsFromMessages(
      [
        { id: 'u', role: 'user', content: 'hi' },
        {
          id: 'a',
          role: 'assistant',
          modelID: 'glm-5.3-flash',
          providerID: 'zai',
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
          time: { created: 1, completed: 2 },
        },
      ],
      new Map([
        [
          'a',
          [
            { type: 'tool', tool: 'Bash', id: 't1', state: { status: 'completed', input: { command: 'ls' } } },
            { type: 'text', text: 'done' },
            { type: 'step_finish' },
          ],
        ],
      ]),
    )
    expect(turns[0]).toEqual({ role: 'user', text: 'hi' })
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      text: 'done',
      model: 'zai/glm-5.3-flash',
      complete: true,
      stopReason: 'end_turn',
      lastBlock: 'text',
      usage: { promptTokens: 110, completionTokens: 25, cachedTokens: 10 },
      tools: [{ name: 'Bash', status: 'done', id: 't1', args: { command: 'ls' } }],
    })
  })

  it('keeps a running tool turn in flight', () => {
    const turns = opencodeTurnsFromMessages([
      { id: 'u', role: 'user', content: 'hi' },
      { id: 'a', role: 'assistant' },
    ], new Map([
      [
        'a',
        [{ type: 'tool', tool: 'Bash', id: 't1', state: { status: 'running', input: { command: 'ls' } } }],
      ],
    ]))
    expect(turns[1].complete).toBeUndefined()
    expect(turns[1].stopReason).toBe('tool_use')
    expect(turns[1].lastBlock).toBe('tool_use')
  })
})

describe('opencode adapter → turn tracker', () => {
  it('emits turn-complete only after the final answer', () => {
    const tracker = createTurnTracker(opencodeAdapter)
    const user: HarnessTranscriptTurn[] = [{ role: 'user', text: 'hi' }]
    expect(tracker.apply(user, 'opencode').status?.status).toBe('working')

    const tool: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'hi' },
      {
        role: 'assistant',
        text: '',
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
        tools: [{ name: 'Bash', status: 'running', id: 't1' }],
      },
    ]
    expect(tracker.apply(tool, 'opencode').turnCompleted).toBeUndefined()
    expect(tracker.inFlight()).toBe(true)

    const done = opencodeTurnsFromMessages(
      [
        { id: 'u', role: 'user', content: 'hi' },
        {
          id: 'a',
          role: 'assistant',
          tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
          time: { completed: 2 },
        },
      ],
      new Map([
        [
          'a',
          [
            { type: 'tool', tool: 'Bash', id: 't1', state: { status: 'completed', input: { command: 'ls' } } },
            { type: 'text', text: 'ok' },
            { type: 'step-finish' },
          ],
        ],
      ]),
    )
    const edge = tracker.apply(done, 'opencode')
    expect(edge.turnCompleted).toBe(true)
    expect(edge.status?.status).toBe('idle')
    expect(tracker.inFlight()).toBe(false)
  })
})
