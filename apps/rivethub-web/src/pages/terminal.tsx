/**
 * Terminal (4f) — xterm.js over den's PTY surface via the /api/terminal
 * aliases. Framing (den-server term/ws.ts): one JSON hello, one binary
 * scrollback replay, live binary output, JSON exit frame; client sends raw
 * binary keystrokes + {resize}/{kill} control frames. Reattach-safe: a
 * closed tab detaches, the manager's TTL owns the PTY.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PtyInfo, TermExitFrame, TermHelloFrame } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'

export function TerminalPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const endpointKey = `${baseUrl}|${token ?? ''}`
  const [attached, setAttached] = useState<string | undefined>()
  const [spawnError, setSpawnError] = useState<string | undefined>()

  const config = useQuery({
    queryKey: ['term-config', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.termConfig(signal),
  })
  const list = useQuery({
    queryKey: ['term-list', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.termList(signal),
    refetchInterval: 10_000,
  })

  const spawn = async (command?: string): Promise<void> => {
    setSpawnError(undefined)
    try {
      const pty = await useConnection.getState().gateway.termSpawn(command ? { command } : {})
      await list.refetch()
      setAttached(pty.id)
    } catch (err) {
      setSpawnError((err as Error).message)
    }
  }

  if (config.isError)
    return <div className="p-8 font-mono text-sm text-red">{config.error.message}</div>
  if (config.data && !config.data.enabled)
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-dim">
        Terminal is disabled on this node (den.terminal.enabled).
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-4 py-2">
        {(config.data?.commands ?? []).map((c) => (
          <button
            key={c.id}
            onClick={() => void spawn(c.id)}
            className="rounded border border-line px-3 py-1.5 font-mono text-xs text-ink-dim hover:border-em hover:text-em"
          >
            + {c.label}
          </button>
        ))}
        <div className="mx-2 h-4 w-px bg-line" />
        {(list.data?.ptys ?? []).map((p) => (
          <PtyTab
            key={p.id}
            pty={p}
            active={p.id === attached}
            onSelect={() => setAttached(p.id)}
            onKill={() => {
              void useConnection
                .getState()
                .gateway.termKill(p.id)
                .then(() => list.refetch())
            }}
          />
        ))}
        {spawnError && <span className="font-mono text-xs text-red">✗ {spawnError}</span>}
      </div>

      {attached ? (
        <XtermAttach key={`${endpointKey}|${attached}`} ptyId={attached} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
          Spawn or pick a terminal above.
        </div>
      )}
    </div>
  )
}

function PtyTab(props: {
  pty: PtyInfo
  active: boolean
  onSelect: () => void
  onKill: () => void
}): JSX.Element {
  return (
    <span
      className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-xs ${
        props.active ? 'bg-panel-2 text-em' : 'text-ink-dim hover:bg-panel-2'
      }`}
    >
      <button onClick={props.onSelect}>
        {props.pty.command} {props.pty.state === 'exited' ? '(exited)' : ''}
      </button>
      <button onClick={props.onKill} className="text-ink-dim hover:text-red" aria-label="kill">
        ✕
      </button>
    </span>
  )
}

function XtermAttach(props: { ptyId: string }): JSX.Element {
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
    // the first (closing) socket must never write into a disposed terminal
    // (#302 review).
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
          // client geometry wins: the PTY spawned with server defaults;
          // push our fitted size (skip when it already matches).
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
    // Debounced: a drag-resize fires the observer per frame; the PTY only
    // needs the settled geometry (#302 review).
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
      // detach, never kill — the manager's TTL owns the PTY's fate
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
