import { describe, expect, it } from 'vitest'
import { qwenCodeAdapter, qwenCodeTurnsFromLines } from './qwen-code.js'

describe('qwenCodeTurnsFromLines', () => {
  it('folds a real_user + thinking/text assistant line and skips system', () => {
    // Scrubbed from samples/11111111-2222-4333-8444-555555555555.jsonl
    // (`/tmp/claude-…` → `/home/example`).
    const turns = qwenCodeTurnsFromLines([
      {
        type: 'user',
        provenance: 'real_user',
        cwd: '/home/example/proj',
        message: { role: 'user', parts: [{ text: 'reply with the single word pong' }] },
      },
      {
        type: 'system',
        provenance: 'system',
        subtype: 'attribution_snapshot',
        systemPayload: { snapshot: { type: 'attribution-snapshot' } },
      },
      {
        type: 'assistant',
        provenance: 'assistant_output',
        model: 'qwen-27b',
        message: {
          role: 'model',
          parts: [
            {
              text: 'The user is asking for a response with just the single word "pong".',
              thought: true,
            },
            { text: '\n\npong' },
          ],
        },
        usageMetadata: {
          promptTokenCount: 26724,
          candidatesTokenCount: 78,
          thoughtsTokenCount: 78,
          totalTokenCount: 26802,
          cachedContentTokenCount: 0,
        },
      },
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({ role: 'user', text: 'reply with the single word pong' })
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      text: 'pong',
      thinking: 'The user is asking for a response with just the single word "pong".',
      model: 'qwen-27b',
      usage: { promptTokens: 26724, completionTokens: 78, cachedTokens: 0 },
    })
  })

  it('does not invent a turn for a non-real_user user line', () => {
    const turns = qwenCodeTurnsFromLines([
      {
        type: 'user',
        provenance: 'tool_result',
        message: { role: 'user', parts: [{ text: 'should not appear' }] },
      },
    ])
    expect(turns).toEqual([])
  })

  it('completes functionCall tools from a later tool_result and reads args', () => {
    // Scrubbed from samples/22222222-2222-4222-8222-222222222222.jsonl
    const turns = qwenCodeTurnsFromLines([
      {
        type: 'user',
        provenance: 'real_user',
        message: {
          role: 'user',
          parts: [{ text: 'Use the run_shell_command tool to run: echo tool-sample-ok.' }],
        },
      },
      {
        type: 'assistant',
        model: 'qwen-27b',
        message: {
          role: 'model',
          parts: [
            { text: 'Looking up the deferred tool.', thought: true },
            {
              functionCall: {
                id: 'call_bda5b2b65280477f9794028f',
                name: 'tool_search',
                args: { query: 'select:run_shell_command' },
              },
            },
          ],
        },
        usageMetadata: {
          promptTokenCount: 24330,
          candidatesTokenCount: 237,
          thoughtsTokenCount: 220,
          cachedContentTokenCount: 0,
        },
      },
      {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_bda5b2b65280477f9794028f',
                name: 'tool_search',
                response: { output: 'Loaded 1 tool(s)' },
              },
            },
          ],
        },
      },
      {
        type: 'assistant',
        model: 'qwen-27b',
        message: {
          role: 'model',
          parts: [
            { text: 'Running the command.', thought: true },
            {
              functionCall: {
                id: 'call_6ef8c237955540faabb31812',
                name: 'run_shell_command',
                args: { command: 'echo tool-sample-ok', description: 'Print a sample marker' },
              },
            },
          ],
        },
        usageMetadata: {
          promptTokenCount: 26222,
          candidatesTokenCount: 101,
          thoughtsTokenCount: 61,
          cachedContentTokenCount: 0,
        },
      },
      {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_6ef8c237955540faabb31812',
                name: 'run_shell_command',
                response: { output: 'Output: tool-sample-ok\nExit Code: 0' },
              },
            },
          ],
        },
      },
      {
        type: 'assistant',
        model: 'qwen-27b',
        message: {
          role: 'model',
          parts: [
            { text: 'The output is tool-sample-ok.', thought: true },
            { text: '\n\ntool-sample-ok' },
          ],
        },
        usageMetadata: {
          promptTokenCount: 26388,
          candidatesTokenCount: 22,
          thoughtsTokenCount: 17,
          cachedContentTokenCount: 0,
        },
      },
    ])
    expect(turns).toHaveLength(4)
    expect(turns[0]).toMatchObject({
      role: 'user',
      text: 'Use the run_shell_command tool to run: echo tool-sample-ok.',
    })
    expect(turns[1].tools).toEqual([
      {
        name: 'tool_search',
        status: 'done',
        id: 'call_bda5b2b65280477f9794028f',
        args: { query: 'select:run_shell_command' },
      },
    ])
    expect(turns[2].tools).toEqual([
      {
        name: 'run_shell_command',
        status: 'done',
        id: 'call_6ef8c237955540faabb31812',
        args: { command: 'echo tool-sample-ok', description: 'Print a sample marker' },
      },
    ])
    expect(turns[3]).toMatchObject({
      role: 'assistant',
      text: 'tool-sample-ok',
      model: 'qwen-27b',
      usage: { promptTokens: 26388, completionTokens: 22, cachedTokens: 0 },
    })
  })

  it('does not invent a turn for the tool_result line itself', () => {
    const turns = qwenCodeTurnsFromLines([
      {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'x',
                name: 'run_shell_command',
                response: { output: 'nope' },
              },
            },
          ],
        },
      },
    ])
    expect(turns).toEqual([])
  })

  it('maps cachedContentTokenCount onto cachedTokens without double-counting prompt', () => {
    const turns = qwenCodeTurnsFromLines([
      {
        type: 'assistant',
        model: 'qwen-27b',
        message: { role: 'model', parts: [{ text: 'ok' }] },
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 4,
          cachedContentTokenCount: 20,
          thoughtsTokenCount: 3,
        },
      },
    ])
    expect(turns[0]?.usage).toEqual({ promptTokens: 100, completionTokens: 4, cachedTokens: 20 })
  })
})

describe('qwenCodeAdapter', () => {
  it('advertises liveTurn without prompts or approvals', () => {
    expect(qwenCodeAdapter.id).toBe('qwen-code')
    expect(qwenCodeAdapter.promptToolNames).toEqual([])
    expect(qwenCodeAdapter.capabilities()).toEqual({
      liveTurn: true,
      prompts: false,
      approvals: false,
    })
  })

  it('parseLines and parseObjects agree on a user turn', () => {
    const obj = {
      type: 'user',
      provenance: 'real_user',
      message: { role: 'user', parts: [{ text: 'hi' }] },
    }
    expect(qwenCodeAdapter.store.parseObjects?.([obj])).toEqual([{ role: 'user', text: 'hi' }])
    expect(qwenCodeAdapter.store.parseLines?.([JSON.stringify(obj)])).toEqual([
      { role: 'user', text: 'hi' },
    ])
  })
})
