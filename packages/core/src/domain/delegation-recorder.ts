/**
 * Delegation runs recorder — optional Postgres observability for DelegationEngine.
 *
 * Inserts one row per delegation invocation into ros_delegation_runs. Best-effort:
 * recording failures are logged and swallowed; they never fail the delegation.
 *
 * The in-memory result cache in DelegationEngine is unchanged — delegation
 * remains a synchronous tool call from the agent's perspective, with a 5-min
 * cache. This recorder gives us an audit log across restarts so we can answer
 * "what did agent X delegate, when, to whom, how long" without keeping state
 * in process memory.
 */

import type pg from 'pg'
import type { DelegationRequest, DelegationResult } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('DelegationRecorder')

export interface DelegationRunsRecorder {
  record(
    request: DelegationRequest,
    result: DelegationResult,
    opts: { chainDepth: number; cached: boolean; startedAt: number },
  ): Promise<void>
}

/** No-op recorder for tests / pgUrl-less dev. */
export const noopDelegationRecorder: DelegationRunsRecorder = {
  record(): Promise<void> {
    return Promise.resolve()
  },
}

export function createPgDelegationRecorder(pool: pg.Pool): DelegationRunsRecorder {
  return {
    async record(request, result, opts): Promise<void> {
      try {
        const status = opts.cached
          ? 'cached'
          : result.status === 'completed'
            ? 'completed'
            : result.status === 'timeout'
              ? 'timeout'
              : 'failed'

        await pool.query(
          `INSERT INTO ros_delegation_runs
             (from_agent, to_agent, task, model, chain_depth, status, response,
              iterations, prompt_tokens, completion_tokens, tools_used,
              duration_ms, cached, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8, $9, $10, $11::jsonb,
                   $12, $13, to_timestamp($14 / 1000.0), now())`,
          [
            request.fromAgent,
            request.toAgent,
            request.task,
            request.model ?? null,
            opts.chainDepth,
            status,
            result.response,
            result.iterations ?? null,
            result.usage?.promptTokens ?? null,
            result.usage?.completionTokens ?? null,
            result.toolsUsed ? JSON.stringify(result.toolsUsed) : null,
            result.durationMs ?? null,
            opts.cached,
            opts.startedAt,
          ],
        )
      } catch (err: unknown) {
        log.warn(`Failed to record delegation run: ${(err as Error).message}`)
      }
    },
  }
}
