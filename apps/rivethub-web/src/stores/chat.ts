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
 *
 * **Two owners, never both.** A session claimed by a registered HarnessDriver
 * is marked `harnessBound` and is driven entirely by the control plane
 * (`lib/harness-attach.ts` — its own WS plus a transcript hard-resync). This
 * socket then ignores it: den events reach both surfaces, so folding each
 * twice would double every delta. Everything else keeps the gateway chat
 * channel binding verbatim (docs/plans/harness-control-plane.md § Phase 3).
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
import { uuidv4 } from '../lib/uuid.js'
import { messagesFromHarnessTurns } from '../lib/harness-turns.js'
import { questionsFromLiveTools, type AskQuestion } from '../lib/ask-user.js'
import type { HarnessApprovalEvent } from '../lib/harness-fold.js'
import { denRoomKey } from '../lib/harness-chat.js'

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

/** An approval the harness is blocked on (control-plane sessions only —
 *  drivers reporting `approvals: false` never emit these). */
export type PendingApproval = Extract<HarnessApprovalEvent, { type: 'approval-request' }>

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
  /**
   * Sessions a registered HarnessDriver owns. Their transcript and live turn
   * arrive on the control-plane socket (`WS /api/harness-sessions/ws` + a
   * transcript hard-resync), so the all-sessions chat socket must NOT also
   * write them — the same den events reach both surfaces, and folding each
   * twice doubles every delta. One owner per session.
   */
  harnessBound: Record<string, true | undefined>
  /** Approvals a control-plane session is blocked on, oldest-first. */
  approvals: Record<string, PendingApproval[] | undefined>
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
  /**
   * Move every record for a thread onto a new key, in place.
   *
   * Two things do this: the control plane ADOPTING a draft (its bare uuid
   * becomes the canonical `<harness-id>:<uuid>`) and a driver ROTATING a
   * native id (`previousSessionId` → new canonical). Both replace the drawer
   * row's key while the user is sitting in the conversation, and without this
   * the transcript, the inject queue and the live turn are all stranded on the
   * old key. No-op when the destination already has state (a real collision is
   * the node's problem, not something to merge blindly).
   */
  rekey: (from: string, to: string) => void
  /** Seamless modes: show the user's turn immediately. Returns optim id. */
  addOptimisticUser: (sessionId: string, text: string, id?: string) => string
  /** Enqueue a user turn (optimistic bubble + queue). Returns optim id. */
  enqueueOutbound: (sessionId: string, text: string) => string
  markOutboundSending: (sessionId: string, id: string) => void
  /** Put a sending item back in the queue — the harness answered
   *  `turn_in_flight`, which is a "not yet", not a failure. */
  requeueOutbound: (sessionId: string, id: string) => void
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
  /** Replace the live slot outright (control-plane fold owns the whole turn). */
  setLive: (sessionId: string, turn: LiveTurn | undefined) => void
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
  /** Hand a session to the control plane (or take it back on detach). */
  bindHarness: (sessionId: string, harnessId: string) => void
  unbindHarness: (sessionId: string) => void
  /**
   * Hard resync from `GET /api/harness-sessions/:enc/transcript`. Replaces the
   * committed transcript wholesale (the live tail has no replay, so this is
   * the only source of missed history) while keeping optimistic bubbles the
   * store has not caught up with yet.
   */
  syncHarnessTranscript: (sessionId: string, turns: HarnessTranscriptTurn[]) => void
  /** Record an approval-request / retire it on approval-resolved. */
  applyApprovalEvent: (sessionId: string, event: HarnessApprovalEvent) => void
  /** Drop one pending approval (answered locally). */
  clearApproval: (sessionId: string, requestId: string) => void
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
 * Rebuild a session's solid messages from a full turn array and reconcile the
 * optimistic outbound bubbles: a user turn the store now carries supersedes
 * its optimistic copy — first match only, so two identical queued turns don't
 * collapse. Only bubbles with NO outbound entry are eligible — queued means
 * not injected yet (a matching store turn is a TUI-typed twin), and sending
 * means the pump hasn't observed success/failure, so eating the bubble early
 * could leave a failed inject with no retry cue (grok review).
 *
 * `changed` is the window to reconcile against: the delta's own turns for a
 * pushed frame, every turn for a control-plane hard resync (which has no
 * "what changed" information by construction).
 *
 * live/ask state is untouched: the live overlay clears through its own
 * commit/done paths, and the view hides the in-flight solid turn while a live
 * turn is busy.
 */
function transcriptPatch(
  s: ChatState,
  sid: string,
  turns: HarnessTranscriptTurn[],
  changed: HarnessTranscriptTurn[],
  command: string,
  rev: number,
): Partial<ChatState> {
  const mapped = messagesFromHarnessTurns(sid, turns)
  const existing = s.messages[sid] ?? []
  const optimBubbles = existing.filter((m) => m.id.startsWith('optim:'))
  const outbound = s.outbound[sid] ?? []
  const newUserTexts = changed.filter((t) => t.role === 'user').map((t) => t.text)
  const keptBubbles: SessionMessage[] = []
  for (const bubble of optimBubbles) {
    // Newest match, not oldest: a bubble the user just sent is the tail of the
    // conversation, and pairing it with an identical turn from an hour ago
    // would retire the wrong one (and flicker the new turn in behind it).
    const hit = newUserTexts.lastIndexOf(bubble.text)
    const inQueue = outbound.some((o) => o.id === bubble.id)
    if (hit >= 0 && !inQueue) {
      newUserTexts.splice(hit, 1)
    } else {
      keptBubbles.push(bubble)
    }
  }
  return {
    transcripts: { ...s.transcripts, [sid]: { rev, turns, command } },
    messages: { ...s.messages, [sid]: [...mapped, ...keptBubbles] },
  }
}

/**
 * Apply a pushed transcript frame: splice the turn array at frame.from, then
 * rebuild through `transcriptPatch`. Returns null when a delta can't be
 * applied (missed rev / length mismatch) so the caller can ask for a snapshot.
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
  return transcriptPatch(s, sid, turns, frame.turns, frame.command, frame.rev)
}

export const useChat = create<ChatState>((set, get) => ({
  messages: {},
  transcripts: {},
  sessionsDirty: 0,
  live: {},
  liveTs: {},
  ask: {},
  outbound: {},
  harnessBound: {},
  approvals: {},
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

  rekey: (from, to) =>
    set((s) => {
      if (from === to) return {}
      // Destination already live: leave both alone rather than clobber a real
      // transcript with the one we were about to fold in.
      if (s.messages[to] !== undefined || s.transcripts[to] !== undefined) return {}
      const move = <T>(m: Record<string, T | undefined>): Record<string, T | undefined> => {
        if (!(from in m)) return m
        const { [from]: value, ...rest } = m
        return { ...rest, [to]: value }
      }
      const swap = (list: string[]): string[] =>
        list.includes(from) ? list.map((id) => (id === from ? to : id)) : list
      // The transcript watch is refcounted server-side per socket, so the old
      // subscription has to be released explicitly — the server has no idea
      // the two ids are the same thread.
      if (watchedSessions.has(from)) {
        watchedSessions.delete(from)
        subscription?.send({ type: 'unwatch', session: from })
        watchedSessions.add(to)
        subscription?.send({ type: 'watch', session: to })
      }
      return {
        messages: move(s.messages),
        transcripts: move(s.transcripts),
        live: move(s.live),
        liveTs: move(s.liveTs),
        ask: move(s.ask),
        outbound: move(s.outbound),
        harnessBound: move(s.harnessBound),
        approvals: move(s.approvals),
        opened: swap(s.opened),
        drafts: s.drafts.includes(from) ? s.drafts.filter((id) => id !== from) : s.drafts,
        active: s.active === from ? to : s.active,
      }
    }),

  addOptimisticUser: (sessionId, text, id) => {
    const msgId = id ?? `optim:${uuidv4()}`
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
    const id = `optim:${uuidv4()}`
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

  requeueOutbound: (sessionId, id) =>
    set((s) => ({
      outbound: {
        ...s.outbound,
        [sessionId]: (s.outbound[sessionId] ?? []).map((o) =>
          o.id === id ? { ...o, status: 'queued' as const } : o,
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

  setLive: (sessionId, turn) =>
    set((s) => {
      // A turn ending takes its ask-user prompt with it unless we stash it:
      // headless ask tools don't block, so the question outlives the turn as
      // the composer's ask card until answered or dismissed. Same rule the
      // bridge path applies on `done` — without it, a control-plane session
      // would show the card mid-turn and lose it the moment the turn ended.
      const prev = s.live[sessionId]
      const stashed = turn === undefined && prev ? questionsFromLiveTools(prev.tools) : []
      return {
        live: { ...s.live, [sessionId]: turn },
        liveTs: { ...s.liveTs, [sessionId]: Date.now() },
        ask: stashed.length > 0 ? { ...s.ask, [sessionId]: stashed } : s.ask,
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

  bindHarness: (sessionId, harnessId) =>
    set((s) => ({
      harnessBound: { ...s.harnessBound, [sessionId]: true },
      opened: s.opened.includes(sessionId) ? s.opened : [...s.opened, sessionId],
      // Mark the session store-backed straight away: the transcript is the
      // source of truth for solid messages, so nothing else may append.
      transcripts: s.transcripts[sessionId]
        ? { ...s.transcripts, [sessionId]: { ...s.transcripts[sessionId], command: harnessId } }
        : { ...s.transcripts, [sessionId]: { rev: 0, turns: [], command: harnessId } },
    })),

  unbindHarness: (sessionId) =>
    set((s) => {
      const { [sessionId]: _bound, ...harnessBound } = s.harnessBound
      return { harnessBound, approvals: { ...s.approvals, [sessionId]: undefined } }
    }),

  syncHarnessTranscript: (sessionId, turns) =>
    set((s) => {
      // A resync carries no "what changed", so derive it: everything past the
      // common prefix with what we already hold. That keeps bubble
      // reconciliation pointed at the tail instead of the whole history, where
      // an identical turn from earlier in the conversation could eat a bubble
      // the store has not actually committed yet.
      const prev = s.transcripts[sessionId]?.turns ?? []
      let prefix = 0
      while (
        prefix < prev.length &&
        prefix < turns.length &&
        prev[prefix].role === turns[prefix].role &&
        prev[prefix].text === turns[prefix].text
      ) {
        prefix += 1
      }
      const patch = transcriptPatch(
        s,
        sessionId,
        turns,
        turns.slice(prefix),
        s.transcripts[sessionId]?.command || 'harness',
        (s.transcripts[sessionId]?.rev ?? 0) + 1,
      )
      // A committed user turn at the tail IS the answer — retire the ask card
      // even when the user typed it into the TUI instead of the composer.
      return turns.at(-1)?.role === 'user'
        ? { ...patch, ask: { ...s.ask, [sessionId]: undefined } }
        : patch
    }),

  applyApprovalEvent: (sessionId, event) =>
    set((s) => {
      const pending = s.approvals[sessionId] ?? []
      if (event.type === 'approval-resolved') {
        return {
          approvals: {
            ...s.approvals,
            [sessionId]: pending.filter((p) => p.requestId !== event.requestId),
          },
        }
      }
      if (pending.some((p) => p.requestId === event.requestId)) return s
      return { approvals: { ...s.approvals, [sessionId]: [...pending, event] } }
    }),

  clearApproval: (sessionId, requestId) =>
    set((s) => ({
      approvals: {
        ...s.approvals,
        [sessionId]: (s.approvals[sessionId] ?? []).filter((p) => p.requestId !== requestId),
      },
    })),

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
        harnessBound: {},
        approvals: {},
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
        // A control-plane session is driven by its own socket; the same den
        // events surface on both, so writing here too would double every
        // delta and re-append every committed turn.
        const isOpen = (id: string): boolean => get().opened.includes(id) && !get().harnessBound[id]
        // The den bridge keys its message/stream frames on the DEN ROOM key,
        // which is the native half of a canonical thread key. Map one back
        // onto the thread that owns it — otherwise a canonical-keyed session
        // matches neither `opened` (nothing renders) nor `harnessBound` (the
        // suppression that stops a control-plane session folding every delta
        // twice). Transcript frames need no mapping: the server echoes the id
        // the client watched with, so they already arrive keyed on the thread.
        const ownerKey = (id: string): string => {
          const opened = get().opened
          if (opened.includes(id)) return id
          return opened.find((key) => denRoomKey(key) === id) ?? id
        }
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
          const { kind: _kind, ...bridged } = frame
          const msg = { ...bridged, sessionId: ownerKey(bridged.sessionId) }
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
          const sid = ownerKey(frame.session)
          if (!isOpen(sid)) return
          set((s) => {
            const prev = s.live[sid]
            const next = foldStream(prev, frame.event)
            // `done` clears the slot — keep the turn's ask-user prompt alive
            // as the pending ask card (cleared on answer/dismiss).
            const stashed = next === undefined && prev ? questionsFromLiveTools(prev.tools) : []
            return {
              live: { ...s.live, [sid]: next },
              liveTs: { ...s.liveTs, [sid]: Date.now() },
              ask: stashed.length > 0 ? { ...s.ask, [sid]: stashed } : s.ask,
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
            //
            // Except what this socket does not own. A control-plane session's
            // live turn belongs to ITS socket, which did not drop; blanking it
            // here would erase a mid-stream bubble and hand the queue pump a
            // false "idle" mid-turn. Non-owner never mutates owner state.
            set((s) => {
              const live: Record<string, LiveTurn | undefined> = {}
              for (const sid of Object.keys(s.live)) {
                if (s.harnessBound[sid]) live[sid] = s.live[sid]
              }
              // wsEpoch still bumps: it only drives HTTP backfill refetches,
              // which bound sessions gate off their own transcript anyway.
              return { wsStatus: status, live, wsEpoch: s.wsEpoch + 1 }
            })
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
