import { describe, expect, it } from 'vitest'
import { narrowLaunchTarget, pickLaunchSession, type LaunchCandidate } from './launch-session.js'

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

describe('narrowLaunchTarget', () => {
  const items = [row('old', 100), row('new', 300)]

  it('resumes the persisted last session IMMEDIATELY, before the load lands', () => {
    expect(
      narrowLaunchTarget({ lastActiveKey: 'last', loaded: false, sourceKeys: [], items, baseUrl: HUB }),
    ).toEqual({ kind: 'resume', key: 'last' })
  })

  it('keeps the resume when the load confirms the key still exists', () => {
    expect(
      narrowLaunchTarget({
        lastActiveKey: 'old',
        loaded: true,
        sourceKeys: ['old', 'new'],
        items,
        baseUrl: HUB,
      }),
    ).toEqual({ kind: 'resume', key: 'old' })
  })

  it('a stale lastActive (no source row after load) falls back to the pick', () => {
    expect(
      narrowLaunchTarget({
        lastActiveKey: 'gone',
        loaded: true,
        sourceKeys: ['old', 'new'],
        items,
        baseUrl: HUB,
      }),
    ).toEqual({ kind: 'pick', key: 'new' })
  })

  it('a stale lastActive with no sessions anywhere resolves to new', () => {
    expect(
      narrowLaunchTarget({ lastActiveKey: 'gone', loaded: true, sourceKeys: [], items: [], baseUrl: HUB }),
    ).toEqual({ kind: 'new' })
  })

  it('with nothing persisted and the load in flight, the surface is loading', () => {
    expect(
      narrowLaunchTarget({ loaded: false, sourceKeys: [], items: [], baseUrl: HUB }),
    ).toEqual({ kind: 'loading' })
  })

  it('with nothing persisted, the most recent session is picked once loaded', () => {
    expect(
      narrowLaunchTarget({ loaded: true, sourceKeys: ['old', 'new'], items, baseUrl: HUB }),
    ).toEqual({ kind: 'pick', key: 'new' })
  })

  it('an empty account resolves to the new-conversation compose state, never the list', () => {
    expect(
      narrowLaunchTarget({ loaded: true, sourceKeys: [], items: [], baseUrl: HUB }),
    ).toEqual({ kind: 'new' })
  })
})
