import { describe, expect, it } from 'vitest'
import {
  aggregateAgentActivity,
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

describe('aggregateAgentActivity', () => {
  const A = 'https://192.0.2.10:5174'
  const B = 'https://192.0.2.11:5174'

  it('active wins over idle and names its node', () => {
    expect(
      aggregateAgentActivity([
        { nodeBaseUrl: A, status: 'idle' },
        { nodeBaseUrl: B, status: 'active' },
      ]),
    ).toEqual({ level: 'active', nodeBaseUrl: B })
  })

  it('idle shows when nothing is active', () => {
    expect(
      aggregateAgentActivity([
        { nodeBaseUrl: A, status: 'ended' },
        { nodeBaseUrl: B, status: 'idle' },
      ]),
    ).toEqual({ level: 'idle', nodeBaseUrl: B })
  })

  it('ended, error, unknown, and empty all read as none', () => {
    expect(aggregateAgentActivity([])).toEqual({ level: 'none' })
    expect(
      aggregateAgentActivity([
        { nodeBaseUrl: A, status: 'ended' },
        { nodeBaseUrl: B, status: 'error' },
        { nodeBaseUrl: A, status: undefined },
      ]),
    ).toEqual({ level: 'none' })
  })
})
