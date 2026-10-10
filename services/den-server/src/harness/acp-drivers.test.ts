// Routing between the ACP agent and the PTY path for Grok Build and OpenCode:
// no pane → ACP, pane open → PTY (and the agent's copy goes stale), den hook
// echoes of an ACP turn are dropped.

import { describe, expect, it } from 'vitest'
import type { HarnessEvent, SessionId } from '@rivetos/types'
import type { AcpFrame, AcpRpc } from './acp-rpc.js'
import { GrokAcpDriver, OpencodeAcpDriver } from './acp-drivers.js'
import type { DenAgentEventLike, HarnessPtyHost } from './pty-harness-driver.js'

const UUID = '01a123d2-335c-7902-96aa-b324f17a48aa'
const SES = 'ses_edc2e3e37ffeaVpOxtt1kqZyRO'

function fakeRpc(newId: string) {
  const sinks = new Set<(f: AcpFrame) => void>()
  const methods: string[] = []
  let finishPrompt: ((r: Record<string, unknown>) => void) | undefined
  const rpc: AcpRpc = {
    generation: 1,
    agent: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } },
    },
    connect: () => Promise.resolve(),
    request: (method) => {
      methods.push(method)
      if (method === 'session/prompt')
        return new Promise((resolve) => {
          finishPrompt = resolve
        })
      return Promise.resolve(method === 'session/new' ? { sessionId: newId } : {})
    },
    notify: (method) => methods.push(method),
    respond: () => undefined,
    reject: () => undefined,
    subscribe: (s) => {
      sinks.add(s)
      return () => sinks.delete(s)
    },
    close: () => undefined,
  }
  return {
    rpc,
    methods,
    finish: () => finishPrompt?.({ stopReason: 'end_turn' }),
    update: (sessionId: string, update: Record<string, unknown>) => {
      for (const s of sinks) s({ method: 'session/update', params: { sessionId, update } })
    },
  }
}

function fakePty() {
  const live = new Map<string, string>()
  const injects: string[] = []
  const host: HarnessPtyHost = {
    spawn: (_key, _c, _r, _remote, session) => {
      const id = `pty-${String(live.size + 1)}`
      if (session) live.set(session, id)
      return { id, denSession: session ?? id }
    },
    ptyForSession: (s) => live.get(s),
    inject: (_id, text) => {
      injects.push(text)
      return true
    },
  }
  return { host, live, injects }
}

const store = {
  list: () => Promise.resolve([]),
  describe: () => Promise.resolve(undefined),
  exists: () => true,
  transcript: () => Promise.resolve({ turns: [] }),
}

function grok(exists = true) {
  const acp = fakeRpc(UUID)
  const pty = fakePty()
  let tap: ((ev: DenAgentEventLike) => void) | undefined
  const driver = new GrokAcpDriver({
    store: { ...store, exists: () => exists },
    pty: () => Promise.resolve(pty.host),
    events: (sink) => {
      tap = sink
      return () => undefined
    },
    cwd: () => '/work',
    deliveryConfirmMs: 0,
    log: () => undefined,
    acp: { rpc: acp.rpc },
  })
  const events: HarnessEvent[] = []
  const sid = `grok-build:${UUID}` as SessionId
  return { driver, acp, pty, events, sid, den: (ev: DenAgentEventLike) => tap?.(ev) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('GrokAcpDriver', () => {
  it('starts a session over ACP and advertises approvals', async () => {
    const t = grok()
    const summary = await t.driver.startSession()
    expect(summary.sessionId).toBe(t.sid)
    expect(t.acp.methods).toEqual(['session/new'])
    expect(t.pty.live.size).toBe(0)
    expect(t.driver.capabilities).toMatchObject({ approvals: true, interrupt: true })
  })

  it('pins a caller-minted id through the TUI, as before', async () => {
    const t = grok(false)
    await t.driver.startSession({ nativeSessionId: UUID })
    expect(t.acp.methods).toEqual([])
    expect(t.pty.live.has(UUID)).toBe(true)
  })

  it('sends over ACP with no pane open, and over the PTY with one', async () => {
    const t = grok()
    await t.driver.startSession()
    t.driver.subscribe(t.sid, (e) => t.events.push(e))
    await t.driver.sendUserTurn(t.sid, { text: 'over acp' })
    expect(t.acp.methods).toEqual(['session/new', 'session/prompt'])
    expect(t.driver.chatTurnRunning(UUID)).toBe(true)
    t.acp.update(UUID, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    })
    t.acp.finish()
    await tick()
    expect(t.events.filter((e) => e.type === 'assistant-delta')).toHaveLength(1)
    expect(t.events.some((e) => e.type === 'turn-complete')).toBe(true)

    t.pty.live.set(UUID, 'pty-tui')
    await t.driver.sendUserTurn(t.sid, { text: 'over pty' })
    expect(t.pty.injects).toEqual(['over pty'])

    // The pane closes; the agent reloads its stale copy before the next turn.
    t.pty.live.delete(UUID)
    await t.driver.interrupt(t.sid)
    await t.driver.sendUserTurn(t.sid, { text: 'back to acp' })
    expect(t.acp.methods.slice(-3)).toEqual(['session/close', 'session/resume', 'session/prompt'])
  })

  it('drops den hook echoes of an ACP turn but keeps them while a TUI is open', async () => {
    const t = grok()
    await t.driver.startSession()
    t.driver.subscribe(t.sid, (e) => t.events.push(e))
    const echo = { session: UUID, type: 'message.agent', text: 'from hook', harness: 'grok-build' }
    t.den(echo)
    expect(t.events.filter((e) => e.type === 'assistant-delta')).toHaveLength(0)
    t.pty.live.set(UUID, 'pty-tui')
    t.den(echo)
    expect(t.events.filter((e) => e.type === 'assistant-delta')).toHaveLength(1)
  })

  it('cancels a running ACP turn instead of sending Esc', async () => {
    const t = grok()
    await t.driver.startSession()
    await t.driver.sendUserTurn(t.sid, { text: 'long' })
    await t.driver.interrupt(t.sid)
    expect(t.acp.methods.at(-1)).toBe('session/cancel')
    expect(t.pty.injects).toEqual([])
  })
})

describe('OpencodeAcpDriver', () => {
  it('starts sessions over ACP — the TUI cannot pin one', async () => {
    const acp = fakeRpc(SES)
    const pty = fakePty()
    const driver = new OpencodeAcpDriver({
      store,
      pty: () => Promise.resolve(pty.host),
      cwd: () => '/work',
      log: () => undefined,
      acp: { rpc: acp.rpc },
    })
    const summary = await driver.startSession({ cwd: '/tmp' })
    expect(summary.sessionId).toBe(`opencode:${SES}`)
    await driver.sendUserTurn(summary.sessionId, { text: 'hi' })
    expect(acp.methods).toEqual(['session/new', 'session/prompt'])
    expect(pty.injects).toEqual([])
  })
})
