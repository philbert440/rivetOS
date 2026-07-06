/**
 * transcript-capture key-resolution tests — pure-function coverage of the
 * conversation-key precedence that joins task-engine spawns to their task
 * conversation (`task:<taskId>` via RIVETOS_SESSION_KEY) while leaving
 * interactive-session keying (`claude-code:<session_id>`) unchanged.
 * The DB-bound ingest paths are exercised against scratch Postgres elsewhere.
 */

import { describe, expect, it } from 'vitest'
import { resolveConversationKey, sessionKeyFromId } from './transcript-capture.js'

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
