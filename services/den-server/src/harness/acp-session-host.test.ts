// AcpSessionHost over an in-memory AcpRpc. Frame shapes are the ones
// `opencode acp` 1.18.35 and `grok agent stdio` 1.0.44 sent on live turns.

import { describe, expect, it, vi } from 'vitest'
import { HarnessError, type HarnessEvent, type SessionId } from '@rivetos/types'
import type { AcpFrame, AcpRpc } from './acp-rpc.js'
import { AcpSessionHost } from './acp-session-host.js'

const MODEL_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: 'opencode/big-pickle',
    options: [{ value: 'opencode/big-pickle' }, { value: 'openrouter/z-ai/glm-5.3' }],
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [{ value: 'high' }, { value: 'low' }],
  },
]

interface Pending {
  method: string
  params: Record<string, unknown>
  resolve: (r: Record<string, unknown>) => void
  reject: (e: Error) => void
}

function setup(
  caps: Record<string, unknown> = {
    loadSession: true,
    sessionCapabilities: { resume: {}, close: {} },
  },
) {
  const sinks = new Set<(f: AcpFrame) => void>()
  const requests: Pending[] = []
  const notes: { method: string; params: Record<string, unknown> }[] = []
  const responses: { id: number | string; result: unknown }[] = []
  const rejects: (number | string)[] = []
  /** Methods answered immediately; anything else waits for the test. */
  const auto: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {
    'session/new': () => ({ sessionId: 'ses_new', configOptions: MODEL_OPTIONS }),
    'session/resume': () => ({ configOptions: MODEL_OPTIONS }),
    'session/close': () => ({}),
    'session/set_config_option': (p) => ({
      configOptions: MODEL_OPTIONS.map((o) =>
        o.id === p.configId ? { ...o, currentValue: p.value } : o,
      ),
    }),
  }
  const rpc: AcpRpc & { generation: number } = {
    generation: 1,
    agent: { protocolVersion: 1, agentCapabilities: caps },
    connect: () => Promise.resolve(),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        requests.push({ method, params, resolve, reject })
        const answer = auto[method]
        if (answer) resolve(answer(params))
      }),
    notify: (method, params) => notes.push({ method, params }),
    respond: (id, result) => responses.push({ id, result }),
    reject: (id) => rejects.push(id),
    subscribe: (sink) => {
      sinks.add(sink)
      return () => sinks.delete(sink)
    },
    close: vi.fn(),
  }
  const events: HarnessEvent[] = []
  const turns: string[] = []
  const host = new AcpSessionHost({
    rpc,
    harnessId: 'opencode',
    productName: 'OpenCode',
    sid: (n) => `opencode:${n}` as SessionId,
    emit: (_n, e) => events.push(e),
    turnStarted: (n) => turns.push(`start:${n}`),
    turnEnded: (n, r) => turns.push(`end:${n}:${r}`),
    activity: () => undefined,
    log: () => undefined,
  })
  const frame = (f: AcpFrame): void => {
    for (const s of sinks) s(f)
  }
  const update = (sessionId: string, u: Record<string, unknown>): void =>
    frame({ method: 'session/update', params: { sessionId, update: u } })
  const promptRequest = (): Pending => {
    const p = requests.filter((r) => r.method === 'session/prompt').at(-1)
    if (!p) throw new Error('no prompt sent')
    return p
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  return {
    host,
    rpc,
    requests,
    notes,
    responses,
    rejects,
    events,
    turns,
    frame,
    update,
    promptRequest,
    tick,
  }
}

describe('AcpSessionHost', () => {
  it('runs a turn on a new session and maps its updates', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    expect(native).toBe('ses_new')
    await t.host.prompt(native, '/work', 'hello')
    expect(t.requests.map((r) => r.method)).toEqual(['session/new', 'session/prompt'])
    expect(t.promptRequest().params).toEqual({
      sessionId: 'ses_new',
      prompt: [{ type: 'text', text: 'hello' }],
    })
    expect(t.host.prompting(native)).toBe(true)

    t.update(native, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    })
    t.update(native, {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'bash',
      kind: 'execute',
      status: 'pending',
      rawInput: {},
    })
    t.update(native, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })
    t.update(native, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { output: 'ok\n' },
    })
    t.update(native, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    t.update(native, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done' },
    })
    t.update(native, { sessionUpdate: 'usage_update', used: 1 })
    t.promptRequest().resolve({ stopReason: 'end_turn' })
    await t.tick()

    expect(t.events.map((e) => e.type)).toEqual([
      'reasoning-delta',
      'tool-use',
      'tool-result',
      'assistant-delta',
    ])
    expect(t.events[2]).toMatchObject({
      toolCallId: 'c1',
      name: 'bash',
      output: { output: 'ok\n' },
    })
    expect(t.turns).toEqual(['start:ses_new', 'end:ses_new:end-turn'])
    expect(t.host.prompting(native)).toBe(false)
  })

  it('refuses a second send while a turn runs', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'one')
    await expect(t.host.prompt(native, '/work', 'two')).rejects.toMatchObject({
      code: 'turn_in_flight',
    })
  })

  it('resumes a session it has not loaded, without replay', async () => {
    const t = setup()
    await t.host.prompt('ses_old', '/work', 'hi')
    expect(t.requests.map((r) => r.method)).toEqual(['session/resume', 'session/prompt'])
    expect(t.requests[0].params).toEqual({ sessionId: 'ses_old', cwd: '/work', mcpServers: [] })
  })

  it('falls back to session/load and swallows its replayed history', async () => {
    const t = setup({ loadSession: true })
    const sent = t.host.prompt('ses_old', '/work', 'hi')
    await t.tick()
    const load = t.requests.find((r) => r.method === 'session/load')!
    t.update('ses_old', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'old' },
    })
    load.resolve({})
    await sent
    expect(t.events).toEqual([])
    expect(t.promptRequest().params.sessionId).toBe('ses_old')
  })

  it('closes and reopens a session the TUI wrote to', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    t.host.markStale(native)
    await t.host.prompt(native, '/work', 'after terminal')
    expect(t.requests.map((r) => r.method)).toEqual([
      'session/new',
      'session/close',
      'session/resume',
      'session/prompt',
    ])
  })

  it('reloads after the agent restarts', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    t.rpc.generation = 2
    await t.host.prompt(native, '/work', 'hi')
    expect(t.requests.map((r) => r.method)).toContain('session/resume')
    expect(t.requests.map((r) => r.method)).not.toContain('session/close')
  })

  it('surfaces a permission request and answers with the chosen option', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'run it')
    t.frame({
      method: 'session/request_permission',
      id: 0,
      params: {
        sessionId: native,
        toolCall: {
          toolCallId: 'c1',
          title: 'echo hi',
          kind: 'execute',
          rawInput: { command: 'echo hi' },
        },
        options: [
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
        ],
      },
    })
    const request = t.events.find((e) => e.type === 'approval-request')
    expect(request).toMatchObject({
      requestId: 'acp:number:0',
      toolCallId: 'c1',
      input: { command: 'echo hi' },
      options: [
        { key: 'allow', label: 'Allow once' },
        { key: 'allow-session', label: 'Always allow' },
        { key: 'deny', label: 'Reject' },
      ],
    })
    expect(t.events.at(-1)).toMatchObject({ type: 'status', status: 'blocked' })
    expect(t.host.hasPermission('acp:number:0')).toBe(true)

    t.host.resolvePermission('acp:number:0', 'allow-session')
    expect(t.responses).toEqual([
      { id: 0, result: { outcome: { outcome: 'selected', optionId: 'always' } } },
    ])
    expect(t.events.at(-2)).toMatchObject({ type: 'approval-resolved', decision: 'allow-session' })
    expect(t.events.at(-1)).toMatchObject({ type: 'status', status: 'working' })
    expect(() => t.host.resolvePermission('acp:number:0', 'allow')).toThrow(HarnessError)
  })

  it('rejects a permission request for a session with no running turn', async () => {
    const t = setup()
    await t.host.newSession('/work')
    t.frame({ method: 'session/request_permission', id: 7, params: { sessionId: 'ses_new' } })
    expect(t.rejects).toEqual([7])
    expect(t.events).toEqual([])
  })

  it('cancels: answers open permissions as cancelled and ends the turn interrupted', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'run it')
    t.frame({
      method: 'session/request_permission',
      id: 1,
      params: { sessionId: native, toolCall: { toolCallId: 'c1' }, options: [] },
    })
    t.host.cancel(native)
    expect(t.responses).toEqual([{ id: 1, result: { outcome: { outcome: 'cancelled' } } }])
    expect(t.notes).toEqual([{ method: 'session/cancel', params: { sessionId: native } }])
    t.promptRequest().resolve({ stopReason: 'cancelled' })
    await t.tick()
    expect(t.turns.at(-1)).toBe(`end:${native}:interrupted`)
  })

  it('ends a running turn with an error when the agent exits', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'hi')
    t.frame({ method: '$disconnected', params: {} })
    expect(t.events.at(-1)).toMatchObject({ type: 'error', code: 'harness_unavailable' })
    expect(t.turns.at(-1)).toBe(`end:${native}:error`)
    // The late rejection of the prompt request must not end it twice.
    t.promptRequest().reject(new Error('gone'))
    await t.tick()
    expect(t.turns.filter((x) => x.startsWith('end')).length).toBe(1)
  })

  it('reports a failed prompt as an error turn', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'hi')
    t.promptRequest().reject(new Error('Internal error: No LLM provider configured'))
    await t.tick()
    expect(t.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('provider'),
    })
    expect(t.turns.at(-1)).toBe(`end:${native}:error`)
  })

  it('switches model and effort through config options, validating the value', async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'hi', { model: 'openrouter/z-ai/glm-5.3', effort: 'low' })
    const sets = t.requests
      .filter((r) => r.method === 'session/set_config_option')
      .map((r) => r.params)
    expect(sets).toEqual([
      { sessionId: native, configId: 'model', value: 'openrouter/z-ai/glm-5.3' },
      { sessionId: native, configId: 'reasoning_effort', value: 'low' },
    ])
    t.promptRequest().resolve({ stopReason: 'end_turn' })
    await t.tick()
    await expect(t.host.prompt(native, '/work', 'hi', { model: 'gpt-x' })).rejects.toMatchObject({
      code: 'bad_request',
    })
    expect(t.host.prompting(native)).toBe(false)
  })

  it("names Grok's tools from _meta rather than the command title", async () => {
    const t = setup()
    const native = await t.host.newSession('/work')
    await t.host.prompt(native, '/work', 'hi')
    t.update(native, {
      sessionUpdate: 'tool_call',
      toolCallId: 'g1',
      title: 'Execute `echo hi`',
      rawInput: { command: 'echo hi' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command' } },
    })
    expect(t.events.at(-1)).toMatchObject({ type: 'tool-use', name: 'run_terminal_command' })
  })
})
