/**
 * `delegate_task` and `list_agents` for CLI harnesses.
 *
 * A single-host RivetHub user has no in-process runtime agents, and the
 * gateway route needs an mTLS client cert once local dens serve TLS. This
 * talks to Postgres directly: a preset becomes the harness-session row
 * slice 3 creates; a config.yaml agent id becomes a chat-loop row pinned
 * to the newest online mesh node that hosts it (`delegateRemoteViaTasks`).
 *
 * Mesh reads are a bounded `parseMeshFile` of `<meshDir>/mesh.json`
 * (`RIVETOS_MESH_DIR`, else the shared dir). A read that exceeds
 * {@link ROSTER_READ_BOUND_MS} is abandoned: `list_agents` says the mesh is
 * unavailable and a preset on this node still runs. The parsed file is cached
 * with its mtime so the hot path does not read it again within that bound.
 * A hung read is not stored on the request path and is not started a second
 * time. A permanently wedged read (the syscall never returns) stays
 * unavailable for the process lifetime by design — one libuv thread stays
 * pinned, and retrying would pin more.
 * `FileMeshRegistry` is not constructed — it needs TLS material and starts
 * heartbeats. The engine is given one registry at construction whose
 * `getNodes` consults this loader. A parsed file, or the last good snapshot,
 * is returned as nodes. A missing, unreadable, or timed-out read with no
 * snapshot is no mesh registry: a preset whose node equals this node still
 * runs, because the node name mirrors boot; any other node is refused.
 * `list_agents` labels "this node" only on that exact match.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import {
  createCachedPresetResolver,
  PgAgentPresetStore,
  type AgentPresetStore,
} from '@rivetos/agent-registry'
import {
  CRITERIA_POLICY_OFF,
  NoMeshRegistryError,
  PgTaskStore,
  PresetDelegationEngine,
  ROSTER_READ_BOUND_MS,
  createTaskCompletionWaiter,
  harnessExecutorGap,
  normalizeCriteria,
  settleDelegatedTask,
  type PresetRosterEntry,
  type TaskCompletionWaiter,
  type TaskRow,
  type TaskStore,
} from '@rivetos/core'
import type { ToolExecuteContext, ToolRegistration } from '@rivetos/mcp'
import {
  parseMeshFile,
  type DelegationRequest,
  type DelegationResult,
  type MeshNode,
  type MeshRegistry,
} from '@rivetos/types'
import { z } from 'zod'

/** Same cap as `PresetDelegationEngine`'s default. The next depth, not the parent's. */
const MAX_CHAIN_DEPTH = 3
/**
 * Non-UUID `RIVETOS_TASK_ID`. The next delegation is the last the cap allows
 * (`depth === MAX_CHAIN_DEPTH`), instead of starting a fresh chain at 0.
 */
const FAIL_CLOSED_PARENT_DEPTH = MAX_CHAIN_DEPTH - 1
/** Tool default. The engine's own unset default is 30 minutes; we always pass this. */
const DEFAULT_TIMEOUT_MS = 1_200_000
const MAX_TIMEOUT_MS = 1_800_000
/** Matches the grace both delegation engines add on top of `timeoutMs`. */
const WAIT_GRACE_MS = 5_000
/**
 * `pg.Pool` connect budget. A black-holed host must not stall sidecar startup
 * for the kernel TCP timeout (~2 min). The probe then fails, tools are
 * skipped, and the server still binds.
 */
export const DELEGATE_POOL_CONNECTION_TIMEOUT_MS = 5_000
const DELEGATE_POOL_MAX = 2
const CLIENT_ABORT_TEXT = '[killed] delegate_task aborted by the client'
/** Postgres accepts any hex 8-4-4-4-12 uuid, and rejects everything else. */
const TASK_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const

/**
 * HTTP and unix-socket mode have no per-harness `RIVETOS_TASK_ID` (that env
 * belongs to the spawned sidecar, not the shared server). Registering
 * `delegate_task` there would run every call at depth 0.
 */
export const DELEGATE_TASK_HTTP_REASON =
  'delegate_task needs a per-harness stdio sidecar for the chain guard'

export interface DelegateToolsDeps {
  store: TaskStore
  waiter: TaskCompletionWaiter
  /** Built WITHOUT `executors` — the sidecar judges coverage from the mesh. */
  presets: PresetDelegationEngine
  /**
   * Read-only roster. `'unavailable'` when the bounded mesh read timed out
   * or failed — `list_agents` says so instead of listing runtime agents.
   * `[]` when the file is absent.
   */
  meshNodes: () => Promise<MeshNode[] | 'unavailable'>
  nodeName: string
  requestedBy: string
  /**
   * Loop guard. Absent at depth 0 (not inside a delegated harness).
   * `id` is omitted when the parent id is not a UUID (fail closed: depth
   * only, no `parentTaskId` stamped onto the child).
   */
  parentTask?: { id?: string; chainDepth: number }
  now?: () => number
  log?: (msg: string) => void
}

export interface DelegateToolsHandle {
  tools: ToolRegistration[]
  /**
   * Stops the waiter. The handle from `createDelegateToolsFromEnv` also
   * ends the pool that function opened. A second call is a no-op.
   */
  close(): Promise<void>
}

interface DelegateCall {
  toAgent: string
  task: string
  context?: string[]
  timeoutMs: number
  model?: string
}

interface DelegateStores {
  tasks: TaskStore & { isReady(): Promise<boolean> }
  presets: AgentPresetStore
}

type MeshView =
  | { kind: 'ok'; nodes: MeshNode[] }
  | { kind: 'absent' }
  | { kind: 'unavailable'; lastGood?: MeshNode[] }

/**
 * `delegate_task` only in stdio mode. HTTP/socket keeps `list_agents`.
 * `skippedDelegateTask` is the signal to log {@link DELEGATE_TASK_HTTP_REASON}.
 */
export function delegateToolsForTransport(
  tools: readonly ToolRegistration[],
  stdioMode: boolean,
): { tools: ToolRegistration[]; skippedDelegateTask: boolean } {
  if (stdioMode) return { tools: [...tools], skippedDelegateTask: false }
  const kept = tools.filter((tool) => tool.name !== 'delegate_task')
  return {
    tools: kept,
    skippedDelegateTask: kept.length !== tools.length,
  }
}

/**
 * Boot's node name is `mesh.node_name || HOSTNAME || 'local'`.
 * The sidecar has no config file, so `RIVETOS_NODE_NAME` stands in for
 * `mesh.node_name` and must equal it when that is set. Blank values are
 * ignored. Never `os.hostname()`: a systemd unit with no HOSTNAME stamps
 * presets `node: 'local'`.
 */
export function sidecarNodeName(env: NodeJS.ProcessEnv): string {
  const named = env.RIVETOS_NODE_NAME?.trim()
  if (named) return named
  const host = env.HOSTNAME?.trim()
  if (host) return host
  return 'local'
}

/**
 * Directory that contains `mesh.json`. `RIVETOS_MESH_DIR` wins over the
 * shared dir. Boot writes the file to `mesh.storage_dir ?? sharedDir()`.
 */
export function resolveMeshDir(env: NodeJS.ProcessEnv, shared: string): string {
  const override = env.RIVETOS_MESH_DIR?.trim()
  return override ? override : shared
}

export function delegatePoolConfig(pgUrl: string): pg.PoolConfig {
  return {
    connectionString: pgUrl,
    max: DELEGATE_POOL_MAX,
    connectionTimeoutMillis: DELEGATE_POOL_CONNECTION_TIMEOUT_MS,
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Zod already checks this on the wire. Direct callers get the same rejection. */
function readDelegateCall(args: Record<string, unknown>): DelegateCall | string {
  const toAgent = args.to_agent
  const task = args.task
  if (typeof toAgent !== 'string' || toAgent.length === 0) return '[failed] to_agent is required'
  if (typeof task !== 'string' || task.length === 0) return '[failed] task is required'

  let context: string[] | undefined
  if (args.context !== undefined) {
    if (!isStringArray(args.context)) return '[failed] context must be an array of strings'
    if (args.context.length > 0) context = args.context
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (args.timeout_ms !== undefined) {
    const value = args.timeout_ms
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > MAX_TIMEOUT_MS
    ) {
      return '[failed] timeout_ms must be a positive integer up to 1800000'
    }
    timeoutMs = value
  }

  let model: string | undefined
  if (args.model !== undefined) {
    if (typeof args.model !== 'string') return '[failed] model must be a string'
    if (args.model.trim() !== '') model = args.model
  }

  return {
    toAgent,
    task,
    timeoutMs,
    ...(context ? { context } : {}),
    ...(model ? { model } : {}),
  }
}

function delegationGoal(task: string, context: string[] | undefined): string {
  if (!context || context.length === 0) return task
  return `${task}\n\nContext:\n${context.join('\n')}`
}

/** Same line shape as `PresetDelegationEngine.rosterText`. */
function formatRosterLine(entry: PresetRosterEntry): string {
  const where = entry.local ? `${entry.node} — this node` : entry.node || 'unknown'
  const dir = entry.directory ? `, dir ${entry.directory}` : ''
  if (!entry.harnessId) {
    const place = entry.node ? ` (on ${where}${dir})` : ''
    return `- ${entry.name}${place} — no harness configured`
  }
  let line = `- ${entry.name} (agent: ${entry.harnessId} on ${where}${dir})`
  if (entry.implemented === false) {
    line += ` — NO headless executor: ${entry.gap ?? harnessExecutorGap(entry.harnessId)}`
  }
  return line
}

function formatAgentListing(
  entries: PresetRosterEntry[],
  nodes: MeshNode[],
  runtimeUnavailable: boolean,
): string {
  const presetText =
    entries.length === 0 ? '(none)' : entries.map((entry) => formatRosterLine(entry)).join('\n')
  const runtimeLines: string[] = []
  if (!runtimeUnavailable) {
    for (const node of nodes) {
      if (node.status !== 'online') continue
      for (const id of node.agents) runtimeLines.push(`- ${id} (${node.name})`)
    }
  }
  const runtimeText = runtimeUnavailable
    ? '(mesh unavailable)'
    : runtimeLines.length === 0
      ? '(none)'
      : runtimeLines.join('\n')
  return (
    `${presetText}\n\n` +
    `Runtime agents (mesh):\n${runtimeText}\n\n` +
    'to_agent accepts a preset name or id, or a runtime agent id.'
  )
}

/** Online hosts of `agentId`, newest `lastSeen` first. A tie keeps the earlier node. */
function pickOnlineHost(nodes: MeshNode[], agentId: string): MeshNode | undefined {
  let best: MeshNode | undefined
  for (const node of nodes) {
    if (node.status !== 'online' || !node.agents.includes(agentId)) continue
    if (!best || node.lastSeen > best.lastSeen) best = node
  }
  return best
}

/**
 * A queued row that nobody claims is the single-host failure mode: the
 * runtime on that node is not running. `settleDelegatedTask` already killed
 * the row; this adds the sentence operators need.
 */
function annotateTimeout(result: DelegationResult, node: string): DelegationResult {
  if (result.status !== 'timeout') return result
  if (result.response.includes('no runner claimed or finished it in time')) return result
  return {
    ...result,
    response:
      `${result.response} — no runner claimed or finished it in time — ` +
      `is the rivetos runtime running on "${node}"?`,
  }
}

/** Same shape as the in-process `delegate_task` tool. */
function formatDelegationResult(result: DelegationResult): string {
  const meta: string[] = []
  if (result.durationMs != null) meta.push(`${String(result.durationMs)}ms`)
  if (result.toolsUsed?.length) {
    meta.push(`tools: ${[...new Set(result.toolsUsed)].join(', ')}`)
  }
  if (result.usage) {
    meta.push(`tokens: ${String(result.usage.promptTokens + result.usage.completionTokens)}`)
  }
  const metaLine = meta.length
    ? `\n\n---\n_Delegation [${result.status}]: ${meta.join(' | ')}_`
    : ''
  if (result.status === 'completed') return result.response + metaLine
  return `[${result.status}] ${result.response}${metaLine}`
}

function readOnlyMeshRegistry(getNodes: () => Promise<MeshNode[]>): MeshRegistry {
  return {
    register: () => Promise.resolve(),
    deregister: () => Promise.resolve(),
    heartbeat: () => Promise.resolve(),
    getNodes,
    getNode: () => Promise.resolve(undefined),
    findByAgent: (agentId) =>
      getNodes().then((nodes) => nodes.filter((node) => node.agents.includes(agentId))),
    findByCapability: () => Promise.resolve([]),
    findByProvider: () => Promise.resolve([]),
    sync: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
  }
}

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  // Abort returns without awaiting `work`. Observe a late rejection so a
  // create that fails after the client is gone cannot crash the process.
  void work.catch(() => undefined)
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort)
    if (signal.aborted) {
      onAbort()
      return
    }
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(errorMessage(err)))
      },
    )
  })
}

/**
 * The row this call inserted, if it did. `done` stays pending until `note`
 * or `finish` so an abort can wait out an in-flight `create` (it cannot be
 * cancelled) and then kill exactly that row.
 */
function trackCreatedRow(): {
  note(rowId: string): void
  done: Promise<string | undefined>
  finish(): void
} {
  let rowId: string | undefined
  let settled = false
  let resolveDone: (id: string | undefined) => void = () => undefined
  const done = new Promise<string | undefined>((resolve) => {
    resolveDone = (id) => {
      if (settled) return
      settled = true
      resolve(id)
    }
  })
  return {
    note(id: string) {
      rowId = id
      resolveDone(id)
    },
    done,
    finish() {
      resolveDone(rowId)
    },
  }
}

/**
 * One registry for the life of the handle. `getNodes` reads the bounded
 * loader on every call, so concurrent delegations cannot race a flag and the
 * engine does not have to keep its config object by reference.
 * No snapshot throws {@link NoMeshRegistryError} — same refusal as no registry.
 */
function dynamicMeshRegistry(load: () => Promise<MeshView>): MeshRegistry {
  return readOnlyMeshRegistry(async () => {
    const view = await load()
    if (view.kind === 'ok') return view.nodes
    if (view.kind === 'unavailable' && view.lastGood) return view.lastGood
    throw new NoMeshRegistryError()
  })
}

function raceBound<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout')
    }, ms)
    timer.unref()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * One mesh.json snapshot. The request path races the read against `boundMs`
 * and drops its reference on timeout so a hung `readFile` is not awaited
 * again. A second call while that read is still hung does not start another.
 * A fresh mtime match skips `readFile` entirely.
 */
function createBoundedMeshReader(opts: {
  path: string
  boundMs: number
  readFile: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ mtimeMs: number }>
  log: (msg: string) => void
}): { load: () => Promise<MeshView> } {
  type Cached =
    | { kind: 'ok'; nodes: MeshNode[]; mtimeMs: number; at: number }
    | { kind: 'absent'; at: number }
    | { kind: 'error'; at: number }

  let cached: Cached | undefined
  let lastGood: MeshNode[] | undefined
  /** True once a read has outlived the bound. Cleared if that read later finishes. */
  let hung = false
  let attempt: Promise<void> | undefined
  let attemptAt = 0
  let loggedTimeout = false
  let loggedAbsent = false
  let loggedBad = false

  function viewFromCache(): MeshView {
    if (!cached || cached.kind === 'error') {
      return lastGood ? { kind: 'unavailable', lastGood } : { kind: 'unavailable' }
    }
    if (cached.kind === 'absent') return { kind: 'absent' }
    return { kind: 'ok', nodes: cached.nodes }
  }

  function unavailableView(): MeshView {
    return lastGood ? { kind: 'unavailable', lastGood } : { kind: 'unavailable' }
  }

  async function readOnce(): Promise<void> {
    try {
      const info = await opts.stat(opts.path)
      if (cached?.kind === 'ok' && cached.mtimeMs === info.mtimeMs) {
        cached = { ...cached, at: Date.now() }
        hung = false
        return
      }
      const raw = await opts.readFile(opts.path)
      const nodes = Object.values(parseMeshFile(raw, opts.path).nodes)
      cached = { kind: 'ok', nodes, mtimeMs: info.mtimeMs, at: Date.now() }
      lastGood = nodes
      hung = false
    } catch (err: unknown) {
      if (errorCode(err) === 'ENOENT') {
        cached = { kind: 'absent', at: Date.now() }
        lastGood = undefined
        hung = false
        if (!loggedAbsent) {
          loggedAbsent = true
          opts.log(
            'mesh.json unavailable (ENOENT) — no mesh file; only presets on this node can run',
          )
        }
        return
      }
      cached = { kind: 'error', at: Date.now() }
      hung = false
      if (!loggedBad) {
        loggedBad = true
        const code = errorCode(err)
        const detail = code ? `${code}: ${errorMessage(err)}` : errorMessage(err)
        opts.log(`mesh.json unavailable (${detail}) — runtime agent roster empty`)
      }
    }
  }

  async function load(): Promise<MeshView> {
    if (hung) return unavailableView()
    const now = Date.now()
    if (cached && now - cached.at < opts.boundMs) return viewFromCache()

    // A Promise is always truthy, so absence is `=== undefined`.
    let pending: Promise<void>
    if (attempt === undefined) {
      attemptAt = now
      // Not retained past the bound. The fs callback roots the promise until
      // the syscall finishes; a late finish updates `cached` inside readOnce.
      pending = readOnce()
      attempt = pending
    } else {
      pending = attempt
    }

    const elapsed = Date.now() - attemptAt
    const giveUp = (): MeshView => {
      hung = true
      // Drop the field so nothing in this object awaits the hung read, and
      // so the next call cannot start a second readFile while `hung` is set.
      attempt = undefined
      if (!loggedTimeout) {
        loggedTimeout = true
        opts.log(
          `mesh.json read exceeded ${String(opts.boundMs)}ms (${opts.path}) — runtime agent roster unavailable`,
        )
      }
      return unavailableView()
    }
    if (elapsed >= opts.boundMs) return giveUp()

    const outcome = await raceBound(pending, opts.boundMs - elapsed)
    if (attempt === pending) attempt = undefined
    if (outcome === 'timeout') return giveUp()
    return viewFromCache()
  }

  return { load }
}

async function resolveParentTask(
  store: TaskStore,
  parentTaskId: string | undefined,
  log: (msg: string) => void,
): Promise<DelegateToolsDeps['parentTask']> {
  // Empty string is "no parent" and does not fall through to the process env,
  // so tests can opt out without unsetting the operator's shell.
  const raw = parentTaskId !== undefined ? parentTaskId : process.env.RIVETOS_TASK_ID
  const parentId = raw?.trim()
  if (!parentId) return undefined
  if (!TASK_ID_UUID.test(parentId)) {
    log(
      `RIVETOS_TASK_ID "${parentId}" is not a UUID — delegate tools registered at chain depth ${String(FAIL_CLOSED_PARENT_DEPTH)} (fail closed)`,
    )
    return { chainDepth: FAIL_CLOSED_PARENT_DEPTH }
  }
  const row: TaskRow | undefined = await store.get(parentId)
  if (!row) {
    log(`RIVETOS_TASK_ID ${parentId} not in ros_tasks — treating chain depth as 0`)
    return undefined
  }
  return { id: row.id, chainDepth: row.chainDepth }
}

export function createDelegateTools(deps: DelegateToolsDeps): DelegateToolsHandle {
  const now = deps.now ?? Date.now

  async function renderAgents(): Promise<string> {
    // One bound, not two: the roster refresh and the mesh read share the loader.
    const [mesh, entries] = await Promise.all([
      deps.meshNodes(),
      deps.presets.rosterEntriesFresh({ timeoutMs: ROSTER_READ_BOUND_MS }),
    ])
    if (mesh === 'unavailable') return formatAgentListing(entries, [], true)
    return formatAgentListing(entries, mesh, false)
  }

  async function delegateRuntime(
    call: DelegateCall,
    host: MeshNode,
    parentDepth: number,
    onCreated?: (rowId: string) => void,
  ): Promise<DelegationResult> {
    const startTime = now()
    const goal = delegationGoal(call.task, call.context)
    const describe = `Remote delegation to ${call.toAgent} on ${host.name}`
    // Same node as the sidecar: this is a local handoff, matching the preset
    // path's `origin: 'tool'`. Anywhere else stays a mesh delegation.
    const origin = host.name === deps.nodeName ? 'tool' : 'mesh'
    try {
      const row = await deps.store.create({
        goal,
        executor: 'chat-loop',
        agentId: call.toAgent,
        origin,
        nodeAffinity: host.name,
        requestedBy: deps.requestedBy,
        chainDepth: parentDepth + 1,
        ...(deps.parentTask?.id ? { parentTaskId: deps.parentTask.id } : {}),
        maxAttempts: 1,
        budget: { maxWallClockMs: call.timeoutMs },
        acceptanceCriteria: normalizeCriteria({ goal, origin }, CRITERIA_POLICY_OFF),
        spec: {
          delegation: true,
          meshFrom: deps.nodeName,
          excludeTools: ['delegate_task'],
          ...(call.model ? { model: call.model } : {}),
        },
      })
      onCreated?.(row.id)
      return await settleDelegatedTask({
        store: deps.store,
        waiter: deps.waiter,
        rowId: row.id,
        waitMs: call.timeoutMs + WAIT_GRACE_MS,
        startTime,
        describe,
        now,
      })
    } catch (err: unknown) {
      return {
        status: 'failed',
        response: `${describe} failed: ${errorMessage(err)}`,
        durationMs: now() - startTime,
      }
    }
  }

  const tools: ToolRegistration[] = [
    {
      name: 'delegate_task',
      description:
        'Delegate work to a RivetHub agent (preset name or id) or a runtime agent id. ' +
        'Call list_agents first. A preset name or id wins when it also matches a runtime agent id. ' +
        'Presets run as a harness session in the agent directory; ' +
        'runtime agents run as a chat-loop on the newest online node that hosts them. ' +
        'Waits until the task finishes or the timeout elapses (default 20 minutes, max 30). ' +
        'Set the client tool-call timeout above that wait — Codex tool_timeout_sec ' +
        '(its default of 60s aborts the call) and Claude Code MCP timeout. ' +
        'An aborted call kills the row.',
      inputSchema: {
        to_agent: z
          .string()
          .min(1)
          .describe('RivetHub agent name or id, or a runtime agent id — call list_agents first'),
        task: z.string().min(1).describe('What the delegate should do'),
        context: z
          .array(z.string())
          .optional()
          .describe('Extra context lines included with the task'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(1_800_000)
          .optional()
          .describe('How long to wait, in milliseconds (default 20 minutes, max 30)'),
        model: z.string().optional().describe('Optional model override for this delegation'),
      },
      async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext): Promise<string> {
        try {
          const call = readDelegateCall(args)
          if (typeof call === 'string') return call

          const parentDepth = deps.parentTask?.chainDepth ?? 0
          const nextDepth = parentDepth + 1
          if (nextDepth > MAX_CHAIN_DEPTH) {
            const depth = String(nextDepth)
            const cap = String(MAX_CHAIN_DEPTH)
            return `[failed] delegation chain too deep (${depth} > ${cap})`
          }

          const signal = ctx?.signal
          if (signal?.aborted) return CLIENT_ABORT_TEXT

          const mesh = await deps.meshNodes()
          if (signal?.aborted) return CLIENT_ABORT_TEXT
          const nodes = mesh === 'unavailable' ? [] : mesh

          const request: DelegationRequest = {
            fromAgent: deps.requestedBy,
            toAgent: call.toAgent,
            task: call.task,
            timeoutMs: call.timeoutMs,
            ...(call.context ? { context: call.context } : {}),
            ...(call.model ? { model: call.model } : {}),
          }

          const preset = await deps.presets.find(call.toAgent)
          if (signal?.aborted) return CLIENT_ABORT_TEXT

          const created = trackCreatedRow()
          const work = (async (): Promise<string> => {
            try {
              if (preset) {
                const settled = await deps.presets.delegate(
                  request,
                  preset,
                  parentDepth,
                  deps.parentTask?.id,
                  (rowId) => {
                    created.note(rowId)
                  },
                )
                const node = preset.node && preset.node.length > 0 ? preset.node : deps.nodeName
                return formatDelegationResult(annotateTimeout(settled, node))
              }

              const host = pickOnlineHost(nodes, call.toAgent)
              if (!host) {
                const listing = await renderAgents()
                return (
                  `[failed] Agent "${call.toAgent}" not found in RivetHub presets or runtime agents.\n\n` +
                  listing
                )
              }

              const settled = await delegateRuntime(call, host, parentDepth, (rowId) => {
                created.note(rowId)
              })
              return formatDelegationResult(annotateTimeout(settled, host.name))
            } finally {
              created.finish()
            }
          })()

          if (!signal) return await work
          const outcome = await untilAbort(work, signal)
          if (outcome !== 'aborted') return outcome
          // `create` cannot be cancelled. Wait it out so a row that lands
          // after the abort is still killed, and so a failed insert is the
          // result the client sees instead of `[killed]`.
          const rowId = await created.done
          if (rowId) {
            await deps.store.requestKill(rowId)
            return CLIENT_ABORT_TEXT
          }
          return await work
        } catch (err: unknown) {
          return `[failed] delegate_task failed: ${errorMessage(err)}`
        }
      },
    },
    {
      name: 'list_agents',
      description:
        'List RivetHub agents (presets) and runtime agents on online mesh nodes. ' +
        'Pass a preset name or id, or a runtime agent id, as delegate_task to_agent. ' +
        'A preset name or id wins when it also matches a runtime agent id.',
      annotations: READ_ONLY,
      inputSchema: {},
      async execute(): Promise<string> {
        try {
          return await renderAgents()
        } catch (err: unknown) {
          return `[failed] list_agents failed: ${errorMessage(err)}`
        }
      },
    },
  ]

  return {
    tools,
    async close() {
      await deps.waiter.stop()
    },
  }
}

export async function createDelegateToolsFromEnv(opts: {
  pgUrl: string
  /** Directory containing `mesh.json` (`RIVETOS_MESH_DIR` or the shared dir). */
  sharedDir: string
  nodeName: string
  requestedBy: string
  /**
   * Parent ros_tasks id. When omitted, `RIVETOS_TASK_ID` is read. Pass `''`
   * to force depth 0 even if that env var is set.
   */
  parentTaskId?: string
  /**
   * When false (HTTP/socket), do not open the completion waiter. `list_agents`
   * only needs the store; LISTEN exists for `delegate_task`. The tool is still
   * returned — the caller strips it. Default true.
   */
  registerDelegateTask?: boolean
  log?: (msg: string) => void
  /** Test seam. Default `new pg.Pool(delegatePoolConfig(pgUrl))`. */
  createPool?: (config: pg.PoolConfig) => pg.Pool
  /** Test seam. Default `PgTaskStore` + `PgAgentPresetStore`. */
  openStores?: (pool: pg.Pool) => DelegateStores
  /** Test seam. Default `createTaskCompletionWaiter`. */
  createWaiter?: (store: TaskStore) => TaskCompletionWaiter
  /** Test seam. Default `fs.readFile`. */
  readFile?: (path: string) => Promise<string>
  /** Test seam. Default `fs.stat`. */
  stat?: (path: string) => Promise<{ mtimeMs: number }>
  /** Test seam. Default {@link ROSTER_READ_BOUND_MS}. */
  meshBoundMs?: number
}): Promise<DelegateToolsHandle | undefined> {
  const log = opts.log ?? (() => undefined)
  const createPool = opts.createPool ?? ((config: pg.PoolConfig) => new pg.Pool(config))
  const pool = createPool(delegatePoolConfig(opts.pgUrl))
  // An idle client error with no listener crashes the process.
  pool.on('error', (err: Error) => {
    log(`delegate pool error: ${err.message}`)
  })

  let waiter: TaskCompletionWaiter | undefined
  let releasePool = true
  try {
    const opened = opts.openStores
      ? opts.openStores(pool)
      : { tasks: new PgTaskStore(pool), presets: new PgAgentPresetStore(pool) }
    const store = opened.tasks
    const presetStore = opened.presets

    try {
      if (!(await store.isReady())) {
        log('ros_tasks missing — delegate_task disabled')
        return undefined
      }
      if (!(await presetStore.isReady())) {
        log('ros_agent_presets missing — delegate_task disabled')
        return undefined
      }
    } catch (err: unknown) {
      log(`delegate tools skipped — postgres probe failed: ${errorMessage(err)}`)
      return undefined
    }

    let parentTask: DelegateToolsDeps['parentTask']
    try {
      parentTask = await resolveParentTask(store, opts.parentTaskId, log)
    } catch (err: unknown) {
      log(`delegate tools skipped — postgres probe failed: ${errorMessage(err)}`)
      return undefined
    }

    // HTTP/socket never registers delegate_task, so it must not open LISTEN.
    const registerDelegateTask = opts.registerDelegateTask !== false
    waiter = registerDelegateTask
      ? (
          opts.createWaiter ??
          ((tasks: TaskStore) => createTaskCompletionWaiter({ store: tasks, pgUrl: opts.pgUrl }))
        )(store)
      : {
          wait: () => Promise.resolve(undefined),
          stop: () => Promise.resolve(),
        }

    const meshPath = join(opts.sharedDir, 'mesh.json')
    const mesh = createBoundedMeshReader({
      path: meshPath,
      boundMs: Math.max(1, opts.meshBoundMs ?? ROSTER_READ_BOUND_MS),
      readFile:
        opts.readFile ??
        ((path) => {
          return readFile(path, 'utf8')
        }),
      stat:
        opts.stat ??
        (async (path) => {
          const info = await stat(path)
          return { mtimeMs: info.mtimeMs }
        }),
      log,
    })
    const presets = new PresetDelegationEngine({
      resolver: createCachedPresetResolver(presetStore, { log }),
      taskStore: store,
      waiter,
      nodeName: opts.nodeName,
      meshRegistry: dynamicMeshRegistry(() => mesh.load()),
    })

    const meshNodes = async (): Promise<MeshNode[] | 'unavailable'> => {
      const view = await mesh.load()
      if (view.kind === 'ok') return view.nodes
      // Absent is an empty roster, not "unavailable": the file is not there.
      // Remote presets are refused by the engine (no mesh registry). A timed-out
      // or unreadable read stays unavailable; a last-good snapshot still lets
      // delegation judge remote nodes via the registry, not via this listing.
      if (view.kind === 'absent') return []
      return 'unavailable'
    }

    const inner = createDelegateTools({
      store,
      waiter,
      presets,
      meshNodes,
      nodeName: opts.nodeName,
      requestedBy: opts.requestedBy,
      ...(parentTask ? { parentTask } : {}),
      log,
    })
    releasePool = false
    let closed = false
    return {
      tools: inner.tools,
      async close() {
        if (closed) return
        closed = true
        try {
          await inner.close()
        } finally {
          await pool.end()
        }
      },
    }
  } finally {
    if (releasePool) {
      await waiter?.stop().catch(() => undefined)
      await pool.end().catch(() => undefined)
    }
  }
}
