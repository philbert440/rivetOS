import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TermExitFrame, TermHelloFrame } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
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
 * xterm answers with rgb:0d0d/1111/1717 (#0d1117 theme bg) via onData → PTY
 * stdin → visible garbage `]11;rgb:…` in the TUI. Strip queries on write and
 * drop report replies on onData.
 */
export function XtermAttach(props: { ptyId: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  // Shared with the socket effect: it silences copy-on-select around
  // term.reset() (reset can fire onSelectionChange) and clears any pending
  // debounce so a pre-rebind selection can't copy mid-rebind.
  const selTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selSuppressRef = useRef(false)
  const transportEpoch = useConnection((s) => s.transportEpoch)
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
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#34d399' },
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

  useEffect(() => {
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return

    // disposed guard: StrictMode dev runs mount→cleanup→mount; frames from
    // the first (closing) socket must never write into a disposed terminal.
    let disposed = false
    setStatus('connecting')
    // Reattach (epoch rebind) replays scrollback — clear the buffer so the
    // replay doesn't append a second copy. First attach: no-op. Silence
    // copy-on-select for the reset: it clears the selection, and a leftover
    // non-empty selection must not be copied mid-rebind.
    selSuppressRef.current = true
    if (selTimerRef.current) clearTimeout(selTimerRef.current)
    term.reset()
    selSuppressRef.current = false

    const { gateway } = useConnection.getState()
    const ws = new WebSocket(gateway.terminalWsUrl({ id: props.ptyId }))
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      if (disposed) return
      setStatus('attached')
      // Always re-fit and declare our size on (re)attach — a rebind would
      // otherwise keep whatever PTY size the previous socket negotiated.
      fit.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onclose = () => {
      if (!disposed) setStatus((s) => (s === 'exited' ? s : 'closed'))
    }
    ws.onmessage = (event: MessageEvent) => {
      if (disposed) return
      if (typeof event.data === 'string') {
        const frame = JSON.parse(event.data) as TermHelloFrame | TermExitFrame
        if (frame.type === 'hello') {
          if (frame.cols !== term.cols || frame.rows !== term.rows)
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
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

    const dataSub = term.onData((data) => {
      if (ws.readyState !== 1) return
      // Belt-and-suspenders: if a color report still fires (live query path),
      // do not forward it as PTY input — harnesses treat it as typed text.
      if (isOscColorReport(data)) return
      ws.send(new TextEncoder().encode(data))
    })
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed) return
        fit.fit()
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }, 150)
    })
    resizeObserver.observe(host)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      try {
        dataSub.dispose()
      } catch {
        // terminal may already be disposed when the PTY itself changed
      }
      ws.close()
    }
  }, [props.ptyId, transportEpoch])

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
