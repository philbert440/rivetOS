import { describe, expect, it } from 'vitest'
import {
  SYNC_LOG_LIMIT,
  createSyncLog,
  syncLogReducer,
} from './session-sync-log.js'

describe('syncLogReducer', () => {
  it('records entries newest-first with monotonic ids', () => {
    let state = createSyncLog()
    state = syncLogReducer(state, {
      type: 'record',
      cause: 'attach',
      turnCount: 3,
      durationMs: 40,
      at: 1_000,
    })
    state = syncLogReducer(state, {
      type: 'record',
      cause: 'reconnect',
      turnCount: 5,
      durationMs: 12,
      at: 2_000,
    })
    expect(state.entries).toHaveLength(2)
    expect(state.entries[0]).toMatchObject({
      id: 2,
      cause: 'reconnect',
      turnCount: 5,
      durationMs: 12,
      at: 2_000,
    })
    expect(state.entries[1]).toMatchObject({ id: 1, cause: 'attach', turnCount: 3 })
  })

  it('caps at SYNC_LOG_LIMIT', () => {
    let state = createSyncLog()
    for (let i = 0; i < SYNC_LOG_LIMIT + 5; i++) {
      state = syncLogReducer(state, {
        type: 'record',
        cause: i % 2 === 0 ? 'manual' : 'rev-gap sync',
        turnCount: i,
        durationMs: i,
        at: i,
      })
    }
    expect(state.entries).toHaveLength(SYNC_LOG_LIMIT)
    expect(state.entries[0]?.turnCount).toBe(SYNC_LOG_LIMIT + 4)
    expect(state.entries.at(-1)?.turnCount).toBe(5)
  })

  it('clear resets the log', () => {
    let state = createSyncLog()
    state = syncLogReducer(state, {
      type: 'record',
      cause: 'attach',
      turnCount: 1,
      durationMs: 1,
    })
    state = syncLogReducer(state, { type: 'clear' })
    expect(state).toEqual(createSyncLog())
  })

  it('clamps negative duration to zero', () => {
    const state = syncLogReducer(createSyncLog(), {
      type: 'record',
      cause: 'manual',
      turnCount: 0,
      durationMs: -5,
      at: 10,
    })
    expect(state.entries[0]?.durationMs).toBe(0)
  })
})
