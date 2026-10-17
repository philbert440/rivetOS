import { describe, expect, it } from 'vitest'
import { modelIconKey } from './model-icon.js'

describe('modelIconKey', () => {
  it('reads the vendor from the model, past any provider prefix', () => {
    expect(modelIconKey({ model: 'openrouter/z-ai/glm-5.3', harnessId: 'opencode' })).toBe('zhipu')
    expect(modelIconKey({ model: 'opencode/nemotron-3.5-lightning-free' })).toBe('nvidia')
    expect(modelIconKey({ model: 'deepseek/deepseek-v4-flash' })).toBe('deepseek')
    expect(modelIconKey({ model: 'grok-4.7' })).toBe('grok')
    expect(modelIconKey({ model: 'claude-opus-5-5' })).toBe('claude')
    expect(modelIconKey({ model: 'openrouter/moonshotai/kimi-k3' })).toBe('kimi')
    expect(modelIconKey({ model: 'gpt-5.2' })).toBe('openai')
    expect(modelIconKey({ model: 'gpt-5.2-codex' })).toBe('codex')
  })

  it('falls back to the harness when the model is unknown or unset', () => {
    expect(modelIconKey({ harnessId: 'claude-code' })).toBe('claudecode')
    expect(modelIconKey({ model: 'default', harnessId: 'grok-build' })).toBe('grok')
    expect(modelIconKey({ model: 'some-house-model', command: 'opencode' })).toBe('opencode')
  })

  it('is undefined when neither identifies a brand', () => {
    expect(modelIconKey({})).toBeUndefined()
    expect(modelIconKey({ model: 'some-house-model', harnessId: 'mystery' })).toBeUndefined()
  })
})
