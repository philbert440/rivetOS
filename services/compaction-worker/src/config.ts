/**
 * Environment-driven configuration for the compaction worker.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[CompactWorker] ${name} is required`)
    process.exit(1)
  }
  return value
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  pgUrl: requireEnv('RIVETOS_PG_URL'),
  llmUrl: requireEnv('RIVETOS_COMPACTOR_URL'),
  llmModel: process.env.RIVETOS_COMPACTOR_MODEL ?? 'rivet-refined-v5',
  llmApiKey: process.env.RIVETOS_COMPACTOR_API_KEY ?? '',

  // Worker-local concurrency
  compactConcurrency: intEnv('COMPACT_CONCURRENCY', 1),

  // Wiki extraction (phase 3c) — dark by default; single writer per design.
  wikiExtraction: process.env.WIKI_EXTRACTION === '1',
  wikiDir: process.env.WIKI_DIR ?? '/rivet-shared/wiki',

  // Batch sizes (worker-local — library exports only absolute budgets)
  leafBatchSize: intEnv('COMPACT_LEAF_BATCH', 10),
  branchBatchSize: intEnv('COMPACT_BRANCH_BATCH', 8),
  rootBatchSize: intEnv('COMPACT_ROOT_BATCH', 5),

  // Idle session detection
  idleMinutes: intEnv('COMPACT_IDLE_MINUTES', 15),
  minLeavesForBranch: intEnv('COMPACT_MIN_LEAFS', 5),
  minBranchesForRoot: intEnv('COMPACT_MIN_BRANCHES', 3),

  // Stale-partial flush: once a conversation has been idle this long it is
  // treated as final, so its leftover below-floor tail (1..MIN_BATCH_SIZE-1
  // unsummarized messages, which the normal idle sweep skips by design) is
  // flushed into a leaf summary anyway. Default 4 days. staleMinBatch is the
  // floor for that flush — 2, not 1, so lone singleton conversations (already
  // optimally represented as their own embedded message row) don't spawn a
  // near-redundant summary per ping.
  staleMinutes: intEnv('COMPACT_STALE_MINUTES', 4 * 24 * 60),
  staleMinBatch: intEnv('COMPACT_STALE_MIN_BATCH', 2),

  // Tool-synth
  toolSynthEndpoint: process.env.TOOL_SYNTH_ENDPOINT ?? requireEnv('RIVETOS_COMPACTOR_URL'),
  toolSynthModel:
    process.env.TOOL_SYNTH_MODEL ?? process.env.RIVETOS_COMPACTOR_MODEL ?? 'rivet-refined-v5',
} as const
