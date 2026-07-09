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
import type { SessionMessage, SessionWsFrame } from '@rivetos/types'
import type { Subscription } from '@rivetos/gateway-client'
import { isValidGatewayUrl, useConnection } from './connection.js'
import { foldStream, type LiveTurn } from '../lib/fold-stream.js'

export type { LiveTurn, LiveToolEntry } from '../lib/fold-stream.js'
export { foldStream } from '../lib/fold-stream.js'

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
  /** Hard-resync: replace the session transcript wholesale and clear live
   *  turn state (Android resyncTranscriptToConversation). Does not merge. */
  replace: (sessionId: string, messages: SessionMessage[]) => void
  addDraft: (sessionId: string) => void
  /** Seamless modes: show the user's turn immediately on a harness send. The
   *  inject path has real latency (hook fire + first-boot ready-gate), so
   *  unlike the chat-loop there's no instant echo. The real user frame (from
   *  the harness UserPromptSubmit hook, via the bridge) supersedes it by text. */
  addOptimisticUser: (sessionId: string, text: string) => void
  /**
   * Start (or keep) a live turn so the UI shows a typing/processing indicator
   * as soon as the user sends — before the harness's first den event arrives
   * (inject ready-gate + first tool can take seconds). Stream events from the
   * WS fold on top via foldStream; clearLive / done clears the slot.
   */
  beginLive: (sessionId: string, activity?: string) => void
  /** Drop the live slot (send failed, or explicit cancel). */
  clearLive: (sessionId: string) => void
  setActive: (sessionId: string) => void
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

  replace: (sessionId, msgs) =>
    set((s) => ({
      messages: { ...s.messages, [sessionId]: [...msgs] },
      live: { ...s.live, [sessionId]: undefined },
    })),

  addDraft: (sessionId) =>
    set((s) => ({
      drafts: s.drafts.includes(sessionId) ? s.drafts : [sessionId, ...s.drafts],
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
    })),

  addOptimisticUser: (sessionId, text) =>
    set((s) => {
      const msg: SessionMessage = {
        id: `optim:${crypto.randomUUID()}`,
        sessionId,
        role: 'user',
        text,
        ts: Date.now(),
      }
      return { messages: { ...s.messages, [sessionId]: appendMessage(s.messages[sessionId], msg) } }
    }),

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

  setActive: (sessionId) =>
    set((s) => ({
      active: sessionId,
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
    })),

  connect: (endpointKey) => {
    subscription?.close()
    if (currentEndpoint !== undefined && currentEndpoint !== endpointKey) {
      set({ messages: {}, live: {}, opened: [], drafts: [], active: undefined })
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
        if (frame.kind === 'message') {
          const { kind: _kind, ...msg } = frame
          if (!isOpen(msg.sessionId)) return
          set((s) => {
            let list = s.messages[msg.sessionId] ?? []
            // the real user frame supersedes ONE optimistic bubble of the same
            // text — remove only the first match so two identical turns
            // ("yes" then "yes") don't collapse to one (#316 review).
            if (msg.role === 'user') {
              const i = list.findIndex((m) => m.id.startsWith('optim:') && m.text === msg.text)
              if (i >= 0) list = [...list.slice(0, i), ...list.slice(i + 1)]
            }
            return {
              messages: { ...s.messages, [msg.sessionId]: appendMessage(list, msg) },
              // an assistant message ends the in-flight turn
              live: msg.role === 'assistant' ? { ...s.live, [msg.sessionId]: undefined } : s.live,
            }
          })
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
