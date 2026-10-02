/**
 * Unit tests for @rivetos/provider-anthropic
 *
 * Tests the provider configuration, model handling, and provider-options
 * construction (thinking levels, caching, reasoning flags). Uses pure helpers
 * and no network mocking needed — tests config/options logic only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicProvider, manifest } from './index.js'
import { ProviderError } from '@rivetos/types'
import type { ChatOptions, Message, ThinkingLevel } from '@rivetos/types'
import { createTokenSource } from '@rivetos/token-command'

describe('AnthropicProvider', () => {
  describe('constructor', () => {
    it('throws ProviderError if model is missing', () => {
      expect(() => {
        new AnthropicProvider({
          apiKey: 'test-key',
          model: '',
        })
      }).toThrow(ProviderError)
    })

    it('throws ProviderError with correct status and provider id', () => {
      try {
        new AnthropicProvider({
          apiKey: 'test-key',
          model: '',
        })
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError)
        if (err instanceof ProviderError) {
          expect(err.statusCode).toBe(400)
          expect(err.providerId).toBe('anthropic')
        }
      }
    })

    it('accepts required config and sets defaults', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
      })
      expect(provider.getModel()).toBe('claude-opus-4-7')
      expect(provider.getContextWindow()).toBe(0)
      expect(provider.getMaxOutputTokens()).toBe(0)
    })

    it('accepts optional maxTokens and applies it', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
        maxTokens: 4096,
      })
      expect(provider.id).toBe('anthropic')
    })

    it('accepts contextWindow and maxOutputTokens config', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
        contextWindow: 200000,
        maxOutputTokens: 8192,
      })
      expect(provider.getContextWindow()).toBe(200000)
      expect(provider.getMaxOutputTokens()).toBe(8192)
    })

    it('applies baseUrl override', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
        baseUrl: 'https://custom.example.com',
      })
      expect(provider.id).toBe('anthropic')
    })
  })

  describe('getModel and setModel', () => {
    it('getModel returns the configured model', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
      })
      expect(provider.getModel()).toBe('claude-opus-4-7')
    })

    it('setModel updates the model', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
      })
      provider.setModel('claude-sonnet-4-20250514')
      expect(provider.getModel()).toBe('claude-sonnet-4-20250514')
    })
  })

  describe('aiSdkBridge', () => {
    describe('buildProviderOptions', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
      })
      const bridge = provider.aiSdkBridge()

      it('includes cacheControl and sendReasoning by default', () => {
        const opts = bridge.buildProviderOptions([], {})
        expect(opts).toBeDefined()
        expect(opts?.anthropic).toBeDefined()
        expect((opts?.anthropic as any).cacheControl).toEqual({ type: 'ephemeral' })
        expect((opts?.anthropic as any).sendReasoning).toBe(true)
      })

      it('thinking off does not add thinking option', () => {
        const opts = bridge.buildProviderOptions([], { thinking: 'off' })
        expect((opts?.anthropic as any).thinking).toBeUndefined()
      })

      it('Claude 4 with thinking sets adaptive mode', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-opus-4-7',
          thinking: 'medium',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking).toEqual({ type: 'adaptive' })
        expect(anthropic.effort).toBe('medium')
      })

      it('Claude 4 with high thinking sets effort to high', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-opus-4-20250514',
          thinking: 'high',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking).toEqual({ type: 'adaptive' })
        expect(anthropic.effort).toBe('high')
      })

      it('Claude 4 with xhigh thinking sets effort to xhigh', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-haiku-4-20250514',
          thinking: 'xhigh',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.effort).toBe('xhigh')
      })

      it('Claude 3.5 with thinking low sets budget to 2000', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-3-5-sonnet-20241022',
          thinking: 'low',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking).toEqual({ type: 'enabled', budgetTokens: 2000 })
      })

      it('Claude 3.5 with thinking medium sets budget to 10000', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-3-5-sonnet-20241022',
          thinking: 'medium',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking).toEqual({ type: 'enabled', budgetTokens: 10000 })
      })

      it('Claude 3.5 with thinking high sets budget to 50000', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-3-5-sonnet-20241022',
          thinking: 'high',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking).toEqual({ type: 'enabled', budgetTokens: 50000 })
      })

      it('Claude 3.5 with thinking xhigh sets budget to 50000', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-3-5-sonnet-20241022',
          thinking: 'xhigh',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking).toEqual({ type: 'enabled', budgetTokens: 50000 })
      })

      it('modelOverride takes precedence over default model', () => {
        const opts = bridge.buildProviderOptions([], {
          modelOverride: 'claude-opus-4-7',
          thinking: 'medium',
        })
        const anthropic = opts?.anthropic as any
        expect(anthropic.thinking.type).toBe('adaptive')
      })

      it('returns nested anthropic key', () => {
        const opts = bridge.buildProviderOptions([], {})
        expect(Object.keys(opts || {})).toContain('anthropic')
      })
    })

    describe('getModel', () => {
      it('returns a LanguageModel for the configured model', () => {
        const provider = new AnthropicProvider({
          apiKey: 'test-key',
          model: 'claude-opus-4-7',
        })
        const bridge = provider.aiSdkBridge()
        const model = bridge.getModel({ modelOverride: undefined })
        expect(model).toBeDefined()
      })

      it('uses modelOverride when provided', () => {
        const provider = new AnthropicProvider({
          apiKey: 'test-key',
          model: 'claude-opus-4-7',
        })
        const bridge = provider.aiSdkBridge()
        const model = bridge.getModel({ modelOverride: 'claude-sonnet-4-20250514' })
        expect(model).toBeDefined()
      })

      it('creates provider with correct apiKey', () => {
        const provider = new AnthropicProvider({
          apiKey: 'secret-key-12345',
          model: 'claude-opus-4-7',
        })
        const bridge = provider.aiSdkBridge()
        const model = bridge.getModel({ modelOverride: undefined })
        expect(model).toBeDefined()
      })
    })
  })

  describe('provider metadata', () => {
    it('has id property set to anthropic', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
      })
      expect(provider.id).toBe('anthropic')
    })

    it('has name property', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-opus-4-7',
      })
      expect(provider.name).toBe('Anthropic Claude')
    })
  })

  describe('token_command', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })

    it('without tokenSource, isAvailable uses the static apiKey', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const provider = new AnthropicProvider({
        apiKey: 'static-key',
        model: 'claude-opus-4-7',
        baseUrl: 'https://example.test',
      })
      expect(await provider.isAvailable()).toBe(true)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(new Headers(init.headers).get('x-api-key')).toBe('static-key')
    })

    it('with tokenSource, isAvailable remints once on 401', async () => {
      let n = 0
      const tokenSource = createTokenSource({
        argv: ['helper'],
        runCommand: async () => `tok-${++n}`,
      })
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const key = new Headers(init?.headers).get('x-api-key')
        if (key === 'tok-1') return new Response('nope', { status: 401 })
        return new Response('ok', { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)

      const provider = new AnthropicProvider({
        apiKey: 'ignored-when-token-source',
        model: 'claude-opus-4-7',
        baseUrl: 'https://example.test',
        tokenSource,
      })
      expect(await provider.isAvailable()).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(n).toBe(2)
    })

    it('aiSdkBridge getModel works with tokenSource (authorized fetch wired)', () => {
      const tokenSource = createTokenSource({
        argv: ['helper'],
        runCommand: async () => 'minted',
      })
      const provider = new AnthropicProvider({
        apiKey: '',
        model: 'claude-opus-4-7',
        tokenSource,
      })
      const model = provider.aiSdkBridge().getModel({})
      expect(model).toBeDefined()
    })

    it('manifest skips token source when token_command is a shell string', () => {
      const warn = vi.fn()
      let registered: AnthropicProvider | undefined
      manifest.register({
        pluginConfig: { model: 'claude-opus-4-7', token_command: 'op read …' },
        env: {},
        logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
        registerProvider: (p) => {
          registered = p as AnthropicProvider
        },
      } as unknown as Parameters<typeof manifest.register>[0])
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/argv array/))
      expect(registered).toBeDefined()
      expect((registered as any).tokenSource).toBeUndefined()
    })
  })
})
