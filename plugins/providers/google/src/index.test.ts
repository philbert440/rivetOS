/**
 * Unit tests for @rivetos/provider-google — GoogleProvider class.
 * Tests config handling, model/token getters, aiSdkBridge, and isAvailable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GoogleProvider } from './index.js'
import type { ChatOptions } from '@rivetos/types'

describe('GoogleProvider', () => {
  const mockConfig = {
    apiKey: 'test-key-12345',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('sets apiKey and defaults for model, maxTokens, baseUrl', () => {
      const provider = new GoogleProvider(mockConfig)
      expect(provider.getModel()).toBe('gemini-2.5-pro') // MODEL_DEFAULTS.google
      expect(provider.id).toBe('google')
      expect(provider.name).toBe('Google Gemini')
    })

    it('applies custom model override', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        model: 'gemini-1.5-pro',
      })
      expect(provider.getModel()).toBe('gemini-1.5-pro')
    })

    it('applies custom maxTokens', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        maxTokens: 4096,
      })
      expect(provider).toBeDefined()
    })

    it('applies custom baseUrl', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        baseUrl: 'https://custom.example.com/v1',
      })
      expect(provider).toBeDefined()
    })

    it('sets context window and output token limits', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        contextWindow: 100000,
        maxOutputTokens: 4096,
      })
      expect(provider.getContextWindow()).toBe(100000)
      expect(provider.getMaxOutputTokens()).toBe(4096)
    })
  })

  describe('model management', () => {
    it('getModel returns current model', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        model: 'gemini-2.0-flash',
      })
      expect(provider.getModel()).toBe('gemini-2.0-flash')
    })

    it('setModel updates model', () => {
      const provider = new GoogleProvider(mockConfig)
      provider.setModel('gemini-exp-05-11')
      expect(provider.getModel()).toBe('gemini-exp-05-11')
    })
  })

  describe('context window and output tokens', () => {
    it('returns 0 for context window when not set', () => {
      const provider = new GoogleProvider(mockConfig)
      expect(provider.getContextWindow()).toBe(0)
    })

    it('returns custom context window', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        contextWindow: 1000000,
      })
      expect(provider.getContextWindow()).toBe(1000000)
    })

    it('returns 0 for max output tokens when not set', () => {
      const provider = new GoogleProvider(mockConfig)
      expect(provider.getMaxOutputTokens()).toBe(0)
    })

    it('returns custom max output tokens', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        maxOutputTokens: 8192,
      })
      expect(provider.getMaxOutputTokens()).toBe(8192)
    })
  })

  describe('aiSdkBridge', () => {
    it('returns bridge with getModel and buildProviderOptions methods', () => {
      const provider = new GoogleProvider(mockConfig)
      const bridge = provider.aiSdkBridge()
      expect(bridge.getModel).toBeDefined()
      expect(bridge.buildProviderOptions).toBeDefined()
    })

    it('getModel uses model override when provided', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        model: 'gemini-2.5-pro',
      })
      const bridge = provider.aiSdkBridge()
      const model = bridge.getModel({ modelOverride: 'gemini-exp-05-11' })
      expect(model).toBeDefined()
    })

    it('getModel uses default model when no override', () => {
      const provider = new GoogleProvider({
        ...mockConfig,
        model: 'gemini-2.5-pro',
      })
      const bridge = provider.aiSdkBridge()
      const model = bridge.getModel({})
      expect(model).toBeDefined()
    })

    describe('buildProviderOptions', () => {
      it('returns undefined for thinking: off', () => {
        const provider = new GoogleProvider(mockConfig)
        const bridge = provider.aiSdkBridge()
        const options = bridge.buildProviderOptions([], { thinking: 'off' })
        expect(options).toBeUndefined()
      })

      it('returns thinkingConfig for thinking: low', () => {
        const provider = new GoogleProvider(mockConfig)
        const bridge = provider.aiSdkBridge()
        const options = bridge.buildProviderOptions([], { thinking: 'low' })
        expect(options).toEqual({
          google: {
            thinkingConfig: {
              thinkingBudget: 1024,
              includeThoughts: true,
            },
          },
        })
      })

      it('returns thinkingConfig for thinking: medium', () => {
        const provider = new GoogleProvider(mockConfig)
        const bridge = provider.aiSdkBridge()
        const options = bridge.buildProviderOptions([], { thinking: 'medium' })
        expect(options).toEqual({
          google: {
            thinkingConfig: {
              thinkingBudget: 8192,
              includeThoughts: true,
            },
          },
        })
      })

      it('returns thinkingConfig for thinking: high', () => {
        const provider = new GoogleProvider(mockConfig)
        const bridge = provider.aiSdkBridge()
        const options = bridge.buildProviderOptions([], { thinking: 'high' })
        expect(options).toEqual({
          google: {
            thinkingConfig: {
              thinkingBudget: 32768,
              includeThoughts: true,
            },
          },
        })
      })

      it('returns thinkingConfig for thinking: xhigh (same as high)', () => {
        const provider = new GoogleProvider(mockConfig)
        const bridge = provider.aiSdkBridge()
        const options = bridge.buildProviderOptions([], { thinking: 'xhigh' })
        expect(options).toEqual({
          google: {
            thinkingConfig: {
              thinkingBudget: 32768,
              includeThoughts: true,
            },
          },
        })
      })

      it('defaults thinking to off when not specified', () => {
        const provider = new GoogleProvider(mockConfig)
        const bridge = provider.aiSdkBridge()
        const options = bridge.buildProviderOptions([], {})
        expect(options).toBeUndefined()
      })
    })
  })

  describe('isAvailable', () => {
    beforeEach(() => {
      global.fetch = vi.fn()
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('returns true on successful fetch to models endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch

      const provider = new GoogleProvider(mockConfig)
      const available = await provider.isAvailable()

      expect(available).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('models/gemini-2.5-pro'))
    })

    it('returns false on failed fetch (not ok)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false })
      global.fetch = mockFetch

      const provider = new GoogleProvider(mockConfig)
      const available = await provider.isAvailable()

      expect(available).toBe(false)
    })

    it('returns false on fetch exception', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
      global.fetch = mockFetch

      const provider = new GoogleProvider(mockConfig)
      const available = await provider.isAvailable()

      expect(available).toBe(false)
    })

    it('includes apiKey in query string', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch

      const provider = new GoogleProvider({
        ...mockConfig,
        apiKey: 'secret-key-xyz',
      })
      await provider.isAvailable()

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('key=secret-key-xyz'))
    })

    it('uses custom baseUrl if provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch

      const provider = new GoogleProvider({
        ...mockConfig,
        baseUrl: 'https://custom.example.com/v1beta',
      })
      await provider.isAvailable()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://custom.example.com/v1beta'),
      )
    })

    it('uses custom model in isAvailable check', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true })
      global.fetch = mockFetch

      const provider = new GoogleProvider({
        ...mockConfig,
        model: 'gemini-exp-05-11',
      })
      await provider.isAvailable()

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('models/gemini-exp-05-11'))
    })
  })

  describe('chatStream integration', () => {
    it('returns an async iterable', () => {
      const provider = new GoogleProvider(mockConfig)
      const stream = provider.chatStream([])
      expect(stream[Symbol.asyncIterator]).toBeDefined()
    })
  })
})
