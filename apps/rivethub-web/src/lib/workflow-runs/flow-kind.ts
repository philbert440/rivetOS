/**
 * Map workflow step kinds onto the three node families the flows canvas
 * draws: entry (start), action (work), operator (control).
 */

export type FlowNodeFamily = 'action' | 'entry' | 'operator'

const OPERATOR_KINDS = new Set(['call', 'done', 'gate', 'human', 'parallel', 'transform'])

export function flowNodeFamily(kind: string | undefined): FlowNodeFamily {
  if (kind === undefined || kind === '' || kind === 'entry' || kind === 'start') {
    return 'entry'
  }
  if (OPERATOR_KINDS.has(kind)) return 'operator'
  return 'action'
}
