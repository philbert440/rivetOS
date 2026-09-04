import { describe, expect, it } from 'vitest'
import { pickLaunchSession, type LaunchCandidate } from './launch-session.js'

const HUB = 'https://hub.example'
const OTHER = 'https://other.example'

function row(key: string, updatedAt: number, kind = 'harness', pinNodeBaseUrl?: string): LaunchCandidate {
  return { key, updatedAt, kind, ...(pinNodeBaseUrl ? { pinNodeBaseUrl } : {}) }
}

describe('pickLaunchSession', () => {
  it('picks the most recent session for the current node', () => {
    expect(
      pickLaunchSession([row('old', 100), row('new', 300), row('mid', 200)], HUB),
    ).toBe('new')
  })

  it('an in-progress draft wins over a more recent finished thread', () => {
    expect(
      pickLaunchSession([row('finished', 900), row('draft-1', 100, 'draft')], HUB),
    ).toBe('draft-1')
  })

  it('picks the most recent draft when several are in progress', () => {
    expect(
      pickLaunchSession(
        [row('d1', 100, 'draft'), row('finished', 900), row('d2', 200, 'draft')],
        HUB,
      ),
    ).toBe('d2')
  })

  it('ignores rows pinned from another node', () => {
    expect(
      pickLaunchSession(
        [row('remote-pin', 900, 'legacy', OTHER), row('local', 100)],
        HUB,
      ),
    ).toBe('local')
  })

  it('accepts a pin whose node IS the current node', () => {
    expect(pickLaunchSession([row('home-pin', 900, 'legacy', HUB), row('local', 100)], HUB)).toBe(
      'home-pin',
    )
  })

  it('returns undefined when the node has no sessions at all', () => {
    expect(pickLaunchSession([], HUB)).toBeUndefined()
    expect(pickLaunchSession([row('remote-pin', 1, 'legacy', OTHER)], HUB)).toBeUndefined()
  })
})
