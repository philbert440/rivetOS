/**
 * A Cowork task can be captured from hooks before its transcript is readable,
 * then again from the transcript. Tool rows already share `tool_use_id`.
 * Prompt and reply rows do not. The store rewrites the hook row's event id
 * to the transcript id so a later pass is a no-op.
 *
 * The hash is the same NUL-joined tuple as `contentTupleHash` in
 * `@rivetos/capture-core` for a user or assistant row (no tool name, no tool
 * args): `role`, `content`, empty, empty. One hook row is consumed per
 * matching line, so identical repeats stay distinct.
 */

import { createHash } from 'node:crypto'

export interface CoworkHookRow {
  id: string
  role: string
  content: string
  eventId: string
}

/** SHA-256 hex of `role`, `content`, and two empty tool fields, NUL-joined. */
export function coworkContentHash(role: string, content: string): string {
  return createHash('sha256').update(`${role}\0${content}\0\0`, 'utf8').digest('hex')
}

export function pickCoworkHookRewrite(
  incoming: {
    role: string
    content: string
    source?: unknown
    replacesEventId?: unknown
  },
  rows: readonly CoworkHookRow[],
  consumed: ReadonlySet<string>,
): CoworkHookRow | undefined {
  if (incoming.source !== 'cowork-transcript') return undefined
  if (incoming.role !== 'user' && incoming.role !== 'assistant') return undefined
  const open = rows.filter((row) => !consumed.has(row.id))
  if (typeof incoming.replacesEventId === 'string' && incoming.replacesEventId !== '') {
    const direct = open.find((row) => row.eventId === incoming.replacesEventId)
    if (direct) return direct
  }
  const want = coworkContentHash(incoming.role, incoming.content)
  return open.find(
    (row) => row.role === incoming.role && coworkContentHash(row.role, row.content) === want,
  )
}
