// WS /audio/mic — RivetHub host publishes PCM into MicBridge.
//
// Framing (v1):
//   Client → server JSON: hello | start | stop
//   Client → server binary: raw s16le PCM
//   Server → client JSON: ready | error | stopped
//
// Auth is decided by the caller (server.ts) before handleUpgrade.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { MicBridge } from './bridge.js'

export interface AudioSocket {
  readyState: number
  /** Optional — real `ws` sockets expose this for backpressure. */
  bufferedAmount?: number
  send(data: string | Buffer, opts?: { binary?: boolean }): void
  close(code?: number): void
  terminate(): void
  ping(): void
  on(
    event: 'message',
    cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): unknown
  on(event: 'close' | 'error' | 'pong', cb: () => void): unknown
}

export interface AudioWsDeps {
  bridge: () => MicBridge | null
  enabled: () => boolean
  /** Remote address for audit (optional). */
  remoteOf?: (req: IncomingMessage) => string | undefined
}

export interface AudioWs {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void
  attach(bridge: MicBridge, ws: AudioSocket, meta?: { remote?: string }): void
  heartbeat(): void
  close(): void
}

const MAX_BUFFERED = 1024 * 1024
const toBuffer = (d: string | Buffer | ArrayBuffer | Buffer[]): Buffer =>
  typeof d === 'string'
    ? Buffer.from(d, 'utf8')
    : Buffer.isBuffer(d)
      ? d
      : Array.isArray(d)
        ? Buffer.concat(d)
        : Buffer.from(d)

interface AudioClient {
  ws: AudioSocket
  alive: boolean
  publisherId: string
  remote?: string
  helloOk: boolean
}

export function createAudioWs(deps: AudioWsDeps): AudioWs {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<AudioClient>()

  const sendJson = (ws: AudioSocket, obj: unknown): void => {
    if (ws.readyState !== 1) return
    ws.send(JSON.stringify(obj))
  }

  const attach = (bridge: MicBridge, ws: AudioSocket, meta?: { remote?: string }): void => {
    const publisherId = randomBytes(8).toString('hex')
    const client: AudioClient = {
      ws,
      alive: true,
      publisherId,
      remote: meta?.remote,
      helloOk: false,
    }
    clients.add(client)

    const detach = (): void => {
      if (!clients.has(client)) return
      clients.delete(client)
      bridge.release(publisherId, { remote: client.remote })
    }

    ws.on('error', () => {
      detach()
      ws.terminate()
    })
    ws.on('close', () => detach())
    ws.on('pong', () => {
      client.alive = true
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!client.helloOk) return
        const buf = toBuffer(data)
        if (buf.length) bridge.writePcm(publisherId, buf)
        return
      }
      let msg: {
        type?: string
        v?: number
        sampleRate?: number
        channels?: number
        format?: string
      }
      try {
        msg = JSON.parse(toBuffer(data).toString('utf8')) as typeof msg
      } catch {
        sendJson(ws, { type: 'error', code: 'bad-hello', message: 'invalid JSON' })
        return
      }
      if (msg.type === 'hello' || msg.type === 'start') {
        if (msg.type === 'hello') {
          if (msg.v !== undefined && msg.v !== 1) {
            sendJson(ws, { type: 'error', code: 'bad-hello', message: 'unsupported v' })
            return
          }
          if (msg.format && msg.format !== 's16le') {
            sendJson(ws, { type: 'error', code: 'bad-hello', message: 'format must be s16le' })
            return
          }
          if (msg.channels !== undefined && msg.channels !== 1) {
            sendJson(ws, { type: 'error', code: 'bad-hello', message: 'channels must be 1' })
            return
          }
        }
        const acq = bridge.acquire(publisherId, { remote: client.remote })
        if (!acq.ok) {
          if (acq.code === 'busy') {
            sendJson(ws, {
              type: 'error',
              code: 'busy',
              message: `mic held by ${acq.publisherId}`,
            })
          } else {
            sendJson(ws, {
              type: 'error',
              code: 'no-runtime',
              message: acq.message,
            })
          }
          return
        }
        client.helloOk = true
        const st = bridge.status()
        sendJson(ws, {
          type: 'ready',
          device: st.device,
          sampleRate: st.sampleRate,
          format: st.format,
          backend: st.backend,
        })
        return
      }
      if (msg.type === 'stop') {
        bridge.release(publisherId, { remote: client.remote })
        client.helloOk = false
        sendJson(ws, { type: 'stopped' })
        return
      }
    })
  }

  return {
    handleUpgrade(req, socket, head, _url) {
      if (!deps.enabled()) {
        socket.destroy()
        return
      }
      const bridge = deps.bridge()
      if (!bridge) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const remote = deps.remoteOf?.(req) ?? req.socket.remoteAddress ?? undefined
        attach(bridge, ws, { remote })
      })
    },
    attach,
    heartbeat() {
      for (const c of clients) {
        if (c.ws.readyState !== 1) {
          clients.delete(c)
          continue
        }
        if (typeof c.ws.bufferedAmount === 'number' && c.ws.bufferedAmount > MAX_BUFFERED) {
          c.ws.terminate()
          clients.delete(c)
          continue
        }
        if (!c.alive) {
          c.ws.terminate()
          clients.delete(c)
          continue
        }
        c.alive = false
        c.ws.ping()
      }
    },
    close() {
      for (const c of clients) c.ws.close()
      clients.clear()
      wss.close()
    },
  }
}
