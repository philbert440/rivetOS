/**
 * Memory, wiki, and delegate tools backed by the local den over HTTPS.
 *
 * Tool names, descriptions, and input schemas match the Postgres factories,
 * including `delegate_task`: the den's task route resolves `to_agent` with
 * the same rules (`agent@node` included), so the definition is shared.
 * `execute` returns the den's ToolResult string as-is. Content-part arrays
 * are wrapped the same way `adaptRivetTool` wraps them: a bare array has no
 * `.content`, and the v2 mount would drop it. Postgres pools are not opened.
 */

import { GatewayError, RivetGateway } from '@rivetos/gateway-client'
import type { ToolExecuteContext, ToolExecuteResult, ToolRegistration } from '@rivetos/mcp'
import { toolResultToStructured } from '@rivetos/mcp'
import { MAX_CHAIN_DEPTH, harnessExecutorGap } from '@rivetos/core'
import type {
  CatalogAgent,
  MemoryToolArgsByName,
  MemoryToolName,
  TaskCreateRequest,
  TaskWire,
  ToolResult,
  WikiMissBody,
} from '@rivetos/types'

import {
  TAGS_WRITE_ACTIONS,
  memoryBrowseInputSchema,
  memoryGetFullInputSchema,
  memoryTagsDescription,
  memoryTagsInputSchema,
  memorySearchInputSchema,
  memoryStatsInputSchema,
  tagsReadOnlyRefusal,
} from './memory.js'
import { memoryAppendInputSchema, memoryIngestSessionInputSchema } from './memory-write.js'
import { formatWikiRead, type WikiReadSection } from './wiki-read-format.js'

import { wikiSearchDefinition, wikiReadDefinition } from './wiki.js'
import { denDelegateTaskDefinition, listAgentsDefinition } from './delegate.js'

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const
const WRITE_ANNOTATIONS = { readOnlyHint: false, idempotentHint: true } as const
const SLUG_RE = /^[a-z0-9-]{1,80}$/
const TASK_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Tool default. Same as the pg delegate tool. */
const DEFAULT_TIMEOUT_MS = 1_200_000
const MAX_TIMEOUT_MS = 1_800_000
/** Fail-closed child depth: parent is treated as `MAX_CHAIN_DEPTH - 1`. */
const FAIL_CLOSED_CHILD_DEPTH = MAX_CHAIN_DEPTH

const MEMORY_SEARCH_DESCRIPTION =
  'Search RivetOS persistent memory (conversation history + summaries). ' +
  'Hybrid FTS + semantic + temporal scoring with auto-expansion of summary hits ' +
  'to their source messages. Use this to find past decisions, prior context, ' +
  'or "what did we say about X" before asking the user. ' +
  'Mirrors the in-process `memory_search` tool exposed to local agents. ' +
  'Truncated hits include a `memory_get_full id=` handle — call that tool to ' +
  'recover the full capture payload.'

const MEMORY_BROWSE_DESCRIPTION =
  'Browse RivetOS conversation messages chronologically. Unlike memory_search ' +
  '(which ranks by relevance), this returns messages in time order. By default ' +
  'excludes role=tool rows (pass include_tools=true to see tool calls/results). Use to ' +
  'review what happened in a session, catch up on recent activity, or read a ' +
  'specific conversation by ID. For time-bounded questions ("today", "yesterday", ' +
  '"this morning"), prefer window= over raw since/before so local midnights convert correctly to UTC. ' +
  'Capture-truncated rows append `→ memory_get_full id=` — use that tool for the full payload.'

const MEMORY_STATS_DESCRIPTION =
  'RivetOS memory system health check — message/summary counts, embedding queue ' +
  'depth, unsummarized messages, compaction status, missing summaries, and ' +
  'breakdowns by agent/role/kind. Use to diagnose memory issues or check if ' +
  'background jobs are keeping up.'

const MEMORY_GET_FULL_DESCRIPTION =
  'Fetch the complete, untruncated payload for a memory row whose content or ' +
  'tool_result was elided at capture time (rows marked "…[truncated]" / ' +
  '"⚠ truncated at capture" by memory_search or memory_browse). Pass the row ' +
  'id from that hint. Re-reads the original capture JSONL line from disk — not ' +
  'a generic file reader. Mirrors the in-process `memory_get_full` tool.'

const MEMORY_APPEND_DESCRIPTION =
  'Append one message to RivetOS memory. Tags source/agent/persona from args or env. Optional event_id for idempotency. Content and tool_result are capped at 16,000 chars; the elided tail is unrecoverable. Returns truncated+full_content_length when truncation occurs.'

const MEMORY_INGEST_DESCRIPTION =
  'Ingest a session into RivetOS memory. Skips ordinals and event_ids already stored for that session. Content is capped at 16,000 chars; the elided tail is unrecoverable. Returns truncated+full_content_length when truncation occurs.'

/** Methods the den tools call. `RivetGateway` satisfies this; tests pass a fake. */
export interface DenToolsGateway {
  memoryTool: RivetGateway['memoryTool']
  wikiIndex: RivetGateway['wikiIndex']
  wikiRead: RivetGateway['wikiRead']
  catalogAgents: RivetGateway['catalogAgents']
  createTask: RivetGateway['createTask']
  waitTask: RivetGateway['waitTask']
  getTask: RivetGateway['getTask']
  killTask: RivetGateway['killTask']
}

export interface DenToolsOptions {
  denUrl: string
  enableWrite: boolean
  enableDelegate: boolean
  requestedBy: string
  parentTaskId?: string
  log: (message: string) => void
  /** Test seam. Default `new RivetGateway({ baseUrl: denUrl })`. */
  gateway?: DenToolsGateway
}

export interface DenToolsHandle {
  tools: ToolRegistration[]
  /** No Postgres pool. Resolves immediately. */
  close: () => Promise<void>
}

interface DelegateCall {
  toAgent: string
  task: string
  context?: string[]
  timeoutMs: number
  model?: string
}

/** MCP hands zod-parsed JSON. The client types are the same fields. */
function wireArgs<N extends MemoryToolName>(
  _name: N,
  args: Record<string, unknown>,
): MemoryToolArgsByName[N] {
  return args as unknown as MemoryToolArgsByName[N]
}

function relay(result: ToolResult): ToolExecuteResult {
  if (typeof result === 'string') return result
  return toolResultToStructured(result)
}

function unreachable(denUrl: string, err: GatewayError): string {
  return `den unreachable at ${denUrl}: ${err.message}`
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runMemory<N extends MemoryToolName>(
  gateway: DenToolsGateway,
  denUrl: string,
  name: N,
  args: MemoryToolArgsByName[N],
  signal: AbortSignal | undefined,
  write: boolean,
): Promise<ToolExecuteResult> {
  try {
    return relay(await gateway.memoryTool(name, args, signal))
  } catch (err: unknown) {
    if (isAbort(err)) throw err
    if (err instanceof GatewayError) {
      if (err.status === 0) return unreachable(denUrl, err)
      if (write && err.status === 404) return `den has no write tools mounted (${err.message})`
      return `${name} failed: ${err.message}`
    }
    return `${name} failed: ${errorMessage(err)}`
  }
}

function formatWikiSearch(topics: Array<{ title: string; slug: string; excerpt: string }>): string {
  if (topics.length === 0) {
    return 'No wiki topics match — a gap worth filling, or try memory_search for raw history.'
  }
  // The index wire carries `excerpt` (not `currentState` / `lastVerifiedAt`).
  // Same heading shape as the pg tool; the body is the excerpt, capped at 600.
  return topics
    .map((hit) => `## ${hit.title} (${hit.slug})\n${hit.excerpt.slice(0, 600)}`)
    .join('\n\n')
}

function formatWikiMiss(slug: string, suggestions: WikiMissBody['suggestions']): string {
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.map((item) => item.slug).join(', ')}?`
      : ''
  return `No page for "${slug}" — a red link.${hint}`
}

function isPreset(agent: CatalogAgent): agent is Extract<CatalogAgent, { kind: 'preset' }> {
  return 'kind' in agent
}

function formatPresetLine(entry: Extract<CatalogAgent, { kind: 'preset' }>): string {
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

/** Same two-section text as `delegate.ts` `formatAgentListing`. */
function formatCatalogAgents(agents: CatalogAgent[]): string {
  const presets = agents.filter(isPreset)
  const runtime = agents.filter((agent) => !isPreset(agent))
  const presetText = presets.length === 0 ? '(none)' : presets.map(formatPresetLine).join('\n')
  const runtimeText =
    runtime.length === 0
      ? '(none)'
      : runtime.map((agent) => `- ${agent.id} (${agent.node})`).join('\n')
  return (
    `${presetText}\n\n` +
    `Runtime agents (mesh):\n${runtimeText}\n\n` +
    'to_agent accepts a preset name or id, or a runtime agent id (agent@node pins the node).'
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

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

function parentCreateFields(
  parentTaskId: string | undefined,
  log: (message: string) => void,
): Pick<TaskCreateRequest, 'parentTaskId' | 'chainDepth'> {
  const parentId = parentTaskId?.trim()
  if (!parentId) return { chainDepth: 1 }
  if (!TASK_ID_UUID.test(parentId)) {
    log(
      `RIVETOS_TASK_ID "${parentId}" is not a UUID — delegate tools registered at chain depth ${String(MAX_CHAIN_DEPTH - 1)} (fail closed)`,
    )
    return { chainDepth: FAIL_CLOSED_CHILD_DEPTH }
  }
  return { parentTaskId: parentId }
}

function formatSettledTask(task: SettledTask, toAgent: string, elapsedMs: number): string {
  const where = task.nodeAffinity ? ` on ${task.nodeAffinity}` : ''
  const describe = `Remote delegation to ${toAgent}${where}`
  let status: 'completed' | 'failed' | 'timeout'
  let response: string
  if (task.status === 'completed') {
    status = 'completed'
    response = task.result?.output ?? task.result?.summary ?? '[no response from remote agent]'
  } else if (task.status === 'timeout') {
    status = 'timeout'
    response = `${describe} timeout${task.error ? `: ${task.error}` : ''}`
  } else {
    status = 'failed'
    response = `${describe} ${task.status}${task.error ? `: ${task.error}` : ''}`
  }
  const meta: string[] = []
  meta.push(`${String(elapsedMs)}ms`)
  const usage = task.result?.usage ?? task.usage
  if (usage) meta.push(`tokens: ${String(usage.inputTokens + usage.outputTokens)}`)
  const metaLine = meta.length ? `\n\n---\n_Delegation [${status}]: ${meta.join(' | ')}_` : ''
  if (status === 'completed') return response + metaLine
  return `[${status}] ${response}${metaLine}`
}

interface SettledTask {
  id: string
  status: TaskWire['status']
  nodeAffinity?: string
  result?: { output?: string; summary?: string; usage?: TokenUsage }
  usage?: TokenUsage
  durationMs?: number
  error?: string
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUsage(value: unknown): value is TokenUsage | undefined {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.inputTokens === 'number' &&
      Number.isFinite(value.inputTokens) &&
      typeof value.outputTokens === 'number' &&
      Number.isFinite(value.outputTokens))
  )
}

function isTaskStatus(value: unknown): value is TaskWire['status'] {
  return (
    typeof value === 'string' &&
    ['queued', 'running', 'completed', 'failed', 'killed', 'timeout', 'awaiting-input'].includes(
      value,
    )
  )
}

function timeoutTask(body: unknown): SettledTask | undefined {
  if (!isRecord(body) || !isRecord(body.task)) return undefined
  const task = body.task
  if (typeof task.id !== 'string' || !isTaskStatus(task.status)) return undefined
  if (task.nodeAffinity !== undefined && typeof task.nodeAffinity !== 'string') return undefined
  if (task.error !== undefined && typeof task.error !== 'string') return undefined
  if (
    task.durationMs !== undefined &&
    (typeof task.durationMs !== 'number' || !Number.isFinite(task.durationMs))
  )
    return undefined
  if (!isUsage(task.usage)) return undefined
  const result = task.result
  if (
    result !== undefined &&
    (!isRecord(result) ||
      (result.output !== undefined && typeof result.output !== 'string') ||
      (result.summary !== undefined && typeof result.summary !== 'string') ||
      !isUsage(result.usage))
  )
    return undefined
  return task as unknown as SettledTask
}

export function createDenTools(opts: DenToolsOptions): DenToolsHandle {
  const gateway = opts.gateway ?? new RivetGateway({ baseUrl: opts.denUrl })
  const denUrl = opts.denUrl
  const parent = parentCreateFields(opts.parentTaskId, opts.log)

  const tools: ToolRegistration[] = [
    {
      name: 'memory_search',
      description: MEMORY_SEARCH_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: memorySearchInputSchema,
      execute(args, ctx) {
        return runMemory(
          gateway,
          denUrl,
          'memory_search',
          wireArgs('memory_search', args),
          ctx?.signal,
          false,
        )
      },
    },
    {
      name: 'memory_browse',
      description: MEMORY_BROWSE_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: memoryBrowseInputSchema,
      execute(args, ctx) {
        return runMemory(
          gateway,
          denUrl,
          'memory_browse',
          wireArgs('memory_browse', args),
          ctx?.signal,
          false,
        )
      },
    },
    {
      name: 'memory_stats',
      description: MEMORY_STATS_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: memoryStatsInputSchema,
      execute(args, ctx) {
        return runMemory(
          gateway,
          denUrl,
          'memory_stats',
          wireArgs('memory_stats', args),
          ctx?.signal,
          false,
        )
      },
    },
    {
      name: 'memory_get_full',
      description: MEMORY_GET_FULL_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: memoryGetFullInputSchema,
      execute(args, ctx) {
        return runMemory(
          gateway,
          denUrl,
          'memory_get_full',
          wireArgs('memory_get_full', args),
          ctx?.signal,
          false,
        )
      },
    },
    {
      name: 'memory_tags',
      description: memoryTagsDescription(opts.enableWrite),
      annotations: opts.enableWrite ? WRITE_ANNOTATIONS : READ_ONLY,
      inputSchema: memoryTagsInputSchema,
      execute(args, ctx) {
        // The den's tool route can decide and edit. This sidecar only passes
        // those through when its write surface is on, like the pg transport.
        const action = typeof args.action === 'string' ? args.action : 'pending'
        if (!opts.enableWrite && TAGS_WRITE_ACTIONS.has(action)) {
          return Promise.resolve(tagsReadOnlyRefusal(action))
        }
        return runMemory(
          gateway,
          denUrl,
          'memory_tags',
          wireArgs('memory_tags', args),
          ctx?.signal,
          opts.enableWrite && TAGS_WRITE_ACTIONS.has(action),
        )
      },
    },
  ]

  if (opts.enableWrite) {
    tools.push(
      {
        name: 'memory_append',
        description: MEMORY_APPEND_DESCRIPTION,
        annotations: WRITE_ANNOTATIONS,
        inputSchema: memoryAppendInputSchema,
        execute(args, ctx) {
          return runMemory(
            gateway,
            denUrl,
            'memory_append',
            wireArgs('memory_append', args),
            ctx?.signal,
            true,
          )
        },
      },
      {
        name: 'memory_ingest_session',
        description: MEMORY_INGEST_DESCRIPTION,
        annotations: WRITE_ANNOTATIONS,
        inputSchema: memoryIngestSessionInputSchema,
        execute(args, ctx) {
          return runMemory(
            gateway,
            denUrl,
            'memory_ingest_session',
            wireArgs('memory_ingest_session', args),
            ctx?.signal,
            true,
          )
        },
      },
    )
  }

  tools.push(
    {
      name: 'wiki_search',
      ...wikiSearchDefinition,
      async execute(args, ctx): Promise<string> {
        const query = typeof args.query === 'string' ? args.query : ''
        const limit = typeof args.limit === 'number' ? args.limit : 5
        try {
          const index = await gateway.wikiIndex({ q: query, limit }, ctx?.signal)
          return formatWikiSearch(index.topics)
        } catch (err: unknown) {
          if (isAbort(err)) throw err
          if (err instanceof GatewayError && err.status === 0) return unreachable(denUrl, err)
          return `wiki_search failed: ${errorMessage(err)}`
        }
      },
    },
    {
      name: 'wiki_read',
      ...wikiReadDefinition,
      async execute(args, ctx): Promise<string> {
        const slug = typeof args.slug === 'string' ? args.slug : ''
        const section =
          typeof args.section === 'string' ? (args.section as WikiReadSection) : undefined
        if (!SLUG_RE.test(slug)) return `Invalid slug "${slug}" — lowercase kebab-case only.`
        try {
          const page = await gateway.wikiRead(slug, ctx?.signal)
          if (page.kind === 'miss') return formatWikiMiss(slug, page.suggestions)
          return formatWikiRead(page.markdown, { slug, section })
        } catch (err: unknown) {
          if (isAbort(err)) throw err
          if (err instanceof GatewayError && err.status === 0) return unreachable(denUrl, err)
          return `wiki_read failed: ${errorMessage(err)}`
        }
      },
    },
  )

  if (opts.enableDelegate) {
    tools.push(
      {
        name: 'delegate_task',
        ...denDelegateTaskDefinition,
        async execute(args, ctx?: ToolExecuteContext): Promise<string> {
          const call = readDelegateCall(args)
          if (typeof call === 'string') return call
          if (ctx?.signal?.aborted) throw new DOMException('delegate_task aborted', 'AbortError')
          const goal = delegationGoal(call.task, call.context)
          const startTime = Date.now()
          let taskId: string | undefined
          try {
            const created = await gateway.createTask({
              goal,
              agentId: call.toAgent,
              requestedBy: opts.requestedBy,
              ...parent,
              budget: { maxWallClockMs: call.timeoutMs },
              spec: {
                delegation: true,
                excludeTools: ['delegate_task'],
                ...(call.model ? { model: call.model } : {}),
              },
            })
            taskId = created.task.id
            if (ctx?.signal?.aborted) throw new DOMException('delegate_task aborted', 'AbortError')
            const settled = await gateway.waitTask(taskId, {
              timeoutMs: call.timeoutMs,
              ...(ctx?.signal ? { signal: ctx.signal } : {}),
            })
            return formatSettledTask(settled.task, call.toAgent, Date.now() - startTime)
          } catch (err: unknown) {
            if (ctx?.signal?.aborted === true || isAbort(err)) {
              if (taskId) {
                try {
                  await gateway.killTask(taskId)
                } catch {
                  /* best effort */
                }
              }
              throw new DOMException('delegate_task aborted', 'AbortError')
            }
            if (err instanceof GatewayError) {
              if (err.status === 0) return unreachable(denUrl, err)
              if (err.status === 409 && err.message.startsWith('delegation chain too deep')) {
                return `[failed] ${err.message}`
              }
              if (err.status === 504) {
                const fallback = `[timeout] Remote delegation to ${call.toAgent} timed out after ${String(call.timeoutMs)}ms`
                // GET /wait only observes: the creating caller owns cancellation.
                let killed = false
                if (taskId) {
                  let reread: boolean
                  try {
                    const result = await gateway.killTask(taskId)
                    killed = result.prior !== null
                    reread = result.prior === null
                  } catch (killError: unknown) {
                    reread = killError instanceof GatewayError && killError.status === 404
                  }
                  if (reread) {
                    try {
                      const task = timeoutTask(await gateway.getTask(taskId))
                      if (
                        task &&
                        ['completed', 'failed', 'killed', 'timeout'].includes(task.status)
                      ) {
                        return formatSettledTask(task, call.toAgent, Date.now() - startTime)
                      }
                    } catch {
                      /* best effort */
                    }
                  }
                }
                try {
                  const task = timeoutTask(err.body)
                  if (isRecord(err.body) && err.body.task !== undefined && !task) return fallback
                  const id = killed ? taskId : undefined
                  const diagnostic =
                    isRecord(err.body) && typeof err.body.error === 'string'
                      ? `: ${err.body.error}` +
                        ' — no runner claimed or finished it in time' +
                        (task?.nodeAffinity
                          ? ` — is the rivetos runtime running on "${task.nodeAffinity}"?`
                          : '')
                      : ''
                  return (
                    fallback +
                    (id ? ` (task ${id} killed)` : '') +
                    diagnostic +
                    `

---
_Delegation [timeout]: ${String(Date.now() - startTime)}ms_`
                  )
                } catch (formatError: unknown) {
                  if (isAbort(formatError)) throw formatError
                  return fallback
                }
              }
              return `[failed] delegate_task failed: ${err.message}`
            }
            return `[failed] delegate_task failed: ${errorMessage(err)}`
          }
        },
      },
      {
        name: 'list_agents',
        ...listAgentsDefinition,
        async execute(_args, ctx): Promise<string> {
          try {
            const catalog = await gateway.catalogAgents(ctx?.signal)
            return formatCatalogAgents(catalog.agents)
          } catch (err: unknown) {
            if (isAbort(err)) throw err
            if (err instanceof GatewayError && err.status === 0) return unreachable(denUrl, err)
            return `[failed] list_agents failed: ${errorMessage(err)}`
          }
        },
      },
    )
  }

  return {
    tools,
    close() {
      return Promise.resolve()
    },
  }
}
