/**
 * transcript-capture key-resolution tests — pure-function coverage of the
 * conversation-key precedence and of the task context a spawned CLI inherits
 * from its parent's env, both of which decide where a task's turns land.
 * The DB-bound ingest paths are exercised against scratch Postgres elsewhere.
 */

import { describe, expect, it } from 'vitest'
import {
  isTaskId,
  resolveConversationKey,
  resolveTaskContext,
  sessionKeyFromId,
} from './transcript-capture.js'

const TASK_UUID = '3f1b5f6a-9c1e-4a2b-8d7e-0123456789ab'

describe('resolveConversationKey', () => {
  const fallbackKey = 'claude-code:-home-rivet/abc123'

  it('uses the override verbatim when present — no claude-code: prefix', () => {
    expect(
      resolveConversationKey({
        override: 'task:t-42',
        hookSessionId: 'sess-1',
        transcriptSessionId: 'sess-2',
        fallbackKey,
      }),
    ).toBe('task:t-42')
  })

  it('falls back to the hook session_id when no override', () => {
    expect(
      resolveConversationKey({
        hookSessionId: 'sess-1',
        transcriptSessionId: 'sess-2',
        fallbackKey,
      }),
    ).toBe(sessionKeyFromId('sess-1'))
  })

  it('falls back to the transcript session id, then the path key', () => {
    expect(
      resolveConversationKey({ transcriptSessionId: 'sess-2', fallbackKey }),
    ).toBe(sessionKeyFromId('sess-2'))
    expect(resolveConversationKey({ transcriptSessionId: null, fallbackKey })).toBe(fallbackKey)
  })

  it('treats an empty override as absent', () => {
    expect(resolveConversationKey({ override: '', hookSessionId: 'sess-1', fallbackKey })).toBe(
      sessionKeyFromId('sess-1'),
    )
  })
})

describe('resolveTaskContext', () => {
  it('takes the task from RIVETOS_TASK_ID and leaves the key alone', () => {
    expect(resolveTaskContext({ RIVETOS_TASK_ID: TASK_UUID })).toEqual({
      sessionKeyOverride: undefined,
      taskId: TASK_UUID,
      legacyTaskKey: false,
    })
  })

  it('honors a legacy RIVETOS_SESSION_KEY=task:<id> and flags it deprecated', () => {
    // The write-key override still wins for this ingest — a task in flight
    // across a rolling deploy must not split its transcript — and the id is
    // extracted too, so the row is reachable through the join as well.
    expect(resolveTaskContext({ RIVETOS_SESSION_KEY: `task:${TASK_UUID}` })).toEqual({
      sessionKeyOverride: `task:${TASK_UUID}`,
      taskId: TASK_UUID,
      legacyTaskKey: true,
    })
  })

  it('prefers RIVETOS_TASK_ID when both are set', () => {
    const ctx = resolveTaskContext({
      RIVETOS_SESSION_KEY: 'task:00000000-0000-4000-8000-000000000000',
      RIVETOS_TASK_ID: TASK_UUID,
    })
    expect(ctx.taskId).toBe(TASK_UUID)
    expect(ctx.legacyTaskKey).toBe(true)
  })

  it('leaves a den terminal key untouched and undeprecated', () => {
    // RIVETOS_SESSION_KEY is still the den PTY contract; only `task:` is legacy.
    expect(resolveTaskContext({ RIVETOS_SESSION_KEY: 'chat-20260808-abcd' })).toEqual({
      sessionKeyOverride: 'chat-20260808-abcd',
      taskId: undefined,
      legacyTaskKey: false,
    })
  })

  it('reports nothing for a plain interactive session', () => {
    expect(resolveTaskContext({})).toEqual({
      sessionKeyOverride: undefined,
      taskId: undefined,
      legacyTaskKey: false,
    })
    // Empty strings are absent, matching resolveConversationKey.
    expect(resolveTaskContext({ RIVETOS_SESSION_KEY: '', RIVETOS_TASK_ID: '' }).taskId).toBe(
      undefined,
    )
  })
})

describe('isTaskId', () => {
  it('accepts a UUID in either case', () => {
    expect(isTaskId(TASK_UUID)).toBe(true)
    expect(isTaskId(TASK_UUID.toUpperCase())).toBe(true)
  })

  it('rejects anything the UUID column cannot hold', () => {
    // A malformed id must degrade to "no association", not a 22P02 that rolls
    // back the whole ingest.
    for (const bad of [undefined, '', 'task-env-check', `task:${TASK_UUID}`, `${TASK_UUID} `]) {
      expect(isTaskId(bad)).toBe(false)
    }
  })
})
