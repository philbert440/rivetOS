import { HEALTH_REFRESH_MS, memoryHealthState } from './health.js'
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
    refetchInterval: HEALTH_REFRESH_MS,
    queryKey: ['memory-health', props.baseUrl],
    queryFn: ({ signal }) => props.gateway.memoryHealth(signal),
  })
  const stats = useQuery({
    refetchInterval: HEALTH_REFRESH_MS,
    queryKey: ['memory-stats', props.baseUrl],
    queryFn: ({ signal }) => props.gateway.memoryStats(signal),
  })

  const h = health.data
  const s = stats.data
  const embedOk = h?.embeddings.status === 'ok'
  const healthState = memoryHealthState(h, Boolean(health.error))

  return (
    <div className="pane">
      <header className="pane-head row">
        <p className="muted small">
          {healthState.label}
          {h?.observedAt ? ` · checked ${relativeTime(h.observedAt)}` : ''}
        </p>
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
          hint="Waiting for embedding; pending work alone is not a failure"
        />
      </div>

      {healthState.stale && (
        <div className="banner warn">
          Current health is unverified. Refresh to obtain a new observation.
        </div>
      )}
      {h && (
        <section className="stat-section">
          <h3>Pipeline diagnostics</h3>
          <p className="muted small">
            Capture: {h.capture?.impact ?? 'Capture progress is not measured.'}
          </p>
          <div className="stat-grid">
            <StatCard
              label="Failed embeddings"
              value={h.failedEmbeddings === undefined ? '—' : compactNumber(h.failedEmbeddings)}
              tone={(h.failedEmbeddings ?? 0) > 0 ? 'bad' : undefined}
            />
            <StatCard
              label="Skipped embedding inputs"
              value={h.skippedEmbeddings === undefined ? '—' : compactNumber(h.skippedEmbeddings)}
              hint="Deliberately unembeddable; excluded from pending work"
            />
            <StatCard
              label="Compaction eligible"
              value={h.compaction ? compactNumber(h.compaction.eligible) : '—'}
            />
            <StatCard
              label="Active conversation tails"
              value={h.compaction ? compactNumber(h.compaction.activeTail) : '—'}
              hint="Waiting for conversation inactivity"
            />
            <StatCard
              label="Below compaction floor"
              value={h.compaction ? compactNumber(h.compaction.belowFloor) : '—'}
              hint="Not currently eligible; not a stuck queue"
            />
          </div>
          {h.queueStatus !== 'available' ? (
            <p className="muted small">
              {h.queueStatus === 'restricted'
                ? 'Worker diagnostics are visible to the node owner.'
                : 'Worker queue health is unavailable.'}
            </p>
          ) : (
            <>
              <h3>Worker queues</h3>
              <p className="muted small">
                Embedding, compaction and wiki work share the existing worker queues. Pending age
                shows waiting time; it does not prove a worker is stalled.
              </p>
              {(h.queues ?? []).length === 0 && <p>No queued jobs.</p>}
              <ul className="stat-list">
                {(h.queues ?? []).map((q) => (
                  <li key={q.task}>
                    <span>
                      <strong>{q.task}</strong>
                      <div className="muted small">
                        {q.pending} pending · {q.running} running · {q.scheduled} scheduled
                        {q.oldestPendingMinutes === null
                          ? ''
                          : ` · oldest ${Math.floor(q.oldestPendingMinutes)}m`}
                      </div>
                    </span>
                    {q.dead > 0 && (
                      <span className="tag tag-warn">
                        {q.dead} failed jobs · run rivetos doctor for recovery details
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

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
