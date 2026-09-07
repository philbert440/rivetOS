import { describe, expect, it } from 'vitest'
import { deriveTurnStatus, isPromptToolName } from './harness-turn-status.js'
import type { HarnessTranscriptTurn } from './gateway-api.js'

describe('isPromptToolName', () => {
  it('matches AskUserQuestion, ask_user_question, ask_user case-insensitively', () => {
    expect(isPromptToolName('AskUserQuestion')).toBe(true)
    expect(isPromptToolName('askuserquestion')).toBe(true)
    expect(isPromptToolName('ask_user_question')).toBe(true)
    expect(isPromptToolName('ASK_USER_QUESTION')).toBe(true)
    expect(isPromptToolName('ask_user')).toBe(true)
    expect(isPromptToolName('Ask_User')).toBe(true)
    expect(isPromptToolName('Bash')).toBe(false)
    expect(isPromptToolName('Read')).toBe(false)
  })
})

describe('deriveTurnStatus', () => {
  it('no turns → empty', () => {
    expect(deriveTurnStatus([], 'claude')).toEqual({})
  })

  it('trailing user turn → in-flight thinking', () => {
    expect(deriveTurnStatus([{ role: 'user', text: 'hi' }], 'claude')).toEqual({
      inFlight: true,
      phase: 'thinking',
    })
  })

  it('trailing compaction marker (complete) → idle, even right after a user turn', () => {
    const turns: HarnessTranscriptTurn[] = [
      { role: 'user', text: 'big question' },
      {
        role: 'assistant',
        text: 'Conversation compacted (950k tokens → 20k tokens)',
        stopReason: 'end_turn',
        lastBlock: 'text',
        complete: true,
        compact: true,
        usage: { promptTokens: 19_624, completionTokens: 0, cachedTokens: 0 },
      },
    ]
    expect(deriveTurnStatus(turns, 'claude')).toEqual({ inFlight: false })
  })

  it('trailing assistant with a running tool → in-flight tool', () => {
    const turns: HarnessTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        tools: [{ name: 'Bash', status: 'running', id: 't1' }],
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
      },
    ]
    expect(deriveTurnStatus(turns, 'claude')).toEqual({
      inFlight: true,
      phase: 'tool',
      tool: { name: 'Bash', toolCallId: 't1' },
    })
  })

  it('running prompt-class tool → phase prompt + promptToolId', () => {
    const turns: HarnessTranscriptTurn[] = [
      {
        role: 'assistant',
        text: '',
        tools: [{ name: 'AskUserQuestion', status: 'running', id: 'q1' }],
        lastBlock: 'tool_use',
        stopReason: 'tool_use',
      },
    ]
    expect(deriveTurnStatus(turns, 'claude')).toEqual({
      inFlight: true,
      phase: 'prompt',
      tool: { name: 'AskUserQuestion', toolCallId: 'q1' },
      promptToolId: 'q1',
    })
  })

  it('lastBlock thinking → in-flight thinking', () => {
    expect(
      deriveTurnStatus(
        [{ role: 'assistant', text: '', lastBlock: 'thinking', stopReason: 'tool_use' }],
        'claude',
      ),
    ).toEqual({ inFlight: true, phase: 'thinking' })
  })

  it('lastBlock text and not complete → writing', () => {
    expect(
      deriveTurnStatus(
        [{ role: 'assistant', text: 'hello', lastBlock: 'text', stopReason: 'end_turn' }],
        'claude',
      ),
    ).toEqual({ inFlight: true, phase: 'writing' })
  })

  it('complete → inFlight false', () => {
    expect(
      deriveTurnStatus(
        [
          {
            role: 'assistant',
            text: 'done',
            lastBlock: 'text',
            stopReason: 'end_turn',
            complete: true,
          },
        ],
        'claude',
      ),
    ).toEqual({ inFlight: false })
  })

  it('trailing assistant with neither stopReason nor lastBlock → empty', () => {
    expect(deriveTurnStatus([{ role: 'assistant', text: 'ok' }], 'grok')).toEqual({})
  })
})
