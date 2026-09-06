import { describe, expect, it } from 'vitest'
import type { HarnessTranscriptTurn } from '@rivetos/types'
import { claudeAdapter } from './adapters/claude.js'
import { deepseekAdapter } from './adapters/deepseek.js'
import { grokAdapter } from './adapters/grok.js'
import { createTurnTracker } from './turn-tracker.js'

const ASK_INPUT = {
  questions: [
    {
      question: 'Which auth?',
      header: 'Auth',
      multiSelect: false,
      options: [
        { label: 'OAuth', description: 'browser' },
        { label: 'API key', description: 'token' },
      ],
    },
  ],
}

function asst(
  partial: Partial<HarnessTranscriptTurn> & Pick<HarnessTranscriptTurn, 'text'>,
): HarnessTranscriptTurn {
  return { role: 'assistant', ...partial }
}

describe('createTurnTracker', () => {
  it('emits a status edge once per change; same turns twice → no status', () => {
    const t = createTurnTracker(claudeAdapter)
    const thinking: HarnessTranscriptTurn[] = [{ role: 'user', text: 'hi' }]
    const first = t.apply(thinking, 'claude')
    expect(first.status).toEqual({ status: 'working', phase: 'thinking' })
    const again = t.apply(thinking, 'claude')
    expect(again.status).toBeUndefined()
    expect(again.turnCompleted).toBeUndefined()
    expect(t.inFlight()).toBe(true)

    const idle: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'hi' },
      asst({ text: 'done', lastBlock: 'text', stopReason: 'end_turn', complete: true }),
    ]
    const second = t.apply(idle, 'claude')
    expect(second.status).toEqual({ status: 'idle' })
    const third = t.apply(idle, 'claude')
    expect(third.status).toBeUndefined()
  })

  it('emits turnCompleted exactly once when the trailing assistant becomes complete', () => {
    const t = createTurnTracker(claudeAdapter)
    const running: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'hi' },
      asst({
        text: '',
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
        tools: [{ name: 'Bash', status: 'running', id: 't1' }],
      }),
    ]
    expect(t.apply(running, 'claude').turnCompleted).toBeUndefined()
    const done: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'hi' },
      asst({ text: 'ok', lastBlock: 'text', stopReason: 'end_turn', complete: true }),
    ]
    expect(t.apply(done, 'claude').turnCompleted).toBe(true)
    expect(t.apply(done, 'claude').turnCompleted).toBeUndefined()
    expect(t.inFlight()).toBe(false)
  })

  it('opens then resolves a prompt; malformed AskUserQuestion input → no prompt', () => {
    const t = createTurnTracker(claudeAdapter)
    const open: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'ask' },
      asst({
        text: '',
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
        tools: [
          {
            name: 'AskUserQuestion',
            status: 'running',
            id: 'ask_1',
            input: ASK_INPUT,
          },
        ],
      }),
    ]
    const opened = t.apply(open, 'claude')
    expect(opened.promptsOpened).toEqual([
      {
        promptId: 'ask_1',
        toolName: 'AskUserQuestion',
        questions: [
          {
            question: 'Which auth?',
            header: 'Auth',
            multiSelect: false,
            options: [
              { label: 'OAuth', description: 'browser' },
              { label: 'API key', description: 'token' },
            ],
          },
        ],
      },
    ])
    expect(opened.status?.phase).toBe('prompt')
    expect(t.pendingPromptIds()).toEqual(['ask_1'])

    const resolved: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'ask' },
      asst({
        text: '',
        lastBlock: 'tool_result',
        stopReason: 'tool_use',
        tools: [
          {
            name: 'AskUserQuestion',
            status: 'done',
            id: 'ask_1',
            input: ASK_INPUT,
            resultText: 'Auth: API key',
          },
        ],
      }),
    ]
    const after = t.apply(resolved, 'claude')
    expect(after.promptsOpened).toEqual([])
    expect(after.promptsResolved).toEqual([{ promptId: 'ask_1', answerText: 'Auth: API key' }])
    expect(t.pendingPromptIds()).toEqual([])

    const malformed = createTurnTracker(claudeAdapter)
    const bad: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'ask' },
      asst({
        text: '',
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
        tools: [
          {
            name: 'AskUserQuestion',
            status: 'running',
            id: 'ask_bad',
            input: { questions: [{ question: 'no options' }] },
          },
        ],
      }),
    ]
    const skipped = malformed.apply(bad, 'claude')
    expect(skipped.promptsOpened).toEqual([])
    expect(malformed.pendingPromptIds()).toEqual([])
  })

  it('text-only store → inFlight() === undefined and no edges', () => {
    const t = createTurnTracker(deepseekAdapter)
    const turns: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'hi' },
      asst({
        text: '',
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
        tools: [{ name: 'AskUserQuestion', status: 'running', id: 'x', input: ASK_INPUT }],
      }),
    ]
    expect(t.apply(turns, 'dsh')).toEqual({ promptsOpened: [], promptsResolved: [] })
    expect(t.inFlight()).toBeUndefined()
    expect(t.pendingPromptIds()).toEqual([])
  })

  it('grok liveTurn tracker reports inFlight from complete', () => {
    const t = createTurnTracker(grokAdapter)
    expect(t.inFlight()).toBeUndefined() // unknown until the first frame — the driver's claim decides
    t.apply(
      [
        { role: 'user', text: 'hi' },
        asst({
          text: '',
          lastBlock: 'tool_use',
          stopReason: 'tool_use',
          tools: [{ name: 'read_file', status: 'running', id: 'c1' }],
        }),
      ],
      'grok',
    )
    expect(t.inFlight()).toBe(true)
    const done = t.apply(
      [
        { role: 'user', text: 'hi' },
        asst({ text: 'ok', lastBlock: 'text', stopReason: 'end_turn', complete: true }),
      ],
      'grok',
    )
    expect(done.turnCompleted).toBe(true)
    expect(t.inFlight()).toBe(false)
  })
})
