import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RivetConfig } from './config.js'
import { nodeNameFor } from './node-name.js'

afterEach(() => vi.unstubAllEnvs())

describe('nodeNameFor', () => {
  it('prefers a trimmed mesh.node_name over HOSTNAME', () => {
    vi.stubEnv('HOSTNAME', 'from-host')
    expect(nodeNameFor({ mesh: { node_name: '  ct115  ' } } as RivetConfig)).toBe('ct115')
  })

  it('falls through a blank mesh.node_name to a trimmed HOSTNAME', () => {
    vi.stubEnv('HOSTNAME', '  box  ')
    expect(nodeNameFor({ mesh: { node_name: '   ' } } as RivetConfig)).toBe('box')
  })

  it('uses HOSTNAME when mesh is absent', () => {
    vi.stubEnv('HOSTNAME', 'box')
    expect(nodeNameFor({} as RivetConfig)).toBe('box')
  })

  it('uses local when both are absent or blank', () => {
    vi.stubEnv('HOSTNAME', '   ')
    expect(nodeNameFor({} as RivetConfig)).toBe('local')
    vi.stubEnv('HOSTNAME', '')
    expect(nodeNameFor({ mesh: {} } as RivetConfig)).toBe('local')
  })
})
