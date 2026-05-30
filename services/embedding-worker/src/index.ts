/**
 * Embedding Worker — graphile-worker daemon.
 *
 * Replaces the previous LISTEN/NOTIFY-driven JS worker
 * (plugins/memory/postgres/workers/embedding/index.js).
 *
 * Tasks:
 *   - embed-target       — embed a single row from ros_messages or ros_summaries
 *   - enqueue-unembedded — cron (every 10 min) — backstop that re-enqueues rows
 *                          left with NULL embedding and no live job
 *
 * Environment:
 *   RIVETOS_PG_URL              required
 *   RIVETOS_EMBED_URL           required (Nemotron endpoint)
 *   RIVETOS_EMBED_MODEL         default: nemotron
 *   EMBED_CONCURRENCY           default: 4
 *   EMBED_TRUNCATE_DIMS         default: 4000
 *   EMBED_CHARS_PER_CHUNK       default: 6000   (must be <= endpoint per-request capacity)
 *   EMBED_API_TIMEOUT_MS        default: 30000
 *   EMBED_MAX_RETRIES           default: 3
 *   EMBED_MAX_FAILURES          default: 3
 *   EMBED_SWEEP_LIMIT           default: 200    (rows per table per sweep)
 *   EMBED_SWEEP_MAX_ATTEMPTS    default: 5
 */

import { parseCronItems, run } from 'graphile-worker'
import { config } from './config.js'
import { embedTargetTask } from './tasks/embed-target.js'
import { enqueueUnembeddedTask } from './tasks/enqueue-unembedded.js'

async function main(): Promise<void> {
  console.log('[EmbedWorker] Starting...')
  console.log(`[EmbedWorker] Embed endpoint: ${config.embedUrl} (model: ${config.embedModel})`)
  console.log(
    `[EmbedWorker] Concurrency: ${config.concurrency}, chunk: ${config.charsPerChunk}, truncate: ${config.truncateDims}`,
  )

  const runner = await run({
    connectionString: config.pgUrl,
    concurrency: config.concurrency,
    noHandleSignals: false,
    pollInterval: 60_000,
    taskList: {
      'embed-target': embedTargetTask,
      'enqueue-unembedded': enqueueUnembeddedTask,
    },
    parsedCronItems: parseCronItems([
      {
        task: 'enqueue-unembedded',
        match: '*/10 * * * *',
        identifier: 'unembedded-sweep',
        options: { backfillPeriod: 0 },
      },
    ]),
  })

  console.log('[EmbedWorker] Ready — graphile-worker listening')
  await runner.promise
}

main().catch((err) => {
  console.error('[EmbedWorker] Fatal:', err)
  process.exit(1)
})
