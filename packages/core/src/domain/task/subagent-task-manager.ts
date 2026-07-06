/**
 * TaskBackedSubagentManager — the subagent tool surface over the task engine.
 *
 * Cutover step (d): subagent_spawn/status/send/list/kill keep their exact
 * external contract (createSubagentTools() is reused unchanged) but write
 * ros_tasks rows instead of ros_subagent_sessions. One row per subagent
 * session: origin 'tool', executor 'chat-loop', spec.interactive so every
 * turn parks as awaiting-input instead of finishing — which is what makes
 * subagent_send-on-a-"completed"-session work (a parked task resumes; a
 * terminal one cannot).
 *
 * Status mapping (task → subagent):
 *   queued | running          → 'running'
 *   awaiting-input | completed → 'completed'
 *   failed | timeout | killed  → 'failed'
 *
 * Kill uses TaskStore.requestKill: pre-terminal rows flip to killed; an
 * in-flight turn is not aborted — the runner discards its outcome at turn
 * end (legacy subagent semantics). History/messageCount are read from the
 * task's memory conversation (session_key = task:<id>, step (c)); without
 * memory they degrade to empty/0.
 */

import type {
  Memory,
  SubagentManager,
  SubagentSession,
  SubagentSpawnRequest,
  SubagentStatusResponse,
} from '@rivetos/types'
import type { Router } from '../router.js'
import type { TaskRow, TaskStore } from './store.js'
import { logger } from '../../logger.js'

const log = logger('TaskBackedSubagentManager')

export interface TaskBackedSubagentManagerConfig {
  router: Router
  store: TaskStore
  /** History/messageCount source — the task's memory conversation. */
  memory?: Pick<Memory, 'getSessionHistory'>
  /** Parent agent id stamped on new sessions (defaults to 'parent'). */
  parentAgent?: string
}

/** Marker in spec so list() can tell subagent-origin tasks apart. */
const SUBAGENT_MARKER = { interactive: true, subagent: true } as const

function mapStatus(row: TaskRow): SubagentSession['status'] {
  switch (row.status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'awaiting-input':
    case 'completed':
      return 'completed'
    default:
      return 'failed'
  }
}

function lastResponse(row: TaskRow): string {
  return row.result?.output ?? row.result?.summary ?? ''
}

function usageOf(row: TaskRow): { promptTokens: number; completionTokens: number } | undefined {
  const u = row.result?.usage ?? row.usage
  if (!u) return undefined
  return { promptTokens: u.inputTokens, completionTokens: u.outputTokens }
}

function elapsedOf(row: TaskRow): number {
  if (row.durationMs != null) return row.durationMs
  if (row.startedAt != null) return Date.now() - row.startedAt
  return 0
}

function toSession(row: TaskRow, parentAgent: string, router: Router): SubagentSession {
  return {
    id: row.id,
    parentAgent: row.requestedBy ?? parentAgent,
    childAgent: row.agentId,
    provider: router.getAgents().find((a) => a.id === row.agentId)?.provider ?? 'unknown',
    status: mapStatus(row),
    history: [],
    createdAt: row.createdAt,
    iterations: row.result?.usage.turns ?? row.usage?.turns ?? 0,
    toolsUsed: [],
    usage: usageOf(row),
    durationMs: row.durationMs,
    lastResponse: lastResponse(row) || undefined,
    error: row.error ?? row.result?.error,
  }
}

export class TaskBackedSubagentManager implements SubagentManager {
  constructor(private config: TaskBackedSubagentManagerConfig) {}

  async spawn(request: SubagentSpawnRequest): Promise<SubagentSession> {
    const { router, store } = this.config

    const agents = router.getAgents()
    const agent = agents.find((a) => a.id === request.agent)
    if (!agent) {
      throw new Error(
        `Unknown agent: "${request.agent}". Available: ${agents.map((a) => a.id).join(', ')}`,
      )
    }
    const provider = router.getProviders().find((p) => p.id === agent.provider)
    if (!provider) {
      throw new Error(`Provider "${agent.provider}" not available for agent "${request.agent}"`)
    }

    const row = await store.create({
      goal: request.task,
      executor: 'chat-loop',
      agentId: request.agent,
      origin: 'tool',
      requestedBy: this.config.parentAgent ?? 'parent',
      spec: { ...SUBAGENT_MARKER },
      budget: request.timeoutMs ? { maxWallClockMs: request.timeoutMs } : undefined,
      maxAttempts: 1,
    })
    return toSession(row, this.config.parentAgent ?? 'parent', this.config.router)
  }

  async status(sessionId: string): Promise<SubagentStatusResponse> {
    const row = await this.getRow(sessionId)
    return {
      id: row.id,
      agent: row.agentId,
      status: mapStatus(row),
      elapsedMs: elapsedOf(row),
      iterations: row.result?.usage.turns ?? row.usage?.turns ?? 0,
      toolsUsed: [],
      lastResponse: lastResponse(row),
      usage: usageOf(row),
      error: row.error ?? row.result?.error,
      messageCount: await this.messageCount(row.id),
    }
  }

  async send(sessionId: string, message: string): Promise<void> {
    const row = await this.getRow(sessionId)
    const status = mapStatus(row)
    if (status === 'running') {
      throw new Error(`Sub-agent session ${sessionId} is still running — wait for completion`)
    }
    if (status === 'failed') {
      throw new Error(`Sub-agent session ${sessionId} has failed — cannot send messages`)
    }
    // 'completed' externally means parked awaiting-input internally; a truly
    // terminal completed row (non-interactive path) cannot resume.
    if (row.status === 'completed') {
      throw new Error(`Sub-agent session ${sessionId} has finished — cannot send messages`)
    }
    await this.config.store.send(sessionId, message)
  }

  async list(): Promise<SubagentSession[]> {
    const rows = await this.config.store.list()
    return rows
      .filter((r) => r.origin === 'tool' && r.spec.subagent === true)
      .map((r) => toSession(r, this.config.parentAgent ?? 'parent', this.config.router))
  }

  async kill(sessionId: string): Promise<void> {
    const row = await this.getRow(sessionId)
    const prior = await this.config.store.requestKill(row.id)
    if (prior === undefined) {
      log.info(`Sub-agent ${sessionId} already terminal — kill is a no-op`)
      return
    }
    log.info(`Sub-agent ${sessionId} killed (was ${prior})`)
  }

  private async getRow(sessionId: string): Promise<TaskRow> {
    const row = await this.config.store.get(sessionId)
    if (!row) throw new Error(`Sub-agent session not found: ${sessionId}`)
    return row
  }

  private async messageCount(taskId: string): Promise<number> {
    if (!this.config.memory) return 0
    try {
      const history = await this.config.memory.getSessionHistory(`task:${taskId}`, { limit: 1000 })
      return history.length
    } catch (err: unknown) {
      log.warn(
        `messageCount for task ${taskId} unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return 0
    }
  }
}
