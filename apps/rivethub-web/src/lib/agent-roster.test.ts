import { describe, expect, it } from 'vitest'
import {
  agentOpenPlan,
  KEEP_DIALOG_NOTE,
  nodeHealthStatus,
  sessionPointerMatches,
  uniqueRosterNodes,
} from './agent-roster.js'

describe('uniqueRosterNodes', () => {
  it('lets the roster name win over the synthetic Current Node label', () => {
    const nodes = uniqueRosterNodes(
      [{ name: 'rivet-grok', baseUrl: 'https://192.0.2.10:5174' }],
      'https://192.0.2.10:5174',
    )
    expect(nodes).toEqual([{ name: 'rivet-grok', baseUrl: 'https://192.0.2.10:5174' }])
  })

  it('keeps Current Node when the live URL is not in the roster', () => {
    const nodes = uniqueRosterNodes(
      [{ name: 'other', baseUrl: 'https://192.0.2.11:5174' }],
      'https://192.0.2.10:5174',
    )
    expect(nodes).toEqual([
      { name: 'Current Node', baseUrl: 'https://192.0.2.10:5174' },
      { name: 'other', baseUrl: 'https://192.0.2.11:5174' },
    ])
  })
})

describe('nodeHealthStatus', () => {
  it('treats pending as unknown so the row stays enabled without a red dot', () => {
    expect(nodeHealthStatus(undefined, true)).toBe('unknown')
    expect(nodeHealthStatus(undefined, false)).toBe('unknown')
    expect(nodeHealthStatus(true, false)).toBe('online')
    expect(nodeHealthStatus(false, false)).toBe('offline')
    expect(nodeHealthStatus(true, true)).toBe('online')
    expect(nodeHealthStatus(false, true)).toBe('offline')
  })
})

describe('agentOpenPlan', () => {
  it('keep does not add a draft or rewrite settings', () => {
    expect(agentOpenPlan('keep')).toEqual({ addDraft: false, applySettings: false })
    expect(agentOpenPlan('fresh')).toEqual({ addDraft: true, applySettings: true })
  })

  it('keep dialog tells the operator prompt/model changes apply to new conversations', () => {
    expect(KEEP_DIALOG_NOTE).toMatch(/new conversations/i)
  })
})

describe('sessionPointerMatches', () => {
  const nativeOf = (id: string): string | undefined => {
    const i = id.indexOf(':')
    return i >= 0 ? id.slice(i + 1) : undefined
  }

  it('matches canonical to native and identical ids', () => {
    expect(sessionPointerMatches('abc', 'abc', nativeOf)).toBe(true)
    expect(sessionPointerMatches('claude-code:abc', 'abc', nativeOf)).toBe(true)
    expect(sessionPointerMatches('claude-code:abc', 'claude-code:abc', nativeOf)).toBe(true)
    expect(sessionPointerMatches('abc', 'other', nativeOf)).toBe(false)
  })
})
