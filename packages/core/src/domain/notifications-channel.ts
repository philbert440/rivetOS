/**
 * WS /api/notifications/ws — ephemeral push to connected RivetHub clients
 * (phase 4e). Deliberately its own route family: multiplexing notification
 * frames onto the sessions WS would force every chat consumer to filter
 * them (same separation rationale as sessions vs den events, Appendix F).
 *
 * Ephemeral by contract: /api/outcomes is the durable escalation inbox; a
 * client that was offline reads it there. No replay, no persistence here.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { NotificationFrame } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('NotificationsChannel')

const MAX_BUFFERED = 256 * 1024

export interface NotificationsChannelHandle {
  /** Fan a frame out to every connected client (fire-and-forget). */
  broadcast(frame: NotificationFrame): void
  clientCount(): number
  upgrade: {
    path: string
    handle: (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void
  }
  close(): Promise<void>
}

const HEARTBEAT_MS = 30_000

export function createNotificationsChannel(): NotificationsChannelHandle {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()
  const alive = new WeakMap<WebSocket, boolean>()
  let closing = false

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  // Escalations are low-frequency: without a sweep, a dropped tab would hold
  // its FD until the next broadcast — possibly never (#300 review). Protocol
  // pings only; nothing added to the wire contract.
  const sweep = setInterval(() => {
    for (const ws of clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        clients.delete(ws)
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, HEARTBEAT_MS)
  sweep.unref()

  return {
    broadcast(frame: NotificationFrame): void {
      if (closing) return
      const payload = JSON.stringify(frame)
      for (const ws of [...clients]) {
        if (ws.readyState !== 1) continue
        if (ws.bufferedAmount > MAX_BUFFERED) {
          ws.terminate()
          clients.delete(ws)
          continue
        }
        ws.send(payload)
      }
      log.debug(`notification ${frame.kind} → ${String(clients.size)} client(s)`)
    },
    clientCount(): number {
      return clients.size
    },
    upgrade: {
      path: '/api/notifications/ws',
      handle: (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      },
    },
    close: async () => {
      closing = true
      clearInterval(sweep)
      for (const ws of clients) ws.terminate()
      clients.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
