import { describe, expect, it, vi } from 'vitest'
import type { RivetGateway } from '@rivetos/gateway-client'
import {
  backoffMs,
  desiredProjectTags,
  PROJECT_TAG_REASON,
  projectTagLiteral,
  sessionKeyOf,
  syncProjectTags,
  type ProjectTagLedger,
} from './project-tags.js'

const BASE = 'https://hub:8787'
const SPACES = [
  { id: 'p1', name: 'Android stuff' },
  { id: 'p2', name: 'Site' },
]

/** In-memory tag store behind the two gateway calls the sync makes. */
function fakeGateway(captured: Set<string>) {
  let nextId = 1
  const tags: {
    id: string
    session: string
    key: string
    value: string
    state: string
    reason: string
  }[] = []
  const calls: string[] = []
  const gateway = {
    memoryTagsAdd: async (body: { session_key?: string; tag?: string; reason?: string }) => {
      calls.push(`add ${body.session_key} ${body.tag}`)
      if (!captured.has(body.session_key ?? '')) {
        throw new Error(`no conversation captured for session "${body.session_key}"`)
      }
      const [key, raw] = (body.tag ?? '').split(':')
      const value = raw.trim().toLowerCase().replace(/\s+/g, '-')
      const found = tags.find(
        (t) => t.session === body.session_key && t.key === key && t.value === value,
      )
      if (found) found.state = 'accepted'
      else
        tags.push({
          id: String(nextId++),
          session: body.session_key ?? '',
          key,
          value,
          state: 'accepted',
          reason: body.reason ?? '',
        })
      return {}
    },
    memoryTagsLookup: async (body: { session_keys: string[] }) => ({
      sessions: Object.fromEntries(
        body.session_keys.map((key) => [key, tags.filter((t) => t.session === key)]),
      ),
    }),
    memoryTagsDecide: async (body: { ids: string[]; state: string }) => {
      calls.push(`decide ${body.ids.join(',')} ${body.state}`)
      for (const tag of tags) if (body.ids.includes(tag.id)) tag.state = body.state
      return { changed: body.ids }
    },
  }
  return {
    endpoint: { gateway: gateway as unknown as RivetGateway, baseUrl: BASE },
    tags,
    calls,
  }
}

describe('project tags', () => {
  it('builds project:<name> per placed session key', () => {
    expect(projectTagLiteral('Android stuff')).toBe('project:Android stuff')
    expect(projectTagLiteral('  ')).toBeUndefined()
    expect(sessionKeyOf(`${BASE}::claude-code:abc`)).toBe('claude-code:abc')
    const desired = desiredProjectTags({ [`${BASE}::s1`]: 'p1', [`${BASE}::s2`]: 'gone' }, SPACES)
    expect([...desired]).toEqual([['s1', 'project:Android stuff']])
  })

  it('tags a captured session, and retries one not captured yet with backoff', async () => {
    const captured = new Set(['s1'])
    const { endpoint, tags } = fakeGateway(captured)
    const desired = desiredProjectTags({ [`${BASE}::s1`]: 'p1', [`${BASE}::s2`]: 'p1' }, SPACES)
    let ledger: ProjectTagLedger = await syncProjectTags(endpoint, {}, desired, 1000)
    expect(tags.map((t) => [t.session, t.value, t.reason])).toEqual([
      ['s1', 'android-stuff', PROJECT_TAG_REASON],
    ])
    expect(ledger.s1?.applied).toBe(true)
    expect(ledger.s2).toMatchObject({ applied: false, tries: 1, nextAt: 1000 + backoffMs(1) })

    // Not due yet: nothing is sent.
    ledger = await syncProjectTags(endpoint, ledger, desired, 2000)
    expect(tags).toHaveLength(1)

    captured.add('s2')
    ledger = await syncProjectTags(endpoint, ledger, desired, 1000 + backoffMs(1))
    expect(tags.map((t) => t.session)).toEqual(['s1', 's2'])
    expect(ledger.s2?.applied).toBe(true)
  })

  it('records and logs a failure that is not "not captured yet", and clears it on success', async () => {
    const { endpoint, tags } = fakeGateway(new Set(['s1']))
    const add = endpoint.gateway.memoryTagsAdd.bind(endpoint.gateway)
    let down = true
    endpoint.gateway.memoryTagsAdd = async (...args: Parameters<typeof add>) => {
      if (down) throw new Error('tag tables are missing: apply migration 0019 (rivetos db migrate)')
      return add(...args)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const desired = desiredProjectTags({ [`${BASE}::s1`]: 'p1' }, SPACES)
    let ledger = await syncProjectTags(endpoint, {}, desired, 0)
    expect(ledger.s1).toMatchObject({ applied: false, tries: 1 })
    expect(ledger.s1?.lastError).toMatch(/migration 0019/)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()

    down = false
    ledger = await syncProjectTags(endpoint, ledger, desired, backoffMs(1))
    expect(ledger.s1).toEqual({
      literal: 'project:Android stuff',
      applied: true,
      tries: 0,
      nextAt: 0,
    })
    expect(tags).toHaveLength(1)
  })

  it('does not log a session that is not captured yet', async () => {
    const { endpoint } = fakeGateway(new Set())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ledger = await syncProjectTags(
      endpoint,
      {},
      desiredProjectTags({ [`${BASE}::s1`]: 'p1' }, SPACES),
      0,
    )
    expect(ledger.s1?.lastError).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('moves the tag with the session and retires it when the session leaves', async () => {
    const { endpoint, tags } = fakeGateway(new Set(['s1']))
    let ledger = await syncProjectTags(
      endpoint,
      {},
      desiredProjectTags({ [`${BASE}::s1`]: 'p1' }, SPACES),
      0,
    )
    ledger = await syncProjectTags(
      endpoint,
      ledger,
      desiredProjectTags({ [`${BASE}::s1`]: 'p2' }, SPACES),
      0,
    )
    expect(tags.map((t) => [t.value, t.state])).toEqual([
      ['android-stuff', 'rejected'],
      ['site', 'accepted'],
    ])
    ledger = await syncProjectTags(endpoint, ledger, new Map(), 0)
    expect(tags.map((t) => [t.value, t.state])).toEqual([
      ['android-stuff', 'rejected'],
      ['site', 'rejected'],
    ])
    expect(ledger).toEqual({})
  })

  it('a project rename retags; a same-slug rename does not', async () => {
    const { endpoint, calls } = fakeGateway(new Set(['s1']))
    const rows = { [`${BASE}::s1`]: 'p1' }
    let ledger = await syncProjectTags(endpoint, {}, desiredProjectTags(rows, SPACES), 0)
    calls.length = 0
    ledger = await syncProjectTags(
      endpoint,
      ledger,
      desiredProjectTags(rows, [{ id: 'p1', name: 'ANDROID  Stuff' }]),
      0,
    )
    expect(calls).toEqual([])
    await syncProjectTags(
      endpoint,
      ledger,
      desiredProjectTags(rows, [{ id: 'p1', name: 'Phone' }]),
      0,
    )
    expect(calls).toEqual(['add s1 project:Phone', 'decide 1 rejected'])
  })

  it('never retires a project tag another tagger added', async () => {
    const { endpoint, tags } = fakeGateway(new Set(['s1']))
    let ledger = await syncProjectTags(
      endpoint,
      {},
      desiredProjectTags({ [`${BASE}::s1`]: 'p1' }, SPACES),
      0,
    )
    const ours = tags[0]
    if (ours) ours.reason = 'git root'
    ledger = await syncProjectTags(endpoint, ledger, new Map(), 0)
    expect(tags[0]?.state).toBe('accepted')
    expect(ledger).toEqual({})
  })
})
