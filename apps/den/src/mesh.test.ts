import { describe, expect, it } from 'vitest'
import { buildMeshCards, type MeshNodePayload } from './mesh.js'
import { resolveServer } from './net.js'
import { LED_COLOR } from './room.js'

const PAGE = 'http://192.0.2.99:5174'

describe('buildMeshCards', () => {
  it('online remote node: count, host, origin href, green LED', () => {
    const [c] = buildMeshCards(
      [{ id: 'a', name: 'alpha', denUrl: 'http://192.0.2.10:5174', online: true, sessions: 2 }],
      PAGE,
    )
    expect(c.name).toBe('alpha')
    expect(c.host).toBe('192.0.2.10:5174')
    expect(c.status).toBe('2 sessions')
    expect(c.local).toBe(false)
    expect(c.href).toBe('http://192.0.2.10:5174')
    expect(c.led).toBe('#34d399')
    expect(c.latest).toBeNull()
  })

  it('singular count, and a probe that answered without one', () => {
    const nodes: MeshNodePayload[] = [
      { id: 'a', denUrl: 'http://192.0.2.10:5174', online: true, sessions: 1 },
      { id: 'b', denUrl: 'http://192.0.2.11:5174', online: true, sessions: null },
    ]
    const [one, unknown] = buildMeshCards(nodes, PAGE)
    expect(one.status).toBe('1 session')
    expect(unknown.status).toBe('online')
  })

  it('offline node: grayed status, no glow color, still clickable', () => {
    const [c] = buildMeshCards(
      [{ id: 'a', denUrl: 'https://192.0.2.10:8443', online: false, sessions: null }],
      PAGE,
    )
    expect(c.online).toBe(false)
    expect(c.status).toBe('offline')
    expect(c.led).toBe('#3a4a5e')
    expect(c.href).toBe('https://192.0.2.10:8443')
  })

  it('local node (latest key present, even null) links home, not to itself', () => {
    const [c] = buildMeshCards(
      [{ id: 'me', denUrl: 'http://192.0.2.20:5174', online: true, sessions: 0, latest: null }],
      PAGE,
      '/?token=t',
    )
    expect(c.local).toBe(true)
    expect(c.href).toBe('/?token=t')
    expect(c.status).toBe('0 sessions')
    expect(c.latest).toBeNull()
  })

  it('page-origin match marks local even without a latest key', () => {
    const [c] = buildMeshCards([{ id: 'me', denUrl: `${PAGE}/`, online: true, sessions: 1 }], PAGE)
    expect(c.local).toBe(true)
    expect(c.href).toBe('/')
  })

  it('latest peek: known activity gets the den label + LED color', () => {
    const [c] = buildMeshCards(
      [
        {
          id: 'me',
          denUrl: 'http://192.0.2.20:5174',
          online: true,
          sessions: 2,
          latest: { activity: 'editing_code', title: 'wiring the mesh view' },
        },
      ],
      PAGE,
    )
    expect(c.latest).toEqual({ title: 'wiring the mesh view', label: 'editing code' })
    expect(c.led).toBe(`#${LED_COLOR.editing_code.toString(16).padStart(6, '0')}`)
  })

  it('latest peek: unknown activity falls back to the raw word', () => {
    const [c] = buildMeshCards(
      [
        {
          id: 'me',
          denUrl: 'http://192.0.2.20:5174',
          online: true,
          sessions: 1,
          latest: { activity: 'transcending_spacetime', title: 't' },
        },
      ],
      PAGE,
    )
    expect(c.latest?.label).toBe('transcending spacetime')
    expect(c.led).toBe('#34d399') // no color mapping → plain online green
  })

  it('malformed entries still render something instead of throwing', () => {
    const cards = buildMeshCards([{}, { id: 'x', denUrl: 'not a url', online: true }], PAGE)
    expect(cards[0].name).toBe('?')
    expect(cards[1].host).toBe('not a url')
    expect(cards[1].href).toBe('not a url')
  })
})

describe('resolveServer (?server= derivation)', () => {
  const page = { protocol: 'http:', host: 'viewer:5173', hostname: 'viewer' }
  const pageTls = { protocol: 'https:', host: 'viewer', hostname: 'viewer' }

  it('bare host:port inherits the page protocol (pre-existing behavior)', () => {
    expect(resolveServer('192.0.2.10:5174', false, page)).toEqual({
      http: 'http://192.0.2.10:5174',
      ws: 'ws://192.0.2.10:5174',
    })
    expect(resolveServer('192.0.2.10:5174', false, pageTls)).toEqual({
      http: 'https://192.0.2.10:5174',
      ws: 'wss://192.0.2.10:5174',
    })
  })

  it('full http origin is used as-is; ws follows the OVERRIDE scheme', () => {
    // https page + http override: the override wins (that is the point)
    expect(resolveServer('http://192.0.2.10:5174', false, pageTls)).toEqual({
      http: 'http://192.0.2.10:5174',
      ws: 'ws://192.0.2.10:5174',
    })
  })

  it('full https origin derives wss and drops any path', () => {
    expect(resolveServer('https://den.example/some/path?x=1', false, page)).toEqual({
      http: 'https://den.example',
      ws: 'wss://den.example',
    })
  })

  it('an unparseable "://" override degrades to the host:port path', () => {
    expect(resolveServer('http://', false, page).http).toBe('http://http://')
  })

  it('no override: same-origin in prod, den port in dev', () => {
    expect(resolveServer(null, false, pageTls)).toEqual({ http: '', ws: 'wss://viewer' })
    expect(resolveServer(null, true, page)).toEqual({
      http: 'http://viewer:5174',
      ws: 'ws://viewer:5174',
    })
  })
})
