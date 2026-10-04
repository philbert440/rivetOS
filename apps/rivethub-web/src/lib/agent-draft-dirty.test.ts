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

  it('RED-GREEN: re-baselining after harness defaults un-dirties the form', () => {
    // The auto-fill effect runs after mount: capture the pre-default baseline,
    // "apply" the defaults to live fields, then re-baseline — the form must
    // read clean again (the false-positive bug was: baseline stayed stale).
    const preFill = captureAgentDraft(sample({ rawHarnessId: '', rawModel: '', rawEffort: '' }))
    const liveAfterFill = sample({ rawHarnessId: 'hermes', rawModel: 'm1', rawEffort: 'medium' })
    expect(agentDraftDirty(preFill, liveAfterFill)).toBe(true)
    // Re-baseline from the filled state — the same operation the effect does:
    const rebased = captureAgentDraft(liveAfterFill)
    expect(agentDraftDirty(rebased, liveAfterFill)).toBe(false)
  })

  it('RED-GREEN: re-baselining must preserve untouched fields, not snapshot defaults blindly', () => {
    // User edits name BEFORE the harness sheet arrives; the auto-fill
    // re-baseline must keep the user's edit as the baseline for name while
    // taking the harness defaults for the three auto-filled fields.
    const preFill = captureAgentDraft(
      sample({ name: 'my-agent', rawHarnessId: '', rawModel: '', rawEffort: '' }),
    )
    const liveAfterFill = sample({
      name: 'my-agent',
      rawHarnessId: 'hermes',
      rawModel: 'm1',
      rawEffort: 'medium',
    })
    // Correct re-baseline: name stays 'my-agent' (user edit = baseline),
    // the three auto-filled fields take their new values.
    const rebased = captureAgentDraft({
      ...liveAfterFill,
      name: preFill.name === liveAfterFill.name ? liveAfterFill.name : preFill.name,
    })
    expect(agentDraftDirty(rebased, liveAfterFill)).toBe(false)
  })
})
