import type { JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RivetGateway } from '@rivetos/gateway-client'
import { compactNumber, relativeTime } from './format.js'

export function StatsView(props: {
  gateway: RivetGateway
  /** Endpoint identity (datahub baseUrl) — the query-key discriminator. */
  baseUrl: string
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  // Connection gating happens one level up (MemoryHubPage) — see SearchView.
  const health = useQuery({
    queryKey: ['memory-health', props.baseUrl],
    queryFn: ({ signal }) => props.gateway.memoryHealth(signal),
  })
  const stats = useQuery({
    queryKey: ['memory-stats', props.baseUrl],
    queryFn: ({ signal }) => props.gateway.memoryStats(signal),
  })

  const h = health.data
  const s = stats.data
  const embedOk = h?.embeddings.status === 'ok'

  return (
    <div className="pane">
      <header className="pane-head row">
        <p className="muted small">Capture volume, embedding queue, top tools.</p>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void health.refetch()
            void stats.refetch()
          }}
        >
          refresh
        </button>
      </header>

      {health.error && <div className="banner bad">{health.error.message}</div>}
      {stats.error && <div className="banner bad">{stats.error.message}</div>}
      {s && s.conversations === 0 && (
        <div className="empty">
          <strong>No captured sessions yet</strong>
          Talk in Conversations and they show up here.
        </div>
      )}

      <div className="stat-grid">
        <StatCard label="Sessions" value={s ? compactNumber(s.conversations) : '—'} />
        <StatCard label="Messages" value={s ? compactNumber(s.messages) : '—'} />
        <StatCard label="Tool calls" value={s ? compactNumber(s.toolCalls) : '—'} />
        <StatCard label="Summaries" value={s ? compactNumber(s.summaries) : '—'} />
        <StatCard
          label="Embedded"
          value={s ? compactNumber(s.embeddedMessages) : '—'}
          hint={embedOk ? 'vector leg ok' : 'vector degraded'}
          tone={embedOk ? 'good' : 'warn'}
        />
        <StatCard
          label="Embed queue"
          value={s ? compactNumber(s.embedQueueDepth) : '—'}
          tone={s && s.embedQueueDepth > 0 ? 'warn' : undefined}
        />
      </div>

      {h && !embedOk && (
        <div className="banner warn">
          <strong>Semantic search unavailable.</strong>{' '}
          {h.embeddings.impact ?? 'Keyword matching still works; meaning-based ranking is offline.'}
        </div>
      )}

      {s && s.topTools.length > 0 && (
        <section className="stat-section">
          <h3>Top tools</h3>
          <ul className="stat-list">
            {s.topTools.map((t) => (
              <li key={t.tool}>
                <span className="mono">{t.tool}</span>
                <span className="muted">{compactNumber(t.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {s && s.recentSessions.length > 0 && (
        <section className="stat-section">
          <h3>Recent sessions</h3>
          <ul className="stat-list">
            {s.recentSessions.map((r) => (
              <li key={r.sessionId}>
                <span>
                  <strong>{r.title || r.agent}</strong>
                  <div className="muted small">
                    {compactNumber(r.messages)} msgs · last {relativeTime(r.lastActive)}
                  </div>
                </span>
                {props.onOpenSession ? (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => props.onOpenSession!(r.sessionId)}
                  >
                    open
                  </button>
                ) : (
                  <span className="mono small muted">{r.sessionId.slice(0, 8)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function StatCard(props: {
  label: string
  value: string
  hint?: string
  tone?: 'good' | 'warn' | 'bad'
}): JSX.Element {
  return (
    <div className={`stat-card ${props.tone ?? ''}`}>
      <div className="stat-value">{props.value}</div>
      <div className="stat-label">{props.label}</div>
      {props.hint && <div className="muted small">{props.hint}</div>}
    </div>
  )
}
