import { describe, expect, it } from 'vitest'
import { pickLaunchSession, type LaunchCandidate } from './launch-session.js'

const HUB = 'https://hub.example'
const OTHER = 'https://other.example'

function row(
  key: string,
  updatedAt: number,
  kind = 'harness',
  pinNodeBaseUrl?: string,
  pin = false,
): LaunchCandidate {
  return { key, updatedAt, kind, ...(pinNodeBaseUrl ? { pinNodeBaseUrl } : {}), ...(pin ? { pin } : {}) }
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

  it('prefers the current node over a more recent session on another node', () => {
    expect(
      pickLaunchSession(
        [row('remote-newer', 900, 'harness', OTHER), row('local', 100, 'harness', HUB)],
        HUB,
      ),
    ).toBe('local')
  })

  it('falls back to the most recent session on ANY node when the current node has none', () => {
    // datahub case: the current node holds no interactive sessions → resume
    // the genuinely most recent thread rather than stranding on the list.
    expect(
      pickLaunchSession(
        [row('remote-old', 100, 'harness', OTHER), row('remote-new', 500, 'harness', OTHER)],
        HUB,
      ),
    ).toBe('remote-new')
  })

  it('excludes agent-pin pointer rows, even the most recent', () => {
    expect(
      pickLaunchSession(
        [row('agent-pin', 900, 'harness', HUB, true), row('real', 100, 'harness', HUB)],
        HUB,
      ),
    ).toBe('real')
  })

  it('returns undefined only when there is no resumable session anywhere', () => {
    expect(pickLaunchSession([], HUB)).toBeUndefined()
    expect(
      pickLaunchSession(
        [row('p1', 900, 'harness', HUB, true), row('p2', 800, 'harness', OTHER, true)],
        HUB,
      ),
    ).toBeUndefined()
  })
})
