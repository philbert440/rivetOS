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

export function createNotificationsChannel(): NotificationsChannelHandle {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  return {
    broadcast(frame: NotificationFrame): void {
      const payload = JSON.stringify(frame)
      for (const ws of clients) {
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
      for (const ws of clients) ws.terminate()
      clients.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
