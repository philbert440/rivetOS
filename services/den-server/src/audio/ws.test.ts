import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MicBridge } from './bridge.js'
import { createAudioWs, type AudioSocket } from './ws.js'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

class FakeSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent: { data: string | Buffer; binary: boolean }[] = []
  pings = 0
  closedWith: number | undefined
  terminated = false
  send(data: string | Buffer, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: opts?.binary ?? false })
  }
  close(code?: number): void {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
    this.emit('close')
  }
  terminate(): void {
    if (this.readyState === 3) return
    this.terminated = true
    this.readyState = 3
    this.emit('close')
  }
  ping(): void {
    this.pings++
  }
}

function jsonMsgs(ws: FakeSocket): unknown[] {
  return ws.sent
    .filter((s) => !s.binary && typeof s.data === 'string')
    .map((s) => JSON.parse(s.data as string))
}

function makeBridge(): MicBridge {
  const dir = mkdtempSync(join(tmpdir(), 'mic-ws-'))
  dirs.push(dir)
  return new MicBridge({
    dir,
    deviceName: 'RivetHub Mic',
    sampleRate: 16000,
    channels: 1,
    format: 's16le',
  })
}

describe('audio WS protocol', () => {
  it('hello acquires and returns ready', () => {
    const bridge = makeBridge()
    const audioWs = createAudioWs({
      bridge: () => bridge,
      enabled: () => true,
    })
    const ws = new FakeSocket()
    audioWs.attach(bridge, ws as unknown as AudioSocket)
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'hello', v: 1, sampleRate: 16000, channels: 1, format: 's16le' })),
      false,
    )
    const msgs = jsonMsgs(ws)
    expect(msgs.some((m) => (m as { type: string }).type === 'ready')).toBe(true)
    expect(bridge.status().armed).toBe(true)
    ws.close()
    expect(bridge.status().armed).toBe(false)
    audioWs.close()
  })

  it('second client gets busy', () => {
    const bridge = makeBridge()
    const audioWs = createAudioWs({
      bridge: () => bridge,
      enabled: () => true,
    })
    const a = new FakeSocket()
    const b = new FakeSocket()
    audioWs.attach(bridge, a as unknown as AudioSocket)
    audioWs.attach(bridge, b as unknown as AudioSocket)
    a.emit('message', Buffer.from(JSON.stringify({ type: 'hello', v: 1 })), false)
    b.emit('message', Buffer.from(JSON.stringify({ type: 'hello', v: 1 })), false)
    const errs = jsonMsgs(b).filter((m) => (m as { type: string }).type === 'error') as {
      code: string
    }[]
    expect(errs.some((e) => e.code === 'busy')).toBe(true)
    a.close()
    b.close()
    audioWs.close()
  })

  it('binary before hello is ignored (no throw)', () => {
    const bridge = makeBridge()
    const audioWs = createAudioWs({
      bridge: () => bridge,
      enabled: () => true,
    })
    const ws = new FakeSocket()
    audioWs.attach(bridge, ws as unknown as AudioSocket)
    expect(() => ws.emit('message', Buffer.alloc(640, 1), true)).not.toThrow()
    expect(bridge.status().armed).toBe(false)
    ws.close()
    audioWs.close()
  })

  it('stop releases and sends stopped', () => {
    const bridge = makeBridge()
    const audioWs = createAudioWs({
      bridge: () => bridge,
      enabled: () => true,
    })
    const ws = new FakeSocket()
    audioWs.attach(bridge, ws as unknown as AudioSocket)
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start' })), false)
    expect(bridge.status().armed).toBe(true)
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false)
    expect(bridge.status().armed).toBe(false)
    expect(jsonMsgs(ws).some((m) => (m as { type: string }).type === 'stopped')).toBe(true)
    ws.close()
    audioWs.close()
  })
})
