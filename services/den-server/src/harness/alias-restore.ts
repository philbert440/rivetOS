/**
 * Post-restart alias reconstructor — the reader for the rotation breadcrumbs
 * hermes capture writes (docs/plans/harness-control-plane.md
 * § Rotation migration story).
 *
 * The problem it closes, plainly: the registry's alias store is in-memory and
 * per-node, so it dies with den-server. Every rotation the node observed while
 * it was up is forgotten on restart — a superseded id stops resolving to
 * canonical, a `subscribe` under the old id no longer follows the chain, and a
 * chain-union read no longer unions. The link was never lost from the DATA:
 * `on_session_switch` writes one durable `role=system` breadcrumb under the
 * SUCCESSOR conversation carrying `previous_session_key` and hermes's own
 * `reason`. Until now nothing read it back.
 *
 * ```
 *   ros_messages.role = 'system'
 *   ros_messages.metadata ->> 'kind'                 = 'session-rotation'
 *   ros_messages.metadata ->> 'previous_session_key' = <predecessor SessionId>
 *   ros_conversations.session_key                    = <successor SessionId>
 * ```
 *
 * **Every link goes in through `registry.alias()`** — i.e. the same
 * `AliasStore.record` path a live rotation takes — so the chain-hygiene rules
 * apply to a rebuilt chain exactly as they do to a fresh one: same-harness
 * only, no cycles, depth capped at 32, one successor per id. A breadcrumb that
 * violates any of them is dropped with a log line, never forced in.
 *
 * **Failure-soft, always.** A DB that is unreachable, slow, or missing the
 * tables logs one line and the node boots with an empty alias store — exactly
 * the state it booted in before this existed. The link stays in the data, so
 * the next boot tries again. Reconstruction never blocks startup and never
 * fails a request.
 *
 * **Placement: boot, not first-miss.** An "alias miss" is not observable — an
 * id with no alias resolves to itself, which is indistinguishable from a
 * canonical id that never rotated, so a lazy reader would have to query the DB
 * for every unknown id (a remote round-trip on the dispatch path, memoized into
 * boot-time behavior anyway after the first one) or guess. One bounded query,
 * fired at boot and not awaited, is cheaper and answers before the first
 * client asks. See § Rotation migration story for the recorded reasoning.
 */

import type { SessionId } from '@rivetos/types'
import pg from 'pg'
import { normalizeSessionId } from './alias.js'
import type { HarnessRegistry } from './registry.js'

/** One `session-rotation` breadcrumb, as read back from the memory DB. */
export interface RotationBreadcrumb {
  /** `metadata->>'previous_session_key'` — the predecessor. */
  previousSessionKey: string
  /** The successor conversation's `session_key`. */
  sessionKey: string
  /** hermes's own reason (`new_session` / `branch` / `resume` / `compression`). */
  reason?: string
  /** Breadcrumb write time, for ordering and for the log line. */
  at?: string
}

export interface RotationBreadcrumbSource {
  /** Oldest-first, so chains rebuild in the order they were created. */
  read(opts: { limit: number; lookbackMs: number }): Promise<RotationBreadcrumb[]>
  /**
   * Release whatever the source holds, once the restore is done with it.
   * `restoreHarnessAliases` calls this in a `finally`, on the failure path too
   * — a source that kept a connection open past a failed read would leave the
   * process holding a socket for a query that already gave up. Best-effort:
   * a `close` that throws is swallowed like any other teardown.
   *
   * Optional because a source may own nothing between reads — the pg source
   * below is exactly that, creating and ending its client inside one `read`.
   */
  close?(): Promise<void>
}

export interface AliasRestoreResult {
  /** Did the source answer at all? `false` = DB miss; aliases stay recoverable. */
  ok: boolean
  /** Breadcrumbs read from the source. */
  read: number
  /** Links handed to `record()` without complaint. */
  linked: number
  /** Rows dropped before `record()` — malformed keys, missing fields. */
  malformed: number
  /**
   * Rows whose two keys are the SAME id. `record()` treats a self-alias as a
   * no-op rather than an error, so counting them as `linked` would report a
   * chain link that does not exist. They are their own bucket: not malformed
   * (both keys parse), not rejected (nothing refused them), just nothing.
   */
  selfLinks: number
  /** Links `record()` itself refused — cross-harness, cycle, depth, collision. */
  rejected: number
}

/**
 * How far back to read. Rotations older than this are not reconstructed:
 * resolving a two-month-old superseded id matters far less than a bounded query
 * against a table that grows forever, and the breadcrumb stays in the data
 * either way. The bound rides `idx_ros_messages_created`, so the scan is a
 * range over recent rows rather than a full table read.
 */
export const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
/** Ceiling on rows pulled in one restore — a runaway rotation loop stays bounded. */
export const DEFAULT_LIMIT = 5000
/** Connect/statement budget for the boot query. Nothing waits on it, but it must not hang forever. */
const QUERY_TIMEOUT_MS = 15_000

/**
 * Validate one side of a breadcrumb as a canonical SessionId.
 *
 * `normalizeSessionId` is the same gate inbound ids pass through, so the
 * reconstructor accepts exactly what the rest of the control plane accepts:
 * canonical `<harness-id>:<native>` (Claude's path-fallback shape collapses to
 * its uuid form), and nothing else. A bare uuid carries no harness, a
 * `task:<id>` key is not a SessionId at all, and an unknown harness token is
 * not ours — all three are malformed here.
 */
function asSessionId(raw: unknown): SessionId | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const normalized = normalizeSessionId(raw)
    return normalized.kind === 'canonical' ? normalized.sessionId : undefined
  } catch {
    return undefined
  }
}

/**
 * Rebuild alias chains from rotation breadcrumbs.
 *
 * Idempotent: `record()` no-ops a link it already holds, so a second run (a
 * restart, an operator re-trigger) changes nothing and reports the same counts.
 */
export async function restoreHarnessAliases(opts: {
  registry: Pick<HarnessRegistry, 'alias'>
  source: RotationBreadcrumbSource
  limit?: number
  lookbackMs?: number
  log?: (msg: string) => void
}): Promise<AliasRestoreResult> {
  const log = opts.log ?? ((): void => undefined)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS
  const result: AliasRestoreResult = {
    ok: true,
    read: 0,
    linked: 0,
    malformed: 0,
    selfLinks: 0,
    rejected: 0,
  }

  let rows: RotationBreadcrumb[]
  try {
    rows = await opts.source.read({ limit, lookbackMs })
  } catch (err) {
    // The whole point of failure-soft: a node whose memory DB is down boots
    // with no reconstructed aliases, which is where it was before this landed.
    log(
      '[den-server] harness: alias reconstruction skipped — ' +
        (err instanceof Error ? err.message : String(err)),
    )
    return { ...result, ok: false }
  } finally {
    // Whatever the read did, the source is done being read from. Releasing it
    // here rather than at the call site is the only way an optional `close` is
    // reliably paid on BOTH paths.
    try {
      await opts.source.close?.()
    } catch {
      /* a teardown that throws must not become the restore's outcome */
    }
  }

  result.read = rows.length
  for (const row of rows) {
    const previous = asSessionId(row.previousSessionKey)
    const next = asSessionId(row.sessionKey)
    if (!previous || !next) {
      result.malformed += 1
      log(
        `[den-server] harness: skipping malformed rotation breadcrumb ` +
          `${JSON.stringify(row.previousSessionKey)} → ${JSON.stringify(row.sessionKey)}`,
      )
      continue
    }
    if (previous === next) {
      // A breadcrumb pointing an id at itself. `record()` no-ops it, so calling
      // it would inflate `linked` with a link nobody made.
      result.selfLinks += 1
      continue
    }
    try {
      // Through the registry, deliberately: cross-harness, cycle, depth and
      // one-successor-per-id are control-plane rules, and a chain rebuilt from
      // disk has no more right to break them than a live rotation does.
      opts.registry.alias(previous, next)
      result.linked += 1
    } catch (err) {
      result.rejected += 1
      log(
        `[den-server] harness: rotation breadcrumb ${previous} → ${next} rejected — ` +
          (err instanceof Error ? err.message : String(err)),
      )
    }
  }

  if (result.read > 0) {
    log(
      `[den-server] harness: rebuilt ${String(result.linked)} rotation alias(es) from ` +
        `${String(result.read)} breadcrumb(s)` +
        (result.malformed || result.rejected || result.selfLinks
          ? ` (${String(result.malformed)} malformed, ${String(result.selfLinks)} self, ` +
            `${String(result.rejected)} rejected)`
          : ''),
    )
  }
  return result
}

/**
 * Breadcrumb source over the memory DB.
 *
 * den-server already talks to Postgres — `devices.ts` mints per-device roles
 * through `pg`, over its own CREATEROLE admin URL (`pgAdminUrl`) — and already
 * reads `RIVETOS_PG_URL`, which until now it only ever handed onward in an
 * enrollment payload rather than connecting to itself. So the dependency and
 * the env var were both already here: the reconstructor needed no new
 * connection story, no gateway plumbing and no boot-side pre-read passed in as
 * initial aliases. It borrows `devices.ts`'s SHAPE — a short-lived `pg.Client`,
 * not a pool — because this runs once per process, and a pool held for one boot
 * query is a socket kept open for the life of the node.
 *
 * The query is scoped by breadcrumb shape, not by `agent`. The memory DB is
 * mesh-shared, but a breadcrumb names BOTH keys, so a link is self-contained;
 * and the `agent` tag is per-harness (`rivet-hermes`), not per-node, so
 * filtering on it would not isolate this node anyway. A chain from another
 * node's hermes resolves harmlessly here — the local driver simply does not own
 * those ids.
 */
export function createPgBreadcrumbSource(opts: {
  pgUrl: string
  log?: (msg: string) => void
}): RotationBreadcrumbSource {
  return {
    async read({ limit, lookbackMs }): Promise<RotationBreadcrumb[]> {
      const client = new pg.Client({
        connectionString: opts.pgUrl,
        connectionTimeoutMillis: QUERY_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS,
        statement_timeout: QUERY_TIMEOUT_MS,
      })
      await client.connect()
      try {
        // Newest-first with the LIMIT, then reversed below: an ASC limit would
        // keep the OLDEST rows in an over-full window, which is exactly the
        // half of the history nobody is still holding an id from.
        const { rows } = await client.query<{
          session_key: string | null
          previous_session_key: string | null
          reason: string | null
          created_at: Date | null
        }>(
          `SELECT c.session_key,
                  m.metadata ->> 'previous_session_key' AS previous_session_key,
                  m.metadata ->> 'reason'               AS reason,
                  m.created_at
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE m.role = 'system'
              AND m.metadata ->> 'kind' = 'session-rotation'
              AND m.created_at >= now() - ($1::bigint * interval '1 millisecond')
            ORDER BY m.created_at DESC
            LIMIT $2`,
          [String(lookbackMs), limit],
        )
        return rows.reverse().map((r) => ({
          previousSessionKey: r.previous_session_key ?? '',
          sessionKey: r.session_key ?? '',
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.created_at ? { at: r.created_at.toISOString() } : {}),
        }))
      } finally {
        await client.end().catch(() => undefined)
      }
    },
  }
}

/**
 * Boot hook: reconstruct aliases in the background, swallowing everything.
 *
 * Returns the promise so a caller (or a test) can await the outcome; nothing on
 * the startup path does. With no `pgUrl` there is no source and no work — the
 * node has no memory DB to recover from, which is a configuration fact, not a
 * failure.
 */
export function startAliasRestore(opts: {
  registry: Pick<HarnessRegistry, 'alias'>
  source?: RotationBreadcrumbSource | null
  pgUrl?: string
  log?: (msg: string) => void
}): Promise<AliasRestoreResult> {
  const log = opts.log ?? ((): void => undefined)
  const none: AliasRestoreResult = {
    ok: false,
    read: 0,
    linked: 0,
    malformed: 0,
    selfLinks: 0,
    rejected: 0,
  }
  if (opts.source === null) return Promise.resolve(none)
  const source =
    opts.source ?? (opts.pgUrl ? createPgBreadcrumbSource({ pgUrl: opts.pgUrl, log }) : undefined)
  if (!source) return Promise.resolve(none)
  return restoreHarnessAliases({ registry: opts.registry, source, log }).catch((err: unknown) => {
    // restoreHarnessAliases already swallows the source's failure; this is the
    // belt for a bug in the restore itself. Boot must not care either way.
    log(
      '[den-server] harness: alias reconstruction failed — ' +
        (err instanceof Error ? err.message : String(err)),
    )
    return none
  })
}
