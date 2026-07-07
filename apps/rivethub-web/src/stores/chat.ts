/**
 * Live chat state. One WS subscription (all sessions) feeds this store:
 * message frames append to per-session transcripts, stream frames drive the
 * in-flight turn indicator. HTTP backfill (sessionMessages) seeds a session
 * the first time it's opened; everything after arrives over the socket —
 * including the echo of our own sends (no optimistic append; the gateway
 * broadcasts the user frame the moment it records it, so the echo IS the
 * delivery confirmation).
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
  /** transcripts keyed by sessionId; only sessions the user opened */
  messages: Record<string, SessionMessage[] | undefined>
  /** sessions with a turn currently streaming */
  live: Record<string, LiveTurn | undefined>
  wsStatus: WsStatus
  /** sessions created locally this visit (may have no messages yet) */
  drafts: string[]
  /** the open conversation */
  active?: string
  seed: (sessionId: string, messages: SessionMessage[]) => void
  addDraft: (sessionId: string) => void
  setActive: (sessionId: string) => void
  connect: () => void
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
    case 'done':
    case 'error':
    case 'interrupt':
      return undefined
    default:
      return base
  }
}

let subscription: Subscription | undefined

export const useChat = create<ChatState>((set) => ({
  messages: {},
  live: {},
  wsStatus: 'closed',
  drafts: [],

  seed: (sessionId, msgs) =>
    set((s) => {
      const existing = s.messages[sessionId] ?? []
      // Keep WS frames that raced ahead of the HTTP backfill.
      const merged = [...msgs]
      for (const m of existing) if (!merged.some((x) => x.id === m.id)) merged.push(m)
      merged.sort((a, b) => a.ts - b.ts)
      return { messages: { ...s.messages, [sessionId]: merged } }
    }),

  addDraft: (sessionId) =>
    set((s) => ({
      drafts: s.drafts.includes(sessionId) ? s.drafts : [sessionId, ...s.drafts],
    })),

  setActive: (sessionId) => set({ active: sessionId }),

  connect: () => {
    subscription?.close()
    const { gateway } = useConnection.getState()
    subscription = gateway.watchSessions(
      (frame: SessionWsFrame) => {
        if (frame.kind === 'message') {
          const { kind: _kind, ...msg } = frame
          set((s) => ({
            messages: {
              ...s.messages,
              [msg.sessionId]: appendMessage(s.messages[msg.sessionId], msg),
            },
            // an assistant message ends the in-flight turn
            live: msg.role === 'assistant' ? { ...s.live, [msg.sessionId]: undefined } : s.live,
          }))
        } else {
          set((s) => ({
            live: { ...s.live, [frame.session]: foldStream(s.live[frame.session], frame.event) },
          }))
        }
      },
      undefined,
      { onStatus: (status) => set({ wsStatus: status }) },
    )
  },

  disconnect: () => {
    subscription?.close()
    subscription = undefined
    set({ wsStatus: 'closed' })
  },
}))
