/**
 * Compaction Worker — graphile-worker daemon.
 *
 * Replaces the previous LISTEN/NOTIFY-driven JS worker
 * (plugins/memory/postgres/workers/compaction/index.js).
 *
 * Tasks:
 *   - compact-conversation     — bottom-up leaf/branch/root compaction for one conversation
 *   - synthesize-tool-call     — fill empty-content assistant tool-call messages with synthesized natural-language content
 *   - enqueue-idle             — cron (every 5 min) — find idle conversations with unsummarized messages and enqueue them
 *
 * Environment:
 *   RIVETOS_PG_URL              required
 *   RIVETOS_COMPACTOR_URL       required (LLM endpoint)
 *   RIVETOS_COMPACTOR_MODEL     default: rivet-refined-v5
 *   RIVETOS_COMPACTOR_API_KEY   optional
 *   COMPACT_CONCURRENCY         default: 1 (compaction is CPU-heavy on the LLM, single-flight per worker)
 *   TOOL_SYNTH_CONCURRENCY      default: 2
 *   COMPACT_IDLE_MINUTES        default: 15
 *   COMPACT_MIN_UNSUMMARIZED    default: 50
 */

import { parseCronItems, run } from 'graphile-worker'
import { config } from './config.js'
import { compactConversationTask } from './tasks/compact-conversation.js'
import { synthesizeToolCallTask } from './tasks/synthesize-tool-call.js'
import { enqueueIdleTask } from './tasks/enqueue-idle.js'

async function main(): Promise<void> {
  console.log('[CompactWorker] Starting...')
  console.log(`[CompactWorker] LLM endpoint: ${config.llmUrl} (model: ${config.llmModel})`)
  console.log(
    `[CompactWorker] Idle threshold: ${config.idleMinutes} min, min-unsummarized: ${config.minUnsummarized}`,
  )

  const runner = await run({
    connectionString: config.pgUrl,
    concurrency: config.compactConcurrency,
    noHandleSignals: false,
    pollInterval: 60_000,
    taskList: {
      'compact-conversation': compactConversationTask,
      'synthesize-tool-call': synthesizeToolCallTask,
      'enqueue-idle': enqueueIdleTask,
    },
    parsedCronItems: parseCronItems([
      {
        task: 'enqueue-idle',
        match: '*/5 * * * *',
        identifier: 'idle-enqueue',
        options: { backfillPeriod: 0 },
      },
    ]),
  })

  console.log('[CompactWorker] Ready — graphile-worker listening')
  await runner.promise
}

main().catch((err) => {
  console.error('[CompactWorker] Fatal:', err)
  process.exit(1)
})
