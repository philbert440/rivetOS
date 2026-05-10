/**
 * Embedding Worker — graphile-worker daemon.
 *
 * Replaces the previous LISTEN/NOTIFY-driven JS worker
 * (plugins/memory/postgres/workers/embedding/index.js).
 *
 * Tasks:
 *   - embed-target — embed a single row from ros_messages or ros_summaries
 *
 * Environment:
 *   RIVETOS_PG_URL              required
 *   RIVETOS_EMBED_URL           required (Nemotron endpoint)
 *   RIVETOS_EMBED_MODEL         default: nemotron
 *   EMBED_CONCURRENCY           default: 4
 *   EMBED_TRUNCATE_DIMS         default: 4000
 *   EMBED_CHARS_PER_CHUNK       default: 20000
 *   EMBED_API_TIMEOUT_MS        default: 30000
 *   EMBED_MAX_RETRIES           default: 3
 *   EMBED_MAX_FAILURES          default: 3
 */

import { run } from 'graphile-worker'
import { config } from './config.js'
import { embedTargetTask } from './tasks/embed-target.js'

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
    },
  })

  console.log('[EmbedWorker] Ready — graphile-worker listening')
  await runner.promise
}

main().catch((err) => {
  console.error('[EmbedWorker] Fatal:', err)
  process.exit(1)
})
