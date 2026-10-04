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
export { SqliteWikiIndex, SqliteWikiExtractor, EXTRACT_WIKI_TASK } from './wiki.js'
export {
  SqliteWikiMaintenance,
  CONSOLIDATE_WIKI_TASK,
  RECOMPILE_WIKI_TASK,
} from './wiki-maintenance.js'
export type { ConsolidateOptions, RecompileOptions } from './wiki-maintenance.js'
export type { WikiTopicRow, WikiTopicHit, TopicResolution } from './wiki.js'
export { SqliteRoutingMemory, userFromSessionKey, isSafeUserId, foldUserId } from './routing.js'
export { exportSqliteMemory, importSqliteMemory } from './portability.js'
export type { SqliteExportOptions, SqliteImportOptions, SqliteImportResult } from './portability.js'
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

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginManifest } from '@rivetos/types'
import { DEFAULT_OWNER_USER_ID, loadUsersRegistry, sharedDir, sharedPath } from '@rivetos/types'
import type { Tool } from '@rivetos/types'
import { BLOCKED, SqliteRoutingMemory, foldUserId, isSafeUserId } from './routing.js'
import { SqliteMemory, resolveSqlitePath } from './adapter.js'
import { clampEmbedTimeoutMs } from '@rivetos/memory-core'
import { MIN_BATCH_SIZE } from '@rivetos/memory-core'
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from './compaction.js'
import type { EmbedConfig } from './embed.js'
import type { LlmConfig } from './llm.js'
import type { NativeTagger } from './tagging.js'
export type { NativeTagger } from './tagging.js'

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
    // The users registry names the node owner and anyone else who has an
    // account here. Only those other users are routed or refused: the
    // owner's own turns carry other ids (the default owner id, platform ids)
    // and must keep working. The registry is re-read (at most every few
    // seconds), because den reloads it too: a user added while the node runs
    // must not land in the owner's file.
    const registry = registryView(ctx.env, (line) => {
      ctx.logger.warn(line)
    })
    const otherUsers = (): ReadonlySet<string> => registry.others()
    const wiki = resolveWikiConfig(cfg, ctx.env)
    const { error: taggingError, ...tagging } = resolveTaggingConfig(cfg, ctx.env)
    if (taggingError) ctx.logger.error(`memory.sqlite: ${taggingError}`)
    if (tagging.enabled && !tagging.llm && !tagging.native && !compactor) tagging.enabled = false
    if (wiki.extraction && !compactor) {
      ctx.logger.warn(
        'memory.sqlite: wiki extraction is on but no compactor endpoint is set; no pages will be written',
      )
    }
    const log = (line: string): void => {
      ctx.logger.warn(line)
    }
    const shared = {
      tagging,
      ...(cfg.project_rule === false ? { projectRule: null } : {}),
      ...(embed ? { embed } : {}),
      ...(compactor ? { compactor, compaction: resolveCompactionSettings(ctx.env) } : {}),
      ...(typeof cfg.workers === 'boolean' ? { workers: cfg.workers } : {}),
      log,
    }
    const main = new SqliteMemory({ path, userId: registry.owner(), otherUsers, wiki, ...shared })

    // One file per other user, beside the owner's. A user whose store cannot
    // be opened is blocked, never sent to the owner's file. With
    // `per_user_files: false` there are no user stores and those users are
    // refused outright.
    const perUser = cfg.per_user_files !== false
    const usersDir = resolveUsersDir(cfg, path)
    const openUser = (id: string): SqliteMemory | typeof BLOCKED => {
      try {
        if (!isSafeUserId(id)) throw new Error('the user id is not usable as a directory name')
        // Two ids that fold to one directory name on a case-insensitive
        // filesystem would share a file: neither gets one.
        const twin = [...registry.others(), registry.owner()].find(
          (other) => other !== id && foldUserId(other) === foldUserId(id),
        )
        if (twin !== undefined) {
          throw new Error(`the id differs from "${twin}" only by case or trailing dots`)
        }
        // The same for a directory an earlier user left behind: on such a
        // filesystem this id would open that user's file.
        const left = usersDir === ':memory:' ? undefined : leftoverTwin(usersDir, id)
        if (left !== undefined) {
          throw new Error(
            `the directory of an earlier user "${left}" differs from this id only by case or trailing dots`,
          )
        }
        return new SqliteMemory({
          path: usersDir === ':memory:' ? ':memory:' : join(usersDir, id, 'memory.sqlite'),
          userId: id,
          // In this user's file, everyone else (the owner included) is the other user.
          otherUsers: () =>
            new Set([...registry.others(), registry.owner()].filter((other) => other !== id)),
          wiki: { dir: join(wiki.dir, 'users', id), extraction: wiki.extraction },
          ...shared,
        })
      } catch (err) {
        ctx.logger.error(
          `memory.sqlite: store for user "${id}" is not available; their memory is blocked: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return BLOCKED
      }
    }
    const userStores = new Map<string, SqliteMemory | typeof BLOCKED>()
    if (perUser) for (const id of registry.others()) userStores.set(id, openUser(id))
    // Always routed when per-user files are on, so a user who joins the
    // registry later gets a store the first time they are seen.
    const routing = perUser
      ? new SqliteRoutingMemory(main, userStores, openUser, (id) => registry.others().has(id))
      : undefined
    ctx.registerMemory(routing ?? main)

    // The agent's memory tools. Writing tools (append, ingest) are served over
    // HTTP for capture clients, not handed to the agent. A turn den resolved
    // to another registry user is served from that user's own store, or
    // refused when they have none: never from the owner's.
    const toolsByStore = new WeakMap<SqliteMemory, Map<string, Tool>>()
    const toolFor = (store: SqliteMemory, name: string): Tool | undefined => {
      let tools = toolsByStore.get(store)
      if (!tools) {
        tools = new Map(
          store
            .backend()
            .readTools()
            .map((t) => [t.name, t]),
        )
        toolsByStore.set(store, tools)
      }
      return tools.get(name)
    }
    for (const tool of main.backend().readTools()) {
      ctx.registerTool({
        ...tool,
        async execute(args, signal, context) {
          const uid = context?.session?.userId
          if (uid) {
            if (routing) {
              // The same decision every other surface makes; throws for a
              // user whose store is blocked.
              const store = routing.storeFor(uid)
              if (store !== main) {
                const routed = toolFor(store, tool.name)
                if (!routed) throw new Error(`memory for user "${uid}" is unavailable on this node`)
                return routed.execute(args, signal, context)
              }
            } else if (registry.others().has(uid)) {
              throw new Error(
                `memory for user "${uid}" is unavailable on this node (per-user files are off)`,
              )
            }
          }
          return tool.execute(args, signal, context)
        },
      })
    }
    ctx.registerShutdown(async () => {
      for (const store of routing?.stores() ?? [main]) {
        await store.stopWorkers()
        store.close()
      }
    })
    const opened = [...userStores.values()].filter((store) => store !== BLOCKED).length
    if (opened > 0) {
      ctx.logger.info(
        `sqlite memory: ${String(opened)} other user(s) each have their own file under ${usersDir}`,
      )
    }
    if (compactor) {
      ctx.logger.info(`sqlite memory: summarizing with ${compactor.model}`)
    }
    if (tagging.enabled) {
      ctx.logger.info(
        `sqlite memory: suggesting tags with ${tagging.native?.model ?? tagging.llm?.model ?? compactor?.model ?? '?'}`,
      )
    }
    if (wiki.extraction && compactor) {
      ctx.logger.info(`sqlite memory: mining summaries into the wiki at ${wiki.dir}`)
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

    if (!perUser && registry.others().size > 0) {
      ctx.logger.warn(
        `memory.sqlite: per-user files are off — ${String(registry.others().size)} other user(s) in the users registry get no memory from this store: their sessions are not stored or read, and search, context and tools refuse them`,
      )
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
 * A live view of the users registry: who the owner is, and everyone else it
 * has ever listed while this process ran.
 *
 * - Fresh on every call: the registry files are stat'ed each time and re-read
 *   when one changed, so a user den starts stamping is known here at once.
 * - Never forgets: a user seen once stays an "other user" until restart. A
 *   registry file caught half-written (or emptied, or made invalid) cannot
 *   send that user's traffic to the owner's file, and a user removed from
 *   the registry keeps being routed to their own store, never the owner's.
 *
 * Without a registry the owner is `RIVETOS_USER_ID` (or the default owner
 * id) and there is nobody else.
 */
function registryView(
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): { owner: () => string; others: () => ReadonlySet<string> } {
  const fallback = env.RIVETOS_USER_ID?.trim() || DEFAULT_OWNER_USER_ID
  // The files loadUsersRegistry may read, in its order.
  const candidates = [
    env.RIVETOS_USERS_FILE?.trim() || undefined,
    join(env.RIVETOS_SHARED_DIR?.trim() || sharedDir(), 'rivetos', 'users.json'),
    join(homedir(), '.rivetos', 'users.json'),
  ].filter((p): p is string => p !== undefined)
  const signature = (): string =>
    candidates
      .map((path) => {
        try {
          const st = statSync(path)
          return `${String(st.mtimeMs)}:${String(st.size)}`
        } catch {
          return '-'
        }
      })
      .join('|')

  let owner = fallback
  const others = new Set<string>()
  let seen: string | undefined
  const current = (): void => {
    const now = signature()
    if (now === seen) return
    seen = now
    try {
      const registry = loadUsersRegistry(env)
      if (!registry) return
      const listed = Object.keys(registry.users).filter((id) => id !== registry.ownerUserId)
      // A registry that lists only its owner after one that listed more is
      // what a half-written or invalid file looks like: keep who we know.
      if (listed.length > 0 || others.size === 0) owner = registry.ownerUserId
      for (const id of listed) others.add(id)
      // The owner is never an "other user", whatever an earlier read said.
      others.delete(owner)
    } catch (err) {
      warn(
        `memory.sqlite: the users registry could not be read (${err instanceof Error ? err.message : String(err)}); keeping the users already known`,
      )
    }
  }
  return {
    owner: () => {
      current()
      return owner
    },
    others: () => {
      current()
      return others
    },
  }
}

/**
 * Where the other users' files go: `users_dir`, or `users/` beside the
 * owner's file. Each user gets `<dir>/<userId>/memory.sqlite`.
 */
/** A directory under `usersDir` whose name is not `id` but folds to it. */
function leftoverTwin(usersDir: string, id: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(usersDir)
  } catch {
    return undefined
  }
  return names.find((name) => name !== id && foldUserId(name) === foldUserId(id))
}

export function resolveUsersDir(cfg: Record<string, unknown>, ownerPath: string): string {
  if (typeof cfg.users_dir === 'string' && cfg.users_dir.trim() !== '') {
    return resolveSqlitePath(cfg.users_dir.trim())
  }
  return ownerPath === ':memory:' ? ':memory:' : join(dirname(ownerPath), 'users')
}

/**
 * Where the wiki's page files live and whether summaries are mined into
 * them. Config first, then the variables the Postgres pipeline reads
 * (`WIKI_DIR`, `WIKI_EXTRACTION=1`). Extraction is off unless asked for.
 */
export function resolveWikiConfig(
  cfg: Record<string, unknown>,
  env: Record<string, string | undefined>,
): { dir: string; extraction: boolean } {
  const configured =
    typeof cfg.wiki_dir === 'string' && cfg.wiki_dir.trim() !== ''
      ? cfg.wiki_dir.trim()
      : env.WIKI_DIR?.trim() || undefined
  const dir = configured ? resolveSqlitePath(configured) : sharedPath('wiki')
  const extraction =
    typeof cfg.wiki_extraction === 'boolean' ? cfg.wiki_extraction : env.WIKI_EXTRACTION === '1'
  return { dir, extraction }
}

/**
 * Tag suggestions: on unless `tagging: false` or `SESSION_TAGGING=0`, the
 * switch the Postgres worker reads. The tagger uses the compactor's endpoint
 * unless it is given one of its own (`tagger_endpoint` + `tagger_model`, or
 * `RIVETOS_TAGGER_URL` + `RIVETOS_TAGGER_MODEL`), spoken to as a chat model
 * or, with `tagger_wire_shape: native`, as a classifier service. An unknown
 * shape, or `native` without an endpoint and model, turns tagging off and
 * returns the reason as `error`.
 */
export function resolveTaggingConfig(
  cfg: Record<string, unknown>,
  env: Record<string, string | undefined>,
): { enabled: boolean; llm?: LlmConfig; native?: NativeTagger; error?: string } {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const enabled =
    typeof cfg.tagging === 'boolean'
      ? cfg.tagging
      : !/^(0|false|no|off)$/i.test((env.SESSION_TAGGING ?? '').trim())
  if (!enabled) return { enabled: false }
  const endpoint = str(cfg.tagger_endpoint) ?? str(env.RIVETOS_TAGGER_URL)
  const model = str(cfg.tagger_model) ?? str(env.RIVETOS_TAGGER_MODEL)
  const shape = (
    str(cfg.tagger_wire_shape) ??
    str(env.RIVETOS_TAGGER_WIRE_SHAPE) ??
    'openai'
  ).toLowerCase()
  // A setting that cannot be honoured turns tagging off and says why; it
  // does not take the rest of memory down with it, and it does not send the
  // chat prompt to a classifier.
  if (shape !== 'openai' && shape !== 'native') {
    return {
      enabled: false,
      error: `tagger_wire_shape must be "openai" or "native", not "${shape}"; tag suggestions are off`,
    }
  }
  if (!endpoint || !model) {
    if (shape === 'native') {
      return {
        enabled: false,
        error:
          'tagger_wire_shape "native" needs tagger_endpoint and tagger_model; tag suggestions are off',
      }
    }
    return { enabled: true }
  }
  const apiKey = str(cfg.tagger_api_key) ?? str(env.RIVETOS_TAGGER_API_KEY)
  // `native`: the endpoint is a classifier service that takes the summary and
  // the vocabulary in one POST, as the Postgres worker's native shape does.
  if (shape === 'native') {
    return { enabled: true, native: { url: endpoint, model, ...(apiKey ? { apiKey } : {}) } }
  }
  return { enabled: true, llm: { endpoint, model, ...(apiKey ? { apiKey } : {}) } }
}
