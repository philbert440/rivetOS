/**
 * Terminal (4f) — xterm.js over den's PTY surface via the /api/terminal
 * aliases. Framing (den-server term/ws.ts): one JSON hello, one binary
 * scrollback replay, live binary output, JSON exit frame; client sends raw
 * binary keystrokes + {resize}/{kill} control frames. Reattach-safe: a
 * closed tab detaches, the manager's TTL owns the PTY.
 */

import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PtyInfo } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { XtermAttach } from '../components/xterm-attach.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'

export function TerminalPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const endpointKey = `${baseUrl}|${token ?? ''}`
  const [attached, setAttached] = useState<string | undefined>()
  const [spawnError, setSpawnError] = useState<string | undefined>()
  const connected = useGatewayReady()

  const config = useQuery({
    queryKey: ['term-config', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.termConfig(signal),
    enabled: connected,
  })
  const list = useQuery({
    queryKey: ['term-list', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.termList(signal),
    refetchInterval: 10_000,
    enabled: connected,
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

  if (!connected) return <NotConnected />
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
        <PtyList ptys={list.data?.ptys ?? []} onSelect={setAttached} />
      )}
    </div>
  )
}

/** Landing view: every open terminal session on the node, click to attach.
 *  (The tab bar above stays the quick switcher once one is attached.) */
function PtyList(props: { ptys: PtyInfo[]; onSelect: (id: string) => void }): JSX.Element {
  if (props.ptys.length === 0)
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
        No open terminals on this node — spawn one above.
      </div>
    )
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-2 font-mono text-xs text-ink-dim">
        open terminals · {props.ptys.length}
      </div>
      <div className="flex max-w-2xl flex-col gap-1.5">
        {props.ptys.map((p) => (
          <button
            key={p.id}
            onClick={() => props.onSelect(p.id)}
            className="flex items-baseline gap-3 rounded border border-line bg-panel/40 px-3 py-2 text-left hover:border-em"
          >
            <span
              className={`font-mono text-sm ${p.state === 'running' ? 'text-em' : 'text-ink-dim line-through'}`}
            >
              {p.command}
            </span>
            <span className="truncate font-mono text-[11px] text-ink-dim">{p.denSession}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-dim">
              {p.state === 'exited'
                ? `exited${p.exitCode != null ? ` (${String(p.exitCode)})` : ''}`
                : `${String(p.attached)} attached`}
            </span>
          </button>
        ))}
      </div>
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
