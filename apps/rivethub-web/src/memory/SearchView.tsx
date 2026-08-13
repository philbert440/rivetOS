import { useState, type JSX } from 'react'
import type { MemorySearchResponse } from '@rivetos/types'
import type { RivetGateway } from '@rivetos/gateway-client'
import { preview, relativeTime } from './format.js'
import { useAsync } from './use-async.js'

export function SearchView(props: {
  gateway: RivetGateway
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'both' | 'messages' | 'summaries'>('both')
  const [verbose, setVerbose] = useState(false)

  const res = useAsync<MemorySearchResponse | undefined>(
    () =>
      query
        ? props.gateway.memorySearch({ q: query, scope, limit: 20 })
        : Promise.resolve(undefined),
    [query, scope, props.gateway],
  )

  return (
    <div className="pane">
      <form
        className="searchbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(input.trim())
        }}
      >
        <input
          type="search"
          value={input}
          placeholder="Search messages and summaries…"
          onChange={(e) => setInput(e.target.value)}
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
          aria-label="scope"
        >
          <option value="both">everything</option>
          <option value="messages">messages</option>
          <option value="summaries">summaries</option>
        </select>
        <label className="small check">
          <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
          scores
        </label>
        <button type="submit">Search</button>
      </form>

      {!query && (
        <div className="empty">
          <strong>Search your history</strong>
          Messages and summaries on datahub. Open a hit to jump into that session.
        </div>
      )}
      {res.loading && query && <p className="muted pad">Searching…</p>}
      {res.error && (
        <div className="banner bad">
          {/401|unauthorized/i.test(res.error.message)
            ? 'Datahub refused the request (401). In the desktop app this should ride the mTLS pipe — quit RivetHub from the tray and relaunch. In a browser, import the device certificate; “proceed” on the padlock warning is not a client cert.'
            : /unreachable|fetch|empty/i.test(res.error.message)
              ? 'Cannot reach datahub. Dens are HTTPS-only — a stored http:// datahub URL will fail. Set Settings → Memory wiki to https://<datahub-host>:5174.'
              : res.error.message}
        </div>
      )}

      {res.data?.degraded && (
        <div className="banner warn">
          <strong>Keyword match only.</strong> Meaning-based ranking is offline, so results match
          the words you typed — not “similar ideas.”
          {res.data.degraded.reason && (
            <div className="mono small">{res.data.degraded.reason}</div>
          )}
        </div>
      )}

      {res.data && res.data.results.length === 0 && (
        <div className="empty">
          <strong>No matches for “{res.data.query}”</strong>
          Try a shorter phrase, switch scope, or Browse newest messages instead.
        </div>
      )}

      <ul className="hits">
        {res.data?.results.map((h) => {
          const openable = Boolean(h.sessionId && props.onOpenSession)
          return (
            <li key={`${h.source}-${h.id}`} className={`hit ${openable ? 'hit-click' : ''}`}>
              <button
                type="button"
                className="hit-btn"
                disabled={!openable}
                onClick={() => {
                  if (h.sessionId && props.onOpenSession) props.onOpenSession(h.sessionId)
                }}
              >
                <div className="hit-head">
                  <span className={`tag ${h.source === 'summary' ? 'tag-sum' : 'tag-msg'}`}>
                    {h.source === 'summary' ? (h.kind ?? 'summary') : (h.role ?? 'message')}
                  </span>
                  {h.agent && <span className="muted small">{h.agent}</span>}
                  <span className="muted small">{relativeTime(h.createdAt)}</span>
                  <span className="grow" />
                  {verbose && <span className="mono small muted">{h.score.toFixed(4)}</span>}
                  {openable && <span className="open-hint small">open →</span>}
                </div>
                <div className="hit-body">{preview(h.content, 320)}</div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
