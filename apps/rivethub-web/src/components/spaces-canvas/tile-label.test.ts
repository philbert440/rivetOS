import { describe, expect, it } from 'vitest'
import { modelLabel, modelNamesFrom, tileChip } from './tile-label.js'

const names = modelNamesFrom([
  { name: 'GLM 5.3', model: 'openrouter/z-ai/glm-5.3' },
  { name: 'Nemotron Free', model: 'opencode/nemotron-3.5-lightning-free' },
  { name: 'Second GLM', model: 'openrouter/z-ai/glm-5.3' },
  { name: 'No model' },
])

describe('modelLabel', () => {
  it('uses the roster agent that runs the model', () => {
    expect(modelLabel('openrouter/z-ai/glm-5.3', names)).toBe('GLM 5.3')
  })

  it('matches across a provider prefix on either side', () => {
    expect(modelLabel('z-ai/glm-5.3', names)).toBe('GLM 5.3')
    expect(modelLabel('gateway/opencode/nemotron-3.5-lightning-free', names)).toBe('Nemotron Free')
  })

  it("falls back to the model id's last segment", () => {
    expect(modelLabel('openrouter/moonshot/kimi-k3', names)).toBe('kimi-k3')
    expect(modelLabel('grok-4.7', names)).toBe('grok-4.7')
  })

  it('is undefined without a usable model', () => {
    expect(modelLabel(undefined, names)).toBeUndefined()
    expect(modelLabel('  ', names)).toBeUndefined()
    expect(modelLabel('default', names)).toBeUndefined()
  })
})

describe('tileChip', () => {
  it('prefers the model over the harness command', () => {
    expect(tileChip({ model: 'openrouter/z-ai/glm-5.3', command: 'opencode' }, names)).toBe(
      'GLM 5.3',
    )
  })

  it('keeps an explicit agent name first', () => {
    expect(
      tileChip({ agentName: 'general-purpose', model: 'grok-4.7', command: 'grok' }, names),
    ).toBe('general-purpose')
  })

  it('falls back to the command, then the harness, then session', () => {
    expect(tileChip({ command: 'opencode' }, names)).toBe('opencode')
    expect(tileChip({ harnessId: 'claude-code' }, names)).toBe('claude-code')
    expect(tileChip({}, names)).toBe('session')
  })
})
