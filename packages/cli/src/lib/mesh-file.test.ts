import { describe, it, expect } from 'vitest'
import { assertRecordMeshFile } from './mesh-file.js'

describe('mesh-file', () => {
  it('accepts Record-format mesh.json', () => {
    const mesh = assertRecordMeshFile(
      {
        version: 1,
        updatedAt: 42,
        nodes: {
          a: { id: 'a', name: 'a', host: '192.0.2.1', port: 3100, status: 'online' },
        },
      },
      '/tmp/test-mesh.json',
    )
    expect(mesh.nodes.a.name).toBe('a')
    expect(mesh.updatedAt).toBe(42)
  })

  it('fails loud on pre-capabilities flat-array mesh.json', () => {
    expect(() =>
      assertRecordMeshFile(
        {
          nodes: [{ name: 'legacy-node', ip: '192.0.2.1', role: 'primary' }],
          updatedAt: 1,
        },
        '/tmp/legacy-mesh.json',
      ),
    ).toThrow(/pre-capabilities flat-array/)
    expect(() =>
      assertRecordMeshFile(
        {
          nodes: [{ name: 'legacy-node', ip: '192.0.2.1', role: 'primary' }],
          updatedAt: 1,
        },
        '/tmp/legacy-mesh.json',
      ),
    ).toThrow(/\/tmp\/legacy-mesh\.json/)
  })
})
