/**
 * Worker role → which graphile-worker tasks and cron identifiers this process
 * registers. graphile-worker only claims jobs whose task identifier is in its
 * taskList, so a compaction-role worker leaves wiki jobs for the wiki worker.
 */

export const WORKER_ROLES = ['all', 'compaction', 'wiki'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export interface WorkerPlanConfig {
  workerRole: WorkerRole
  wikiExtraction: boolean
}

export interface WorkerPlan {
  taskNames: string[]
  cronIdentifiers: string[]
}

/** Today's full task set, in the order `index.ts` historically registered them. */
export const ALL_TASK_NAMES = [
  'compact-conversation',
  'synthesize-tool-call',
  'enqueue-idle',
  'extract-wiki',
  'enqueue-wiki-backfill',
  'consolidate-wiki',
  'recompile-wiki',
  'enqueue-stale-wiki',
  'enqueue-stale-compaction',
  'reap-dead-jobs',
] as const

const COMPACTION_TASK_NAMES = [
  'compact-conversation',
  'synthesize-tool-call',
  'enqueue-idle',
  'enqueue-stale-compaction',
  'reap-dead-jobs',
] as const

const WIKI_TASK_NAMES = [
  'extract-wiki',
  'enqueue-wiki-backfill',
  'consolidate-wiki',
  'recompile-wiki',
  'enqueue-stale-wiki',
] as const

/** Today's cron identifiers, wiki-sweep excluded (gated on wikiExtraction). */
const ALL_CRON_IDENTIFIERS = [
  'idle-enqueue',
  'wiki-backfill',
  'stale-compaction-sweep',
  'reap-dead-jobs',
] as const

const COMPACTION_CRON_IDENTIFIERS = [
  'idle-enqueue',
  'stale-compaction-sweep',
  'reap-dead-jobs',
] as const

const WIKI_SWEEP_CRON = 'stale-wiki-sweep'

export function parseWorkerRole(raw: string | undefined): WorkerRole {
  // Unset → all. Empty string and any other value are invalid (fail loud).
  if (raw === undefined) return 'all'
  if ((WORKER_ROLES as readonly string[]).includes(raw)) return raw as WorkerRole
  throw new Error(
    `[CompactWorker] WORKER_ROLE must be one of: ${WORKER_ROLES.join(', ')} (got ${JSON.stringify(raw)})`,
  )
}

export function buildWorkerPlan(config: WorkerPlanConfig): WorkerPlan {
  switch (config.workerRole) {
    case 'compaction':
      return {
        taskNames: [...COMPACTION_TASK_NAMES],
        cronIdentifiers: [...COMPACTION_CRON_IDENTIFIERS],
      }
    case 'wiki':
      return {
        taskNames: [...WIKI_TASK_NAMES],
        cronIdentifiers: config.wikiExtraction
          ? ['wiki-backfill', WIKI_SWEEP_CRON]
          : ['wiki-backfill'],
      }
    case 'all':
      return {
        taskNames: [...ALL_TASK_NAMES],
        cronIdentifiers: config.wikiExtraction
          ? [...ALL_CRON_IDENTIFIERS, WIKI_SWEEP_CRON]
          : [...ALL_CRON_IDENTIFIERS],
      }
  }
}
