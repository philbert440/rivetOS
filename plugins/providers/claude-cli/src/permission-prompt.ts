/**
 * Headless permission prompts for one `claude -p` spawn.
 *
 * Claude Code 2.1.x calls `--permission-prompt-tool` with
 * `{ tool_name, input, tool_use_id }` and requires the MCP result to be one
 * text block whose text is `{behavior:'allow'}` or
 * `{behavior:'deny', message:string}`. Anything else is itself a denial,
 * after the CLI has already spent its own decision timeout — so this side
 * always returns one of those two shapes.
 *
 * The tool name on the wire is `mcp__<server>__request_permission`. The
 * embedded bridge advertises the server as `rivetos` and omits this tool
 * from tools/list. A direct tools/call can still park a prompt; only an
 * explicit allow answers it, and an unanswered park denies.
 */

import { randomUUID } from 'node:crypto'

import type { TaskEvent, Tool } from '@rivetos/types'

/**
 * Default park for an unanswered `ui` prompt. Boot passes
 * `permission_timeout_ms` when that key is set; this stays the fallback
 * and the value `TASK_PERMISSION_TIMEOUT_MS` must keep matching.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 60_000

/** A longer park is a stuck card, not a decision. Ten minutes. */
export const PERMISSION_PROMPT_TIMEOUT_MAX_MS = 600_000

/**
 * `providers.claude-cli.permission_timeout_ms`. Absent, blank, or anything
 * other than a positive integer within the max returns the default. A
 * skipped validator must not park for 0ms or forever.
 */
export function parsePermissionTimeoutMs(raw: unknown): number {
  if (raw == null || raw === '') return PERMISSION_PROMPT_TIMEOUT_MS
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return PERMISSION_PROMPT_TIMEOUT_MS
  if (raw < 1 || raw > PERMISSION_PROMPT_TIMEOUT_MAX_MS) return PERMISSION_PROMPT_TIMEOUT_MS
  return raw
}

/** MCP server name the embedded bridge advertises. Matches mcp-bridge.ts. */
export const PERMISSION_PROMPT_SERVER = 'rivetos'

/** Tool name inside that server. The CLI flag prefixes `mcp__<server>__`. */
export const PERMISSION_TOOL_NAME = 'request_permission'

export function permissionPromptToolId(server: string = PERMISSION_PROMPT_SERVER): string {
  return `mcp__${server}__${PERMISSION_TOOL_NAME}`
}

export type PermissionPromptMode = 'ui' | 'none'

/**
 * `providers.claude-cli.permission_prompts`. Absent stays absent (the spawn
 * gains no flag). Any other value is undefined so a caller that skipped
 * validation does not silently turn a typo into `ui`.
 */
export function parsePermissionPrompts(raw: unknown): PermissionPromptMode | undefined {
  if (raw == null || raw === '') return undefined
  if (raw === 'ui' || raw === 'none') return raw
  return undefined
}

/** What the parked tool call resolves to. `timeout` is a denial. */
export interface PermissionAnswer {
  behavior: 'allow' | 'deny'
  message?: string
  decision: 'allow' | 'deny' | 'timeout'
}

/**
 * Host that parks one prompt until RivetHub or
 * `POST /api/tasks/:id/approvals/:requestId` answers, or the window expires.
 * Implementations fail closed: abort, timeout, and a duplicate id deny.
 */
export interface PermissionPrompter {
  ask(args: {
    taskId: string
    requestId: string
    name: string
    input: unknown
    toolUseId?: string
    signal?: AbortSignal
  }): Promise<PermissionAnswer>
  /**
   * Deny every prompt still parked for this task. A killed spawn never
   * answers, and a late allow must not be recorded after the CLI is dead.
   * Optional so a prompter that only answers in-process can omit it.
   * `message` is an audit reason; omit it on the kill path.
   */
  denyPending?(taskId: string, message?: string): void
}

/** CLI text-block body. Allow omits `updatedInput` so the CLI keeps the
 *  input it already showed the operator — we never echo a schema-stripped copy. */
export function permissionDecisionText(
  answer: Pick<PermissionAnswer, 'behavior' | 'message'>,
): string {
  if (answer.behavior === 'allow') return JSON.stringify({ behavior: 'allow' })
  const message =
    typeof answer.message === 'string' && answer.message.length > 0
      ? answer.message
      : 'permission denied'
  return JSON.stringify({ behavior: 'deny', message })
}

export function createPermissionPromptTool(opts: {
  taskId: string
  prompter: PermissionPrompter
  emit: (event: TaskEvent) => void
}): Tool {
  return {
    name: PERMISSION_TOOL_NAME,
    description:
      'Internal gate for this Claude Code session. Decides one tool call. Not a tool for the model to call.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'The name of the tool requesting permission',
        },
        // No `type`: the bridge's schema adapter maps an untyped node to
        // z.unknown(), so the object the CLI sent survives intact for the
        // approval card. A typed object with no properties would strip it.
        input: { description: 'The input for the tool' },
        tool_use_id: {
          type: 'string',
          description: 'The unique tool use request ID',
        },
      },
      required: ['tool_name', 'input'],
    },
    async execute(args, signal) {
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : ''
      const toolUseId = typeof args.tool_use_id === 'string' ? args.tool_use_id : undefined
      const input = args.input
      if (toolName.length === 0) {
        return permissionDecisionText({
          behavior: 'deny',
          message: 'permission request missing tool_name',
        })
      }
      const requestId = randomUUID()
      const pending = opts.prompter.ask({
        taskId: opts.taskId,
        requestId,
        name: toolName,
        input,
        toolUseId,
        signal,
      })
      opts.emit({
        ts: Date.now(),
        type: 'approval-request',
        taskId: opts.taskId,
        requestId,
        name: toolName,
        input,
        toolCallId: toolUseId,
      })
      let answer: PermissionAnswer
      try {
        answer = await pending
      } catch {
        answer = {
          behavior: 'deny',
          decision: 'deny',
          message: 'permission request failed closed',
        }
      }
      opts.emit({
        ts: Date.now(),
        type: 'approval-resolved',
        taskId: opts.taskId,
        requestId,
        decision: answer.decision,
      })
      return permissionDecisionText(answer)
    },
  }
}
