/**
 * @rivetos/memory-sqlite
 *
 * SQLite Memory backend — the in-process Memory contract plus the wider
 * MemoryBackend surface (capture, the hub's Memory pages, tools over HTTP)
 * on one WAL file.
 */

export {
  SqliteMemory,
  EMBED_TARGET_TASK,
  resolveSqlitePath,
  buildFtsMatchQuery,
  relevanceFromBm25,
  resolveTaskId,
  ensureSqliteParentDir,
  restrictSqliteFileModes,
} from './adapter.js'
export type { SqliteMemoryConfig } from './adapter.js'
export { SCHEMA, SCHEMA_VERSION } from './schema.js'
export { SqliteTagStore } from './tags.js'
export { SqliteJobQueue, JobRunner, retryDelayMs } from './jobs.js'
export type { Job, JobHandler, EnqueueOptions, Sweep } from './jobs.js'
export { LlmClient, LlmTruncatedError, LlmPermanentError } from './llm.js'
export type { LlmConfig, LlmAnswer } from './llm.js'
export { SqliteCompactor, COMPACT_TASK, DEFAULT_COMPACTION_SETTINGS } from './compaction.js'
export type { CompactionSettings } from './compaction.js'
export { EmbedClient } from './embed.js'
export type { EmbedConfig, EmbedOutcome } from './embed.js'
export { ExactScanIndex, encodeVector, decodeVector } from './vectors.js'
export type { VectorIndex, VectorHit, VectorFilter } from './vectors.js'
export type {
  SqliteAddTagInput,
  SqliteListTagsOptions,
  SqlitePendingTag,
  SqliteTagCount,
} from './tags.js'

import { homedir } from 'node:os'
import type { PluginManifest } from '@rivetos/types'
import { loadUsersRegistry } from '@rivetos/types'
import { SqliteMemory, resolveSqlitePath } from './adapter.js'
import { clampEmbedTimeoutMs } from '@rivetos/memory-core'
import { MIN_BATCH_SIZE } from '@rivetos/memory-core'
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from './compaction.js'
import type { EmbedConfig } from './embed.js'
import type { LlmConfig } from './llm.js'

export const manifest: PluginManifest = {
  type: 'memory',
  name: 'sqlite',
  async register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const rawPath = typeof cfg.path === 'string' ? cfg.path.trim() : ''
    if (!rawPath) {
      ctx.logger.warn('memory.sqlite.path is missing — sqlite memory not registered')
      return
    }

    const path = resolveSqlitePath(rawPath)
    const embed = await resolveEmbedConfig(cfg, ctx.env, (line) => {
      ctx.logger.warn(line)
    })
    const compactor = await resolveCompactorConfig(cfg, ctx.env, (line) => {
      ctx.logger.warn(line)
    })
    // Everyone the users registry lists besides the owner. Only these are
    // refused: the owner's own turns carry other ids (the default owner id,
    // platform ids), and must keep working.
    const otherUsers = otherUsersOf(ctx.env, (line) => {
      ctx.logger.warn(line)
    })
    const memory = new SqliteMemory({
      path,
      otherUsers,
      ...(embed ? { embed } : {}),
      ...(compactor ? { compactor, compaction: resolveCompactionSettings(ctx.env) } : {}),
      ...(typeof cfg.workers === 'boolean' ? { workers: cfg.workers } : {}),
      log: (line) => {
        ctx.logger.warn(line)
      },
    })
    ctx.registerMemory(memory)
    // The agent's memory tools. Writing tools (append, ingest) are served over
    // HTTP for capture clients, not handed to the agent. The file is the node
    // owner's: a turn den resolved to another registry user gets a refusal.
    for (const tool of memory.backend().readTools()) {
      ctx.registerTool({
        ...tool,
        async execute(args, signal, context) {
          const uid = context?.session?.userId
          if (uid && otherUsers.has(uid)) {
            throw new Error(
              `memory for user "${uid}" is unavailable (this node's memory is a single-user store)`,
            )
          }
          return tool.execute(args, signal, context)
        },
      })
    }
    ctx.registerShutdown(async () => {
      await memory.stopWorkers()
      memory.close()
    })
    if (compactor) {
      ctx.logger.info(`sqlite memory: summarizing with ${compactor.model}`)
    }
    if (embed) {
      ctx.logger.info(
        `sqlite memory: embedding with ${embed.model}, vector search on` +
          (cfg.workers === false ? ' (workers off: rows are queued, not embedded)' : ''),
      )
    }

    const display =
      path === ':memory:'
        ? ':memory:'
        : path.startsWith(homedir())
          ? `~${path.slice(homedir().length)}`
          : path
    ctx.logger.info(`sqlite memory ready at ${display}`)

    // Phase 1 is single-file / single-user. Warn when a users registry defines
    // additional accounts so operators know transcripts are not isolated.
    try {
      const registry = loadUsersRegistry(ctx.env)
      if (registry) {
        const others = Object.keys(registry.users).filter((id) => id !== registry.ownerUserId)
        if (others.length > 0) {
          ctx.logger.warn(
            `memory.sqlite is single-user in phase 1 — ${others.length} routed user(s) in the users registry get no memory from this store (no search, context or tools); their own turns are still written to it`,
          )
        }
      }
    } catch {
      // registry load failures are unrelated to opening the store
    }
  },
}

/**
 * Embedding settings, config first then environment — the same keys and
 * variables the Postgres backend reads, under `memory.sqlite`. Returns
 * undefined when no endpoint is configured (full-text search only).
 */
export async function resolveEmbedConfig(
  cfg: Record<string, unknown>,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): Promise<EmbedConfig | undefined> {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const endpoint = str(cfg.embed_endpoint) ?? str(env.RIVETOS_EMBED_URL)
  if (!endpoint) return undefined
  const model = str(cfg.embed_model) ?? str(env.RIVETOS_EMBED_MODEL)
  if (!model) {
    throw new Error(
      'RIVETOS_EMBED_MODEL (or memory.sqlite.embed_model) is required when an embedding URL is set',
    )
  }
  const { createTokenSource, parseTokenCommandArgv, parseEmbedWireShape } =
    await import('@rivetos/token-command')
  const wire = parseEmbedWireShape(str(cfg.embed_wire_shape) ?? str(env.RIVETOS_EMBED_WIRE_SHAPE))
  if (typeof wire === 'object') warn(`memory.sqlite.embed_wire_shape: ${wire.error}`)
  // Config value (an argv array), else the worker's variable (a JSON argv string).
  let rawArgv: unknown = cfg.embed_token_command
  if (rawArgv === undefined && str(env.RIVETOS_EMBED_TOKEN_COMMAND)) {
    try {
      rawArgv = JSON.parse(env.RIVETOS_EMBED_TOKEN_COMMAND ?? '') as unknown
    } catch {
      warn('RIVETOS_EMBED_TOKEN_COMMAND must be a JSON argv array (no shell string)')
    }
  }
  const argv = parseTokenCommandArgv(rawArgv)
  if (typeof argv === 'string') warn(`memory.sqlite.embed_token_command: ${argv}`)
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const out: EmbedConfig = {
    endpoint,
    model,
    wireShape: typeof wire === 'object' ? 'openai' : wire,
  }
  // Opt-in only: no fallback to a general provider key, which would send that
  // credential to whatever endpoint is configured here.
  const apiKey = str(cfg.embed_api_key) ?? str(env.RIVETOS_EMBED_API_KEY)
  if (apiKey) out.apiKey = apiKey
  if (Array.isArray(argv)) {
    const ttlMs = num(cfg.embed_token_ttl_ms)
    out.tokenSource = createTokenSource({ argv, ...(ttlMs !== undefined ? { ttlMs } : {}) })
  }
  const expected = num(cfg.embed_expected_dims) ?? num(env.RIVETOS_EMBED_EXPECTED_DIMS)
  if (expected !== undefined) out.expectedDims = expected
  // Clamped to the same 500 ms – 60 s range as the Postgres backend.
  const timeout = cfg.embed_timeout_ms ?? env.RIVETOS_EMBED_TIMEOUT_MS
  if (timeout !== undefined) out.timeoutMs = clampEmbedTimeoutMs(timeout)
  // Not trimmed: a prefix like "query: " needs its trailing space.
  const rawInstruction = cfg.embed_query_instruction ?? env.RIVETOS_EMBED_QUERY_INSTRUCTION
  // Any string is passed through, the empty one included: "" turns the prefix
  // off. Unset leaves the client's default (the same instruction as Postgres).
  if (typeof rawInstruction === 'string') out.queryInstruction = rawInstruction
  return out
}

/**
 * Summarization endpoint, config first then environment — the variables the
 * Postgres compaction worker reads. Undefined when none is configured: no
 * summaries are written and nothing is sent anywhere.
 */
export async function resolveCompactorConfig(
  cfg: Record<string, unknown>,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): Promise<LlmConfig | undefined> {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const endpoint = str(cfg.compactor_endpoint) ?? str(env.RIVETOS_COMPACTOR_URL)
  if (!endpoint) return undefined
  const model = str(cfg.compactor_model) ?? str(env.RIVETOS_COMPACTOR_MODEL)
  if (!model) {
    throw new Error(
      'RIVETOS_COMPACTOR_MODEL (or memory.sqlite.compactor_model) is required when a compactor URL is set',
    )
  }
  const out: LlmConfig = { endpoint, model }
  const apiKey = str(cfg.compactor_api_key) ?? str(env.RIVETOS_COMPACTOR_API_KEY)
  if (apiKey) out.apiKey = apiKey
  const { createTokenSource, parseTokenCommandArgv } = await import('@rivetos/token-command')
  const argv = parseTokenCommandArgv(cfg.compactor_token_command)
  if (typeof argv === 'string') warn(`memory.sqlite.compactor_token_command: ${argv}`)
  if (Array.isArray(argv)) out.tokenSource = createTokenSource({ argv })
  const timeout = Number(cfg.compactor_timeout_ms)
  // Clamped to 5 seconds – 60 minutes: a tiny value would fail every call.
  if (Number.isFinite(timeout) && timeout > 0) {
    out.timeoutMs = Math.min(Math.max(timeout, 5000), 60 * 60 * 1000)
  }
  return out
}

/** Batch sizes and idle thresholds from the worker's `COMPACT_*` variables. */
export function resolveCompactionSettings(
  env: Record<string, string | undefined>,
): Partial<CompactionSettings> {
  const out: Partial<CompactionSettings> = {}
  const set = (key: keyof CompactionSettings, name: string): void => {
    const n = Number(env[name])
    if (env[name] !== undefined && Number.isInteger(n) && n > 0) out[key] = n
  }
  set('leafBatch', 'COMPACT_LEAF_BATCH')
  set('branchBatch', 'COMPACT_BRANCH_BATCH')
  set('rootBatch', 'COMPACT_ROOT_BATCH')
  set('minLeavesForBranch', 'COMPACT_MIN_LEAFS')
  set('minBranchesForRoot', 'COMPACT_MIN_BRANCHES')
  set('idleMinutes', 'COMPACT_IDLE_MINUTES')
  set('staleMinutes', 'COMPACT_STALE_MINUTES')
  set('staleMinBatch', 'COMPACT_STALE_MIN_BATCH')
  // A leaf window below the floor could never be written: the sweep would
  // queue a job every pass that does nothing.
  if (out.leafBatch !== undefined && out.leafBatch < MIN_BATCH_SIZE) delete out.leafBatch
  // Likewise a parent batch smaller than the number of children it needs.
  const d = DEFAULT_COMPACTION_SETTINGS
  if ((out.branchBatch ?? d.branchBatch) < (out.minLeavesForBranch ?? d.minLeavesForBranch)) {
    delete out.branchBatch
    delete out.minLeavesForBranch
  }
  if ((out.rootBatch ?? d.rootBatch) < (out.minBranchesForRoot ?? d.minBranchesForRoot)) {
    delete out.rootBatch
    delete out.minBranchesForRoot
  }
  return out
}

/**
 * The users registry's users other than the owner. Empty when there is no
 * registry. A registry that cannot be read is reported: den may still be
 * resolving users from it, and this process then cannot tell them apart.
 */
function otherUsersOf(
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): Set<string> {
  try {
    const registry = loadUsersRegistry(env)
    if (!registry) return new Set()
    return new Set(Object.keys(registry.users).filter((id) => id !== registry.ownerUserId))
  } catch (err) {
    warn(
      `memory.sqlite: the users registry could not be read (${err instanceof Error ? err.message : String(err)}); ` +
        'routed users cannot be told apart from the owner and are not refused',
    )
    return new Set()
  }
}
