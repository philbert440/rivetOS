import { describe, expect, it } from 'vitest'
import { agentDraftDirty, captureAgentDraft, type AgentDraftFields } from './agent-draft-dirty.js'

function sample(overrides: Partial<AgentDraftFields> = {}): AgentDraftFields {
  return {
    name: 'coder',
    color: '#3b82f6',
    rawHarnessId: 'hermes',
    rawModel: '',
    rawEffort: 'medium',
    systemPrompt: '',
    draftDirectory: '/tmp/wf',
    sharedLink: true,
    ...overrides,
  }
}

describe('agentDraftDirty', () => {
  it('clean → identical to baseline is NOT dirty', () => {
    const base = captureAgentDraft(sample())
    expect(agentDraftDirty(base, sample())).toBe(false)
  })

  it('each single-field change is dirty', () => {
    const base = captureAgentDraft(sample())
    for (const field of [
      'name',
      'color',
      'rawHarnessId',
      'rawModel',
      'rawEffort',
      'systemPrompt',
      'draftDirectory',
    ] as const) {
      expect(agentDraftDirty(base, sample({ [field]: base[field] + 'x' })), field).toBe(true)
    }
    expect(agentDraftDirty(base, sample({ sharedLink: false })), 'sharedLink').toBe(true)
  })

  it('whitespace-only name difference counts (caller trims for the label only)', () => {
    const base = captureAgentDraft(sample())
    expect(agentDraftDirty(base, sample({ name: ' coder' }))).toBe(true)
  })

  it('back to baseline after edits is NOT dirty', () => {
    const base = captureAgentDraft(sample())
    const edited = sample({ name: 'coder!', color: '#f00' })
    expect(agentDraftDirty(base, edited)).toBe(true)
    expect(agentDraftDirty(base, sample())).toBe(false)
  })

  it('captureAgentDraft copies — mutating the snapshot does not alias the live fields', () => {
    const live = sample()
    const base = captureAgentDraft(live)
    live.name = 'changed'
    expect(base.name).toBe('coder')
  })

  it('MUTATION PROBE: ignoring fields must fail — pins full-field coverage', () => {
    // Simulates a guard that checks only 'name': a change elsewhere goes
    // unnoticed. A correct implementation must never satisfy this predicate.
    const base = captureAgentDraft(sample())
    const nameOnlyGuard = (live: AgentDraftFields): boolean => live.name !== base.name
    const changedElsewhere = sample({ systemPrompt: 'new prompt' })
    // The correct implementation flags it:
    expect(agentDraftDirty(base, changedElsewhere)).toBe(true)
    // Documenting the anti-pattern the full-field loop prevents:
    expect(nameOnlyGuard(changedElsewhere)).toBe(false)
  })
})
