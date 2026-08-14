import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RivetGateway } from '@rivetos/gateway-client'
import { Select } from '../components/select.js'
import { Button } from '../components/ui/button.js'
import { preview, relativeTime, roleClass, shortTime } from './format.js'

export function BrowseView(props: {
  gateway: RivetGateway
  /** Endpoint identity (datahub baseUrl) — the query-key discriminator. */
  baseUrl: string
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  const [role, setRole] = useState('')
  const [agent, setAgent] = useState('')
  const [window, setWindow] = useState('')
  const [limit, setLimit] = useState(50)

  // Connection gating happens one level up (MemoryHubPage) — see SearchView.
  const res = useQuery({
    queryKey: ['memory-browse', props.baseUrl, role, agent, window, limit],
    queryFn: ({ signal }) =>
      props.gateway.memoryBrowse(
        {
          role: role || undefined,
          agent: agent || undefined,
          window: window || undefined,
          limit,
        },
        signal,
      ),
  })

  return (
    <div className="pane">
      <form
        className="searchbar"
        onSubmit={(e) => {
          e.preventDefault()
          void res.refetch()
        }}
      >
        <Select
          value={role}
          title="role"
          label="Role"
          onChange={setRole}
          options={[
            { value: '', label: 'all roles' },
            { value: 'user', label: 'user' },
            { value: 'assistant', label: 'assistant' },
            { value: 'tool', label: 'tool' },
            { value: 'system', label: 'system' },
          ]}
        />
        <input
          type="text"
          value={agent}
          placeholder="agent (optional)"
          onChange={(e) => setAgent(e.target.value)}
        />
        <Select
          value={window}
          title="window"
          label="Window"
          onChange={setWindow}
          options={[
            { value: '', label: 'any time' },
            { value: 'today', label: 'today' },
            { value: 'yesterday', label: 'yesterday' },
            { value: 'last_7d', label: 'last 7 days' },
            { value: 'last_14d', label: 'last 14 days' },
          ]}
        />
        <Select
          value={String(limit)}
          title="limit"
          label="Limit"
          onChange={(v) => setLimit(Number(v))}
          options={[
            { value: '25', label: '25' },
            { value: '50', label: '50' },
            { value: '100', label: '100' },
          ]}
        />
        <Button type="submit" size="sm" variant="outline">
          Refresh
        </Button>
      </form>

      {res.isLoading && <p className="muted pad">Loading…</p>}
      {res.error && <div className="banner bad">{res.error.message}</div>}
      {res.data && res.data.messages.length === 0 && (
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
