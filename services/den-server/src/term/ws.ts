// WS /term — the terminal attach protocol.
//
// Server → client framing:
//   1. one JSON text frame   {type:'hello', v:1, id, denSession, command,
//      cols, rows, state:'running'|'exited', exitCode?, mux?:'tmux',
//      owner?: {device, self}}
//   2. one binary frame      scrollback replay (possibly empty). Under
//      mux:'tmux' a NON-empty ring is replayed as usual (the tmux client
//      already attached at POST /term, so its redraw is in the ring before
//      the browser WS connects). An empty ring yields an empty frame —
//      tmux will redraw the client.
//   3. live PTY output       binary frames
//   4. ownership changes     {type:'owner', device, self, since?} to every
//      attached client (`self` is per-recipient)
//   5. on child exit         {type:'exit', code, signal?} then close(1000)
//      after a short grace so trailing output frames flush first
// Late attach to an exited-but-lingering record replays the whole story:
// hello(state:'exited') + scrollback + exit frame + close.
//
// Client → server framing:
//   binary frames            raw keystrokes → pty write (every attached
//                            client may type — this is a single-operator
//                            system, not a collaboration protocol)
//   {type:'resize',cols,rows}  clamped to 20-500 / 5-200 (same as POST /term).
//                            Only the session owner applies this to the PTY;
//                            a non-owner records it for a later claim. A
//                            resize while the session has no owner auto-claims.
//   {type:'claim', cols?, rows?}  take ownership; optional size (else last
//                            known resize on this client). Broadcasts owner.
//   {type:'kill'}            same semantics as DELETE /term
//   anything else            ignored (forward compatibility)
//
// Reattach: a closed browser tab detaches but never kills — the manager's
// detached TTL (and, from the last detach, a fresh idle-TTL window) owns the
// PTY's fate; reattaching cancels both reapers and replays scrollback
// byte-exactly.
//
// Backpressure, two tiers: a single client buffered past MAX_BUFFERED is
// terminated (same rule as the /ws fanout — a reader that far behind is dead
// weight). Before any client gets there, once EVERY attached client sits
// above the soft high-water mark the PTY itself is paused (node-pty
// pause/resume, optional-chained for backends without it) and resumed as
// soon as somebody drains — pausing the source beats dropping bytes.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { TermManager } from './manager.js'
import { denJoinKey } from '../harness/session-key.js'

/** The slice of a WebSocket the protocol touches — ws.WebSocket satisfies it
 *  structurally; tests drive the protocol with a scripted fake. */
export interface TermSocket {
  readyState: number
  bufferedAmount: number
  send(data: string | Buffer, opts?: { binary?: boolean }): void
  close(code?: number): void
  terminate(): void
  ping(): void
  on(
    event: 'message',
    cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): unknown
  on(event: 'close' | 'error' | 'pong', cb: () => void): unknown
}

export interface TermWsDeps {
  /** Shared lazy manager (the same memoized promise the HTTP endpoints use);
   *  null = node-pty unavailable → the upgrade is destroyed. */
  manager: () => Promise<TermManager | null>
  /** Terminals enabled AND not security-gated. Anything else must destroy
   *  the upgrade — a gated deployment never completes the handshake. */
  enabled: () => boolean
  /** Tenancy gate: may this request attach to a PTY owned by this den
   *  session? Absent = tenancy off. False destroys the upgrade. */
  authorize?: (req: IncomingMessage, denSession: string) => boolean
  /** Viewer identity for ownership labels. Tests inject a fake. Absent or
   *  null / empty → `'another device'` (loopback / no client cert). */
  identity?: (req: IncomingMessage) => { device: string } | null
  /** Optional; defaults to console.info. Ownership changes log one line. */
  log?: (msg: string) => void
}

export interface TermWs {
  /** Complete (or destroy) a WS upgrade for /term?id=|?session=. The caller
   *  (server.ts) has already authorized the request pre-handshake. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void
  /** Wire a handshaken socket to a PTY — the protocol core, exposed so tests
   *  can drive it with a scripted socket. `opts.device` is the ownership
   *  label (default `'another device'`). */
  attach(manager: TermManager, ptyId: string, ws: TermSocket, opts?: { device?: string }): void
  /** Ping/terminate sweep — folded into the server's shared 30s heartbeat. */
  heartbeat(): void
  close(): void
}

// hard per-client cap — same value and rule as the /ws fanout in server.ts
const MAX_BUFFERED = 1024 * 1024
// pause the PTY source when EVERY attached client is buffered above this
const PAUSE_HIGH_WATER = 256 * 1024
// resume once at least one client has drained back below this (hysteresis)
const RESUME_LOW_WATER = 64 * 1024
// ws exposes no drain event — poll bufferedAmount only while paused
const DRAIN_POLL_MS = 100
// exit frame → close(1000): let trailing output frames flush first
const EXIT_GRACE_MS = 200

const toBuffer = (d: string | Buffer | ArrayBuffer | Buffer[]): Buffer =>
  typeof d === 'string'
    ? Buffer.from(d, 'utf8')
    : Buffer.isBuffer(d)
      ? d
      : Array.isArray(d)
        ? Buffer.concat(d)
        : Buffer.from(d)

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.floor(v)))

interface TermClient {
  ws: TermSocket
  /** Heartbeat flag — set on pong, cleared on ping; dead = terminate. */
  alive: boolean
  cleanup: () => void
  /** Stable id for this attachment (ownership). */
  id: string
  /** Friendly device label shown to other viewers. */
  device: string
  /** Last size this viewer sent via `{type:'resize'}` (or a sized claim). */
  cols?: number
  rows?: number
  /** Monotonic seq of this client's last resize; 0 = never resized. */
  resizeSeq: number
}

interface TermOwner {
  clientId: string
  device: string
  since: number
}

/** All clients attached to one PTY — the unit pause/resume reasons about. */
interface PtyGroup {
  clients: Set<TermClient>
  paused: boolean
  drainTimer?: NodeJS.Timeout
  /** Incremented on every resize from any client in this group. */
  resizeSeq: number
  /** Exactly one owner, or none (until the first auto-claim resize). */
  owner?: TermOwner
}

const FALLBACK_DEVICE = 'another device'

const deviceLabel = (raw: { device?: string } | null | undefined): string => {
  const d = raw?.device?.trim()
  return d || FALLBACK_DEVICE
}

export function createTermWs(deps: TermWsDeps): TermWs {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<TermClient>()
  const groups = new Map<string, PtyGroup>()
  const log = deps.log ?? ((msg: string) => console.info(msg))
  let nextClientId = 0

  const resume = (manager: TermManager, ptyId: string, group: PtyGroup): void => {
    if (!group.paused) return
    group.paused = false
    if (group.drainTimer) clearInterval(group.drainTimer)
    group.drainTimer = undefined
    manager.resume(ptyId)
  }

  const checkDrained = (manager: TermManager, ptyId: string, group: PtyGroup): void => {
    if (!group.paused) return
    if (group.clients.size === 0) return resume(manager, ptyId, group)
    for (const c of group.clients)
      if (c.ws.bufferedAmount <= RESUME_LOW_WATER) return resume(manager, ptyId, group)
  }

  const maybePause = (manager: TermManager, ptyId: string, group: PtyGroup): void => {
    if (group.paused || group.clients.size === 0) return
    for (const c of group.clients) if (c.ws.bufferedAmount <= PAUSE_HIGH_WATER) return
    group.paused = true
    manager.pause(ptyId)
    group.drainTimer = setInterval(() => checkDrained(manager, ptyId, group), DRAIN_POLL_MS)
    group.drainTimer.unref()
  }

  const sendTo = (c: TermClient, obj: Record<string, unknown>): void => {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj))
  }

  const broadcastOwner = (group: PtyGroup): void => {
    const o = group.owner
    for (const c of group.clients) {
      const frame: Record<string, unknown> = {
        type: 'owner',
        device: o ? o.device : null,
        self: o ? o.clientId === c.id : false,
      }
      if (o) frame.since = o.since
      sendTo(c, frame)
    }
  }

  const setOwner = (
    group: PtyGroup,
    ptyId: string,
    next: { clientId: string; device: string } | undefined,
    reason: string,
  ): void => {
    if (group.owner?.clientId === next?.clientId) return
    const prev = group.owner?.device ?? 'none'
    const nextDev = next?.device ?? 'none'
    group.owner = next
      ? { clientId: next.clientId, device: next.device, since: Date.now() }
      : undefined
    log(`term: owner ${prev} → ${nextDev} for ${ptyId} (${reason})`)
    broadcastOwner(group)
  }

  const applySize = (manager: TermManager, ptyId: string, cols: number, rows: number): void => {
    const cur = manager.get(ptyId)
    if (cur && cur.cols === cols && cur.rows === rows) return
    manager.resize(ptyId, cols, rows)
  }

  const mostRecentResizer = (group: PtyGroup): TermClient | undefined => {
    let best: TermClient | undefined
    for (const c of group.clients) {
      if (c.resizeSeq === 0) continue
      if (!best || c.resizeSeq > best.resizeSeq) best = c
    }
    return best
  }

  const attach = (
    manager: TermManager,
    ptyId: string,
    ws: TermSocket,
    opts?: { device?: string },
  ): void => {
    // the record can be reaped between the upgrade check and the handshake
    // completing — close post-handshake instead of destroying mid-frame
    const info = manager.get(ptyId)
    if (!info) {
      ws.close(1011)
      return
    }

    let group = groups.get(ptyId)
    if (!group) {
      group = { clients: new Set(), paused: false, resizeSeq: 0 }
      groups.set(ptyId, group)
    }
    const g = group

    let detach: (() => void) | null = null
    let graceTimer: NodeJS.Timeout | undefined
    let done = false
    const cleanup = (): void => {
      if (done) return
      done = true
      if (graceTimer) clearTimeout(graceTimer)
      detach?.()
      clients.delete(client)
      g.clients.delete(client)
      if (g.clients.size === 0) {
        // never leave a PTY paused with nobody reading — scrollback (and the
        // child itself) must keep flowing while detached. Last viewer out
        // leaves the PTY size alone (reaper / next attach owns it).
        resume(manager, ptyId, g)
        groups.delete(ptyId)
        return
      }
      if (g.owner?.clientId !== client.id) return
      // Owner left: one remaining viewer becomes owner (its last size applied);
      // several remaining → most recent resizer; none of those resized → none.
      if (g.clients.size === 1) {
        const only = [...g.clients][0]
        setOwner(g, ptyId, { clientId: only.id, device: only.device }, 'detach')
        if (only.cols !== undefined && only.rows !== undefined)
          applySize(manager, ptyId, only.cols, only.rows)
        return
      }
      const best = mostRecentResizer(g)
      if (best) {
        setOwner(g, ptyId, { clientId: best.id, device: best.device }, 'detach')
        if (best.cols !== undefined && best.rows !== undefined)
          applySize(manager, ptyId, best.cols, best.rows)
      } else {
        setOwner(g, ptyId, undefined, 'detach')
      }
    }
    const client: TermClient = {
      ws,
      alive: true,
      cleanup,
      id: `t${++nextClientId}`,
      device: deviceLabel(opts),
      resizeSeq: 0,
    }
    clients.add(client)
    g.clients.add(client)

    const sendJson = (obj: Record<string, unknown>): void => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj))
    }
    const closeSoon = (): void => {
      if (graceTimer || done) return
      graceTimer = setTimeout(() => ws.close(1000), EXIT_GRACE_MS)
      graceTimer.unref()
    }

    ws.on('close', cleanup)
    ws.on('error', () => {
      cleanup()
      ws.terminate()
    })
    ws.on('pong', () => (client.alive = true))
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // raw keystrokes — refused by the manager after exit, nothing to do
        manager.write(ptyId, toBuffer(data))
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(toBuffer(data).toString('utf8'))
      } catch {
        return
      }
      if (typeof raw !== 'object' || raw === null) return
      const m = raw as { type?: unknown; cols?: unknown; rows?: unknown }
      if (m.type === 'resize') {
        if (typeof m.cols !== 'number' || !Number.isFinite(m.cols)) return
        if (typeof m.rows !== 'number' || !Number.isFinite(m.rows)) return
        const cols = clamp(m.cols, 20, 500)
        const rows = clamp(m.rows, 5, 200)
        client.cols = cols
        client.rows = rows
        client.resizeSeq = ++g.resizeSeq
        if (!g.owner) {
          setOwner(g, ptyId, { clientId: client.id, device: client.device }, 'resize')
          manager.resize(ptyId, cols, rows)
        } else if (g.owner.clientId === client.id) {
          manager.resize(ptyId, cols, rows)
        }
      } else if (m.type === 'claim') {
        const sized =
          typeof m.cols === 'number' &&
          Number.isFinite(m.cols) &&
          typeof m.rows === 'number' &&
          Number.isFinite(m.rows)
        if (sized) {
          const cols = clamp(m.cols as number, 20, 500)
          const rows = clamp(m.rows as number, 5, 200)
          client.cols = cols
          client.rows = rows
          client.resizeSeq = ++g.resizeSeq
        }
        setOwner(g, ptyId, { clientId: client.id, device: client.device }, 'claim')
        if (client.cols !== undefined && client.rows !== undefined)
          applySize(manager, ptyId, client.cols, client.rows)
      } else if (m.type === 'kill') {
        manager.kill(ptyId)
      }
    })

    // hello → replay → subscribe happen in ONE synchronous block: no PTY
    // output event can interleave, so every client sees hello, then the
    // exact scrollback, then live bytes — nothing lost or doubled between
    const hello: Record<string, unknown> = {
      type: 'hello',
      v: 1,
      id: info.id,
      denSession: info.denSession,
      command: info.command,
      cols: info.cols,
      rows: info.rows,
      state: info.state,
    }
    if (info.state === 'exited') hello.exitCode = info.exitCode ?? null
    // mux is stamped only when tmux backs the PTY — under 'none' the frame
    // stays byte-identical to before T1.
    if (info.mux) hello.mux = info.mux
    if (g.owner) hello.owner = { device: g.owner.device, self: g.owner.clientId === client.id }
    sendJson(hello)
    // Replay den's ring whenever it is NON-empty (tmux client's attach
    // redraw is already in the ring by the time the browser WS connects).
    // Empty ring → empty frame; tmux will redraw the client.
    const replay = manager.scrollback(ptyId) ?? Buffer.alloc(0)
    ws.send(replay, { binary: true })

    detach = manager.attach(
      ptyId,
      (data) => {
        if (ws.readyState !== 1) return
        if (ws.bufferedAmount > MAX_BUFFERED) {
          ws.terminate()
          cleanup()
          return
        }
        ws.send(toBuffer(data), { binary: true })
        maybePause(manager, ptyId, g)
      },
      (code) => {
        sendJson({ type: 'exit', code })
        closeSoon()
      },
    )

    // exited-but-lingering: the exit already happened — replay it and close,
    // mirroring the live sequence exactly
    if (info.state === 'exited') {
      sendJson({ type: 'exit', code: info.exitCode ?? null })
      closeSoon()
    }
  }

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void => {
    void (async () => {
      // disabled or security-gated terminals never complete the handshake
      if (!deps.enabled()) {
        socket.destroy()
        return
      }
      const manager = await deps.manager()
      if (!manager) {
        socket.destroy()
        return
      }
      // A canonical `<harness-id>:<native>` SessionId attaches to the same PTY
      // as the bare den join key it resolves to (§ Legacy keys).
      const session = url.searchParams.get('session')
      const id =
        url.searchParams.get('id') ??
        (session ? manager.ptyForSession(denJoinKey(session)) : undefined)
      const info = id ? manager.get(id) : undefined
      if (!id || !info) {
        socket.destroy()
        return
      }
      // tenancy: a PTY is its owner's — no cross-user attach, ever
      if (deps.authorize && !deps.authorize(req, info.denSession)) {
        socket.destroy()
        return
      }
      const device = deviceLabel(deps.identity?.(req))
      wss.handleUpgrade(req, socket, head, (ws) => attach(manager, id, ws, { device }))
    })().catch(() => socket.destroy())
  }

  return {
    handleUpgrade,
    attach,

    heartbeat(): void {
      for (const c of clients) {
        if (!c.alive) {
          c.ws.terminate()
          c.cleanup()
          continue
        }
        c.alive = false
        c.ws.ping()
      }
    },

    close(): void {
      for (const c of [...clients]) {
        c.cleanup()
        c.ws.close()
      }
      for (const g of groups.values()) if (g.drainTimer) clearInterval(g.drainTimer)
      groups.clear()
      wss.close()
    },
  }
}
