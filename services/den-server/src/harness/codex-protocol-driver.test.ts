import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessEvent } from '@rivetos/types'
import { CodexDriver } from './codex-driver.js'
import { CodexProtocolDriver, codexThreadDefaults } from './codex-protocol-driver.js'
import type { CodexFrame, CodexRpc } from './codex-rpc.js'
const id = '89965427-b96f-4d5e-8ad5-c3dd138e33dc'
const native = '42accb06-524a-47a6-b4b3-0991552914d7'
const sid = CodexDriver.sessionId(id)
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function setup(defaults: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-driver-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const sinks = new Set<(f: CodexFrame) => void>()
  const thread = { id: native, cwd: '/work', turns: [] as unknown[] }
  const rpc: CodexRpc = {
    generation: 1,
    request: vi.fn(async (method) =>
      method === 'turn/start'
        ? { turn: { id: 'turn1', status: 'inProgress' } }
        : { thread, model: 'test' },
    ),
    respond: vi.fn(),
    reject: vi.fn(),
    close: vi.fn(),
    subscribe: (sink) => {
      sinks.add(sink)
      return () => {
        sinks.delete(sink)
      }
    },
  }
  const make = () => {
    const driver = new CodexProtocolDriver({
      rpc,
      endpoint: 'ws://127.0.0.1:5175',
      bindingsFile: join(dir, 'bindings.json'),
      cwd: () => '/work',
      threadDefaults: () => defaults,
      store: {
        list: async () => [],
        describe: async () => undefined,
        exists: () => false,
        transcript: async () => ({ turns: [] }),
      },
    })
    cleanup.push(() => driver.close())
    return driver
  }
  return {
    driver: make(),
    make,
    rpc,
    thread,
    emit: (f: CodexFrame) => {
      for (const sink of sinks) sink(f)
    },
  }
}
it('persists client identity and resumes the native thread after restart', async () => {
  const { driver, make, rpc } = setup()
  expect((await driver.startSession({ nativeSessionId: id })).sessionId).toBe(sid)
  expect(driver.terminalArgv(id, 'codex')).toEqual([
    'codex',
    '--remote',
    'ws://127.0.0.1:5175',
    'resume',
    native,
  ])
  driver.close()
  expect((await make().resumeSession(sid)).sessionId).toBe(sid)
  expect(rpc.request).toHaveBeenCalledWith('thread/resume', { threadId: native })
})
it('serializes sends and interrupts the native turn', async () => {
  const { driver, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  const send = driver.sendUserTurn(sid, { text: 'hello' })
  await expect(driver.sendUserTurn(sid, { text: 'duplicate' })).rejects.toMatchObject({
    code: 'turn_in_flight',
  })
  await send
  await driver.interrupt(sid)
  expect(rpc.request).toHaveBeenCalledWith('turn/interrupt', { threadId: native, turnId: 'turn1' })
})
it('re-reads uncertain sends without replaying them', async () => {
  const { driver, rpc, thread } = setup()
  await driver.startSession({ nativeSessionId: id })
  vi.mocked(rpc.request).mockRejectedValueOnce(new Error('disconnected'))
  await expect(driver.sendUserTurn(sid, { text: 'once' })).rejects.toThrow('disconnected')
  thread.turns = [{ id: 'accepted', status: 'inProgress' }]
  await expect(driver.sendUserTurn(sid, { text: 'again' })).rejects.toMatchObject({
    code: 'turn_in_flight',
  })
  expect(vi.mocked(rpc.request).mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
})
it('delivers context in the accepted first turn even when resume overrides are ignored', async () => {
  const { driver, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  await driver.sendUserTurn(sid, { text: 'hello', systemPrompt: 'context' })
  expect(rpc.request).not.toHaveBeenCalledWith('thread/resume', expect.anything())
  expect(rpc.request).toHaveBeenCalledWith('turn/start', {
    threadId: native,
    input: [
      { type: 'text', text: 'context' },
      { type: 'text', text: 'hello' },
    ],
  })
})
it('preserves approval IDs, ignores other threads and rejects stale answers', async () => {
  const { driver, emit, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  const events: HarnessEvent[] = []
  driver.subscribe(sid, (e) => events.push(e))
  emit({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'other' } })
  expect(rpc.reject).toHaveBeenCalledWith(7, 'No managed thread for request')
  emit({
    id: '7',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: native, itemId: 'cmd1' },
  })
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'approval-request',
      requestId: 'string:7',
      toolCallId: 'cmd1',
    }),
  )
  await expect(driver.resolveApproval(sid, 'string:7', 'allow-session')).rejects.toMatchObject({
    code: 'bad_request',
  })
  await driver.resolveApproval(sid, 'string:7', 'allow')
  expect(rpc.respond).toHaveBeenCalledWith('7', { decision: 'accept' })
  await expect(driver.resolveApproval(sid, 'string:7', 'allow')).rejects.toMatchObject({
    code: 'unknown_approval',
  })
})
it('preserves operator policy and rejects unsupported roster options', () => {
  expect(codexThreadDefaults(['codex', '--dangerously-bypass-approvals-and-sandbox'])).toEqual({
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  expect(codexThreadDefaults(['codex'])).toEqual({})
  expect(() => codexThreadDefaults(['codex', '--unknown'])).toThrow('cannot translate')
})

it('advertises protocol controls even without a PTY backend', () => {
  const { driver } = setup()
  expect(driver.capabilities).toMatchObject({
    resume: true,
    interrupt: true,
    approvals: true,
    liveStream: true,
  })
})

it('accepts interrupt then send before the completion notification', async () => {
  const { driver, rpc, emit } = setup()
  await driver.startSession({ nativeSessionId: id })
  await driver.sendUserTurn(sid, { text: 'first' })
  await driver.interrupt(sid)
  vi.mocked(rpc.request).mockResolvedValueOnce({ turn: { id: 'turn2', status: 'inProgress' } })
  await driver.sendUserTurn(sid, { text: 'replacement' })
  emit({
    method: 'turn/completed',
    params: { threadId: native, turn: { id: 'turn1', status: 'interrupted' } },
  })
  await expect(driver.sendUserTurn(sid, { text: 'third' })).rejects.toMatchObject({
    code: 'turn_in_flight',
  })
})

it('interrupt waits for a pending turn/start response', async () => {
  const { driver, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  let accept!: (value: Record<string, unknown>) => void
  vi.mocked(rpc.request).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      }),
  )
  const send = driver.sendUserTurn(sid, { text: 'first' })
  await vi.waitFor(() => expect(accept).toBeDefined())
  const interrupt = driver.interrupt(sid)
  accept({ turn: { id: 'pending', status: 'inProgress' } })
  await Promise.all([send, interrupt])
  expect(rpc.request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: native,
    turnId: 'pending',
  })
})

it.each(['completed', 'inProgress'])(
  're-reads a disconnected known turn without subscribers: %s',
  async (status) => {
    const { driver, rpc, emit, thread } = setup()
    await driver.startSession({ nativeSessionId: id })
    await driver.sendUserTurn(sid, { text: 'first' })
    emit({ method: '$disconnected', params: {} })
    thread.turns = [{ id: 'turn1', status }]
    if (status === 'completed') await driver.sendUserTurn(sid, { text: 'second' })
    else
      await expect(driver.sendUserTurn(sid, { text: 'second' })).rejects.toMatchObject({
        code: 'turn_in_flight',
      })
    expect(rpc.request).toHaveBeenCalledWith('thread/resume', { threadId: native })
    expect(vi.mocked(rpc.request).mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(
      status === 'completed' ? 2 : 1,
    )
  },
)

it('reports one unavailable event per outage and marks recovered active turns blocked', async () => {
  const { driver, emit, thread } = setup()
  await driver.startSession({ nativeSessionId: id })
  const events: HarnessEvent[] = []
  driver.subscribe(sid, (e) => events.push(e))
  await new Promise((resolve) => setTimeout(resolve, 0))
  emit({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: native } })
  emit({ method: '$disconnected', params: {} })
  emit({ method: '$disconnected', params: {} })
  expect(events.filter((e) => e.type === 'error' && e.code === 'codex_unavailable')).toHaveLength(1)
  thread.turns = [{ id: 'turn1', status: 'inProgress' }]
  emit({ method: '$connected', params: {} })
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'approval_recovery_required' }),
    ),
  )
  expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'blocked' }))
  emit({ method: '$disconnected', params: {} })
  expect(events.filter((e) => e.type === 'error' && e.code === 'codex_unavailable')).toHaveLength(2)
})

it('reads accepted first-turn history before turn/started', async () => {
  const { driver, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  await driver.sendUserTurn(sid, { text: 'first' })
  await driver.transcript(sid)
  expect(rpc.request).toHaveBeenCalledWith('thread/read', { threadId: native, includeTurns: true })
})

it('preserves defaults and empty transcript across driver restart', async () => {
  const defaults = { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  const { driver, rpc, make } = setup(defaults)
  await driver.startSession({ nativeSessionId: id })
  driver.close()
  const resumed = make()
  expect(await resumed.transcript(sid)).toEqual({ turns: [] })
  expect(rpc.request).toHaveBeenCalledWith('thread/resume', { ...defaults, threadId: native })
  expect(rpc.request).not.toHaveBeenCalledWith('thread/read', expect.anything())
})

it('rejects threadless server requests promptly', () => {
  const { emit, rpc } = setup()
  emit({ id: 'token', method: 'account/token/refresh', params: {} })
  expect(rpc.reject).toHaveBeenCalledWith('token', 'No managed thread for request')
})

it('forwards requested reasoning effort on creation', async () => {
  const { driver, rpc } = setup({ config: { existing: true } })
  await driver.startSession({ nativeSessionId: id, effort: 'high' })
  expect(rpc.request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      config: { existing: true, model_reasoning_effort: 'high' },
    }),
  )
})
