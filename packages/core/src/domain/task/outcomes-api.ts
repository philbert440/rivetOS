/**
 * /api/outcomes — the evaluation scoreboard (phase 2g).
 *
 * Read-only aggregates over ros_task_outcomes_v (terminal, evaluable tasks:
 * criteria non-empty, not verifier children, not audit-only inserts). The
 * headline honesty metric is divergenceRate — how often an executor claimed
 * completed and the verifier refuted. RivetHub's outcomes panel (phase 4)
 * reads exactly this endpoint.
 *
 *   GET /api/outcomes?since=2026-07-01&until=2026-07-06&agentId=&origin=
 *
 * Note: duration_ms on evaluated tasks includes verification wall clock —
 * the verifier pass runs before the terminal flip by design.
 */

import type { ServerResponse } from 'node:http'
import type { GatewayRoute } from '@rivetos/types'
import type { OutcomeFilter, OutcomeRow, TaskStore } from './store.js'
import { logger } from '../../logger.js'

const log = logger('OutcomesApi')

export interface OutcomesApiOptions {
  store: TaskStore
}

interface Bucket {
  tasks: number
  completed: number
  failed: number
  verified: number
  refuted: number
  escalated: number
  diverged: number
  divergenceRate: number
  totalCostUsd?: number
  avgDurationMs?: number
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function emptyBucket(): Bucket {
  return {
    tasks: 0,
    completed: 0,
    failed: 0,
    verified: 0,
    refuted: 0,
    escalated: 0,
    diverged: 0,
    divergenceRate: 0,
  }
}

function fold(bucket: Bucket, row: OutcomeRow): void {
  bucket.tasks += 1
  if (row.status === 'completed') bucket.completed += 1
  else bucket.failed += 1
  if (row.evalVerdict === 'verified') bucket.verified += 1
  if (row.evalVerdict === 'refuted') bucket.refuted += 1
  if (row.evalVerdict === 'escalated') bucket.escalated += 1
  if (row.diverged || row.evalVerdict === 'escalated') bucket.diverged += 1
  if (row.costUsd !== undefined) bucket.totalCostUsd = (bucket.totalCostUsd ?? 0) + row.costUsd
  if (row.durationMs !== undefined) {
    const priorTotal = (bucket.avgDurationMs ?? 0) * (bucket.tasks - 1)
    bucket.avgDurationMs = Math.round((priorTotal + row.durationMs) / bucket.tasks)
  }
}

function finalize(bucket: Bucket): Bucket {
  bucket.divergenceRate = bucket.tasks > 0 ? bucket.diverged / bucket.tasks : 0
  if (bucket.totalCostUsd !== undefined) {
    bucket.totalCostUsd = Math.round(bucket.totalCostUsd * 10_000) / 10_000
  }
  return bucket
}

function groupBy(rows: OutcomeRow[], key: (r: OutcomeRow) => string): Record<string, Bucket> {
  const groups: Record<string, Bucket> = {}
  for (const row of rows) {
    const k = key(row)
    groups[k] ??= emptyBucket()
    fold(groups[k], row)
  }
  for (const k of Object.keys(groups)) finalize(groups[k])
  return groups
}

function parseEpoch(value: string | null): number | undefined {
  if (!value) return undefined
  // Accept epoch ms or a date string (2026-07-01).
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function createOutcomesApiRoute(opts: OutcomesApiOptions): GatewayRoute {
  return {
    prefix: '/api/outcomes',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const filter: OutcomeFilter = {
          since: parseEpoch(url.searchParams.get('since')),
          until: parseEpoch(url.searchParams.get('until')),
          agentId: url.searchParams.get('agentId') ?? undefined,
          origin: url.searchParams.get('origin') ?? undefined,
        }
        const rows = await opts.store.listOutcomes(filter)
        const totals = finalize(rows.reduce((b, r) => (fold(b, r), b), emptyBucket()))
        json(res, 200, {
          filter: {
            since: filter.since ? new Date(filter.since).toISOString() : undefined,
            until: filter.until ? new Date(filter.until).toISOString() : undefined,
            agentId: filter.agentId,
            origin: filter.origin,
          },
          totals,
          byAgent: groupBy(rows, (r) => r.agentId),
          byExecutor: groupBy(rows, (r) => r.executorTarget ?? r.executor),
          byDay: groupBy(rows, (r) => r.day),
        })
      } catch (err: unknown) {
        log.error(`/api/outcomes failed: ${err instanceof Error ? err.message : String(err)}`)
        json(res, 500, { error: 'internal error' })
      }
    },
  }
}
