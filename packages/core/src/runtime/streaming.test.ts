/**
 * StreamManager → Channel call snapshot tests.
 *
 * These freeze the channel.send/edit calls StreamManager produces for a given
 * StreamEvent sequence + SessionState. Together with loop.stream-events.test.ts
 * (loop emits StreamEvents), these two layers form the regression baseline for
 * the AI SDK loop swap.
 *
 * Channel-internal formatting (Discord embeds, Telegram markdown, voice TTS)
 * is downstream of StreamManager and unaffected by the loop swap, so it's not
 * snapshotted here.
 *
 * Tests use vitest fake timers because StreamManager throttles edits with a
 * setTimeout(EDIT_INTERVAL_MS=4000).
 */

import { describe, it, vi, beforeEach, afterEach } from 'vitest'
import * as assert from 'node:assert/strict'
import { StreamManager } from './streaming.js'
import type {
  Channel,
  EditResult,
  InboundMessage,
  OutboundMessage,
  SessionState,
  StreamEvent,
} from '@rivetos/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedSend {
  type: 'send'
  message: OutboundMessage
  returnedId: string
}
interface RecordedEdit {
  type: 'edit'
  channelId: string
  messageId: string
  text: string
  overflowIds: string[]
  returned: EditResult | null
}
type RecordedCall = RecordedSend | RecordedEdit

function fakeChannel(calls: RecordedCall[]): Channel {
  let idCounter = 0
  return {
    id: 'fake-ch',
    platform: 'fake',
    async start() {},
    async stop() {},
    async send(message: OutboundMessage): Promise<string | null> {
      const returnedId = `m${++idCounter}`
      calls.push({ type: 'send', message, returnedId })
      return returnedId
    },
    async edit(
      channelId: string,
      messageId: string,
      text: string,
      overflowIds: string[] = [],
    ): Promise<EditResult | null> {
      const returned: EditResult = { messageIds: [messageId] }
      calls.push({
        type: 'edit',
        channelId,
        messageId,
        text,
        overflowIds,
        returned,
      })
      return returned
    },
    onMessage() {},
    onCommand() {},
  }
}

function fakeMessage(): InboundMessage {
  return {
    id: 'in-1',
    userId: 'user-1',
    channelId: 'ch-1',
    chatType: 'dm',
    text: 'hello',
    platform: 'fake',
    timestamp: 0,
  }
}

function fakeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's',
    thinking: 'off',
    reasoningVisible: true,
    toolsVisible: true,
    history: [],
    compactionCount: 0,
    nudgesFired: [],
    ...overrides,
  }
}

async function flushThrottle() {
  // The throttled edit timer fires at 4000ms. Advance + flush microtasks to
  // let the resulting send/edit promise chain settle.
  await vi.advanceTimersByTimeAsync(4100)
  // Two extra microtask drains for the .then() chains after send/edit resolve.
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamManager → Channel call baseline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('text events: single send on first text, edit on subsequent text', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession()

    const events: StreamEvent[] = [{ type: 'text', content: 'Hello' }]
    for (const e of events) sm.handleStreamEvent(ch, msg, session, e)
    await flushThrottle()

    sm.handleStreamEvent(ch, msg, session, { type: 'text', content: ', world!' })
    await flushThrottle()

    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], {
      type: 'send',
      message: {
        channelId: 'ch-1',
        text: 'Hello',
        replyToMessageId: 'in-1',
      },
      returnedId: 'm1',
    })
    assert.deepEqual(calls[1], {
      type: 'edit',
      channelId: 'ch-1',
      messageId: 'm1',
      text: 'Hello, world!',
      overflowIds: [],
      returned: { messageIds: ['m1'] },
    })
  })

  it('reasoning visible + text: italicized reasoning prefix in send', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession({ reasoningVisible: true })

    sm.handleStreamEvent(ch, msg, session, { type: 'reasoning', content: 'thinking hard' })
    sm.handleStreamEvent(ch, msg, session, { type: 'text', content: 'Answer' })
    await flushThrottle()

    assert.equal(calls.length, 1)
    const c0 = calls[0] as RecordedSend
    assert.equal(c0.type, 'send')
    assert.equal(c0.message.text, '_🧠 thinking hard_\n\nAnswer')
  })

  it('reasoning hidden: emits Thinking placeholder, then replaced when text arrives', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession({ reasoningVisible: false })

    sm.handleStreamEvent(ch, msg, session, { type: 'reasoning', content: 'hidden chain' })
    await flushThrottle()
    sm.handleStreamEvent(ch, msg, session, { type: 'text', content: 'Visible answer' })
    await flushThrottle()

    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], {
      type: 'send',
      message: {
        channelId: 'ch-1',
        text: '🧠 _Thinking..._',
        replyToMessageId: 'in-1',
      },
      returnedId: 'm1',
    })
    assert.deepEqual(calls[1], {
      type: 'edit',
      channelId: 'ch-1',
      messageId: 'm1',
      text: 'Visible answer',
      overflowIds: [],
      returned: { messageIds: ['m1'] },
    })
  })

  it('tools visible: tool log emits silent send + edits', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession({ toolsVisible: true })

    sm.handleStreamEvent(ch, msg, session, { type: 'tool_start', content: '🔧 shell' })
    // Drain microtasks so the .then() that captures the toolMessageId resolves
    // before the next event arrives — mirrors real-world timing where chunks
    // arrive across microtask boundaries.
    await Promise.resolve()
    await Promise.resolve()
    sm.handleStreamEvent(ch, msg, session, { type: 'tool_result', content: '✅ shell: hi' })
    await flushThrottle()

    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], {
      type: 'send',
      message: { channelId: 'ch-1', text: '🔧 shell', silent: true },
      returnedId: 'm1',
    })
    // tool_result replaces the last line in the tool log via edit.
    assert.deepEqual(calls[1], {
      type: 'edit',
      channelId: 'ch-1',
      messageId: 'm1',
      text: '✅ shell: hi',
      overflowIds: [],
      returned: { messageIds: ['m1'] },
    })
  })

  it('tools hidden: tool events produce no channel calls', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession({ toolsVisible: false })

    sm.handleStreamEvent(ch, msg, session, { type: 'tool_start', content: '🔧 shell' })
    sm.handleStreamEvent(ch, msg, session, { type: 'tool_result', content: '✅ shell: hi' })
    await flushThrottle()

    assert.deepEqual(calls, [])
  })

  it('error events send a separate message immediately (not throttled)', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession()

    sm.handleStreamEvent(ch, msg, session, { type: 'error', content: 'rate limit' })
    // Error path is fire-and-forget; need a microtask drain rather than
    // throttle advance.
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      type: 'send',
      message: { channelId: 'ch-1', text: '⚠️ rate limit' },
      returnedId: 'm1',
    })
  })

  it('cleanup returns accumulated text + last messageId; cancels pending throttled edits', async () => {
    const calls: RecordedCall[] = []
    const ch = fakeChannel(calls)
    const sm = new StreamManager()
    const msg = fakeMessage()
    const session = fakeSession()

    sm.handleStreamEvent(ch, msg, session, { type: 'text', content: 'Done' })
    await flushThrottle()
    // Schedule a second edit, but cleanup before throttle fires.
    sm.handleStreamEvent(ch, msg, session, { type: 'text', content: ' more' })

    const result = sm.cleanup(`${msg.channelId}:${msg.userId}`)
    assert.deepEqual(result, {
      messageId: 'm1',
      overflowIds: [],
      accumulatedText: 'Done more',
    })

    // Pending throttled edit was cancelled — no second channel call.
    await flushThrottle()
    assert.equal(calls.length, 1)
  })
})
