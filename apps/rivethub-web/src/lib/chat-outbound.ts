import { useChat, subscribeChatThreads } from '../stores/chat.js'
import { createOutboundPumpRegistry, type OutboundPumpStore } from './outbound-pump.js'
import { isTurnInFlight } from './harness-chat.js'

/** Adapter handing the extracted pump (lib/outbound-pump.ts) the chat-store
 *  slice it drives — reads go through getState() so the pump always sees the
 *  latest queue/live state. */
const pumpStore: OutboundPumpStore = {
  resolveSessionKey: (sid) => useChat.getState().resolveSessionKey(sid),
  queue: (sid) => useChat.getState().queueFor(sid),
  liveIsBusy: (sid) => useChat.getState().liveIsBusy(sid),
  markSending: (sid, id) => useChat.getState().markOutboundSending(sid, id),
  dequeue: (sid, id) => useChat.getState().dequeueOutbound(sid, id),
  requeue: (sid, id) => useChat.getState().requeueOutbound(sid, id),
  fail: (sid, id) => useChat.getState().failOutbound(sid, id),
  restoreFailed: (sid, item) => useChat.getState().restoreOutboundFailed(sid, item),
  beginLive: (sid, activity) => useChat.getState().beginLive(sid, activity),
  clearLive: (sid) => useChat.getState().clearLive(sid),
  awaitBusy: (sid, ms) =>
    new Promise((resolve) => {
      if (useChat.getState().liveIsBusy(sid)) {
        resolve()
        return
      }
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        unsub()
        clearTimeout(timer)
        resolve()
      }
      const unsub = useChat.subscribe(() => {
        if (useChat.getState().liveIsBusy(sid)) finish()
      })
      const timer = setTimeout(finish, ms)
    }),
}

// The registry follows successful store rekeys and keeps the old pump's latch.
// ActiveSession remounts only rebind its sink to the new session view.
export const outboundPumpFor = createOutboundPumpRegistry(
  pumpStore,
  isTurnInFlight,
  subscribeChatThreads,
)
