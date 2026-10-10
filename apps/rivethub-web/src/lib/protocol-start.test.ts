import { describe, expect, it } from 'vitest'
import { protocolStartHarness } from './protocol-start.js'

const registry = [
  { harnessId: 'opencode' as const, capabilities: { protocolStart: true } },
  { harnessId: 'claude-code' as const, capabilities: {} },
]
const base = {
  isDraft: true,
  hasPty: false,
  harnessId: 'opencode' as const,
  agentId: undefined,
  registry,
}

describe('protocolStartHarness', () => {
  it('starts a draft through the control plane when the driver asks for it', () => {
    expect(protocolStartHarness(base)).toBe('opencode')
  })

  it('spawns as before for a harness without protocolStart', () => {
    expect(protocolStartHarness({ ...base, harnessId: 'claude-code' })).toBeUndefined()
  })

  it('spawns for an existing session, an existing PTY, an agent preset or an unknown harness', () => {
    expect(protocolStartHarness({ ...base, isDraft: false })).toBeUndefined()
    expect(protocolStartHarness({ ...base, hasPty: true })).toBeUndefined()
    expect(protocolStartHarness({ ...base, agentId: 'a1' })).toBeUndefined()
    expect(protocolStartHarness({ ...base, harnessId: undefined })).toBeUndefined()
  })

  it('spawns while the registry has not loaded', () => {
    expect(protocolStartHarness({ ...base, registry: undefined })).toBeUndefined()
  })
})
