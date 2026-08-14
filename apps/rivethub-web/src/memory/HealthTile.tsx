import type { JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RivetGateway } from '@rivetos/gateway-client'
import { compactNumber } from './format.js'

export function HealthTile(props: {
  gateway: RivetGateway
  /** Datahub identity (endpoint.baseUrl) — the query key, same as
   *  Search/Browse/Stats. NOT gateway.config.baseUrl: on desktop that is the
   *  mTLS loopback pipe, a transport detail that would split the cache (and
   *  collide two wiki identities sharing one pipe). */
  baseUrl: string
  compact?: boolean
}): JSX.Element {
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
  const tone = health.error ? 'bad' : embedOk ? 'good' : 'warn'

  if (props.compact) {
    return (
      <div className="health compact">
        <div className="health-row">
          <span className={`dot ${tone}`} />
          <span className="muted small">
            {health.error ? 'offline' : s ? `${compactNumber(s.conversations)} sess` : '…'}
          </span>
          {!health.error && h && !embedOk && (
            <span className="tag tag-warn small" title="Meaning-based ranking is offline">
              keywords only
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="health">
      <div className="health-row">
        <span className={`dot ${tone}`} />
        <strong>Memory</strong>
        {health.error ? (
          <span className="muted">unreachable</span>
        ) : s ? (
          <span className="muted">
            {compactNumber(s.conversations)} sessions · {compactNumber(s.messages)} messages
          </span>
        ) : (
          <span className="muted">checking…</span>
        )}
      </div>
    </div>
  )
}
