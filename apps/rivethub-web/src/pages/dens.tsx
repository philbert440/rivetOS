/**
 * Den — all open den sessions on this node (the event reducer's live
 * roster), mirroring the Terminal page's shape: session list on the left,
 * the picked session's den viewer embedded on the right. Replaces the old
 * sidebar link-out to /den/.
 */

import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DenSessionInfo } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { harnessAccent } from '../lib/harness-colors.js'

function relTime(ts?: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${String(s)}s ago`
  if (s < 3600) return `${String(Math.round(s / 60))}m ago`
  if (s < 86400) return `${String(Math.round(s / 3600))}h ago`
  return `${String(Math.round(s / 86400))}d ago`
}

export function DensPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const connected = useGatewayReady()
  const [selected, setSelected] = useState<string | undefined>()

  const sessions = useQuery({
    queryKey: ['den-sessions', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.denSessions(signal),
    refetchInterval: 10_000,
    enabled: connected,
  })

  if (!connected) return <NotConnected />
  if (sessions.isError)
    return <div className="p-8 font-mono text-sm text-red">{sessions.error.message}</div>

  const list = sessions.data?.sessions ?? []
  // ?token= rides along for token-gated gateways (den viewer net.ts keeps it
  // across routes); iframes can't carry a bearer header.
  const denUrl = (id: string): string =>
    `${baseUrl.replace(/\/+$/, '')}/den/?session=${encodeURIComponent(id)}` +
    (token ? `&token=${encodeURIComponent(token)}` : '')

  return (
    <div className="flex h-full">
      <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel/40">
        <div className="border-b border-line px-4 py-2 font-mono text-xs text-ink-dim">
          open dens · {list.length}
        </div>
        {list.length === 0 && (
          <div className="px-4 py-6 text-sm text-ink-dim">
            No den sessions on this node yet — they appear as agents emit den events.
          </div>
        )}
        {list.map((s) => (
          <DenRow key={s.id} s={s} active={s.id === selected} onSelect={() => setSelected(s.id)} />
        ))}
      </div>
      {selected ? (
        <iframe
          key={`${baseUrl}|${selected}`}
          src={denUrl(selected)}
          title="den"
          className="h-full min-w-0 flex-1 border-0 bg-panel"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
          Pick a den session on the left.
        </div>
      )}
    </div>
  )
}

function DenRow(props: { s: DenSessionInfo; active: boolean; onSelect: () => void }): JSX.Element {
  const { s } = props
  return (
    <button
      onClick={props.onSelect}
      className={`flex flex-col gap-0.5 border-b border-line/50 px-4 py-2.5 text-left ${
        props.active ? 'bg-panel-2' : 'hover:bg-panel-2/50'
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ backgroundColor: harnessAccent(s.harness) }}
        />
        <span className={`truncate text-sm ${props.active ? 'text-em' : 'text-ink'}`}>
          {s.name}
        </span>
      </span>
      <span className="flex gap-2 pl-4 font-mono text-[11px] text-ink-dim">
        {s.harness && <span>{s.harness}</span>}
        {s.pty && <span className="text-em">●&nbsp;live pty</span>}
        <span>{relTime(s.lastEventTs)}</span>
      </span>
    </button>
  )
}
