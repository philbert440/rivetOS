/**
 * Card face for a drawer row. `blocked` (SessionSummary) wins over the
 * control-plane status: a session waiting on the user is "needs", an ended
 * session is "done", an in-flight turn is "working".
 */

import type { ChatItem } from '../../lib/harness-chat.js'

export type TileStatus = 'idle' | 'working' | 'needs' | 'done'

const PILL: Record<TileStatus, string> = {
  idle: 'idle',
  working: 'working',
  needs: 'needs you',
  done: 'done',
}

export function tileStatus(status: ChatItem['status'], blocked: boolean | undefined): TileStatus {
  if (blocked) return 'needs'
  if (status === 'ended') return 'done'
  if (status === 'active') return 'working'
  return 'idle'
}

export function tilePill(status: TileStatus): string {
  return PILL[status]
}
