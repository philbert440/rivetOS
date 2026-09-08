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
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-driver-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const sinks = new Set<(f: CodexFrame) => void>()
  const thread = { id: native, cwd: '/work', turns: [] as unknown[] }
  const rpc: CodexRpc = {
    generation: 1,
    request: vi.fn(async (method) => method === 'turn/start'
      ? { turn: { id: 'turn1', status: 'inProgress' } } : { thread, model: 'test' }),
    respond: vi.fn(), reject: vi.fn(), close: vi.fn(),
    subscribe: (sink) => { sinks.add(sink); return () => { sinks.delete(sink) } },
  }
  const make = () => {
    const driver = new CodexProtocolDriver({ rpc, endpoint: 'ws://127.0.0.1:5175',
      bindingsFile: join(dir, 'bindings.json'), cwd: () => '/work',
      store: { list: async () => [], describe: async () => undefined, exists: () => false,
        transcript: async () => ({ turns: [] }) } })
    cleanup.push(() => driver.close())
    return driver
  }
  return { driver: make(), make, rpc, thread, emit: (f: CodexFrame) => { for (const sink of sinks) sink(f) } }
}
it('persists client identity and resumes the native thread after restart', async () => {
  const { driver, make, rpc } = setup()
  expect((await driver.startSession({ nativeSessionId: id })).sessionId).toBe(sid)
  expect(driver.terminalArgv(id, 'codex')).toEqual(['codex', '--remote', 'ws://127.0.0.1:5175', 'resume', native])
  driver.close()
  expect((await make().resumeSession(sid)).sessionId).toBe(sid)
  expect(rpc.request).toHaveBeenCalledWith('thread/resume', { threadId: native })
})
it('serializes sends and interrupts the native turn', async () => {
  const { driver, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  const send = driver.sendUserTurn(sid, { text: 'hello' })
  await expect(driver.sendUserTurn(sid, { text: 'duplicate' })).rejects.toMatchObject({ code: 'turn_in_flight' })
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
  await expect(driver.sendUserTurn(sid, { text: 'again' })).rejects.toMatchObject({ code: 'turn_in_flight' })
  expect(vi.mocked(rpc.request).mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
})
it('uses thread/resume for developer instructions', async () => {
  const { driver, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  await driver.sendUserTurn(sid, { text: 'hello', systemPrompt: 'context' })
  expect(rpc.request).toHaveBeenCalledWith('thread/resume', { threadId: native, developerInstructions: 'context' })
  expect(rpc.request).toHaveBeenCalledWith('turn/start', { threadId: native, input: [{ type: 'text', text: 'hello' }] })
})
it('preserves approval IDs, ignores other threads and rejects stale answers', async () => {
  const { driver, emit, rpc } = setup()
  await driver.startSession({ nativeSessionId: id })
  const events: HarnessEvent[] = []
  driver.subscribe(sid, (e) => events.push(e))
  emit({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'other' } })
  expect(rpc.reject).not.toHaveBeenCalled()
  emit({ id: '7', method: 'item/commandExecution/requestApproval', params: { threadId: native, itemId: 'cmd1' } })
  expect(events).toContainEqual(expect.objectContaining({ type: 'approval-request', requestId: 'string:7', toolCallId: 'cmd1' }))
  await expect(driver.resolveApproval(sid, 'string:7', 'allow-session')).rejects.toMatchObject({ code: 'bad_request' })
  await driver.resolveApproval(sid, 'string:7', 'allow')
  expect(rpc.respond).toHaveBeenCalledWith('7', { decision: 'accept' })
  await expect(driver.resolveApproval(sid, 'string:7', 'allow')).rejects.toMatchObject({ code: 'unknown_approval' })
})
it('preserves operator policy and rejects unsupported roster options', () => {
  expect(codexThreadDefaults(['codex', '--dangerously-bypass-approvals-and-sandbox'])).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  expect(codexThreadDefaults(['codex'])).toEqual({})
  expect(() => codexThreadDefaults(['codex', '--unknown'])).toThrow('cannot translate')
})

it('advertises protocol controls even without a PTY backend', () => {
  const { driver } = setup()
  expect(driver.capabilities).toMatchObject({ resume: true, interrupt: true, approvals: true, liveStream: true })
})
