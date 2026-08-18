/**
 * Unit tests for heartbeat-session exclusion helpers.
 * Pure string/SQL fragment — no Postgres required.
 */

import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_SESSION_PREFIX,
  isHeartbeatSessionKey,
  sqlNotHeartbeatConversation,
} from './helpers.js'

describe('isHeartbeatSessionKey', () => {
  it('matches the scheduled-heartbeat prefix', () => {
    expect(isHeartbeatSessionKey('heartbeat:rivet-claude')).toBe(true)
    expect(isHeartbeatSessionKey('heartbeat:')).toBe(true)
  })

  it('rejects user sessions, null, and empty', () => {
    expect(isHeartbeatSessionKey('telegram-rivet-claude')).toBe(false)
    expect(isHeartbeatSessionKey('grok-build')).toBe(false)
    expect(isHeartbeatSessionKey('')).toBe(false)
    expect(isHeartbeatSessionKey(null)).toBe(false)
    expect(isHeartbeatSessionKey(undefined)).toBe(false)
  })
})

describe('sqlNotHeartbeatConversation', () => {
  it('defaults to alias c and the heartbeat: prefix', () => {
    expect(sqlNotHeartbeatConversation()).toBe(
      `(c.session_key IS NULL OR c.session_key NOT LIKE '${HEARTBEAT_SESSION_PREFIX}%')`,
    )
  })

  it('honors a custom alias so wiki backfill can join summaries', () => {
    expect(sqlNotHeartbeatConversation('conv')).toContain('conv.session_key IS NULL')
    expect(sqlNotHeartbeatConversation('conv')).toContain(
      `conv.session_key NOT LIKE '${HEARTBEAT_SESSION_PREFIX}%'`,
    )
  })
})
