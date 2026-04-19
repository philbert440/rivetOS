/**
 * rivetos memory — memory subsystem maintenance commands
 *
 * Usage:
 *   rivetos memory backfill-tool-synth [options]
 *       Synthesize natural-language content for historical assistant messages
 *       that only have tool_name/tool_args (no content). Resumable, parallel,
 *       NUMA-pinned friendly. Uses the same prompt + validation as the live
 *       async queue in the compaction-worker.
 *
 *   rivetos memory queue-status
 *       Show the state of ros_tool_synth_queue (pending / attempts / errors).
 *
 * Options (backfill-tool-synth):
 *   --concurrency N         Parallel workers. Default: 4. Set to match
 *                           --parallel slots on the llama-server endpoints.
 *   --urls <list>           Comma-separated endpoints to round-robin across.
 *                           Default: $TOOL_SYNTH_ENDPOINT or $RIVETOS_COMPACTOR_URL
 *                           Example: http://gerty:8001/v1,http://gerty:8002/v1
 *   --model <name>          Model name sent in the request body.
 *                           Default: $TOOL_SYNTH_MODEL or $RIVETOS_COMPACTOR_MODEL
 *   --api-key <key>         Bearer token. Default: $RIVETOS_COMPACTOR_API_KEY
 *   --batch <N>             Max rows to claim per SQL round. Default: 4
 *   --limit <N>             Stop after this many rows. Default: unbounded
 *   --dry-run               Plan only — show candidate count, do not write.
 *   --json                  Final summary as JSON instead of pretty output.
 *
 * Environment (overridden by flags):
 *   RIVETOS_PG_URL             Required.
 *   TOOL_SYNTH_ENDPOINT        Falls back to RIVETOS_COMPACTOR_URL.
 *   TOOL_SYNTH_MODEL           Falls back to RIVETOS_COMPACTOR_MODEL.
 *   RIVETOS_COMPACTOR_API_KEY  Optional bearer token.
 *
 * Target rows:
 *   role='assistant' AND (content IS NULL OR content='') AND tool_name IS NOT NULL
 *   (drained via ros_tool_synth_queue; historical empty rows are enqueued first.)
 *
 * Safety:
 *   * Concurrency-safe — FOR UPDATE SKIP LOCKED. Multiple concurrent runs are
 *     fine; they will not collide.
 *   * Resumable — stopping mid-run leaves claimed rows untouched (next attempt
 *     simply re-claims). Rows that fail `TOOL_SYNTH_MAX_ATTEMPTS` times are
 *     dequeued and left alone.
 *   * Never fails the broader system — synthesis errors only affect the row
 *     being processed.
 */

import { synthesizeToolCallContent } from '@rivetos/memory-postgres'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackfillFlags {
  concurrency: number
  urls: string[]
  model: string
  apiKey: string
  batch: number
  limit: number | null
  dryRun: boolean
  json: boolean
}

interface RunSummary {
  startedAt: string
  finishedAt: string
  durationMs: number
  concurrency: number
  urls: string[]
  totalCandidates: number
  processed: number
  synthesized: number
  failed: number
  skipped: number
  ratePerSec: number
}

interface ToolSynthRow {
  message_id: string
  tool_name: string
  tool_args: unknown
  agent: string | null
}

const TOOL_SYNTH_MAX_ATTEMPTS = 3
const QUEUE_TABLE = 'ros_tool_synth_queue'

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
    backfill-tool-synth   Synthesize content for historical tool-call messages
    queue-status          Show ros_tool_synth_queue state

  Run "rivetos memory <command> --help" for command-specific options.
`)
}

// ---------------------------------------------------------------------------
// backfill-tool-synth
// ---------------------------------------------------------------------------

async function backfillToolSynth(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  rivetos memory backfill-tool-synth

  Synthesize natural-language content for assistant tool-call messages that
  only have tool_name/tool_args. Resumable, parallel, NUMA-pinned friendly.

  Options:
    --concurrency N         Parallel workers (default: 4)
    --urls <list>           Comma-separated llama-server endpoints
                            (default: $TOOL_SYNTH_ENDPOINT or $RIVETOS_COMPACTOR_URL)
    --model <name>          Model name in request body
                            (default: $TOOL_SYNTH_MODEL or $RIVETOS_COMPACTOR_MODEL)
    --api-key <key>         Bearer token (default: $RIVETOS_COMPACTOR_API_KEY)
    --batch <N>             Rows claimed per SQL round (default: 4)
    --limit <N>             Stop after N rows (default: unbounded)
    --dry-run               Plan only — show candidate count, no writes
    --json                  Final summary as JSON

  Example:
    rivetos memory backfill-tool-synth \\
      --concurrency 8 --batch 8 \\
      --urls http://gerty:8001/v1,http://gerty:8002/v1
`)
    return
  }

  const flags = parseBackfillFlags(args)
  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    console.error('Error: RIVETOS_PG_URL is required.')
    process.exit(1)
  }
  if (flags.urls.length === 0) {
    console.error(
      'Error: no endpoint configured (set --urls or TOOL_SYNTH_ENDPOINT/RIVETOS_COMPACTOR_URL)',
    )
    process.exit(1)
  }
  if (!flags.model) {
    console.error(
      'Error: no model configured (set --model or TOOL_SYNTH_MODEL/RIVETOS_COMPACTOR_MODEL)',
    )
    process.exit(1)
  }

  // Lazy-load pg so memory plugin isn't pulled into unrelated CLI paths.
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: pgUrl, max: flags.concurrency + 2 })

  try {
    await enqueueHistorical(pool)

    const candidates = await countCandidates(pool)
    console.log(
      `Candidates pending: ${candidates.toLocaleString()} (rows queued with attempts < ${TOOL_SYNTH_MAX_ATTEMPTS})`,
    )
    if (flags.dryRun) {
      console.log('--dry-run set, exiting without processing.')
      await pool.end()
      return
    }
    if (candidates === 0) {
      console.log('Nothing to do. Queue is empty.')
      await pool.end()
      return
    }

    const started = Date.now()
    const summary: RunSummary = {
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
      concurrency: flags.concurrency,
      urls: flags.urls,
      totalCandidates: candidates,
      processed: 0,
      synthesized: 0,
      failed: 0,
      skipped: 0,
      ratePerSec: 0,
    }

    let limitRemaining = flags.limit ?? Infinity
    let shuttingDown = false
    const onSignal = (sig: NodeJS.Signals): void => {
      if (!shuttingDown) {
        console.error(`\n[memory] ${sig} — workers finishing current batch…`)
      }
      shuttingDown = true
    }
    process.on('SIGINT', () => onSignal('SIGINT'))
    process.on('SIGTERM', () => onSignal('SIGTERM'))

    const ticker = setInterval(() => {
      if (shuttingDown) return
      const elapsed = (Date.now() - started) / 1000
      const rate = summary.processed / Math.max(elapsed, 1)
      console.log(
        `[backfill] processed=${summary.processed}  ok=${summary.synthesized}  fail=${summary.failed}  rate=${rate.toFixed(2)}/s`,
      )
    }, 15000)

    async function workerLoop(id: number): Promise<void> {
      while (!shuttingDown && limitRemaining > 0) {
        const rows = await claimBatch(pool, Math.min(flags.batch, limitRemaining))
        if (rows.length === 0) return
        limitRemaining -= rows.length

        for (const row of rows) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- SIGINT/SIGTERM can flip this mid-loop
          if (shuttingDown) break
          const endpoint = flags.urls[(id + summary.processed) % flags.urls.length]
          try {
            const toolArgs: unknown =
              typeof row.tool_args === 'string'
                ? JSON.parse(row.tool_args || '{}')
                : (row.tool_args ?? {})
            const synth = await synthesizeToolCallContent({
              endpoint,
              model: flags.model,
              apiKey: flags.apiKey || undefined,
              toolName: row.tool_name,
              toolArgs,
            })
            if (!synth || synth.trim().length === 0) {
              await recordFailure(pool, row.message_id, 'Empty synth response')
              summary.failed++
              continue
            }
            await commitSynth(pool, row.message_id, synth)
            summary.synthesized++
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            try {
              await recordFailure(pool, row.message_id, msg)
            } catch {
              /* swallow — row will be retried next run */
            }
            summary.failed++
          } finally {
            summary.processed++
          }
        }
      }
    }

    const workers: Array<Promise<void>> = []
    for (let i = 0; i < flags.concurrency; i++) {
      workers.push(workerLoop(i))
    }
    await Promise.all(workers)

    clearInterval(ticker)

    const finished = Date.now()
    summary.finishedAt = new Date(finished).toISOString()
    summary.durationMs = finished - started
    summary.ratePerSec = summary.processed / Math.max((finished - started) / 1000, 1)

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log('\nBackfill complete.')
      console.log(`  Processed:    ${summary.processed.toLocaleString()}`)
      console.log(`  Synthesized:  ${summary.synthesized.toLocaleString()}`)
      console.log(`  Failed:       ${summary.failed.toLocaleString()}`)
      console.log(`  Duration:     ${(summary.durationMs / 1000).toFixed(1)}s`)
      console.log(`  Rate:         ${summary.ratePerSec.toFixed(2)}/s`)
    }
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// queue-status
// ---------------------------------------------------------------------------

async function queueStatus(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  rivetos memory queue-status

  Show the state of ros_tool_synth_queue.

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
    const totalRes = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${QUEUE_TABLE}`,
    )
    const byAttempts = await pool.query<{ attempts: number; n: string }>(
      `SELECT attempts, count(*)::text AS n FROM ${QUEUE_TABLE} GROUP BY attempts ORDER BY attempts`,
    )
    const historical = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ros_messages
       WHERE role='assistant'
         AND (content IS NULL OR content='')
         AND tool_name IS NOT NULL
         AND id NOT IN (SELECT message_id FROM ${QUEUE_TABLE})`,
    )

    const payload = {
      queueTotal: Number(totalRes.rows[0]?.n ?? 0),
      byAttempts: byAttempts.rows.map((r) => ({ attempts: r.attempts, count: Number(r.n) })),
      historicalUnqueued: Number(historical.rows[0]?.n ?? 0),
    }

    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      console.log('')
      console.log(`  ros_tool_synth_queue total:        ${payload.queueTotal.toLocaleString()}`)
      console.log(
        `  Historical unqueued candidates:    ${payload.historicalUnqueued.toLocaleString()}`,
      )
      if (payload.byAttempts.length > 0) {
        console.log('')
        console.log('  By attempts:')
        for (const row of payload.byAttempts) {
          const marker = row.attempts >= TOOL_SYNTH_MAX_ATTEMPTS ? '  (stuck)' : ''
          console.log(`    attempts=${row.attempts}: ${row.count.toLocaleString()}${marker}`)
        }
      }
      console.log('')
    }
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

async function enqueueHistorical(pool: import('pg').Pool): Promise<void> {
  // Pull any historical empty-content tool-call rows into the queue if they
  // aren't already there. Idempotent.
  const res = await pool.query(
    `INSERT INTO ${QUEUE_TABLE} (message_id)
     SELECT id FROM ros_messages
     WHERE role='assistant'
       AND (content IS NULL OR content='')
       AND tool_name IS NOT NULL
       AND id NOT IN (SELECT message_id FROM ${QUEUE_TABLE})
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
  )
  if (res.rowCount && res.rowCount > 0) {
    console.log(`  Enqueued ${res.rowCount.toLocaleString()} historical row(s).`)
  }
}

async function countCandidates(pool: import('pg').Pool): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${QUEUE_TABLE} WHERE attempts < $1`,
    [TOOL_SYNTH_MAX_ATTEMPTS],
  )
  return Number(res.rows[0]?.n ?? 0)
}

async function claimBatch(pool: import('pg').Pool, batch: number): Promise<ToolSynthRow[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const rows = await client.query<ToolSynthRow>(
      `SELECT q.message_id, m.tool_name, m.tool_args, m.agent
       FROM ${QUEUE_TABLE} q
       JOIN ros_messages m ON m.id = q.message_id
       WHERE q.attempts < $1
       ORDER BY q.enqueued_at ASC
       LIMIT $2
       FOR UPDATE OF q SKIP LOCKED`,
      [TOOL_SYNTH_MAX_ATTEMPTS, batch],
    )

    if (rows.rows.length > 0) {
      await client.query(
        `UPDATE ${QUEUE_TABLE} SET last_attempt_at = NOW()
         WHERE message_id = ANY($1::uuid[])`,
        [rows.rows.map((r) => r.message_id)],
      )
    }

    await client.query('COMMIT')
    return rows.rows
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function commitSynth(
  pool: import('pg').Pool,
  messageId: string,
  synth: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE ros_messages SET content = $1, updated_at = NOW() WHERE id = $2`, [
      synth,
      messageId,
    ])
    await client.query(`DELETE FROM ${QUEUE_TABLE} WHERE message_id = $1`, [messageId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function recordFailure(
  pool: import('pg').Pool,
  messageId: string,
  errMsg: string,
): Promise<void> {
  await pool.query(
    `UPDATE ${QUEUE_TABLE}
       SET attempts = attempts + 1,
           last_error = $1,
           last_attempt_at = NOW()
     WHERE message_id = $2`,
    [errMsg.slice(0, 500), messageId],
  )
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseBackfillFlags(args: string[]): BackfillFlags {
  const flags: BackfillFlags = {
    concurrency: 4,
    urls: (process.env.TOOL_SYNTH_ENDPOINT ?? process.env.RIVETOS_COMPACTOR_URL ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    model: process.env.TOOL_SYNTH_MODEL ?? process.env.RIVETOS_COMPACTOR_MODEL ?? '',
    apiKey: process.env.RIVETOS_COMPACTOR_API_KEY ?? '',
    batch: 4,
    limit: null,
    dryRun: false,
    json: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--concurrency':
        flags.concurrency = Math.max(1, parseInt(args[++i] ?? '4', 10))
        break
      case '--urls':
        flags.urls = (args[++i] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case '--model':
        flags.model = args[++i] ?? flags.model
        break
      case '--api-key':
        flags.apiKey = args[++i] ?? flags.apiKey
        break
      case '--batch':
        flags.batch = Math.max(1, parseInt(args[++i] ?? '4', 10))
        break
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
