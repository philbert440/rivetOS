/**
 * Parks a headless CLI permission prompt until a client answers or the
 * window expires.
 *
 * Same process as the spawn: the executor's MCP tool calls `ask`, and
 * `POST /api/tasks/:id/approvals/:requestId` (or a RivetHub click that hits
 * that route) calls `decide`. A prompt nobody answers denies. Every settle
 * is appended to the task row (`spec.permissionDecisions`).
 *
 * Fail closed: unknown ids, a second decide, abort, and timeout all deny
 * or no-op. Nothing here returns allow except an explicit `decide('allow')`.
 */

import type { TaskApprovalRequest, TaskPermissionDecision } from '@rivetos/types'
import { logger } from '../../logger.js'
import type { TaskStore } from './store.js'

const log = logger('TaskPermissionBroker')

/**
 * Default park when the caller omits `timeoutMs`. Boot passes
 * `parsePermissionTimeoutMs` instead (`PERMISSION_PROMPT_TIMEOUT_MS`, also
 * 60s) whenever the claude-cli package loads. This literal is only the
 * fallback for that import failing. Core does not depend on the provider
 * package, so the two 60s constants stay separate and must be kept equal.
 */
export const TASK_PERMISSION_TIMEOUT_MS = 60_000

const MESSAGE_CAP = 500

export interface PermissionAsk {
  taskId: string
  requestId: string
  name: string
  input: unknown
  toolUseId?: string
  signal?: AbortSignal
}

export interface PermissionAnswer {
  behavior: 'allow' | 'deny'
  message?: string
  decision: TaskPermissionDecision['decision']
}

interface Pending {
  request: TaskApprovalRequest
  finish: (answer: PermissionAnswer) => void
}

export class TaskPermissionBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(request: TaskApprovalRequest) => void>()
  private readonly timeoutMs: number

  constructor(private readonly opts: { store: TaskStore; timeoutMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? TASK_PERMISSION_TIMEOUT_MS
  }

  pendingFor(taskId: string): TaskApprovalRequest[] {
    const out: TaskApprovalRequest[] = []
    for (const entry of this.pending.values()) {
      if (entry.request.taskId === taskId) out.push(entry.request)
    }
    return out
  }

  /**
   * Resolves with the next prompt parked for `taskId`, including one that
   * is already waiting. Resolves undefined when `signal` aborts (the wait
   * deadline) and nothing arrived.
   */
  next(
    taskId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TaskApprovalRequest | undefined> {
    const existing = this.pendingFor(taskId).at(0)
    if (existing) return Promise.resolve(existing)
    if (opts.signal?.aborted) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      let settled = false
      const finish = (request: TaskApprovalRequest | undefined): void => {
        if (settled) return
        settled = true
        this.listeners.delete(listener)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve(request)
      }
      const listener = (request: TaskApprovalRequest): void => {
        if (request.taskId === taskId) finish(request)
      }
      const onAbort = (): void => finish(undefined)
      this.listeners.add(listener)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const again = this.pendingFor(taskId).at(0)
      if (again) finish(again)
    })
  }

  /**
   * Park. Registers synchronously, before the returned promise yields, so a
   * POST that arrives on the same turn can still find the id.
   */
  ask(args: PermissionAsk): Promise<PermissionAnswer> {
    const key = pendingKey(args.taskId, args.requestId)
    if (this.pending.has(key)) {
      return Promise.resolve({
        behavior: 'deny',
        decision: 'deny',
        message: 'duplicate permission request',
      })
    }
    const request: TaskApprovalRequest = {
      type: 'approval-request',
      taskId: args.taskId,
      requestId: args.requestId,
      name: args.name,
      input: args.input,
      toolCallId: args.toolUseId,
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (answer: PermissionAnswer): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        args.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(key)
        // The CLI is waiting on this promise. A slow or failed audit write
        // must not delay the answer or flip it to deny.
        resolve(answer)
        void this.record(args, answer)
      }
      const onAbort = (): void => {
        finish({ behavior: 'deny', decision: 'deny', message: 'permission prompt aborted' })
      }
      const timer = setTimeout(() => {
        finish({
          behavior: 'deny',
          decision: 'timeout',
          message: `permission prompt timed out after ${String(this.timeoutMs)}ms`,
        })
      }, this.timeoutMs)
      if (args.signal?.aborted) {
        finish({ behavior: 'deny', decision: 'deny', message: 'permission prompt aborted' })
        return
      }
      args.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(key, { request, finish })
      for (const listener of this.listeners) listener(request)
    })
  }

  /**
   * Deny every prompt still parked for `taskId`. A spawn kill has no CLI
   * left to deliver an answer to. A later `decide('allow')` finds nothing.
   * Returns how many prompts this call settled. `message` is the audit
   * reason; the default stays `spawn killed` so a one-arg kill matches
   * the historical record.
   */
  denyPending(taskId: string, message = 'spawn killed'): number {
    let settled = 0
    for (const entry of [...this.pending.values()]) {
      if (entry.request.taskId !== taskId) continue
      entry.finish({ behavior: 'deny', decision: 'deny', message })
      settled += 1
    }
    return settled
  }

  /** True when this call settled the prompt. False when it was unknown or already settled. */
  decide(taskId: string, requestId: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pending.get(pendingKey(taskId, requestId))
    if (!entry) return false
    if (decision === 'allow') {
      entry.finish({ behavior: 'allow', decision: 'allow' })
    } else {
      entry.finish({ behavior: 'deny', decision: 'deny', message: 'permission denied' })
    }
    return true
  }

  private async record(args: PermissionAsk, answer: PermissionAnswer): Promise<void> {
    const decision: TaskPermissionDecision = {
      requestId: args.requestId,
      tool: args.name,
      decision: answer.decision,
      at: Date.now(),
      message: cap(answer.message),
    }
    try {
      await this.opts.store.appendPermissionDecision(args.taskId, decision)
    } catch (err: unknown) {
      // The operator already decided (or the window already closed). Losing
      // the audit row must not flip an allow into a deny, and must not hang
      // the CLI. The spawn still gets `answer`.
      log.warn(
        `permission decision for ${args.taskId} was not recorded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}

function pendingKey(taskId: string, requestId: string): string {
  return `${taskId}\0${requestId}`
}

function cap(message: string | undefined): string | undefined {
  if (!message) return undefined
  return message.length > MESSAGE_CAP ? message.slice(0, MESSAGE_CAP) : message
}
