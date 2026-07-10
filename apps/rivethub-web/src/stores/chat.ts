/**
 * Live chat state. One WS subscription (all sessions) feeds this store, but
 * writes are gated to sessions the user has opened this visit — the socket
 * sees every session on the node, and hoarding transcripts for all of them
 * would grow unbounded (#299 review). HTTP backfill (sessionMessages) seeds
 * a session when it's opened; everything after arrives over the socket —
 * including the echo of our own sends (no optimistic append; the gateway
 * broadcasts the user frame the moment it records it, so the echo IS the
 * delivery confirmation).
 *
 * connect() carries the endpoint identity (baseUrl + token): when it
 * changes, all chat state is reset — session ids are only meaningful per
 * gateway, and merging node A's ring into node B's transcript would
 * fabricate conversations (#299 review).
 */

import { create } from 'zustand'
import type {
  HarnessTranscriptTurn,
  SessionMessage,
  SessionWsFrame,
  TranscriptWsFrame,
} from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { isValidGatewayUrl, useConnection } from './connection.js'
import { foldStream, type LiveTurn } from '../lib/fold-stream.js'
import { messagesFromHarnessTurns } from '../lib/harness-turns.js'
import { questionsFromLiveTools, type AskQuestion } from '../lib/ask-user.js'

export type { LiveTurn, LiveToolEntry } from '../lib/fold-stream.js'
export { foldStream } from '../lib/fold-stream.js'

export type WsStatus = 'connecting' | 'open' | 'closed'

/** User turn waiting to be injected into the harness (or mid-inject). */
export type OutboundStatus = 'queued' | 'sending'

export interface OutboundItem {
  /** Same id as the optimistic SessionMessage (`optim:…`). */
  id: string
  text: string
  status: OutboundStatus
}

/** Server-pushed harness transcript state for a watched session. */
export interface TranscriptState {
  rev: number
  turns: HarnessTranscriptTurn[]
  /** '' = no on-disk store found (fresh draft / API-only session) */
  command: string
}

interface ChatState {
  /** transcripts keyed by sessionId; only sessions opened this visit */
  messages: Record<string, SessionMessage[] | undefined>
  /** Push-synced harness store transcripts (seamless modes v2). When a
   *  session has one with a non-'' command, the store file is the single
   *  source of truth for solid messages — bridge message commits stop
   *  appending and only keep their side effects (live clear, ask stash). */
  transcripts: Record<string, TranscriptState | undefined>
  /** bumped on every sessions-dirty frame — the drawer refetches on change */
  sessionsDirty: number
  /** sessions with a turn currently streaming */
  live: Record<string, LiveTurn | undefined>
  /** ms timestamp of the last stream frame per session — the queue pump's
   *  stale-turn release (a harness that never bridges done/turn.end) */
  liveTs: Record<string, number | undefined>
  /** ask-user prompt that survives its turn: stashed off the live tool stack
   *  when the turn ends (done / assistant commit), shown as the composer's
   *  ask card until the user answers or dismisses it */
  ask: Record<string, AskQuestion[] | undefined>
  /** outbound send queue per session — shown in the transcript as queued/sending */
  outbound: Record<string, OutboundItem[] | undefined>
  /** sessions the user opened — the WS write gate */
  opened: string[]
  wsStatus: WsStatus
  /** bumped on every (re)connect that reaches 'open' — consumers refetch
   *  backfill, because frames during the outage are gone forever */
  wsEpoch: number
  /** sessions created locally this visit (may have no messages yet) */
  drafts: string[]
  /** the open conversation */
  active?: string
  seed: (sessionId: string, messages: SessionMessage[]) => void
  /** Hard-resync: replace the session transcript wholesale and clear live
   *  turn state (Android resyncTranscriptToConversation). Does not merge.
   *  `preserveOutbound` keeps the inject queue + its optimistic bubbles
   *  (auto-sync from TUI must not wipe messages the user just queued). */
  replace: (
    sessionId: string,
    messages: SessionMessage[],
    opts?: { preserveOutbound?: boolean },
  ) => void
  addDraft: (sessionId: string) => void
  /** Seamless modes: show the user's turn immediately. Returns optim id. */
  addOptimisticUser: (sessionId: string, text: string, id?: string) => string
  /** Enqueue a user turn (optimistic bubble + queue). Returns optim id. */
  enqueueOutbound: (sessionId: string, text: string) => string
  markOutboundSending: (sessionId: string, id: string) => void
  /** Drop from queue after inject accepted (bubble stays until WS echo). */
  dequeueOutbound: (sessionId: string, id: string) => void
  /** Inject failed / user cancel — remove queue entry + optimistic bubble. */
  failOutbound: (sessionId: string, id: string) => void
  /** User cancel alias for a queued/sending item. */
  cancelOutbound: (sessionId: string, id: string) => void
  /**
   * Start (or keep) a live turn so the UI shows a typing/processing indicator
   * as soon as the user sends — before the harness's first den event arrives
   * (inject ready-gate + first tool can take seconds). Stream events from the
   * WS fold on top via foldStream; clearLive / done clears the slot.
   */
  beginLive: (sessionId: string, activity?: string) => void
  /** Drop the live slot (send failed, or explicit cancel). */
  clearLive: (sessionId: string) => void
  /** True when live has real stream content (not just a pre-inject placeholder). */
  liveIsBusy: (sessionId: string) => boolean
  /** Drop the pending ask card (user dismissed it / answered by other means). */
  dismissAsk: (sessionId: string) => void
  /** Pass undefined to deselect (error-boundary recover, etc.). */
  setActive: (sessionId: string | undefined) => void
  /** Subscribe to pushed transcript frames for a session (refcounted
   *  server-side per socket; re-sent automatically on reconnect). */
  watchTranscript: (sessionId: string) => void
  unwatchTranscript: (sessionId: string) => void
  connect: (endpointKey: string) => void
  disconnect: () => void
}

function appendMessage(list: SessionMessage[] | undefined, msg: SessionMessage): SessionMessage[] {
  const prev = list ?? []
  if (prev.some((m) => m.id === msg.id)) return prev
  return [...prev, msg]
}

let subscription: Subscription | undefined
let currentEndpoint: string | undefined
/** Sessions with an active transcript watch — re-sent on every reconnect
 *  (server-side subscriptions die with the socket). */
const watchedSessions = new Set<string>()

/**
 * Apply a pushed transcript frame: splice the turn array at frame.from,
 * rebuild solid messages from the result, and reconcile the optimistic
 * outbound bubbles (a user turn the store now carries supersedes its
 * optimistic copy — first match only, so two identical queued turns don't
 * collapse). live/ask state is untouched: the live overlay clears through
 * the bridge's commit/done paths, and the view hides the in-flight solid
 * turn while a live turn is busy.
 */
function applyTranscriptFrame(s: ChatState, frame: TranscriptWsFrame): Partial<ChatState> | null {
  const sid = frame.session
  const cur = s.transcripts[sid]
  let turns: HarnessTranscriptTurn[]
  if (frame.from === 0) {
    turns = frame.turns // full snapshot — always applicable
  } else if (cur && frame.rev === cur.rev + 1 && cur.turns.length >= frame.from) {
    turns = [...cur.turns.slice(0, frame.from), ...frame.turns]
  } else {
    return null // missed a delta — caller requests a snapshot
  }
  if (turns.length !== frame.total) return null

  const mapped = messagesFromHarnessTurns(sid, turns)
  // Reconcile optimistic bubbles against the NEW turns only (frame.turns):
  // the just-committed user turn always sits in the changed window.
  const existing = s.messages[sid] ?? []
  const optimBubbles = existing.filter((m) => m.id.startsWith('optim:'))
  let outbound = s.outbound[sid] ?? []
  const newUserTexts = frame.turns.filter((t) => t.role === 'user').map((t) => t.text)
  const keptBubbles: SessionMessage[] = []
  for (const bubble of optimBubbles) {
    const hit = newUserTexts.indexOf(bubble.text)
    const queueItem = outbound.find((o) => o.id === bubble.id)
    // Still queued = not injected yet — a matching store turn is a TUI-typed
    // twin, not this bubble's commit. Everything else with a match is done.
    if (hit >= 0 && queueItem?.status !== 'queued') {
      newUserTexts.splice(hit, 1)
      if (queueItem) outbound = outbound.filter((o) => o.id !== bubble.id)
    } else {
      keptBubbles.push(bubble)
    }
  }
  return {
    transcripts: {
      ...s.transcripts,
      [sid]: { rev: frame.rev, turns, command: frame.command },
    },
    messages: { ...s.messages, [sid]: [...mapped, ...keptBubbles] },
    outbound: outbound === s.outbound[sid] ? s.outbound : { ...s.outbound, [sid]: outbound },
  }
}

export const useChat = create<ChatState>((set, get) => ({
  messages: {},
  transcripts: {},
  sessionsDirty: 0,
  live: {},
  liveTs: {},
  ask: {},
  outbound: {},
  opened: [],
  wsStatus: 'closed',
  wsEpoch: 0,
  drafts: [],

  seed: (sessionId, msgs) =>
    set((s) => {
      const existing = s.messages[sessionId] ?? []
      // Keep WS frames that raced ahead of the HTTP backfill. Safe to merge
      // unconditionally: state is reset on endpoint change, so everything
      // here belongs to the current gateway.
      const merged = [...msgs]
      for (const m of existing) if (!merged.some((x) => x.id === m.id)) merged.push(m)
      merged.sort((a, b) => a.ts - b.ts)
      return { messages: { ...s.messages, [sessionId]: merged } }
    }),

  replace: (sessionId, msgs, opts) =>
    set((s) => {
      const preserve = opts?.preserveOutbound === true
      const outbound = s.outbound[sessionId] ?? []
      let next = [...msgs]
      if (preserve && outbound.length > 0) {
        // Keep optimistic bubbles for still-queued/sending turns so auto-sync
        // from the TUI store doesn't erase the inject queue mid-compose.
        const existing = s.messages[sessionId] ?? []
        const byId = new Map(next.map((m) => [m.id, m] as const))
        for (const o of outbound) {
          const bubble = existing.find((m) => m.id === o.id)
          if (bubble) byId.set(bubble.id, bubble)
        }
        next = [...byId.values()].sort((a, b) => a.ts - b.ts)
      }
      return {
        messages: { ...s.messages, [sessionId]: next },
        live: preserve ? s.live : { ...s.live, [sessionId]: undefined },
        outbound: preserve ? s.outbound : { ...s.outbound, [sessionId]: [] },
        // hard resync rebuilds from disk — a stale ask card must not survive it
        ask: preserve ? s.ask : { ...s.ask, [sessionId]: undefined },
      }
    }),

  addDraft: (sessionId) =>
    set((s) => ({
      drafts: s.drafts.includes(sessionId) ? s.drafts : [sessionId, ...s.drafts],
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
    })),

  addOptimisticUser: (sessionId, text, id) => {
    const msgId = id ?? `optim:${crypto.randomUUID()}`
    set((s) => {
      const msg: SessionMessage = {
        id: msgId,
        sessionId,
        role: 'user',
        text,
        ts: Date.now(),
      }
      return { messages: { ...s.messages, [sessionId]: appendMessage(s.messages[sessionId], msg) } }
    })
    return msgId
  },

  enqueueOutbound: (sessionId, text) => {
    const id = `optim:${crypto.randomUUID()}`
    get().addOptimisticUser(sessionId, text, id)
    set((s) => ({
      outbound: {
        ...s.outbound,
        [sessionId]: [...(s.outbound[sessionId] ?? []), { id, text, status: 'queued' }],
      },
      // whatever the user sent IS the answer — retire the ask card
      ask: { ...s.ask, [sessionId]: undefined },
    }))
    return id
  },

  markOutboundSending: (sessionId, id) =>
    set((s) => ({
      outbound: {
        ...s.outbound,
        [sessionId]: (s.outbound[sessionId] ?? []).map((o) =>
          o.id === id ? { ...o, status: 'sending' as const } : o,
        ),
      },
    })),

  dequeueOutbound: (sessionId, id) =>
    set((s) => ({
      outbound: {
        ...s.outbound,
        [sessionId]: (s.outbound[sessionId] ?? []).filter((o) => o.id !== id),
      },
    })),

  failOutbound: (sessionId, id) =>
    set((s) => ({
      outbound: {
        ...s.outbound,
        [sessionId]: (s.outbound[sessionId] ?? []).filter((o) => o.id !== id),
      },
      messages: {
        ...s.messages,
        [sessionId]: (s.messages[sessionId] ?? []).filter((m) => m.id !== id),
      },
    })),

  cancelOutbound: (sessionId, id) => get().failOutbound(sessionId, id),

  beginLive: (sessionId, activity = 'processing…') =>
    set((s) => {
      // Don't clobber an already-streaming turn (tool stack / partial text).
      const existing = s.live[sessionId]
      if (existing && (existing.text || existing.tools.length > 0 || existing.reasoningText)) {
        return s
      }
      return {
        live: {
          ...s.live,
          [sessionId]: existing
            ? { ...existing, activity: activity || existing.activity }
            : { text: '', reasoning: false, reasoningText: '', tools: [], activity },
        },
      }
    }),

  clearLive: (sessionId) =>
    set((s) => ({
      live: { ...s.live, [sessionId]: undefined },
    })),

  liveIsBusy: (sessionId) => {
    const L = get().live[sessionId]
    if (!L) return false
    // Placeholder activity alone is not "busy" — many harnesses never bridge
    // a done event, and that used to stall the inject queue forever.
    return !!(L.text || L.tools.length > 0 || L.reasoningText)
  },

  dismissAsk: (sessionId) => set((s) => ({ ask: { ...s.ask, [sessionId]: undefined } })),

  setActive: (sessionId) =>
    set((s) => {
      if (sessionId === undefined) return { active: undefined }
      return {
        active: sessionId,
        opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
      }
    }),

  watchTranscript: (sessionId) => {
    set((s) => ({
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
    }))
    watchedSessions.add(sessionId)
    subscription?.send({ type: 'watch', session: sessionId })
    // not-open sends are fine — the onStatus('open') hook re-sends the set
  },

  unwatchTranscript: (sessionId) => {
    watchedSessions.delete(sessionId)
    subscription?.send({ type: 'unwatch', session: sessionId })
  },

  connect: (endpointKey) => {
    subscription?.close()
    if (currentEndpoint !== undefined && currentEndpoint !== endpointKey) {
      watchedSessions.clear() // session ids are only meaningful per gateway
      set({
        messages: {},
        transcripts: {},
        live: {},
        liveTs: {},
        ask: {},
        outbound: {},
        opened: [],
        drafts: [],
        active: undefined,
      })
    }
    currentEndpoint = endpointKey
    // No gateway configured (fresh desktop shell, or a bad URL): don't open
    // a socket against a non-http origin — WebKit throws on the URL (#4j).
    if (!isValidGatewayUrl(useConnection.getState().baseUrl)) {
      set({ wsStatus: 'closed' })
      return
    }
    const { gateway } = useConnection.getState()
    subscription = gateway.watchSessions(
      (frame: SessionWsFrame) => {
        const isOpen = (id: string): boolean => get().opened.includes(id)
        if (frame.kind === 'sessions-dirty') {
          // a harness store changed somewhere — the drawer refetches on this
          set((s) => ({ sessionsDirty: s.sessionsDirty + 1 }))
          return
        }
        if (frame.kind === 'transcript') {
          if (!isOpen(frame.session)) return
          const patch = applyTranscriptFrame(get(), frame)
          if (patch) {
            set(patch)
          } else {
            // missed a delta (reconnect gap / out-of-order) — ask the server
            // for a fresh full snapshot on this same subscription
            subscription?.send({ type: 'sync', session: frame.session })
          }
          return
        }
        if (frame.kind === 'message') {
          const { kind: _kind, ...msg } = frame
          if (!isOpen(msg.sessionId)) return
          set((s) => {
            let list = s.messages[msg.sessionId] ?? []
            // the real user frame supersedes ONE optimistic bubble of the same
            // text — remove only the first match so two identical turns
            // ("yes" then "yes") don't collapse to one (#316 review).
            let outbound = s.outbound[msg.sessionId]
            if (msg.role === 'user') {
              const i = list.findIndex((m) => m.id.startsWith('optim:') && m.text === msg.text)
              if (i >= 0) {
                const optimId = list[i].id
                list = [...list.slice(0, i), ...list.slice(i + 1)]
                // Real echo supersedes optim — drop matching outbound entry if any.
                if (outbound?.some((o) => o.id === optimId)) {
                  outbound = outbound.filter((o) => o.id !== optimId)
                }
              }
            }
            // an assistant message ends the in-flight turn; an ask-user tool
            // from that turn outlives it as the composer's ask card (headless
            // ask doesn't block — the answer is the next user turn). A user
            // echo means the question got answered (here or in the TUI).
            const endsTurn = msg.role === 'assistant'
            const stashed = endsTurn
              ? questionsFromLiveTools(s.live[msg.sessionId]?.tools ?? [])
              : []
            // Store-backed sessions (push-synced transcript): the store file
            // owns solid messages, so bridge commits don't append — they'd
            // duplicate the turn the next transcript frame carries. Their
            // side effects (optimistic supersede, live clear, ask stash)
            // still apply.
            const storeBacked = !!s.transcripts[msg.sessionId]?.command
            return {
              messages: {
                ...s.messages,
                [msg.sessionId]: storeBacked ? list : appendMessage(list, msg),
              },
              outbound:
                outbound !== s.outbound[msg.sessionId]
                  ? { ...s.outbound, [msg.sessionId]: outbound }
                  : s.outbound,
              live: endsTurn ? { ...s.live, [msg.sessionId]: undefined } : s.live,
              ask:
                msg.role === 'user'
                  ? { ...s.ask, [msg.sessionId]: undefined }
                  : stashed.length > 0
                    ? { ...s.ask, [msg.sessionId]: stashed }
                    : s.ask,
            }
          })
        } else {
          if (!isOpen(frame.session)) return
          set((s) => {
            const prev = s.live[frame.session]
            const next = foldStream(prev, frame.event)
            // `done` clears the slot — keep the turn's ask-user prompt alive
            // as the pending ask card (cleared on answer/dismiss).
            const stashed = next === undefined && prev ? questionsFromLiveTools(prev.tools) : []
            return {
              live: { ...s.live, [frame.session]: next },
              liveTs: { ...s.liveTs, [frame.session]: Date.now() },
              ask: stashed.length > 0 ? { ...s.ask, [frame.session]: stashed } : s.ask,
            }
          })
        }
      },
      undefined,
      {
        onStatus: (status) => {
          if (status === 'open') {
            // Fresh socket: anything accumulated before the outage is
            // unreliable (frames during the gap are gone) — clear live and
            // signal consumers to refetch backfill.
            set((s) => ({ wsStatus: status, live: {}, wsEpoch: s.wsEpoch + 1 }))
            // Server-side transcript subscriptions died with the old socket;
            // re-watch everything open. The server answers each watch with a
            // full snapshot, which also heals any frames lost in the gap.
            for (const sid of watchedSessions) {
              subscription?.send({ type: 'watch', session: sid })
            }
          } else {
            set({ wsStatus: status })
          }
        },
      },
    )
  },

  disconnect: () => {
    subscription?.close()
    subscription = undefined
    set({ wsStatus: 'closed' })
  },
}))
