// WS /term — the terminal attach protocol.
//
// Server → client framing:
//   1. one JSON text frame   {type:'hello', v:1, id, denSession, command,
//      cols, rows, state:'running'|'exited', exitCode?}
//   2. one binary frame      scrollback replay (possibly empty)
//   3. live PTY output       binary frames
//   4. on child exit         {type:'exit', code, signal?} then close(1000)
//      after a short grace so trailing output frames flush first
// Late attach to an exited-but-lingering record replays the whole story:
// hello(state:'exited') + scrollback + exit frame + close.
//
// Client → server framing:
//   binary frames            raw keystrokes → pty write (every attached
//                            client may type — this is a single-operator
//                            system, not a collaboration protocol)
//   {type:'resize',cols,rows}  clamped to 20-500 / 5-200 (same as POST /term)
//   {type:'kill'}            same semantics as DELETE /term
//   anything else            ignored (forward compatibility)
//
// Reattach: a closed browser tab detaches but never kills — the manager's
// detached TTL owns the PTY's fate, and reattaching cancels the reaper and
// replays scrollback byte-exactly.
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
}

export interface TermWs {
  /** Complete (or destroy) a WS upgrade for /term?id=|?session=. The caller
   *  (server.ts) has already authorized the request pre-handshake. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void
  /** Wire a handshaken socket to a PTY — the protocol core, exposed so tests
   *  can drive it with a scripted socket. */
  attach(manager: TermManager, ptyId: string, ws: TermSocket): void
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
}

/** All clients attached to one PTY — the unit pause/resume reasons about. */
interface PtyGroup {
  clients: Set<TermClient>
  paused: boolean
  drainTimer?: NodeJS.Timeout
}

export function createTermWs(deps: TermWsDeps): TermWs {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<TermClient>()
  const groups = new Map<string, PtyGroup>()

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
    group.drainTimer.unref?.()
  }

  const attach = (manager: TermManager, ptyId: string, ws: TermSocket): void => {
    // the record can be reaped between the upgrade check and the handshake
    // completing — close post-handshake instead of destroying mid-frame
    const info = manager.get(ptyId)
    if (!info) {
      ws.close(1011)
      return
    }

    let group = groups.get(ptyId)
    if (!group) {
      group = { clients: new Set(), paused: false }
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
        // child itself) must keep flowing while detached
        resume(manager, ptyId, g)
        groups.delete(ptyId)
      }
    }
    const client: TermClient = { ws, alive: true, cleanup }
    clients.add(client)
    g.clients.add(client)

    const sendJson = (obj: Record<string, unknown>): void => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj))
    }
    const closeSoon = (): void => {
      if (graceTimer || done) return
      graceTimer = setTimeout(() => ws.close(1000), EXIT_GRACE_MS)
      graceTimer.unref?.()
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
        manager.resize(ptyId, clamp(m.cols, 20, 500), clamp(m.rows, 5, 200))
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
    sendJson(hello)
    ws.send(manager.scrollback(ptyId) ?? Buffer.alloc(0), { binary: true })

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
      const session = url.searchParams.get('session')
      const id =
        url.searchParams.get('id') ?? (session ? manager.ptyForSession(session) : undefined)
      if (!id || !manager.get(id)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(manager, id, ws))
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
