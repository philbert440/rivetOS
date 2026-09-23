import type { HarnessAttachGateway } from './harness-attach.js'
import type { OutboundPump } from './outbound-pump.js'
import { undeliveredNote } from './send-block-note.js'

export type DeliveryGateway = Pick<HarnessAttachGateway, 'watchHarnessSession'>

/** Registry-owned live tail: survives view unmounts, closes with the thread.
 * Errors are not replayed, so a gap preserves the pending item as unconfirmed. */
export function watchOutboundDelivery(
  gateway: DeliveryGateway,
  sessionId: string,
  pump: OutboundPump,
) {
  let open = false
  let closed = false
  let status: string | undefined
  const waiters = new Set<(error?: Error) => void>()
  const sub = gateway.watchHarnessSession(
    sessionId,
    (event) => {
      if (closed) return
      if (event.type === 'error' && event.code === 'turn_undelivered' && event.deliveryId) {
        pump.onUndelivered(event.deliveryId, undeliveredNote(event.message))
      } else if (event.type === 'turn-complete') {
        pump.onIdle()
      } else if (event.type === 'status') {
        if (event.status === 'idle') {
          // The initial snapshot is not a turn-complete edge.
          if (status !== undefined && status !== 'idle') pump.onIdle()
        } else {
          pump.onBusy()
        }
        status = event.status
      } else if (
        event.type === 'assistant-delta' ||
        event.type === 'reasoning-delta' ||
        event.type === 'tool-use'
      ) {
        pump.onBusy()
      }
    },
    {
      onStatus: (next) => {
        if (closed) return
        if (next === 'open') {
          open = true
          for (const done of waiters) done()
        } else {
          if (open) pump.onDeliveryLost()
          open = false
          status = undefined
        }
      },
    },
  )
  return {
    get ready(): Promise<void> {
      if (closed) return Promise.reject(new Error('delivery observer closed'))
      if (open) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const done = (error?: Error): void => {
          clearTimeout(timer)
          waiters.delete(done)
          if (error) reject(error)
          else resolve()
        }
        const timer = setTimeout(() => done(new Error('delivery observer unavailable')), 10_000)
        waiters.add(done)
      })
    },
    close: () => {
      if (closed) return
      closed = true
      for (const done of waiters) done(new Error('delivery observer closed'))
      sub.close()
    },
  }
}
