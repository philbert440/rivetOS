import { describe, expect, it } from 'vitest'
import { codexTurnsFromLines } from './codex.js'

const item = (payload: Record<string, unknown>): Record<string, unknown> => ({
  type: 'response_item',
  payload,
})

const user = (text: string): Record<string, unknown> =>
  item({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  })

const assistant = (text: string): Record<string, unknown> =>
  item({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  })

describe('codexTurnsFromLines', () => {
  it('folds user → reasoning + tool + assistant into one complete turn and drops injections', () => {
    const turns = codexTurnsFromLines([
      { type: 'session_meta', payload: { id: '89965427-b96f-4d5e-8ad5-c3dd138e33dc' } },
      item({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp</environment_context>' }],
      }),
      user('<skills_instructions>never show this</skills_instructions>'),
      user('<multi_agent_foo>also skip</multi_agent_foo>'),
      user('list the files'),
      { type: 'event_msg', payload: { type: 'task_started' } },
      item({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'I should list' }],
      }),
      item({
        type: 'custom_tool_call',
        id: 'ctc_1',
        name: 'shell',
        input: JSON.stringify({ command: 'ls', extra: { nested: true } }),
      }),
      item({
        type: 'custom_tool_call_output',
        id: 'ctco_1',
        call_id: 'ctc_1',
        output: 'a.txt',
      }),
      assistant('here they are'),
      {
        type: 'token_usage_record',
        payload: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'turn_context', payload: {} },
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({ role: 'user', text: 'list the files' })
    expect(turns[1].role).toBe('assistant')
    expect(turns[1].text).toBe('here they are')
    expect(turns[1].thinking).toBe('I should list')
    expect(turns[1].tools).toEqual([
      { name: 'shell', status: 'done', id: 'ctc_1', args: { command: 'ls' } },
    ])
    expect(turns[1].usage).toEqual({
      promptTokens: 100,
      completionTokens: 35,
      cachedTokens: 20,
    })
    expect(turns[1].complete).toBe(true)
    expect(turns[1].stopReason).toBe('end_turn')
    expect(turns[1].lastBlock).toBe('text')
  })

  it('a running tool is not complete; an error field marks the tool error', () => {
    const mid = codexTurnsFromLines([
      user('run it'),
      item({ type: 'custom_tool_call', id: 'ctc_err', name: 'shell', input: { command: 'false' } }),
    ])
    expect(mid).toHaveLength(2)
    expect(mid[1].complete).toBeUndefined()
    expect(mid[1].stopReason).toBe('tool_use')
    expect(mid[1].tools?.[0]).toMatchObject({ id: 'ctc_err', status: 'running' })

    const failed = codexTurnsFromLines([
      user('run it'),
      item({ type: 'custom_tool_call', id: 'ctc_err', name: 'shell', input: { command: 'false' } }),
      item({
        type: 'custom_tool_call_output',
        id: 'ctco_err',
        call_id: 'ctc_err',
        output: 'exit 1',
        error: 'command failed',
      }),
      assistant('it failed'),
    ])
    expect(failed[1].tools?.[0].status).toBe('error')
    expect(failed[1].complete).toBe(true)
  })

  it('does not treat a developer-only rollout as a human turn', () => {
    expect(
      codexTurnsFromLines([
        item({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'system' }],
        }),
        { type: 'event_msg', payload: { type: 'token_count' } },
      ]),
    ).toEqual([])
  })
})
