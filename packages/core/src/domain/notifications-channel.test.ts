import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { NotificationFrame } from '@rivetos/types'
import { createNotificationsChannel, type NotificationsChannelHandle } from './notifications-channel.js'
import { createGatewayEscalationNotifier } from './task/escalation.js'
import type { TaskEscalationPayload } from './task/escalation.js'

let server: Server | undefined
let channel: NotificationsChannelHandle | undefined

afterEach(async () => {
  await channel?.close()
  channel = undefined
  if (server) await new Promise((r) => server?.close(r))
  server = undefined
})

async function start(): Promise<{ port: number; chan: NotificationsChannelHandle }> {
  channel = createNotificationsChannel()
  const chan = channel
  server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === chan.upgrade.path) chan.upgrade.handle(req, socket, head, url)
    else socket.destroy()
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return { port: addr.port, chan }
}

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/notifications/ws`)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

describe('notifications channel', () => {
  it('broadcasts frames to every connected client', async () => {
    const { port, chan } = await start()
    const a = await connect(port)
    const b = await connect(port)
    expect(chan.clientCount()).toBe(2)

    const got: Promise<NotificationFrame>[] = [a, b].map(
      (ws) =>
        new Promise((resolve) =>
          ws.on('message', (data: Buffer) => resolve(JSON.parse(data.toString()))),
        ),
    )
    chan.broadcast({ kind: 'task.done', taskId: 't1', status: 'completed', ts: 1 })
    const frames = await Promise.all(got)
    expect(frames[0]).toEqual({ kind: 'task.done', taskId: 't1', status: 'completed', ts: 1 })
    expect(frames[1]).toEqual(frames[0])
    a.close()
    b.close()
  })

  it('drops closed clients and broadcast is a no-op with none connected', async () => {
    const { port, chan } = await start()
    const a = await connect(port)
    a.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(chan.clientCount()).toBe(0)
    expect(() =>
      chan.broadcast({ kind: 'task.done', taskId: 't2', status: 'failed', ts: 2 }),
    ).not.toThrow()
  })

  it('gateway escalation notifier emits the wire frame', async () => {
    const { port, chan } = await start()
    const ws = await connect(port)
    const got = new Promise<NotificationFrame>((resolve) =>
      ws.on('message', (data: Buffer) => resolve(JSON.parse(data.toString()))),
    )

    const notifier = createGatewayEscalationNotifier((f) => chan.broadcast(f))
    const payload = {
      task: { id: 'task-9', agentId: 'rivet', goal: 'do the thing' },
      result: { verdict: 'success', summary: 's', artifacts: [] },
      outcome: { verdict: 'escalated', attempts: 1, criteriaReport: [] },
    } as unknown as TaskEscalationPayload
    await notifier.notify(payload)

    const frame = await got
    expect(frame.kind).toBe('escalation')
    if (frame.kind === 'escalation') {
      expect(frame.taskId).toBe('task-9')
      expect(frame.href).toBe('/tasks/task-9')
      expect(frame.summary).toContain('do the thing')
      expect(frame.summary).toContain('refuted after 1 retry')
    }
    ws.close()
  })
})
