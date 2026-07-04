// Per-window terminal drawer: an xterm.js terminal attached to the session's
// den-server PTY (WS /term?session=<id>), dropping down from the titlebar to
// cover exactly the room recess. The DOM element is window CHROME, not room
// scene — it is styled like the frame bezel and pinned to the recess rect via
// the WindowManager's DomAnchor mechanism, so it tracks grid relayout, scale
// and the mobile camera pan.
//
// Sizing: never CSS-transform the terminal — the div is sized in screen px
// by syncDom and a debounced FitAddon.fit() re-derives cols×rows after every
// resize (a ResizeObserver on the drawer element sees each syncDom change).
// Fits that change the geometry emit {"type":"resize",cols,rows} upstream.
//
// Transport (see services/den-server/src/term/ws.ts for the framing):
//   server → hello JSON, scrollback replay (binary), live bytes (binary),
//            {"type":"exit"} then close
//   client → binary keystrokes, JSON resize/kill
// Reattach replays the whole scrollback — the terminal resets on every hello
// so nothing is doubled. Collapse keeps the WS open (scrollback continuity);
// a drop while open reconnects on a 3s backoff until the PTY exits.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { serverWsBase, withToken } from './net.js'
import { MARGIN, TITLEBAR, type RoomInstance } from './room.js'
import type { WindowManager } from './windows.js'

const RECONNECT_MS = 3000
const FIT_DEBOUNCE_MS = 100

export interface Drawer {
  isOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  /** The live xterm instance — exposed for tests/debugging (?debug). */
  term: Terminal
  /** Close the WS, dispose the terminal, remove the DOM + anchor. */
  destroy(): void
}

export interface DrawerOpts {
  /** Owns the DomAnchor registry (and focus, for click-into-terminal). */
  wm: WindowManager
  /** Drawer visibility changed — the owner mirrors it onto the `>_` btn. */
  onOpenChange?: (open: boolean) => void
}

export function createDrawer(room: RoomInstance, sessionId: string, opts: DrawerOpts): Drawer {
  // ---- DOM: bezel-styled chrome pinned to the room recess ----
  const el = document.createElement('div')
  el.className = 'term-drawer'
  const well = document.createElement('div')
  well.className = 'term-drawer-well'
  el.appendChild(well)
  document.body.appendChild(el)
  el.style.display = 'none'
  // clicking into a terminal focuses its window, like any other chrome
  el.addEventListener('pointerdown', () => opts.wm.focus(sessionId))

  // the dark recess the room sits in — same rect the frame chrome draws
  const anchor = {
    el,
    room,
    x: MARGIN - 6,
    y: TITLEBAR + MARGIN - 6,
    w: room.frameW - MARGIN * 2 + 12,
    h: room.frameH - TITLEBAR - MARGIN * 2 + 12,
  }
  let removeAnchor: (() => void) | null = null

  // ---- xterm ----
  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"Courier New", monospace',
    cursorBlink: true,
    theme: {
      background: '#30394a',
      foreground: '#c5d2e0',
      cursor: '#6ee7a8',
      cursorAccent: '#30394a',
      selectionBackground: '#3a4a5e',
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  let termOpened = false

  // ---- transport ----
  const ENC = new TextEncoder()
  let ws: WebSocket | null = null
  let open = false
  let exited = false
  let destroyed = false
  let needReconnect = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const sendResize = (cols: number, rows: number) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }
  term.onResize(({ cols, rows }) => sendResize(cols, rows))
  term.onData((d) => {
    if (!exited && ws?.readyState === WebSocket.OPEN) ws.send(ENC.encode(d))
  })

  const scheduleReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, RECONNECT_MS)
  }

  function connect() {
    if (destroyed || exited) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    let sock: WebSocket
    try {
      sock = new WebSocket(
        withToken(`${serverWsBase}/term?session=${encodeURIComponent(sessionId)}`),
      )
    } catch {
      scheduleReconnect()
      return
    }
    ws = sock
    sock.binaryType = 'arraybuffer'
    sock.onmessage = (mev) => {
      if (typeof mev.data === 'string') {
        let msg: { type?: string; state?: string }
        try {
          msg = JSON.parse(mev.data) as { type?: string; state?: string }
        } catch {
          return
        }
        if (msg.type === 'hello') {
          // reattach replays the whole scrollback — reset first so a
          // reconnect doesn't double what's already on screen
          term.reset()
          // the server-side PTY may still be 80×24 (or sized by another
          // viewer) — assert our geometry as soon as we're attached
          if (termOpened) sendResize(term.cols, term.rows)
        } else if (msg.type === 'exit') {
          exited = true
          term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
        }
      } else {
        term.write(new Uint8Array(mev.data as ArrayBuffer))
      }
    }
    sock.onclose = () => {
      if (ws !== sock) return
      ws = null
      if (destroyed || exited) return
      // reconnect only while the drawer is showing; a collapsed drawer
      // reconnects on the next expand instead of polling in the background
      if (open) scheduleReconnect()
      else needReconnect = true
    }
  }

  // ---- fit: debounced after every syncDom-driven resize of the div ----
  let fitTimer: ReturnType<typeof setTimeout> | undefined
  const refit = () => {
    if (!open || !termOpened || destroyed) return
    // fit() only fires term.onResize (→ resize message) when cols/rows change
    try {
      fit.fit()
    } catch {
      /* zero-size mid-relayout — the next observation refits */
    }
  }
  const ro = new ResizeObserver(() => {
    if (fitTimer) clearTimeout(fitTimer)
    fitTimer = setTimeout(refit, FIT_DEBOUNCE_MS)
  })
  ro.observe(el)

  function setOpen(want: boolean) {
    if (destroyed || want === open) return
    open = want
    if (want) {
      el.style.display = ''
      removeAnchor = opts.wm.addAnchor(anchor) // syncs the rect immediately
      if (!termOpened) {
        termOpened = true
        term.open(well)
      }
      refit()
      if (!ws && (needReconnect || !exited)) {
        needReconnect = false
        connect()
      }
      term.focus()
    } else {
      // collapse hides the chrome but keeps the WS + buffer alive — the
      // anchor is unregistered because syncDom would force display back on
      removeAnchor?.()
      removeAnchor = null
      el.style.display = 'none'
    }
    opts.onOpenChange?.(open)
  }

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    term,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (fitTimer) clearTimeout(fitTimer)
      ro.disconnect()
      const sock = ws
      ws = null
      try {
        sock?.close()
      } catch {
        /* already closing */
      }
      term.dispose()
      removeAnchor?.()
      removeAnchor = null
      el.remove()
    },
  }
}
