/**
 * `delegate_task` and `list_agents` for CLI harnesses.
 *
 * A single-host RivetHub user has no in-process runtime agents, and the
 * gateway route needs an mTLS client cert once local dens serve TLS. This
 * talks to Postgres directly: a preset becomes the harness-session row
 * slice 3 creates; a config.yaml agent id becomes a chat-loop row pinned
 * to the newest online mesh node that hosts it (`delegateRemoteViaTasks`).
 *
 * Mesh reads are a one-shot `parseMeshFile` of `<sharedDir>/mesh.json`.
 * `FileMeshRegistry` is not constructed — it needs TLS material and starts
 * heartbeats. The engine's `meshRegistry` is still the full `MeshRegistry`
 * (slice 3 is under review); only `getNodes` and `findByAgent` do real work.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { createCachedPresetResolver, PgAgentPresetStore } from '@rivetos/agent-registry'
import {
  CRITERIA_POLICY_OFF,
  PgTaskStore,
  PresetDelegationEngine,
  ROSTER_READ_BOUND_MS,
  createTaskCompletionWaiter,
  harnessExecutorGap,
  normalizeCriteria,
  settleDelegatedTask,
  type PresetRosterEntry,
  type TaskCompletionWaiter,
  type TaskStore,
} from '@rivetos/core'
import type { ToolRegistration } from '@rivetos/mcp'
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
/** Tool default. The engine's own unset default is 30 minutes; we always pass this. */
const DEFAULT_TIMEOUT_MS = 1_200_000
const MAX_TIMEOUT_MS = 1_800_000
/** Matches the grace both delegation engines add on top of `timeoutMs`. */
const WAIT_GRACE_MS = 5_000

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const

export interface DelegateToolsDeps {
  store: TaskStore
  waiter: TaskCompletionWaiter
  /** Built WITHOUT `executors` — the sidecar judges coverage from the mesh. */
  presets: PresetDelegationEngine
  /** Read-only roster. `[]` when no mesh file. */
  meshNodes: () => Promise<MeshNode[]>
  nodeName: string
  requestedBy: string
  /** Loop guard. Absent at depth 0 (not inside a delegated harness). */
  parentTask?: { id: string; chainDepth: number }
  now?: () => number
  log?: (msg: string) => void
}

export interface DelegateToolsHandle {
  tools: ToolRegistration[]
  /**
   * Stops the waiter. The handle from `createDelegateToolsFromEnv` also
   * ends the pool that function opened.
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

function formatAgentListing(entries: PresetRosterEntry[], nodes: MeshNode[]): string {
  const presetText =
    entries.length === 0 ? '(none)' : entries.map((entry) => formatRosterLine(entry)).join('\n')
  const runtimeLines: string[] = []
  for (const node of nodes) {
    if (node.status !== 'online') continue
    for (const id of node.agents) runtimeLines.push(`- ${id} (${node.name})`)
  }
  const runtimeText = runtimeLines.length === 0 ? '(none)' : runtimeLines.join('\n')
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

export function createDelegateTools(deps: DelegateToolsDeps): DelegateToolsHandle {
  const now = deps.now ?? Date.now

  async function renderAgents(): Promise<string> {
    const [entries, nodes] = await Promise.all([
      deps.presets.rosterEntriesFresh({ timeoutMs: ROSTER_READ_BOUND_MS }),
      deps.meshNodes(),
    ])
    return formatAgentListing(entries, nodes)
  }

  async function delegateRuntime(
    call: DelegateCall,
    host: MeshNode,
    parentDepth: number,
  ): Promise<DelegationResult> {
    const startTime = now()
    const goal = delegationGoal(call.task, call.context)
    const describe = `Remote delegation to ${call.toAgent} on ${host.name}`
    try {
      const row = await deps.store.create({
        goal,
        executor: 'chat-loop',
        agentId: call.toAgent,
        origin: 'mesh',
        nodeAffinity: host.name,
        requestedBy: deps.requestedBy,
        chainDepth: parentDepth + 1,
        ...(deps.parentTask ? { parentTaskId: deps.parentTask.id } : {}),
        maxAttempts: 1,
        budget: { maxWallClockMs: call.timeoutMs },
        acceptanceCriteria: normalizeCriteria({ goal, origin: 'mesh' }, CRITERIA_POLICY_OFF),
        spec: {
          delegation: true,
          meshFrom: deps.nodeName,
          excludeTools: ['delegate_task'],
          ...(call.model ? { model: call.model } : {}),
        },
      })
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
        response: `${describe} failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: now() - startTime,
      }
    }
  }

  const tools: ToolRegistration[] = [
    {
      name: 'delegate_task',
      description:
        'Delegate work to a RivetHub agent (preset name or id) or a runtime agent id. ' +
        'Call list_agents first. Presets run as a harness session in the agent directory; ' +
        'runtime agents run as a chat-loop on the newest online node that hosts them. ' +
        'Waits until the task finishes or the timeout elapses (default 20 minutes).',
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
      async execute(args: Record<string, unknown>): Promise<string> {
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

          const request: DelegationRequest = {
            fromAgent: deps.requestedBy,
            toAgent: call.toAgent,
            task: call.task,
            timeoutMs: call.timeoutMs,
            ...(call.context ? { context: call.context } : {}),
            ...(call.model ? { model: call.model } : {}),
          }

          const preset = await deps.presets.find(call.toAgent)
          if (preset) {
            const settled = await deps.presets.delegate(
              request,
              preset,
              parentDepth,
              deps.parentTask?.id,
            )
            const node = preset.node && preset.node.length > 0 ? preset.node : deps.nodeName
            return formatDelegationResult(annotateTimeout(settled, node))
          }

          const host = pickOnlineHost(await deps.meshNodes(), call.toAgent)
          if (!host) {
            const listing = await renderAgents()
            return (
              `[failed] Agent "${call.toAgent}" not found in RivetHub presets or runtime agents.\n\n` +
              listing
            )
          }

          const settled = await delegateRuntime(call, host, parentDepth)
          return formatDelegationResult(annotateTimeout(settled, host.name))
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          return `[failed] delegate_task failed: ${message}`
        }
      },
    },
    {
      name: 'list_agents',
      description:
        'List RivetHub agents (presets) and runtime agents on online mesh nodes. ' +
        'Pass a preset name or id, or a runtime agent id, as delegate_task to_agent.',
      annotations: READ_ONLY,
      inputSchema: {},
      async execute(): Promise<string> {
        try {
          return await renderAgents()
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          return `[failed] list_agents failed: ${message}`
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
  sharedDir: string
  nodeName: string
  requestedBy: string
  parentTaskId?: string
  log?: (msg: string) => void
}): Promise<DelegateToolsHandle | undefined> {
  const log = opts.log ?? (() => undefined)
  const pool = new pg.Pool({ connectionString: opts.pgUrl, max: 2 })
  // An idle client error with no listener crashes the process.
  pool.on('error', (err: Error) => {
    log(`delegate pool error: ${err.message}`)
  })

  let waiter: TaskCompletionWaiter | undefined
  let releasePool = true
  try {
    const store = new PgTaskStore(pool)
    if (!(await store.isReady())) {
      log('ros_tasks missing — delegate_task disabled')
      return undefined
    }
    const presetStore = new PgAgentPresetStore(pool)
    if (!(await presetStore.isReady())) {
      log('ros_agent_presets missing — delegate_task disabled')
      return undefined
    }

    const parentId = (opts.parentTaskId ?? process.env.RIVETOS_TASK_ID)?.trim()
    let parentTask: DelegateToolsDeps['parentTask']
    if (parentId) {
      const row = await store.get(parentId)
      if (!row) {
        log(`RIVETOS_TASK_ID ${parentId} not in ros_tasks — treating chain depth as 0`)
      } else {
        parentTask = { id: row.id, chainDepth: row.chainDepth }
      }
    }

    let meshErrorLogged = false
    const meshNodes = async (): Promise<MeshNode[]> => {
      const path = join(opts.sharedDir, 'mesh.json')
      try {
        const raw = await readFile(path, 'utf8')
        return Object.values(parseMeshFile(raw, path).nodes)
      } catch (err: unknown) {
        if (!meshErrorLogged) {
          meshErrorLogged = true
          const message = err instanceof Error ? err.message : String(err)
          log(`mesh.json unavailable (${message}) — runtime agent roster empty`)
        }
        return []
      }
    }

    waiter = createTaskCompletionWaiter({ store, pgUrl: opts.pgUrl })
    const presets = new PresetDelegationEngine({
      resolver: createCachedPresetResolver(presetStore, { log }),
      taskStore: store,
      waiter,
      nodeName: opts.nodeName,
      meshRegistry: readOnlyMeshRegistry(meshNodes),
    })
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
    return {
      tools: inner.tools,
      async close() {
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
