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
 *       and synthesize-tool-call tasks (pending / locked / failed counts).
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
}

async function queueStatus(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  rivetos memory queue-status

  Show graphile-worker job queue state across all RivetOS tasks.

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
         min(j.run_at) FILTER (WHERE j.locked_at IS NULL) AS oldest_run_at
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
