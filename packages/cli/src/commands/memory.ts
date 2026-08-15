/**
 * rivetos memory — memory subsystem maintenance commands
 *
 * Usage:
 *   rivetos memory backfill-tool-synth [--limit N] [--dry-run] [--json]
 *       Find assistant messages with empty content + tool_name and enqueue them
 *       as graphile-worker 'synthesize-tool-call' jobs. Idempotent — already-
 *       enqueued messages dedupe via job_key. Concurrency, retries, and rate
 *       limiting are handled by the compaction-worker service.
 *
 *   rivetos memory queue-status [--json]
 *       Show graphile-worker queue state for compact-conversation, embed-target,
 *       extract-wiki, and synthesize-tool-call tasks (pending / locked / failed).
 *
 *   rivetos memory retry-failed --task <id> [--error <substr>] [--limit N]
 *                              [--dry-run] [--json]
 *       Reset dead graphile-worker jobs (attempts >= max_attempts) so workers
 *       pick them up again. Required after a code fix when thousands of jobs
 *       sit stuck (e.g. extract-wiki after the text[] & SQL bug). job_key rows
 *       stay in place — only attempts/last_error/run_at/locked_* are cleared.
 *
 * Environment:
 *   RIVETOS_PG_URL  Required.
 */

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default async function memory(): Promise<void> {
  const args = process.argv.slice(3)
  const subcommand = args[0]

  switch (subcommand) {
    case 'backfill-tool-synth':
      await backfillToolSynth(args.slice(1))
      break
    case 'queue-status':
      await queueStatus(args.slice(1))
      break
    case 'retry-failed':
      await retryFailed(args.slice(1))
      break
    default:
      printHelp()
  }
}

function printHelp(): void {
  console.log(`
  rivetos memory — Memory subsystem maintenance

  Commands:
    backfill-tool-synth   Enqueue historical tool-call messages for synthesis
    queue-status          Show graphile-worker job queue state
    retry-failed          Re-queue dead jobs (attempts >= max_attempts)

  Run "rivetos memory <command> --help" for command-specific options.
`)
}

// ---------------------------------------------------------------------------
// backfill-tool-synth
// ---------------------------------------------------------------------------

interface BackfillFlags {
  limit: number | null
  dryRun: boolean
  json: boolean
}

async function backfillToolSynth(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  rivetos memory backfill-tool-synth

  Find assistant messages with empty content + tool_name and enqueue them as
  graphile-worker 'synthesize-tool-call' jobs. Idempotent — re-runs will
  no-op for messages already in the queue (job_key dedup).

  Options:
    --limit <N>   Stop after enqueuing N rows (default: unbounded)
    --dry-run     Plan only — show candidate count, do not enqueue
    --json        Output summary as JSON
`)
    return
  }

  const flags = parseBackfillFlags(args)
  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    console.error('Error: RIVETOS_PG_URL is required.')
    process.exit(1)
  }

  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })

  try {
    const candidates = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM ros_messages
        WHERE role='assistant'
          AND (content IS NULL OR content='')
          AND tool_name IS NOT NULL
        ORDER BY created_at ASC
        ${flags.limit ? 'LIMIT $1' : ''}`,
      flags.limit ? [flags.limit] : [],
    )

    console.log(`Candidates: ${candidates.rowCount?.toLocaleString() ?? 0}`)
    if (flags.dryRun) {
      console.log('--dry-run set, exiting without enqueuing.')
      return
    }
    if (candidates.rowCount === 0) {
      console.log('Nothing to do.')
      return
    }

    const started = Date.now()
    let enqueued = 0
    for (const row of candidates.rows) {
      try {
        await pool.query(
          `SELECT graphile_worker.add_job(
             'synthesize-tool-call',
             json_build_object('messageId', $1::text),
             job_key := 'tool-synth-' || $1::text,
             job_key_mode := 'preserve_run_at',
             max_attempts := 3
           )`,
          [row.id],
        )
        enqueued++
      } catch (err) {
        console.error(`Failed to enqueue ${row.id}: ${(err as Error).message}`)
      }
    }

    const finished = Date.now()
    const summary = {
      candidates: candidates.rowCount ?? 0,
      enqueued,
      durationMs: finished - started,
    }
    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log(
        `\nEnqueued ${summary.enqueued.toLocaleString()} job(s) in ${(summary.durationMs / 1000).toFixed(1)}s.`,
      )
    }
  } finally {
    await pool.end()
  }
}

function parseBackfillFlags(args: string[]): BackfillFlags {
  const flags: BackfillFlags = { limit: null, dryRun: false, json: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--limit': {
        const v = parseInt(args[++i] ?? '0', 10)
        flags.limit = v > 0 ? v : null
        break
      }
      case '--dry-run':
        flags.dryRun = true
        break
      case '--json':
        flags.json = true
        break
      default:
        console.error(`Unknown option: ${arg}`)
        process.exit(1)
    }
  }

  return flags
}

// ---------------------------------------------------------------------------
// queue-status
// ---------------------------------------------------------------------------

interface QueueStatusRow {
  task_identifier: string
  total: string
  pending: string
  locked: string
  failed: string
  oldest_run_at: Date | null
  sample_error: string | null
}

async function queueStatus(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  rivetos memory queue-status

  Show graphile-worker job queue state across all RivetOS tasks.
  Failed column is attempts >= max_attempts (won't retry until reset).
  Use: rivetos memory retry-failed --task <id>

  Options:
    --json   Output as JSON
`)
    return
  }

  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    console.error('Error: RIVETOS_PG_URL is required.')
    process.exit(1)
  }

  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })

  try {
    // graphile-worker keeps active jobs in graphile_worker._private_jobs
    const rows = await pool.query<QueueStatusRow>(
      `SELECT
         (SELECT identifier FROM graphile_worker._private_tasks t WHERE t.id = j.task_id) AS task_identifier,
         count(*)::text AS total,
         count(*) FILTER (WHERE j.locked_at IS NULL AND j.attempts < j.max_attempts)::text AS pending,
         count(*) FILTER (WHERE j.locked_at IS NOT NULL)::text AS locked,
         count(*) FILTER (WHERE j.attempts >= j.max_attempts)::text AS failed,
         min(j.run_at) FILTER (WHERE j.locked_at IS NULL) AS oldest_run_at,
         LEFT(MAX(j.last_error) FILTER (WHERE j.attempts >= j.max_attempts), 80) AS sample_error
       FROM graphile_worker._private_jobs j
       GROUP BY j.task_id
       ORDER BY task_identifier`,
    )

    const payload = {
      tasks: rows.rows.map((r) => ({
        task: r.task_identifier,
        total: Number(r.total),
        pending: Number(r.pending),
        locked: Number(r.locked),
        failed: Number(r.failed),
        oldestRunAt: r.oldest_run_at?.toISOString() ?? null,
        sampleError: r.sample_error,
      })),
    }

    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      if (payload.tasks.length === 0) {
        console.log('\n  No active jobs.\n')
        return
      }
      console.log('')
      console.log('  Task                       Total    Pending    Locked    Failed    Oldest')
      console.log('  ' + '-'.repeat(78))
      for (const t of payload.tasks) {
        const oldest = t.oldestRunAt ? t.oldestRunAt.replace('T', ' ').slice(0, 19) : '-'
        console.log(
          `  ${t.task.padEnd(26)} ${String(t.total).padStart(5)}    ${String(t.pending).padStart(7)}    ${String(t.locked).padStart(6)}    ${String(t.failed).padStart(6)}    ${oldest}`,
        )
        if (t.failed > 0 && t.sampleError) {
          console.log(`    └─ sample error: ${t.sampleError}`)
        }
      }
      const anyFailed = payload.tasks.some((t) => t.failed > 0)
      if (anyFailed) {
        console.log('')
        console.log(
          '  Dead jobs stay until reset. After a code fix: rivetos memory retry-failed --task <name>',
        )
      }
      console.log('')
    }
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      console.error(
        'Error: graphile_worker schema not installed yet — start the worker services first.',
      )
      process.exit(1)
    }
    throw err
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// retry-failed
// ---------------------------------------------------------------------------

/** Exported for unit tests — flag parse for `rivetos memory retry-failed`. */
export interface RetryFailedFlags {
  tasks: string[]
  errorSubstr: string | null
  limit: number | null
  dryRun: boolean
  json: boolean
}

/**
 * Parse CLI flags for retry-failed. Exported for unit tests.
 * Requires at least one --task so we never mass-retry poison queues by accident.
 */
export function parseRetryFailedFlags(args: string[]): RetryFailedFlags {
  const flags: RetryFailedFlags = {
    tasks: [],
    errorSubstr: null,
    limit: null,
    dryRun: false,
    json: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--task': {
        const v = args[++i]
        if (!v || v.startsWith('-')) {
          throw new Error('--task requires a task identifier (e.g. extract-wiki)')
        }
        flags.tasks.push(v)
        break
      }
      case '--error': {
        const v = args[++i]
        if (v === undefined || v.startsWith('-')) {
          throw new Error('--error requires a substring to match against last_error')
        }
        flags.errorSubstr = v
        break
      }
      case '--limit': {
        const v = parseInt(args[++i] ?? '0', 10)
        flags.limit = v > 0 ? v : null
        break
      }
      case '--dry-run':
        flags.dryRun = true
        break
      case '--json':
        flags.json = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (flags.tasks.length === 0) {
    throw new Error(
      'At least one --task <identifier> is required (e.g. --task extract-wiki). ' +
        'Refusing to reset every dead job without an explicit task filter.',
    )
  }

  return flags
}

/**
 * Build the WHERE clause + params for dead-job selection/update.
 * Exported for unit tests — keep SELECT and UPDATE filters identical.
 *
 * Params layout: $1 = text[] tasks, optional $2 = error substr, optional $limit last.
 */
export function buildRetryFailedWhere(flags: RetryFailedFlags): {
  whereSql: string
  params: unknown[]
  limitSql: string
} {
  const params: unknown[] = [flags.tasks]
  const clauses = [
    'j.attempts >= j.max_attempts',
    't.identifier = ANY($1::text[])',
    // Never touch a job a worker still holds — is_available is generated from
    // locked_at + attempts; we only reset unlocked dead rows.
    'j.locked_at IS NULL',
  ]

  if (flags.errorSubstr !== null) {
    params.push(flags.errorSubstr)
    clauses.push(`j.last_error ILIKE '%' || $${String(params.length)}::text || '%'`)
  }

  let limitSql = ''
  if (flags.limit !== null) {
    params.push(flags.limit)
    limitSql = ` LIMIT $${String(params.length)}`
  }

  return { whereSql: clauses.join('\n         AND '), params, limitSql }
}

interface RetryCandidateRow {
  id: string
  task: string
  key: string | null
  attempts: number
  max_attempts: number
  last_error: string | null
}

async function retryFailed(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  rivetos memory retry-failed

  Reset dead graphile-worker jobs so workers can pick them up again.
  A job is "dead" when attempts >= max_attempts (is_available becomes false).
  This keeps the same job row and job_key — only clears attempts / last_error /
  locked_* and sets run_at = now().

  Use after deploying a code fix that made a whole class of jobs fail, e.g.:
    rivetos memory retry-failed --task extract-wiki --error 'text[] &' --dry-run
    rivetos memory retry-failed --task extract-wiki --error 'text[] &'

  Options:
    --task <id>     Task identifier to reset (required; repeatable)
    --error <str>   Only jobs whose last_error contains this substring (ILIKE)
    --limit <N>     Cap how many jobs to reset (oldest run_at first)
    --dry-run       Count + sample only — do not update
    --json          Output summary as JSON
`)
    return
  }

  let flags: RetryFailedFlags
  try {
    flags = parseRetryFailedFlags(args)
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    console.error('Error: RIVETOS_PG_URL is required.')
    process.exit(1)
  }

  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })

  try {
    const { whereSql, params, limitSql } = buildRetryFailedWhere(flags)

    const candidates = await pool.query<RetryCandidateRow>(
      `SELECT j.id::text AS id,
              t.identifier AS task,
              j.key,
              j.attempts,
              j.max_attempts,
              LEFT(j.last_error, 160) AS last_error
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE ${whereSql}
        ORDER BY j.run_at ASC
        ${limitSql}`,
      params,
    )

    const matched = candidates.rowCount ?? 0
    const byTask = new Map<string, number>()
    for (const row of candidates.rows) {
      byTask.set(row.task, (byTask.get(row.task) ?? 0) + 1)
    }

    if (flags.dryRun || matched === 0) {
      const summary = {
        dryRun: flags.dryRun,
        matched,
        reset: 0,
        byTask: Object.fromEntries(byTask),
        sample: candidates.rows.slice(0, 5).map((r) => ({
          id: r.id,
          task: r.task,
          key: r.key,
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
          lastError: r.last_error,
        })),
      }
      if (flags.json) {
        console.log(JSON.stringify(summary, null, 2))
      } else {
        console.log(`Matched dead jobs: ${matched.toLocaleString()}`)
        for (const [task, n] of byTask) {
          console.log(`  ${task}: ${n.toLocaleString()}`)
        }
        if (summary.sample.length > 0) {
          console.log('Sample:')
          for (const s of summary.sample) {
            console.log(
              `  [${s.task}] key=${s.key ?? '-'} attempts=${String(s.attempts)}/${String(s.maxAttempts)} err=${s.lastError ?? '(none)'}`,
            )
          }
        }
        if (flags.dryRun) {
          console.log('--dry-run set, exiting without reset.')
        } else {
          console.log('Nothing to do.')
        }
      }
      return
    }

    // UPDATE only the ordered candidate subset (LIMIT-safe via targets CTE).
    // is_available is GENERATED ALWAYS as (locked_at IS NULL AND attempts < max_attempts).
    const started = Date.now()
    const updated = await pool.query<{ id: string; task: string }>(
      `WITH targets AS (
         SELECT j.id
           FROM graphile_worker._private_jobs j
           JOIN graphile_worker._private_tasks t ON t.id = j.task_id
          WHERE ${whereSql}
          ORDER BY j.run_at ASC
          ${limitSql}
       ),
       updated AS (
         UPDATE graphile_worker._private_jobs j
            SET attempts = 0,
                last_error = NULL,
                run_at = now(),
                locked_at = NULL,
                locked_by = NULL,
                updated_at = now()
           FROM targets
          WHERE j.id = targets.id
          RETURNING j.id, j.task_id
       )
       SELECT u.id::text AS id, t.identifier AS task
         FROM updated u
         JOIN graphile_worker._private_tasks t ON t.id = u.task_id`,
      params,
    )

    const reset = updated.rowCount ?? 0
    const resetByTask = new Map<string, number>()
    for (const row of updated.rows) {
      resetByTask.set(row.task, (resetByTask.get(row.task) ?? 0) + 1)
    }

    const summary = {
      dryRun: false,
      matched,
      reset,
      byTask: Object.fromEntries(resetByTask),
      durationMs: Date.now() - started,
    }

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log(
        `Reset ${reset.toLocaleString()} dead job(s) in ${(summary.durationMs / 1000).toFixed(1)}s.`,
      )
      for (const [task, n] of resetByTask) {
        console.log(`  ${task}: ${n.toLocaleString()}`)
      }
      console.log('Workers will pick them up via is_available (attempts < max_attempts).')
    }
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      console.error(
        'Error: graphile_worker schema not installed yet — start the worker services first.',
      )
      process.exit(1)
    }
    throw err
  } finally {
    await pool.end()
  }
}
