import { describe, expect, it } from 'vitest'
import type { AgentPreset, MeshDenNode } from '@rivetos/types'
import {
  aggregateAgentActivity,
  dedupeRosterAgents,
  meshDenName,
  nodeOptionLabel,
  pointersToPoll,
  resolveAgentNodeUrl,
  sessionPointerMatches,
  uniqueRosterNodes,
  type NodeChoice,
} from './agent-roster.js'

function preset(over: Partial<AgentPreset> & Pick<AgentPreset, 'id' | 'name'>): AgentPreset {
  return {
    color: '',
    model: '',
    effort: '',
    systemPrompt: '',
    nodeBaseUrl: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function mesh(over: Partial<MeshDenNode> & Pick<MeshDenNode, 'id' | 'name'>): MeshDenNode {
  return { denUrl: '', online: true, sessions: null, ...over }
}

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

describe('resolveAgentNodeUrl', () => {
  const source = 'https://192.0.2.10:5174'
  const peer = 'https://192.0.2.11:5174'
  const legacy = 'https://192.0.2.12:5174'
  const ctx = {
    sourceBaseUrl: source,
    sourceNode: 'ct115',
    mesh: [] as MeshDenNode[],
    roster: [] as NodeChoice[],
  }

  it('uses the answering den when agent.node is that den (loopback denUrl is empty)', () => {
    const agent = preset({
      id: 'a',
      name: 'Reviewer',
      node: 'ct115',
      nodeBaseUrl: legacy,
    })
    expect(
      resolveAgentNodeUrl(agent, {
        ...ctx,
        mesh: [mesh({ id: 'ct115', name: 'ct115', denUrl: '' })],
        roster: [{ name: 'other', baseUrl: peer, node: 'ct115' }],
      }),
    ).toBe(source)
  })

  it('uses a mesh denUrl when the name or id matches and the URL is non-empty', () => {
    const agent = preset({ id: 'a', name: 'Reviewer', node: 'ct116', nodeBaseUrl: legacy })
    expect(
      resolveAgentNodeUrl(agent, {
        ...ctx,
        mesh: [
          mesh({ id: 'ct116', name: 'ct116', denUrl: '' }),
          mesh({ id: 'node-116', name: 'ct116', denUrl: `${peer}/` }),
        ],
      }),
    ).toBe(peer)
    expect(
      resolveAgentNodeUrl(agent, {
        ...ctx,
        mesh: [mesh({ id: 'ct116', name: 'display', denUrl: peer })],
      }),
    ).toBe(peer)
  })

  it('uses a roster entry whose recorded healthz node matches', () => {
    const agent = preset({ id: 'a', name: 'Reviewer', node: 'ct116', nodeBaseUrl: legacy })
    const roster: NodeChoice[] = [
      { name: 'Rivet-Grok', baseUrl: source, node: 'ct115' },
      { name: 'saved label', baseUrl: peer, node: 'ct116' },
    ]
    expect(resolveAgentNodeUrl(agent, { ...ctx, roster })).toBe(peer)
  })

  it('does not treat the roster display name as the mesh node name', () => {
    const agent = preset({ id: 'a', name: 'Reviewer', node: 'ct116', nodeBaseUrl: '' })
    expect(
      resolveAgentNodeUrl(agent, {
        ...ctx,
        roster: [{ name: 'ct116', baseUrl: peer }],
      }),
    ).toBeUndefined()
  })

  it('falls back to legacy nodeBaseUrl, else undefined', () => {
    expect(
      resolveAgentNodeUrl(preset({ id: 'a', name: 'Old', nodeBaseUrl: `${legacy}/` }), ctx),
    ).toBe(legacy)
    expect(
      resolveAgentNodeUrl(preset({ id: 'a', name: 'Old', node: 'missing', nodeBaseUrl: '' }), ctx),
    ).toBeUndefined()
    expect(resolveAgentNodeUrl(preset({ id: 'a', name: 'Old', nodeBaseUrl: '  ' }), ctx)).toBe(
      undefined,
    )
  })

  it('prefers same-den, then mesh, then roster, then legacy', () => {
    const agent = preset({
      id: 'a',
      name: 'Reviewer',
      node: 'ct115',
      nodeBaseUrl: legacy,
    })
    const full = {
      ...ctx,
      mesh: [mesh({ id: 'ct115', name: 'ct115', denUrl: peer })],
      roster: [{ name: 'saved', baseUrl: 'https://192.0.2.13:5174', node: 'ct115' }],
    }
    expect(resolveAgentNodeUrl(agent, full)).toBe(source)
    expect(resolveAgentNodeUrl(agent, { ...full, sourceNode: 'other' })).toBe(peer)
    expect(
      resolveAgentNodeUrl(agent, {
        ...full,
        sourceNode: 'other',
        mesh: [mesh({ id: 'ct115', name: 'ct115', denUrl: '  ' })],
      }),
    ).toBe('https://192.0.2.13:5174')
    expect(
      resolveAgentNodeUrl(agent, {
        ...full,
        sourceNode: 'other',
        mesh: [],
        roster: [],
      }),
    ).toBe(legacy)
  })
})

describe('nodeOptionLabel', () => {
  it('labels the current node by its mesh name when the probe recorded one', () => {
    expect(
      nodeOptionLabel(
        { name: 'Current Node', baseUrl: 'https://192.0.2.10:5174' },
        { currentBaseUrl: 'https://192.0.2.10:5174/', healthzNode: 'ct115', meshName: 'other' },
      ),
    ).toBe('ct115')
  })

  it('labels other nodes by mesh name, then the recorded healthz node, then the roster name', () => {
    const choice: NodeChoice = { name: 'saved', baseUrl: 'https://192.0.2.11:5174', node: 'ct116' }
    expect(nodeOptionLabel(choice, { currentBaseUrl: 'https://192.0.2.10:5174' })).toBe('ct116')
    expect(
      nodeOptionLabel(choice, { currentBaseUrl: 'https://192.0.2.10:5174', meshName: 'from-mesh' }),
    ).toBe('from-mesh')
    expect(
      meshDenName(
        [
          mesh({ id: 'ct116', name: 'ct116', denUrl: '' }),
          mesh({ id: 'x', name: 'ct116', denUrl: 'https://192.0.2.11:5174/' }),
        ],
        'https://192.0.2.11:5174',
      ),
    ).toBe('ct116')
  })
})

describe('dedupeRosterAgents', () => {
  const current = 'https://192.0.2.10:5174'
  const host = 'https://192.0.2.11:5174'
  const agent = preset({
    id: 'same',
    name: 'Reviewer',
    node: 'ct116',
    directory: '/srv/reviewer',
    nodeBaseUrl: '',
  })

  it('keeps the resolved copy and prefers the current node when it also resolves', () => {
    const rows = dedupeRosterAgents(
      [
        { baseUrl: current, node: 'ct115', agents: [{ ...agent, name: 'from-current' }] },
        { baseUrl: host, node: 'ct116', agents: [{ ...agent, name: 'from-host' }] },
      ],
      {
        currentBaseUrl: current,
        mesh: [mesh({ id: 'ct116', name: 'ct116', denUrl: host })],
        roster: [],
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('from-current')
    expect(rows[0]?.sourceNodeBaseUrl).toBe(host)
    expect(rows[0]?.listedBaseUrl).toBe(current)
  })

  it('keeps another den’s copy when only that copy resolves', () => {
    const rows = dedupeRosterAgents(
      [
        { baseUrl: current, node: 'ct115', agents: [agent] },
        { baseUrl: host, node: 'ct116', agents: [{ ...agent, directory: '/on/host' }] },
      ],
      { currentBaseUrl: current, mesh: [], roster: [] },
    )
    expect(rows[0]?.sourceNodeBaseUrl).toBe(host)
    expect(rows[0]?.directory).toBe('/on/host')
    expect(rows[0]?.listedBaseUrl).toBe(host)
  })

  it('leaves sourceNodeBaseUrl empty when nothing resolves', () => {
    const rows = dedupeRosterAgents([{ baseUrl: current, node: 'ct115', agents: [agent] }], {
      currentBaseUrl: current,
      mesh: [],
      roster: [],
    })
    expect(rows[0]?.sourceNodeBaseUrl).toBe('')
    expect(rows[0]?.listedBaseUrl).toBe(current)
  })
})

describe('pointersToPoll', () => {
  const A = 'https://192.0.2.10:5174'
  const B = 'https://192.0.2.11:5174'
  const C = 'https://192.0.2.12:5174'
  const p = (nodeBaseUrl: string): { nodeBaseUrl: string } => ({ nodeBaseUrl })

  it('puts the current node first and keeps every pointer within the cap', () => {
    expect(pointersToPoll([p(B), p(C), p(A)], A, 16)).toEqual([p(A), p(B), p(C)])
  })

  it('keeps recency order when the current node holds no pointer', () => {
    expect(pointersToPoll([p(B), p(C)], A, 16)).toEqual([p(B), p(C)])
  })

  it('always polls at least one pointer even with a degenerate limit', () => {
    expect(pointersToPoll([p(B), p(A)], A, 0)).toEqual([p(A)])
  })
})
