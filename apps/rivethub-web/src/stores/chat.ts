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
import type { SessionMessage, SessionWsFrame, StreamEvent } from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { useConnection } from './connection.js'

export interface LiveTurn {
  /** accumulated assistant text deltas for the in-flight turn */
  text: string
  /** last status/tool activity line, for the "working…" chip */
  activity?: string
  reasoning: boolean
}

export type WsStatus = 'connecting' | 'open' | 'closed'

interface ChatState {
  /** transcripts keyed by sessionId; only sessions opened this visit */
  messages: Record<string, SessionMessage[] | undefined>
  /** sessions with a turn currently streaming */
  live: Record<string, LiveTurn | undefined>
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
  addDraft: (sessionId: string) => void
  setActive: (sessionId: string) => void
  connect: (endpointKey: string) => void
  disconnect: () => void
}

function appendMessage(list: SessionMessage[] | undefined, msg: SessionMessage): SessionMessage[] {
  const prev = list ?? []
  if (prev.some((m) => m.id === msg.id)) return prev
  return [...prev, msg]
}

function foldStream(turn: LiveTurn | undefined, event: StreamEvent): LiveTurn | undefined {
  const base: LiveTurn = turn ?? { text: '', reasoning: false }
  switch (event.type) {
    case 'text':
      return { ...base, text: base.text + event.content, reasoning: false, activity: undefined }
    case 'reasoning':
      return { ...base, reasoning: true }
    case 'tool_start':
      return { ...base, activity: event.content || 'running a tool…' }
    case 'tool_result':
      return { ...base, activity: undefined }
    case 'status':
      return { ...base, activity: event.content }
    case 'interrupt':
      // Steer, not termination (AgentLoop emits this mid-turn): the turn
      // continues, so keep the accumulated text (#299 review).
      return { ...base, activity: 'steered — adjusting…' }
    case 'error':
      // Surface it; the runtime follows up with an error message frame,
      // which clears the turn. If that frame is lost, the wsEpoch refetch
      // path recovers on reconnect.
      return { ...base, activity: `⚠ ${event.content || 'error'}` }
    case 'done':
      return undefined
    default:
      return base
  }
}

let subscription: Subscription | undefined
let currentEndpoint: string | undefined

export const useChat = create<ChatState>((set, get) => ({
  messages: {},
  live: {},
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

  addDraft: (sessionId) =>
    set((s) => ({
      drafts: s.drafts.includes(sessionId) ? s.drafts : [sessionId, ...s.drafts],
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
    })),

  setActive: (sessionId) =>
    set((s) => ({
      active: sessionId,
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
    })),

  connect: (endpointKey) => {
    subscription?.close()
    if (currentEndpoint !== undefined && currentEndpoint !== endpointKey) {
      // New gateway: session ids are per-node; drop everything.
      set({ messages: {}, live: {}, opened: [], drafts: [], active: undefined })
    }
    currentEndpoint = endpointKey
    const { gateway } = useConnection.getState()
    subscription = gateway.watchSessions(
      (frame: SessionWsFrame) => {
        const isOpen = (id: string): boolean => get().opened.includes(id)
        if (frame.kind === 'message') {
          const { kind: _kind, ...msg } = frame
          if (!isOpen(msg.sessionId)) return
          set((s) => ({
            messages: {
              ...s.messages,
              [msg.sessionId]: appendMessage(s.messages[msg.sessionId], msg),
            },
            // an assistant message ends the in-flight turn
            live: msg.role === 'assistant' ? { ...s.live, [msg.sessionId]: undefined } : s.live,
          }))
        } else {
          if (!isOpen(frame.session)) return
          set((s) => ({
            live: { ...s.live, [frame.session]: foldStream(s.live[frame.session], frame.event) },
          }))
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
