/**
 * Undo / redo for the flows canvas. Each `push` is one undo step, except that
 * consecutive pushes sharing a `coalesceKey` merge into one — a node drag
 * fires on every pointer move, and typing in an inspector field on every
 * keystroke; each should undo as a single step.
 */

export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /** Key of the step `present` belongs to; a matching next push merges into it. */
  lastKey?: string
}

/** Enough to undo a long session; bounded so drags don't grow memory forever. */
export const HISTORY_LIMIT = 200

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

export function pushHistory<T>(h: History<T>, next: T, coalesceKey?: string): History<T> {
  if (next === h.present) return h
  if (coalesceKey !== undefined && coalesceKey === h.lastKey) {
    return { ...h, present: next, future: [] }
  }
  const past = [...h.past, h.present]
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
  return { past, present: next, future: [], lastKey: coalesceKey }
}

export function undoHistory<T>(h: History<T>): History<T> {
  const prev = h.past.at(-1)
  if (prev === undefined) return h
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] }
}

export function redoHistory<T>(h: History<T>): History<T> {
  const next = h.future[0]
  if (next === undefined) return h
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1) }
}
