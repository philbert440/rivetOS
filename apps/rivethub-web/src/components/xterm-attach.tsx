import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TermExitFrame, TermHelloFrame } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { useResolvedTheme } from '../stores/theme.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { isOscColorReport, stripOscColorQueries } from '../lib/osc-filter.js'
import { copyTextToClipboard, readTextFromClipboard } from '../lib/clipboard.js'
import { openExternal } from '../lib/open-external.js'

/**
 * Attach an xterm to a PTY over WS /api/terminal/ws. Framing per den-server
 * term/ws.ts: hello JSON, scrollback replay, live bytes, exit frame. Detach
 * on unmount — never kill; the manager's TTL owns the PTY (reattach replays).
 *
 * Two effects: the terminal instance lives per PTY; the socket lives per
 * PTY × transportEpoch, so enrolling mid-run (identity pipe appears, epoch
 * bumps) reattaches this pane onto the new transport instead of stranding it
 * on a dead socket. Reattach resets the terminal first — the server replays
 * scrollback, and appending a replay to the existing buffer doubles it.
 *
 * Color-query filtering (osc-filter.ts): harnesses emit OSC 11? on startup;
 * xterm answers with rgb:… (the live theme bg) via onData → PTY
 * stdin → visible garbage `]11;rgb:…` in the TUI. Strip queries on write and
 * drop report replies on onData.
 */
/** Terminal colors track theme.css tokens exactly (light and dark). */
function xtermTheme(): { background: string; foreground: string; cursor: string } {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  return { background: v('--color-bg'), foreground: v('--color-ink'), cursor: v('--color-em') }
}
export function XtermAttach(props: {
  ptyId: string
  /** Node the PTY lives on when it is not the globally connected one —
   *  cross-node sessions attach over that node's own (pipe-routed) gateway. */
  base?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  // Shared with the socket effect: it silences copy-on-select around
  // term.reset() (reset can fire onSelectionChange) and clears any pending
  // debounce so a pre-rebind selection can't copy mid-rebind.
  const selTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selSuppressRef = useRef(false)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const resolvedTheme = useResolvedTheme()
  const [status, setStatus] = useState<'connecting' | 'attached' | 'exited' | 'closed'>(
    'connecting',
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      // Harness output is chatty — the 1000-line default loses the top of a
      // single long tool run. 5k lines is still trivial memory-wise.
      scrollback: 5000,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Clickable URLs in TUI output (PR links, dashboards) — openExternal
    // routes through shell IPC where window.open is denied, and plain
    // window.open in browsers.
    term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)))

    // Terminal-convention clipboard: select-to-copy (debounced — xterm keeps
    // its own selection model, so the browser's copy gestures and the shell's
    // context-menu Copy can't see terminal selections at all), Ctrl+Shift+C
    // copies explicitly, Ctrl+Shift+V pastes (lib/clipboard.ts chain).
    // Plain Ctrl+C stays SIGINT and plain Ctrl+V stays a native paste event
    // into xterm's hidden textarea — neither is intercepted here.
    let alive = true
    const selSub = term.onSelectionChange(() => {
      if (selSuppressRef.current) return
      if (selTimerRef.current) clearTimeout(selTimerRef.current)
      selTimerRef.current = setTimeout(() => {
        if (!alive) return
        const sel = term.getSelection()
        if (sel) void copyTextToClipboard(sel).catch(() => undefined)
      }, 150)
    })
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true
      if (e.code === 'KeyC') {
        const sel = term.getSelection()
        if (!sel) return true // nothing selected — let the browser have it
        void copyTextToClipboard(sel).catch(() => undefined)
        e.preventDefault()
        return false
      }
      if (e.code === 'KeyV') {
        void readTextFromClipboard().then((text) => {
          if (text) term.paste(text)
        })
        e.preventDefault()
        return false
      }
      return true
    })

    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    return () => {
      alive = false
      if (selTimerRef.current) clearTimeout(selTimerRef.current)
      selSub.dispose()
      termRef.current = undefined
      fitRef.current = undefined
      term.dispose()
    }
  }, [props.ptyId])

  // Retheme the live terminal on theme flips (Settings toggle / OS change);
  // creation above reads the same tokens for the initial paint.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermTheme()
  }, [resolvedTheme])

  useEffect(() => {
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return

    setStatus('connecting')
    // Reattach (epoch rebind) replays scrollback — clear the buffer so the
    // replay doesn't append a second copy. First attach: no-op. Silence
    // copy-on-select for the reset: it clears the selection, and a leftover
    // non-empty selection must not be copied mid-rebind.
    selSuppressRef.current = true
    if (selTimerRef.current) clearTimeout(selTimerRef.current)
    term.reset()
    selSuppressRef.current = false

    // disposed guard: StrictMode dev runs mount→cleanup→mount; frames from
    // the first (closing) socket must never write into a disposed terminal.
    // Cross-node PTYs dial their own node's gateway; resolving the pipe base
    // is async, so the socket setup runs behind it with the same guard
    // covering the gap, and the teardown closes whatever the async body
    // managed to create before unmount.
    // holder, not a bare let: the async body reads it AFTER awaits, and TS
    // narrows a closed-over let to its initializer across those boundaries.
    const life = { disposed: false }
    // Filled once the async dial lands. Input/resize subscribe SYNCHRONOUSLY
    // against this ref — the home path used to subscribe before any await,
    // and a remote dial must not open a keystroke-dropping window beyond the
    // pre-open drop both paths always had (readyState !== 1 → ignored).
    const sockRef: { current: WebSocket | undefined } = { current: undefined }
    let resizeTimer: ReturnType<typeof setTimeout> | undefined

    const dataSub = term.onData((data) => {
      const sock = sockRef.current
      if (!sock || sock.readyState !== 1) return
      // Belt-and-suspenders: if a color report still fires (live query path),
      // do not forward it as PTY input — harnesses treat it as typed text.
      if (isOscColorReport(data)) return
      sock.send(new TextEncoder().encode(data))
    })
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (life.disposed) return
        fit.fit()
        const sock = sockRef.current
        if (sock && sock.readyState === 1)
          sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }, 150)
    })
    resizeObserver.observe(host)

    void (async () => {
      let gateway
      try {
        gateway = props.base ? await gatewayFor(props.base) : useConnection.getState().gateway
      } catch {
        if (!life.disposed) setStatus('closed')
        return
      }
      if (life.disposed) return
      const sock = new WebSocket(gateway.terminalWsUrl({ id: props.ptyId }))
      sockRef.current = sock
      sock.binaryType = 'arraybuffer'

      sock.onopen = () => {
        if (life.disposed) return
        setStatus('attached')
        // Always re-fit and declare our size on (re)attach — a rebind would
        // otherwise keep whatever PTY size the previous socket negotiated.
        fit.fit()
        sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      sock.onclose = () => {
        if (!life.disposed) setStatus((s) => (s === 'exited' ? s : 'closed'))
      }
      sock.onmessage = (event: MessageEvent) => {
        if (life.disposed) return
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data) as TermHelloFrame | TermExitFrame
          if (frame.type === 'hello') {
            if (frame.cols !== term.cols || frame.rows !== term.rows)
              sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
            if (frame.state === 'exited') setStatus('exited')
          } else {
            setStatus('exited')
            term.write(`\r\n\x1b[2m[process exited ${String(frame.code)}]\x1b[0m\r\n`)
          }
          return
        }
        // Drop color queries so attach/scrollback replay doesn't generate
        // OSC rgb: replies that leak into the harness as fake keystrokes.
        term.write(stripOscColorQueries(new Uint8Array(event.data as ArrayBuffer)))
      }
    })()

    return () => {
      life.disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      try {
        dataSub.dispose()
      } catch {
        // terminal may already be disposed when the PTY itself changed
      }
      sockRef.current?.close()
    }
    // transportEpoch on the remote path too: the epoch tracks the shell's
    // mTLS pipe lifecycle, and gatewayFor(base) resolves THROUGH that pipe —
    // when it dies/reappears, remote sockets are as stranded as home ones.
    // A home-only reconnect costs a remote pane one reset+replay; a missed
    // pipe swap costs it the session. Rebind.
  }, [props.ptyId, transportEpoch, props.base])

  return (
    <div className="relative min-h-0 flex-1 p-2">
      <div ref={hostRef} className="h-full w-full" />
      {status !== 'attached' && (
        <div className="absolute right-4 top-3 rounded bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink-dim">
          {status}
        </div>
      )}
    </div>
  )
}
