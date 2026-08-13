import type { JSX } from 'react'
import type { MemoryHealthResponse, MemoryStatsResponse } from '@rivetos/types'
import type { RivetGateway } from '@rivetos/gateway-client'
import { compactNumber } from './format.js'
import { useAsync } from './use-async.js'

export function HealthTile(props: { gateway: RivetGateway; compact?: boolean }): JSX.Element {
  const health = useAsync<MemoryHealthResponse>(() => props.gateway.memoryHealth(), [
    props.gateway,
  ])
  const stats = useAsync<MemoryStatsResponse>(() => props.gateway.memoryStats(), [props.gateway])

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
