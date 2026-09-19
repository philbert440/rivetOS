/**
 * Pure sync-event log for the session detail page. Records attach / reconnect /
 * manual / rev-gap resyncs so the reconnect → transcript-restore step is visible.
 */

export type SyncCause = 'attach' | 'reconnect' | 'manual' | 'rev-gap sync'

export interface SyncLogEntry {
  /** Stable key for React lists (monotonic counter). */
  id: number
  /** epoch ms */
  at: number
  cause: SyncCause
  turnCount: number
  /** Wall time of the HTTP (or noted) resync. */
  durationMs: number
}

export interface SyncLogState {
  entries: SyncLogEntry[]
  nextId: number
}

export const SYNC_LOG_LIMIT = 20

export type SyncLogAction =
  | {
      type: 'record'
      cause: SyncCause
      turnCount: number
      durationMs: number
      at?: number
    }
  | { type: 'clear' }

export function createSyncLog(): SyncLogState {
  return { entries: [], nextId: 1 }
}

export function syncLogReducer(state: SyncLogState, action: SyncLogAction): SyncLogState {
  if (action.type === 'clear') return createSyncLog()
  const entry: SyncLogEntry = {
    id: state.nextId,
    at: action.at ?? Date.now(),
    cause: action.cause,
    turnCount: action.turnCount,
    durationMs: Math.max(0, action.durationMs),
  }
  return {
    nextId: state.nextId + 1,
    entries: [entry, ...state.entries].slice(0, SYNC_LOG_LIMIT),
  }
}
