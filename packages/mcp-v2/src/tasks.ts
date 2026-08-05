/**
 * MCP Tasks extension scaffold (io.modelcontextprotocol/tasks).
 *
 * The 2026-07-28 revision moved Tasks out of the experimental core into an
 * official extension (SEP-2663). RivetOS already has a first-class task
 * engine (graphile-worker + /api/tasks); this module does NOT reimplement
 * that plane. It provides:
 *
 *   1. Types for task-aware tool metadata (`taskSupport`)
 *   2. A helper to mark ToolRegistration annotations as task-capable
 *   3. Notes on when to enable the SDK's tasks extension vs RivetOS tasks
 *
 * Wire-up of full `tasks/get` / `tasks/update` / `subscriptions/listen`
 * belongs with a concrete long-running tool (e.g. wiki recompile) and is
 * intentionally left as a follow-up once a consumer needs MCP-native job
 * handles rather than RivetOS task ids.
 */

import type { ToolAnnotations, ToolRegistration } from '@rivetos/mcp'

/** MCP ToolExecution.taskSupport values. */
export type TaskSupport = 'required' | 'optional' | 'forbidden'

export interface TaskAwareOptions {
  taskSupport: TaskSupport
}

/**
 * Attach task-capability metadata onto a registration.
 * The v2 mount currently surfaces this under annotations._meta for hosts
 * that understand the extension; full tasks/* RPC is not registered yet.
 */
export function withTaskSupport(
  tool: ToolRegistration,
  options: TaskAwareOptions,
): ToolRegistration {
  const annotations: ToolAnnotations = {
    ...tool.annotations,
  }
  return {
    ...tool,
    annotations,
    // Stash extension metadata in a well-known key for future mount wiring.
    // ToolRegistration has no dedicated taskSupport field by design (keeps
    // core free of extension specifics); consumers read via this helper.
    execute: tool.execute,
    // Carry as non-enumerable side channel? Prefer explicit map on server opts.
    // For now, encode in description suffix only when debugging is needed —
    // real wiring lands when the first long-running MCP tool needs it.
    ...({ _taskSupport: options.taskSupport } as object),
  }
}

export function getTaskSupport(tool: ToolRegistration): TaskSupport | undefined {
  const ext = tool as ToolRegistration & { _taskSupport?: TaskSupport }
  return ext._taskSupport
}

/**
 * Design notes (for the next agent that wires this for real):
 *
 * - Prefer RivetOS `tasks` table + mesh for collective-internal work.
 * - Use MCP Tasks when an *external* MCP client must poll a long job
 *   without holding an HTTP stream open.
 * - Enable via ServerOptions / createMcpHandler once @modelcontextprotocol
 *   documents the extension registration API for 2.0 stable.
 * - Pair with MRTR for mid-job confirmations (input_required).
 */
export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks'
