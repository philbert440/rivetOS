import { describe, it, expect } from 'vitest'
import type { Provider, RegistrationContext } from '@rivetos/types'
import { GrokCliProvider, defaultGrokBinary, manifest } from './index.js'

describe('GrokCliProvider', () => {
  it('defaults: id grok-cli, dontAsk, one turn, prepend system prompt', () => {
    const p = new GrokCliProvider()
    expect(p.id).toBe('grok-cli')
    expect(p.getModel()).toBe('default')
    const bridge = p.aiSdkBridge()
    const model = bridge.getModel({ agentId: 'maggie' }) as unknown as { modelId: string; provider: string }
    expect(model.provider).toBe('grok-cli')
    expect(model.modelId).toBe('default')
  })

  it('maps thinking levels to reasoning effort providerOptions', () => {
    const b = new GrokCliProvider().aiSdkBridge()
    expect(b.buildProviderOptions([], { thinking: 'xhigh' })).toEqual({ 'grok-cli': { reasoningEffort: 'high' } })
    expect(b.buildProviderOptions([], { thinking: 'low' })).toEqual({ 'grok-cli': { reasoningEffort: 'low' } })
    expect(b.buildProviderOptions([], { thinking: 'off' })).toBeUndefined()
    expect(b.buildProviderOptions([], undefined)).toBeUndefined()
  })

  it('setModel/getModel round-trip and modelOverride wins in getModel()', () => {
    const p = new GrokCliProvider({ model: 'grok-4.5' })
    expect(p.getModel()).toBe('grok-4.5')
    p.setModel('grok-4.6')
    const m = p.aiSdkBridge().getModel({ modelOverride: 'x' }) as unknown as { modelId: string }
    expect(m.modelId).toBe('x')
  })

  it('isAvailable is false for a missing binary (cached)', async () => {
    const p = new GrokCliProvider({ binary: '/nonexistent/grok' })
    expect(await p.isAvailable()).toBe(false)
    expect(await p.isAvailable()).toBe(false)
  })

  it('defaultGrokBinary prefers ~/.grok/bin/grok, else PATH', () => {
    expect(defaultGrokBinary({ HOME: '/nonexistent-home' })).toBe('grok')
  })

  it('manifest registers a provider from snake_case config keys', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'grok-4.5', permission_mode: 'bypassPermissions', max_turns: 3, system_prompt: 'override', allow: ['Read'] },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.type).toBe('provider')
    expect(manifest.name).toBe('grok-cli')
    expect(registered?.id).toBe('grok-cli')
    expect(registered?.getModel()).toBe('grok-4.5')
  })
})
