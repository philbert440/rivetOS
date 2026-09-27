import { describe, expect, it } from 'vitest'
import {
  grokbotSessionBase,
  isPreferredGrokbotSession,
  preferredGrokbotSession,
  shouldHideGrokbotSession,
  sqlNotSupersededGrokbotConversation,
  sqlNotSupersededGrokbotMessage,
} from './grokbot-prefer-v3.js'

describe('grokbot prefer -v3 at query time', () => {
  it('strips legacy and preferred suffixes to the same base', () => {
    expect(grokbotSessionBase('grokbot-rivet-grokbot')).toBe('grokbot-rivet-grokbot')
    expect(grokbotSessionBase('grokbot-rivet-grokbot-v2')).toBe('grokbot-rivet-grokbot')
    expect(grokbotSessionBase('grokbot-rivet-grokbot-v3')).toBe('grokbot-rivet-grokbot')
    expect(grokbotSessionBase('grokbot-rivet-grokbot-v3-rows')).toBe('grokbot-rivet-grokbot')
    expect(grokbotSessionBase('grokbot-rivet-grokbot-v3-store')).toBe('grokbot-rivet-grokbot')
    expect(grokbotSessionBase('grokbot-rivet-grokbot-v3-voice-call1')).toBe('grokbot-rivet-grokbot')
  })

  it('prefers -v3 then -v3-rows over unsuffixed and -v2', () => {
    const keys = ['grokbot-bob', 'grokbot-bob-v2', 'grokbot-bob-v3', 'grokbot-bob-v3-rows']
    expect(preferredGrokbotSession('grokbot-bob', keys)).toBe('grokbot-bob-v3')
    expect(preferredGrokbotSession('grokbot-bob-v2', keys)).toBe('grokbot-bob-v3')
    expect(preferredGrokbotSession('grokbot-bob-v3', keys)).toBe('grokbot-bob-v3')
    expect(preferredGrokbotSession('grokbot-bob-v3-rows', keys)).toBe('grokbot-bob-v3-rows')
    expect(preferredGrokbotSession('grokbot-bob-v3-store', keys)).toBe('grokbot-bob-v3-store')
    expect(shouldHideGrokbotSession('grokbot-bob', keys)).toBe(true)
    expect(shouldHideGrokbotSession('grokbot-bob-v2', keys)).toBe(true)
    expect(shouldHideGrokbotSession('grokbot-bob-v3', keys)).toBe(false)
    expect(shouldHideGrokbotSession('grokbot-bob-v3-store', keys)).toBe(false)
  })

  it('does not hide legacy sessions when no -v3 sibling exists', () => {
    const keys = ['grokbot-bob', 'grokbot-bob-v2']
    expect(preferredGrokbotSession('grokbot-bob', keys)).toBe('grokbot-bob')
    expect(shouldHideGrokbotSession('grokbot-bob', keys)).toBe(false)
    expect(isPreferredGrokbotSession('grokbot-bob')).toBe(false)
  })

  it('treats -v3-rows alone as enough to hide unsuffixed/-v2', () => {
    const keys = ['grokbot-eggbot', 'grokbot-eggbot-v3-rows']
    expect(preferredGrokbotSession('grokbot-eggbot', keys)).toBe('grokbot-eggbot-v3-rows')
    expect(shouldHideGrokbotSession('grokbot-eggbot-v2', keys)).toBe(true)
  })

  it('does not treat -v3-store as the reclean sibling that hides unsuffixed', () => {
    const keys = ['grokbot-bob', 'grokbot-bob-v3-store']
    expect(preferredGrokbotSession('grokbot-bob', keys)).toBe('grokbot-bob')
    expect(shouldHideGrokbotSession('grokbot-bob', keys)).toBe(false)
  })

  it('emits query-time SQL that never DELETE/UPDATEs', () => {
    const msg = sqlNotSupersededGrokbotMessage('m')
    const conv = sqlNotSupersededGrokbotConversation('c')
    expect(msg).toContain('ros_conversations')
    expect(msg).toContain("'-v3'")
    expect(msg).toContain("'-v3-rows'")
    expect(msg).not.toMatch(/DELETE|UPDATE|INSERT/i)
    expect(conv).not.toMatch(/DELETE|UPDATE|INSERT/i)
    expect(msg).toContain("session_key NOT LIKE '%-v3%'")
  })
})
