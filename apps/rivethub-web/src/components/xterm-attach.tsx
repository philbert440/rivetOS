import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TermExitFrame, TermHelloFrame } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'

/**
 * Attach an xterm to a PTY over WS /api/terminal/ws. Framing per den-server
 * term/ws.ts: hello JSON, scrollback replay, live bytes, exit frame. Detach
 * on unmount — never kill; the manager's TTL owns the PTY (reattach replays).
 */
export function XtermAttach(props: { ptyId: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'connecting' | 'attached' | 'exited' | 'closed'>(
    'connecting',
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#34d399' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    // disposed guard: StrictMode dev runs mount→cleanup→mount; frames from
    // the first (closing) socket must never write into a disposed terminal.
    let disposed = false
    const { gateway } = useConnection.getState()
    const ws = new WebSocket(gateway.terminalWsUrl({ id: props.ptyId }))
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      if (!disposed) setStatus('attached')
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
      term.write(new Uint8Array(event.data as ArrayBuffer))
    }

    const dataSub = term.onData((data) => {
      if (ws.readyState === 1) ws.send(new TextEncoder().encode(data))
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
      dataSub.dispose()
      ws.close()
      term.dispose()
    }
  }, [props.ptyId])

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
