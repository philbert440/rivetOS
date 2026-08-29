import { describe, expect, it } from 'vitest'
import {
  aggregateAgentActivity,
  pointersToPoll,
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

  it('prefers the current node when several sessions share the winning level', () => {
    const both = [
      { nodeBaseUrl: A, status: 'active' },
      { nodeBaseUrl: B, status: 'active' },
    ]
    expect(aggregateAgentActivity(both, B)).toEqual({ level: 'active', nodeBaseUrl: B })
    expect(aggregateAgentActivity(both, A)).toEqual({ level: 'active', nodeBaseUrl: A })
    // No current node supplied (or not among matches): first entry wins.
    expect(aggregateAgentActivity(both)).toEqual({ level: 'active', nodeBaseUrl: A })
    expect(
      aggregateAgentActivity(
        [
          { nodeBaseUrl: A, status: 'idle' },
          { nodeBaseUrl: B, status: 'idle' },
        ],
        B,
      ),
    ).toEqual({ level: 'idle', nodeBaseUrl: B })
  })
})

describe('pointersToPoll', () => {
  const A = 'https://192.0.2.10:5174'
  const B = 'https://192.0.2.11:5174'
  const C = 'https://192.0.2.12:5174'
  const p = (nodeBaseUrl: string): { nodeBaseUrl: string } => ({ nodeBaseUrl })

  it('puts the current node first and caps the total', () => {
    expect(pointersToPoll([p(B), p(C), p(A)], A, 2)).toEqual([p(A), p(B)])
  })

  it('keeps recency order when the current node holds no pointer', () => {
    expect(pointersToPoll([p(B), p(C)], A, 2)).toEqual([p(B), p(C)])
  })

  it('always polls at least one pointer even with a degenerate limit', () => {
    expect(pointersToPoll([p(B), p(A)], A, 0)).toEqual([p(A)])
  })
})
