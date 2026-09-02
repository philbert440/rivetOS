import { describe, expect, it } from 'vitest'
import { catalogAgentToHarness, migrateAgentPreset } from './agent-preset.js'

describe('catalogAgentToHarness', () => {
  it('maps catalog agent ids to harness ids', () => {
    expect(catalogAgentToHarness('claude')).toBe('claude-code')
    expect(catalogAgentToHarness('grok')).toBe('grok-build')
    expect(catalogAgentToHarness('grok-fast')).toBe('grok-build')
    expect(catalogAgentToHarness('kimi')).toBe('kimi-code')
    expect(catalogAgentToHarness('hermes')).toBe('hermes')
  })

  it('maps already-canonical harness ids and leaves real model ids alone', () => {
    expect(catalogAgentToHarness('claude-code')).toBe('claude-code')
    expect(catalogAgentToHarness('fable')).toBeUndefined()
    expect(catalogAgentToHarness('grok-4.6')).toBeUndefined()
  })
})

describe('migrateAgentPreset', () => {
  it('moves a catalog agent id from model onto harnessId and clears model', () => {
    expect(migrateAgentPreset({ model: 'claude', name: 'A' })).toEqual({
      model: '',
      name: 'A',
      harnessId: 'claude-code',
    })
    expect(migrateAgentPreset({ model: 'grok-fast' }).harnessId).toBe('grok-build')
    expect(migrateAgentPreset({ model: 'kimi' }).model).toBe('')
  })

  it('leaves a real model id and an already-migrated preset alone', () => {
    expect(migrateAgentPreset({ model: 'fable' })).toEqual({ model: 'fable' })
    expect(migrateAgentPreset({ model: 'opus', harnessId: 'claude-code' as const })).toEqual({
      model: 'opus',
      harnessId: 'claude-code',
    })
  })
})
