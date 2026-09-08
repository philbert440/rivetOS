import WebSocket from 'ws'

/** Stable app-server JSON-RPC envelope. Verified against Codex CLI 0.153.4's
 * generated protocol and https://learn.chatgpt.com/docs/app-server.
 * A disconnected request is never retried: turn/start may already have run.
 */
export interface CodexFrame {
  method: string
  params: Record<string, unknown>
  id?: number | string
}

export interface CodexRpc {
  readonly generation: number
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
  respond(id: number | string, result: unknown): void
  reject(id: number | string, message: string): void
  subscribe(sink: (frame: CodexFrame) => void): () => void
  close(): void
}

export class CodexRpcClient implements CodexRpc {
  generation = 0
  private socket?: WebSocket
  private connecting?: Promise<void>
  private nextId = 0
  private closed = false
  private reconnect?: NodeJS.Timeout
  private reconnectDelay = 1000
  private readonly sinks = new Set<(frame: CodexFrame) => void>()
  private readonly pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  constructor(
    readonly url: string,
    private readonly timeoutMs = 30_000,
  ) {
    const u = new URL(url)
    if (
      u.protocol !== 'ws:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    ) {
      throw new Error('Codex app-server must use a loopback ws:// endpoint')
    }
  }

  subscribe(sink: (frame: CodexFrame) => void): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  private emit(frame: CodexFrame): void {
    for (const sink of this.sinks) {
      try {
        sink(frame)
      } catch {
        /* isolate subscribers */
      }
    }
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'))
    if (this.connecting) return this.connecting
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = undefined
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        handshakeTimeout: this.timeoutMs,
        maxPayload: 32 * 1024 * 1024,
      })
      this.socket = ws
      ws.on('message', (data) => {
        let value: Record<string, unknown>
        try {
          value = record(
            JSON.parse(
              (Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.isBuffer(data)
                  ? data
                  : Buffer.from(data)
              ).toString('utf8'),
            ),
          )
        } catch {
          ws.close(1002)
          return
        }
        if (typeof value.method === 'string') {
          this.emit({
            method: value.method,
            params: record(value.params),
            ...(typeof value.id === 'number' || typeof value.id === 'string'
              ? { id: value.id }
              : {}),
          })
        } else if (typeof value.id === 'number') {
          const pending = this.pending.get(value.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(value.id)
          if (value.error)
            pending.reject(
              new Error(
                typeof record(value.error).message === 'string'
                  ? (record(value.error).message as string)
                  : 'Codex request failed',
              ),
            )
          else pending.resolve(record(value.result))
        }
      })
      ws.once('open', () => {
        void this.send('initialize', {
          clientInfo: { name: 'rivethub', title: 'RivetHub', version: '0.5.0' },
          capabilities: { experimentalApi: true },
        }).then(
          () => {
            ws.send(JSON.stringify({ method: 'initialized', params: {} }))
            this.reconnectDelay = 1000
            this.generation++
            this.emit({ method: '$connected', params: {} })
            resolve()
          },
          (error: unknown) => {
            reject(error instanceof Error ? error : new Error('Codex initialization failed'))
            ws.close()
          },
        )
      })
      // ws emits close after errors; settle there so cleanup precedes reconnect.
      ws.on('error', () => undefined)
      ws.once('close', () => {
        reject(new Error('Codex connection closed before initialization'))
        if (this.socket !== ws) return
        this.socket = undefined
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Codex connection lost; request outcome may be unknown'))
        }
        this.pending.clear()
        this.emit({ method: '$disconnected', params: {} })
        if (!this.closed && this.sinks.size > 0) {
          if (this.reconnect) clearTimeout(this.reconnect)
          this.reconnect = setTimeout(() => {
            void this.connect().catch(() => undefined)
          }, this.reconnectDelay)
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
          this.reconnect.unref()
        }
      })
    }).finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Codex is disconnected'))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out; request was not retried`))
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect()
    return this.send(method, params)
  }

  respond(id: number | string, result: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Codex is disconnected')
    this.socket.send(JSON.stringify({ id, result }))
  }

  reject(id: number | string, message: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ id, error: { code: -32601, message } }))
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    this.socket?.terminate()
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
