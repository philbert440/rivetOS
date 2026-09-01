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
 *   - extract-wiki             — durable topic patches from leaf summaries (WIKI_EXTRACTION)
 *   - enqueue-wiki-backfill    — cron — queue unextracted leaves for wiki mining
 *   - consolidate-wiki         — memory v6: merge near-duplicate topics into durable parents
 *   - recompile-wiki           — memory v7: rebuild Wikipedia-style Summary+Article from history
 *   - enqueue-stale-wiki       — cron (every 15 min, WIKI_EXTRACTION=1) — revive keyed-dead / re-add missing extract-wiki jobs
 *   - enqueue-stale-compaction — cron (every 15 min) — re-add missing compact-conversation jobs (no corpse revive)
 *   - reap-dead-jobs           — cron (hourly) — DELETE keyless dead job corpses older than 7 days
 *
 * Environment:
 *   RIVETOS_PG_URL              required
 *   RIVETOS_COMPACTOR_URL       required (LLM endpoint)
 *   RIVETOS_COMPACTOR_MODEL     required (OpenAI-compatible chat model id)
 *   RIVETOS_COMPACTOR_API_KEY   optional
 *   COMPACT_CONCURRENCY         default: 1 (compaction is CPU-heavy on the LLM, single-flight per worker)
 *   TOOL_SYNTH_CONCURRENCY      default: 2
 *   COMPACT_IDLE_MINUTES        default: 15
 *   COMPACT_LEAF_BATCH          default: 10  (also the full-window enqueue threshold)
 *   COMPACT_STALE_MINUTES       default: 5760 (4 days) — flush below-floor tails of long-idle convs
 *   COMPACT_STALE_MIN_BATCH     default: 2   — min messages for a stale-partial flush
 *   WIKI_SWEEP_LIMIT            default: 20  — max keyed-dead+missing extract-wiki jobs per sweep tick
 *   COMPACTION_SWEEP_LIMIT      default: 20  — max missing compact-conversation jobs per sweep tick
 *   REAP_DEAD_LIMIT             default: 200 — max keyless dead corpses to DELETE per hourly tick
 */

import { parseCronItems, run } from 'graphile-worker'
import { config } from './config.js'
import { compactConversationTask } from './tasks/compact-conversation.js'
import { synthesizeToolCallTask } from './tasks/synthesize-tool-call.js'
import { enqueueIdleTask } from './tasks/enqueue-idle.js'
import { extractWikiTask } from './tasks/extract-wiki.js'
import { enqueueWikiBackfillTask } from './tasks/enqueue-wiki-backfill.js'
import { consolidateWikiTask } from './tasks/consolidate-wiki.js'
import { recompileWikiTask } from './tasks/recompile-wiki.js'
import { enqueueStaleWikiTask } from './tasks/enqueue-stale-wiki.js'
import { enqueueStaleCompactionTask } from './tasks/enqueue-stale-compaction.js'
import { reapDeadJobsTask } from './tasks/reap-dead-jobs.js'

async function main(): Promise<void> {
  console.log('[CompactWorker] Starting...')
  console.log(`[CompactWorker] LLM endpoint: ${config.llmUrl} (model: ${config.llmModel})`)
  console.log(
    `[CompactWorker] Idle threshold: ${config.idleMinutes} min, leaf window: ${config.leafBatchSize}, ` +
      `stale-partial: ${config.staleMinutes} min / >=${config.staleMinBatch} msgs`,
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
      'extract-wiki': extractWikiTask,
      'enqueue-wiki-backfill': enqueueWikiBackfillTask,
      'consolidate-wiki': consolidateWikiTask,
      'recompile-wiki': recompileWikiTask,
      'enqueue-stale-wiki': enqueueStaleWikiTask,
      'enqueue-stale-compaction': enqueueStaleCompactionTask,
      'reap-dead-jobs': reapDeadJobsTask,
    },
    parsedCronItems: parseCronItems([
      {
        task: 'enqueue-idle',
        match: '*/5 * * * *',
        identifier: 'idle-enqueue',
        options: { backfillPeriod: 0 },
      },
      {
        task: 'enqueue-wiki-backfill',
        match: '*/10 * * * *',
        identifier: 'wiki-backfill',
        options: { backfillPeriod: 0 },
      },
      {
        task: 'enqueue-stale-compaction',
        match: '*/15 * * * *',
        identifier: 'stale-compaction-sweep',
        options: { backfillPeriod: 0 },
      },
      {
        task: 'reap-dead-jobs',
        match: '0 * * * *',
        identifier: 'reap-dead-jobs',
        options: { backfillPeriod: 0 },
      },
      // Worker-boundary gate: do not even schedule the wiki sweep when the
      // flag is off. The task itself also no-ops; both are required so a
      // stray add_job cannot revive extract-wiki in a dark deploy.
      ...(config.wikiExtraction
        ? [
            {
              task: 'enqueue-stale-wiki',
              match: '*/15 * * * *',
              identifier: 'stale-wiki-sweep',
              options: { backfillPeriod: 0 },
            },
          ]
        : []),
    ]),
  })

  console.log('[CompactWorker] Ready — graphile-worker listening')
  await runner.promise
}

main().catch((err) => {
  console.error('[CompactWorker] Fatal:', err)
  process.exit(1)
})
