/**
 * 4c scaffold version: proves the gateway wiring end to end by listing live
 * sessions. The full chat surface (transcript, compose, WS stream) is 4d.
 */

import type { JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConnection } from '../stores/connection.js'

export function ChatPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)

  const sessions = useQuery({
    // Token in the key: a credential change on the same origin must not
    // serve the prior credential's cache. getState() in the fn: the query
    // always runs against the LIVE gateway, never a stale closure
    // (#297 review).
    queryKey: ['sessions', baseUrl, token ?? ''],
    queryFn: ({ signal }) => useConnection.getState().gateway.listSessions(signal),
  })

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-4 font-mono text-lg font-semibold text-em">Sessions</h1>

      {sessions.isLoading && <div className="text-sm text-ink-dim">connecting…</div>}
      {sessions.isError && (
        <div className="rounded border border-red/40 bg-panel px-4 py-3 text-sm text-red">
          {sessions.error.message} — check Settings → gateway URL/token.
        </div>
      )}

      {sessions.data && sessions.data.sessions.length === 0 && (
        <div className="text-sm text-ink-dim">
          No sessions yet on this node. The chat composer lands in 4d.
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {sessions.data?.sessions.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between rounded border border-line bg-panel px-4 py-3"
          >
            <span className="font-mono text-sm">{s.id}</span>
            <span className="text-xs text-ink-dim">
              {s.messages} msgs · {new Date(s.lastActive).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
