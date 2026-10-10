import { describe, expect, it } from 'vitest'
import { protocolStartPlan } from './protocol-start.js'

const registry = [
  { harnessId: 'opencode' as const, capabilities: { protocolStart: true } },
  { harnessId: 'claude-code' as const, capabilities: {} },
]
const base = {
  isDraft: true,
  hasPty: false,
  harnessId: 'opencode' as const,
  agentId: undefined,
  presetHasHarness: undefined,
  defaultHarnessId: undefined,
  registry,
}

describe('protocolStartPlan', () => {
  it('starts a draft through the control plane when the driver asks for it', () => {
    expect(protocolStartPlan(base)).toEqual({ harnessId: 'opencode' })
  })

  it('passes an agent preset along when its harness asks for it', () => {
    expect(protocolStartPlan({ ...base, agentId: 'a1', presetHasHarness: true })).toEqual({
      harnessId: 'opencode',
      agentId: 'a1',
    })
  })

  it("uses the node's default harness when the draft names none", () => {
    expect(
      protocolStartPlan({ ...base, harnessId: undefined, defaultHarnessId: 'opencode' }),
    ).toEqual({ harnessId: 'opencode' })
    expect(
      protocolStartPlan({ ...base, harnessId: undefined, defaultHarnessId: 'claude-code' }),
    ).toBeUndefined()
  })

  it('spawns for a preset with no harness, without falling back to the default', () => {
    expect(protocolStartPlan({ ...base, agentId: 'a1', presetHasHarness: false })).toBeUndefined()
    expect(
      protocolStartPlan({
        ...base,
        harnessId: undefined,
        agentId: 'a1',
        defaultHarnessId: 'opencode',
      }),
    ).toBeUndefined()
  })

  it('spawns for a harness without protocolStart, an existing session or PTY, or no registry', () => {
    expect(protocolStartPlan({ ...base, harnessId: 'claude-code' })).toBeUndefined()
    expect(protocolStartPlan({ ...base, isDraft: false })).toBeUndefined()
    expect(protocolStartPlan({ ...base, hasPty: true })).toBeUndefined()
    expect(protocolStartPlan({ ...base, registry: undefined })).toBeUndefined()
  })
})
