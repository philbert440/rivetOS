import { describe, expect, it, vi } from 'vitest'
import {
  assertRecordMeshFile,
  isMeshFlatArrayError,
  MeshParseError,
  parseMeshFile,
} from './mesh.js'

const validDoc = {
  version: 1,
  updatedAt: 42,
  extraRoot: true,
  nodes: {
    a: {
      id: 'a',
      name: 'a',
      host: '192.0.2.1',
      port: 3100,
      status: 'online',
      sshUser: 'philip',
      installRoot: '/srv/rivetos',
      platform: 'linux',
      unknownNodeField: 'ok',
    },
  },
}

describe('parseMeshFile', () => {
  it('accepts a valid Record-format file', () => {
    const mesh = parseMeshFile(JSON.stringify(validDoc))
    expect(mesh.version).toBe(1)
    expect(mesh.updatedAt).toBe(42)
    expect(mesh.nodes.a.name).toBe('a')
    expect(mesh.nodes.a.host).toBe('192.0.2.1')
    expect(mesh.nodes.a.port).toBe(3100)
    expect(mesh.nodes.a.status).toBe('online')
    expect(mesh.nodes.a.sshUser).toBe('philip')
    expect(mesh.nodes.a.installRoot).toBe('/srv/rivetos')
    expect(mesh.nodes.a.platform).toBe('linux')
    expect(mesh.nodes.a.agents).toEqual([])
    expect(mesh.nodes.a.providers).toEqual([])
    expect(mesh.nodes.a.models).toEqual([])
    expect(mesh.nodes.a.capabilities).toEqual([])
  })

  it('preserves unknown fields on the root and on nodes', () => {
    const mesh = parseMeshFile(JSON.stringify(validDoc))
    expect('extraRoot' in mesh).toBe(true)
    expect((mesh as { extraRoot?: unknown }).extraRoot).toBe(true)
    expect('unknownNodeField' in mesh.nodes.a).toBe(true)
    expect((mesh.nodes.a as { unknownNodeField?: unknown }).unknownNodeField).toBe('ok')
    expect(mesh.nodes.a.id).toBe('a')
  })

  it('defaults missing node id/name from the record key', () => {
    const mesh = parseMeshFile(
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        nodes: { ct110: { host: '192.0.2.10', port: 3000, status: 'offline' } },
      }),
    )
    expect(mesh.nodes.ct110.id).toBe('ct110')
    expect(mesh.nodes.ct110.name).toBe('ct110')
    expect(mesh.nodes.ct110.agents).toEqual([])
    expect(mesh.nodes.ct110.lastSeen).toBe(0)
    expect(mesh.nodes.ct110.version).toBe('')
  })

  it('throws MeshParseError on pre-capabilities flat-array', () => {
    const raw = JSON.stringify({
      nodes: [{ name: 'legacy-node', ip: '192.0.2.1', role: 'primary' }],
      updatedAt: 1,
    })
    expect(() => parseMeshFile(raw, '/tmp/legacy-mesh.json')).toThrow(MeshParseError)
    expect(() => parseMeshFile(raw, '/tmp/legacy-mesh.json')).toThrow(/pre-capabilities flat-array/)
    expect(() => parseMeshFile(raw, '/tmp/legacy-mesh.json')).toThrow(/\/tmp\/legacy-mesh\.json/)
    try {
      parseMeshFile(raw, '/tmp/legacy-mesh.json')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isMeshFlatArrayError(err)).toBe(true)
      expect(err).toBeInstanceOf(MeshParseError)
      expect((err as MeshParseError).code).toBe('MESH_FLAT_ARRAY')
    }
  })

  it('throws on invalid JSON', () => {
    expect(() => parseMeshFile('{nope', '/tmp/bad.json')).toThrow(MeshParseError)
    try {
      parseMeshFile('{nope', '/tmp/bad.json')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MeshParseError)
      expect((err as MeshParseError).code).toBe('MESH_JSON_INVALID')
    }
  })

  it('rejects a node that is not an object', () => {
    expect(() =>
      parseMeshFile(JSON.stringify({ version: 1, updatedAt: 0, nodes: { a: 'nope' } })),
    ).toThrow(/node "a" is not an object/)
  })

  it('rejects a node with a non-numeric port', () => {
    expect(() =>
      parseMeshFile(
        JSON.stringify({ version: 1, updatedAt: 0, nodes: { a: { host: 'h', port: '3100' } } }),
      ),
    ).toThrow(/invalid port/)
  })

  it('rejects a node with a non-array agents field', () => {
    expect(() =>
      parseMeshFile(
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          nodes: { a: { host: 'h', port: 1, agents: 'opus' } },
        }),
      ),
    ).toThrow(/invalid agents/)
  })

  it('rejects a node with a non-object metadata field', () => {
    expect(() =>
      parseMeshFile(
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          nodes: { a: { host: 'h', port: 1, metadata: ['nope'] } },
        }),
      ),
    ).toThrow(/invalid metadata/)
  })

  it('skips null node entries', () => {
    const mesh = parseMeshFile(
      JSON.stringify({ version: 1, updatedAt: 7, nodes: { a: null, b: { host: 'h', port: 1 } } }),
    )
    expect(mesh.nodes.a).toBeUndefined()
    expect(mesh.nodes.b.host).toBe('h')
    expect(mesh.updatedAt).toBe(7)
  })

  it('onInvalidNode skip omits a bad node and warns once with its id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const mesh = parseMeshFile(
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          nodes: {
            good: { host: 'h', port: 1 },
            bad: { host: 'h', port: '3100' },
          },
        }),
        'mesh.json',
        { onInvalidNode: 'skip' },
      )
      expect(mesh.nodes.good).toBeDefined()
      expect(mesh.nodes.good.port).toBe(1)
      expect(mesh.nodes.bad).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/"bad"/)
    } finally {
      warn.mockRestore()
    }
  })

  it('onInvalidNode throw (default) still rejects a bad node', () => {
    expect(() =>
      parseMeshFile(
        JSON.stringify({
          version: 1,
          updatedAt: 0,
          nodes: { good: { host: 'h', port: 1 }, bad: { host: 'h', port: '3100' } },
        }),
      ),
    ).toThrow(/invalid port/)
  })

  it('onInvalidNode skip still throws on flat-array', () => {
    expect(() =>
      parseMeshFile(
        JSON.stringify({ nodes: [{ name: 'legacy-node', ip: '192.0.2.1' }], updatedAt: 1 }),
        '/tmp/legacy-mesh.json',
        { onInvalidNode: 'skip' },
      ),
    ).toThrow(/pre-capabilities flat-array/)
  })

  it('onInvalidNode skip still throws on root shape errors', () => {
    expect(() =>
      parseMeshFile(JSON.stringify({ nodes: 'nope' }), 'mesh.json', { onInvalidNode: 'skip' }),
    ).toThrow(/nodes must be an object/)
  })
})

describe('assertRecordMeshFile', () => {
  it('accepts an already-parsed Record-format object', () => {
    const mesh = assertRecordMeshFile(
      {
        version: 1,
        updatedAt: 42,
        nodes: {
          a: {
            id: 'a',
            name: 'a',
            host: '192.0.2.1',
            port: 3100,
            status: 'online',
            sshUser: 'philip',
            installRoot: '/srv/rivetos',
          },
        },
      },
      '/tmp/test-mesh.json',
    )
    expect(mesh.nodes.a.name).toBe('a')
    expect(mesh.nodes.a.sshUser).toBe('philip')
    expect(mesh.nodes.a.installRoot).toBe('/srv/rivetos')
    expect(mesh.updatedAt).toBe(42)
  })
})
