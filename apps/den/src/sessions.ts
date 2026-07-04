// Session state store: one RoomState per session id, fed by the den-server
// WebSocket (silent reconnect, authoritative snapshot reconcile). The demo
// loop runs ONLY on explicit #demo — an unreachable server just warns and
// keeps retrying. Turning sessions into windows is the caller's concern
// (main.ts drives the WindowManager from these callbacks); the store just
// keeps the map current and reports every change.

import {
  initialRoomState,
  reduceRoom,
  type AgentEvent,
  type AgentEventBody,
  type RoomState,
} from '@rivetos/den-protocol'
import { demoScript, DEMO_LOOP_MS } from './demo.js'
import { serverHttp, serverWs, withToken } from './net.js'

/** The synthetic zero-sessions placeholder window (robot asleep in bed). */
export const IDLE_SESSION = '(idle)'

/** Sessions that only ever exist client-side — no server-side eviction, and
 *  their windows are never destroyed by a snapshot reconcile. */
export const LOCAL_SESSIONS = new Set(['demo', IDLE_SESSION])

export interface SessionStoreOpts {
  /** false = #demo mode: skip the WebSocket entirely and run the demo loop. */
  wantLive: boolean
  /** Register a per-frame callback (the demo driver's clock). */
  addTick(fn: () => void): void
  /** A session's state changed (also fires for sessions seen first here). */
  onSessionUpsert(id: string, state: RoomState): void
  /** Per-event side effects (speech bubble trigger etc.) — fires right after
   *  onSessionUpsert for the same event. */
  onEvent(ev: AgentEvent): void
  /** Session evicted server-side (session.removed) — already dropped here. */
  onSessionRemoved(id: string): void
  /** Snapshot reconciled — ids in server recency order (most recent first). */
  onSnapshot(ids: string[]): void
  /** A demo beat fired — the caller routes it (and may drop it mid-preview). */
  onDemoEvent(ev: AgentEventBody): void
}

export interface SessionStore {
  rooms: Record<string, RoomState>
  sessionNames: Record<string, string>
  ingest(ev: AgentEvent): void
  /** Drop a session locally AND ask den-server to evict it. */
  delete(id: string): void
  /** Connect the live feed — or start the demo loop, per wantLive. */
  start(): void
}

export function createSessionStore(opts: SessionStoreOpts): SessionStore {
  const rooms: Record<string, RoomState> = {}
  const sessionNames: Record<string, string> = {}

  function dropSession(id: string) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete rooms[id]
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete sessionNames[id]
  }

  function ingest(ev: AgentEvent) {
    rooms[ev.session] = reduceRoom(rooms[ev.session] ?? initialRoomState, ev)
    if (ev.name) sessionNames[ev.session] = ev.name
    opts.onSessionUpsert(ev.session, rooms[ev.session])
    opts.onEvent(ev)
  }

  // ---- demo driver (explicit #demo only — never a fallback) ----
  let demoStarted = false
  function startDemoOnce() {
    if (demoStarted) return
    demoStarted = true
    const start = performance.now()
    const fired = new Set<number>()
    opts.addTick(() => {
      const el = (performance.now() - start) % DEMO_LOOP_MS
      const cycle = Math.floor((performance.now() - start) / DEMO_LOOP_MS)
      demoScript.forEach((te, i) => {
        const key = cycle * 10000 + i
        if (el >= te.at && !fired.has(key)) {
          fired.add(key)
          opts.onDemoEvent(te.ev)
        }
      })
    })
  }

  // ---- live den-server feed ----
  const handleWs = (raw: string) => {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>
      if (data.type === 'snapshot') {
        // the snapshot is authoritative: reconcile, don't just merge —
        // sessions evicted while we were disconnected must disappear
        const snapRooms = (data.rooms ?? {}) as Record<string, RoomState>
        for (const s of (data.sessions ?? []) as { id: string; name: string }[])
          sessionNames[s.id] = s.name
        for (const id of Object.keys(rooms)) {
          if (!LOCAL_SESSIONS.has(id) && !(id in snapRooms)) dropSession(id)
        }
        Object.assign(rooms, snapRooms)
        opts.onSnapshot(((data.sessions ?? []) as { id: string }[]).map((s) => s.id))
      } else if (data.type === 'session.removed') {
        const id = data.session as string
        dropSession(id)
        opts.onSessionRemoved(id)
      } else {
        ingest(data as unknown as AgentEvent)
      }
    } catch {
      /* ignore malformed */
    }
  }

  // silent reconnect — NEVER reload the page, and NEVER fall back to the
  // demo loop: an unreachable server warns once and keeps the sleeping
  // empty-state window until the feed comes (back) up
  let everConnected = false
  let warnedUnreachable = false
  const warnUnreachable = () => {
    if (warnedUnreachable) return
    warnedUnreachable = true
    console.warn('[den] den-server unreachable — live sessions will appear when it comes back')
  }
  const connect = () => {
    let ws: WebSocket
    try {
      ws = new WebSocket(withToken(serverWs))
    } catch {
      warnUnreachable() // malformed URL — retrying would not help
      return
    }
    const failTimer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }, 2000)
    ws.onopen = () => clearTimeout(failTimer)
    ws.onmessage = (mev) => {
      everConnected = true
      if (demoStarted) return
      handleWs(mev.data as string)
    }
    ws.onclose = () => {
      clearTimeout(failTimer)
      if (!everConnected) warnUnreachable()
      setTimeout(connect, 3000)
    }
  }

  return {
    rooms,
    sessionNames,
    ingest,
    delete: (id) => {
      void fetch(withToken(`${serverHttp}/session?session=${encodeURIComponent(id)}`), {
        method: 'DELETE',
      }).catch(() => {})
      dropSession(id)
    },
    start: () => {
      if (opts.wantLive) connect()
      else startDemoOnce()
    },
  }
}
