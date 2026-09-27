/**
 * Delegation chain cap for POST /api/tasks. The sidecar's delegate_task tool
 * uses the same numbers (MAX_CHAIN_DEPTH = 3, child = parent + 1); the next
 * slice should call this instead of keeping a private copy.
 *
 * An explicit `chainDepth` on the request is the child's depth and wins over
 * the parent lookup. A parent id that is not in ros_tasks counts as depth 0
 * (the child is then 1) and is not stamped onto the row. A malformed parent
 * fails closed at parent depth 2 without a lookup or parent stamp.
 */

export const MAX_CHAIN_DEPTH = 3
const FAIL_CLOSED_PARENT_DEPTH = MAX_CHAIN_DEPTH - 1
const TASK_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ChainStamp {
  chainDepth: number
  parentTaskId?: string
}

export type ChainGuardResult = { ok: true; stamp?: ChainStamp } | { ok: false; error: string }

export interface ChainRequestFields {
  parentTaskId?: string
  chainDepth?: number
}

/** Parse the two optional create fields. A string return is a 400 message. */
export function readChainFields(body: {
  parentTaskId?: unknown
  chainDepth?: unknown
}): ChainRequestFields | string {
  let parentTaskId: string | undefined
  if (body.parentTaskId !== undefined) {
    if (typeof body.parentTaskId !== 'string') return 'parentTaskId must be a string'
    const trimmed = body.parentTaskId.trim()
    if (trimmed) parentTaskId = trimmed
  }
  if (body.chainDepth === undefined) return { parentTaskId }
  const depth = body.chainDepth
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) {
    return 'chainDepth must be a non-negative integer'
  }
  return { parentTaskId, chainDepth: depth }
}

export async function guardTaskChain(input: {
  parentTaskId?: string
  /** Explicit child depth. When set, replaces parentDepth + 1. */
  chainDepth?: number
  lookup: (parentTaskId: string) => Promise<{ chainDepth: number } | undefined>
  log?: (message: string) => void
}): Promise<ChainGuardResult> {
  const parentId = input.parentTaskId?.trim() ? input.parentTaskId.trim() : undefined
  const explicit = input.chainDepth
  if (!parentId && explicit === undefined) return { ok: true }

  let parentDepth = 0
  let stampParent = false
  if (parentId && !TASK_ID_UUID.test(parentId)) {
    parentDepth = FAIL_CLOSED_PARENT_DEPTH
    input.log?.(
      `parentTaskId "${parentId}" is not a UUID — delegate tools registered at chain depth ${String(FAIL_CLOSED_PARENT_DEPTH)} (fail closed)`,
    )
  } else if (parentId) {
    const parent = await input.lookup(parentId)
    if (parent) {
      parentDepth = parent.chainDepth
      stampParent = true
    } else {
      // Same text as the sidecar delegate tool when RIVETOS_TASK_ID is missing.
      input.log?.(`RIVETOS_TASK_ID ${parentId} not in ros_tasks — treating chain depth as 0`)
    }
  }

  const depth = explicit !== undefined ? explicit : parentDepth + 1
  if (depth > MAX_CHAIN_DEPTH) {
    return {
      ok: false,
      error: `delegation chain too deep (${String(depth)} > ${String(MAX_CHAIN_DEPTH)})`,
    }
  }

  const stamp: ChainStamp = { chainDepth: depth }
  if (stampParent && parentId) stamp.parentTaskId = parentId
  return { ok: true, stamp }
}
