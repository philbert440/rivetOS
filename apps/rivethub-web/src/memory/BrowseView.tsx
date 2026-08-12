import { useState, type JSX } from 'react'
import type { MemoryBrowseResponse } from '@rivetos/types'
import type { RivetGateway } from '@rivetos/gateway-client'
import { preview, relativeTime, roleClass, shortTime } from './format.js'
import { useAsync } from './use-async.js'

export function BrowseView(props: {
  gateway: RivetGateway
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  const [role, setRole] = useState('')
  const [agent, setAgent] = useState('')
  const [window, setWindow] = useState('')
  const [limit, setLimit] = useState(50)

  const res = useAsync<MemoryBrowseResponse>(
    () =>
      props.gateway.memoryBrowse({
        role: role || undefined,
        agent: agent || undefined,
        window: window || undefined,
        limit,
      }),
    [role, agent, window, limit, props.gateway],
  )

  return (
    <div className="pane">
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault()
          res.reload()
        }}
      >
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="role">
          <option value="">all roles</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
          <option value="tool">tool</option>
          <option value="system">system</option>
        </select>
        <input
          type="text"
          value={agent}
          placeholder="agent (optional)"
          onChange={(e) => setAgent(e.target.value)}
        />
        <select value={window} onChange={(e) => setWindow(e.target.value)} aria-label="window">
          <option value="">any time</option>
          <option value="today">today</option>
          <option value="yesterday">yesterday</option>
          <option value="last_7d">last 7 days</option>
          <option value="last_14d">last 14 days</option>
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="limit"
        >
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
        <button type="submit">Refresh</button>
      </form>

      {res.loading && <p className="muted pad">Loading…</p>}
      {res.error && <div className="banner bad">{res.error.message}</div>}
      {res.data && res.data.messages.length === 0 && !res.loading && (
        <div className="empty">
          <strong>No messages match these filters</strong>
          Widen the window or drop the role / agent filter.
        </div>
      )}

      <ul className="hits">
        {res.data?.messages.map((m) => (
          <li key={m.id} className="hit">
            <div className="hit-head">
              <span className={`tag ${roleClass(m.role)}`}>{m.role}</span>
              {m.agent && <span className="muted small">{m.agent}</span>}
              {m.toolName && <span className="tag tag-tool">{m.toolName}</span>}
              <span className="muted small" title={m.createdAt}>
                {relativeTime(m.createdAt)} · {shortTime(m.createdAt)}
              </span>
              <span className="grow" />
              {m.sessionId && props.onOpenSession && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => props.onOpenSession!(m.sessionId!)}
                >
                  open session
                </button>
              )}
            </div>
            <div className="hit-body">{preview(m.content, 360)}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
