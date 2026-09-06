import { describe, expect, it, vi } from 'vitest'
import { connectTermSocket, TERM_WS_TIMEOUT_MS } from './term-socket.js'

class FakeWebSocket {
  readyState = 0
  onopen: ((ev?: unknown) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  url: string
  closed = false

  constructor(url: string) {
    this.url = url
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }

  errorThenClose(): void {
    this.onerror?.()
    this.close()
  }
}

describe('connectTermSocket', () => {
  it('dials the URL from terminalWsUrl and fires onOpen when the socket opens', () => {
    let created: FakeWebSocket | undefined
    const onOpen = vi.fn()
    const onClose = vi.fn()
    connectTermSocket(
      'ws://127.0.0.1:33575/api/terminal/ws?id=pty-1',
      { onOpen, onClose },
      {
        WebSocketImpl: class extends FakeWebSocket {
          constructor(url: string) {
            super(url)
            created = this
          }
        } as unknown as new (url: string) => WebSocket,
        setTimeoutFn: ((fn: () => void) => {
          void fn
          return 0
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: () => undefined,
      },
    )
    expect(created?.url).toBe('ws://127.0.0.1:33575/api/terminal/ws?id=pty-1')
    created!.open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0]).toBe(created)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('fails closed on timeout when the socket never leaves CONNECTING', () => {
    const timers: Array<() => void> = []
    let created: FakeWebSocket | undefined
    const onOpen = vi.fn()
    const onClose = vi.fn()
    connectTermSocket(
      'wss://192.0.2.112:5174/api/terminal/ws?id=pty-1',
      { onOpen, onClose },
      {
        WebSocketImpl: class extends FakeWebSocket {
          constructor(url: string) {
            super(url)
            created = this
          }
        } as unknown as new (url: string) => WebSocket,
        timeoutMs: TERM_WS_TIMEOUT_MS,
        setTimeoutFn: ((fn: () => void) => {
          timers.push(fn)
          return timers.length
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: () => undefined,
      },
    )
    expect(created?.readyState).toBe(0)
    expect(timers).toHaveLength(1)
    timers[0]()
    expect(created?.closed).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('fails closed on error/close before open (does not stay connecting)', () => {
    let created: FakeWebSocket | undefined
    const onOpen = vi.fn()
    const onClose = vi.fn()
    connectTermSocket(
      'ws://127.0.0.1:1/api/terminal/ws?id=pty-1',
      { onOpen, onClose },
      {
        WebSocketImpl: class extends FakeWebSocket {
          constructor(url: string) {
            super(url)
            created = this
          }
        } as unknown as new (url: string) => WebSocket,
        setTimeoutFn: ((fn: () => void) => {
          void fn
          return 0
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: () => undefined,
      },
    )
    created!.errorThenClose()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
