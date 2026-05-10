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

  // Batch sizes (worker-local — library exports only absolute budgets)
  leafBatchSize: intEnv('COMPACT_LEAF_BATCH', 10),
  branchBatchSize: intEnv('COMPACT_BRANCH_BATCH', 8),
  rootBatchSize: intEnv('COMPACT_ROOT_BATCH', 5),

  // Idle session detection
  idleMinutes: intEnv('COMPACT_IDLE_MINUTES', 15),
  minUnsummarized: intEnv('COMPACT_MIN_UNSUMMARIZED', 50),
  minLeavesForBranch: intEnv('COMPACT_MIN_LEAFS', 5),
  minBranchesForRoot: intEnv('COMPACT_MIN_BRANCHES', 3),

  // Tool-synth
  toolSynthEndpoint: process.env.TOOL_SYNTH_ENDPOINT ?? requireEnv('RIVETOS_COMPACTOR_URL'),
  toolSynthModel: process.env.TOOL_SYNTH_MODEL ?? process.env.RIVETOS_COMPACTOR_MODEL ?? 'rivet-refined-v5',
} as const
