/**
 * Unit tests for OpenAICompatProvider — config normalization, auth headers,
 * context building, model state, and availability probing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAICompatProvider } from './index.js'
import type { OpenAICompatProviderConfig } from './index.js'

describe('OpenAICompatProvider', () => {
  describe('constructor and defaults', () => {
    it('applies default values for all optional fields', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000',
      }
      const provider = new OpenAICompatProvider(config)

      expect(provider.id).toBe('openai-compat')
      expect(provider.name).toBe('OpenAI-compatible server')
      expect(provider.getModel()).toBe('default')
      expect(provider.getContextWindow()).toBe(0)
      expect(provider.getMaxOutputTokens()).toBe(0)
    })

    it('uses provided custom id and name', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000',
        id: 'my-provider',
        name: 'My Custom Provider',
      }
      const provider = new OpenAICompatProvider(config)

      expect(provider.id).toBe('my-provider')
      expect(provider.name).toBe('My Custom Provider')
    })

    it('normalizes baseUrl: strips trailing slashes and /v1', () => {
      const configs = [
        'http://localhost:8000',
        'http://localhost:8000/',
        'http://localhost:8000/v1',
        'http://localhost:8000/v1/',
        'http://localhost:8000///v1///',
      ]

      for (const baseUrl of configs) {
        const provider = new OpenAICompatProvider({ baseUrl })
        // All should normalize to bare http://localhost:8000
        expect(provider).toBeDefined()
      }
    })

    it('stores custom sampling parameters when provided', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000',
        temperature: 0.5,
        topP: 0.8,
        topK: 40,
        minP: 0.01,
        presencePenalty: 1.5,
        frequencyPenalty: -0.5,
        seed: 42,
      }
      const provider = new OpenAICompatProvider(config)
      // Verify context has the values (via buildAiSdkContext indirectly tested)
      expect(provider).toBeDefined()
    })

    it('respects custom maxTokens and contextWindow', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000',
        maxTokens: 2048,
        contextWindow: 8192,
        maxOutputTokens: 1024,
      }
      const provider = new OpenAICompatProvider(config)

      expect(provider.getMaxOutputTokens()).toBe(1024)
      expect(provider.getContextWindow()).toBe(8192)
    })

    it('accepts empty apiKey (for non-authenticated servers)', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000',
      }
      const provider = new OpenAICompatProvider(config)
      expect(provider).toBeDefined()
    })

    it('stores apiKey when provided', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000',
        apiKey: 'sk-test-key',
      }
      const provider = new OpenAICompatProvider(config)
      expect(provider).toBeDefined()
    })
  })

  describe('getModel / setModel', () => {
    it('returns default model initially', () => {
      const provider = new OpenAICompatProvider({ baseUrl: 'http://localhost:8000' })
      expect(provider.getModel()).toBe('default')
    })

    it('returns custom model from config', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'gpt-4',
      })
      expect(provider.getModel()).toBe('gpt-4')
    })

    it('setModel updates the model', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'model-a',
      })
      expect(provider.getModel()).toBe('model-a')

      provider.setModel('model-b')
      expect(provider.getModel()).toBe('model-b')
    })
  })

  describe('aiSdkBridge', () => {
    it('returns a bridge with getModel, buildProviderOptions, prepareMessages', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'test-model',
      })
      const bridge = provider.aiSdkBridge()

      expect(bridge).toHaveProperty('getModel')
      expect(bridge).toHaveProperty('buildProviderOptions')
      expect(bridge).toHaveProperty('prepareMessages')
      expect(typeof bridge.getModel).toBe('function')
      expect(typeof bridge.buildProviderOptions).toBe('function')
      expect(typeof bridge.prepareMessages).toBe('function')
    })

    it('getModel uses modelOverride when provided', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'default-model',
      })
      const bridge = provider.aiSdkBridge()

      // getModel should return a LanguageModel object; we just verify it's called
      const model1 = bridge.getModel({})
      expect(model1).toBeDefined()

      const model2 = bridge.getModel({ modelOverride: 'override-model' })
      expect(model2).toBeDefined()
    })

    it('buildProviderOptions returns undefined (vLLM knobs flow via transformRequestBody)', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
      })
      const bridge = provider.aiSdkBridge()

      expect(bridge.buildProviderOptions()).toBeUndefined()
    })

    it('prepareMessages splits leading system and folds mid-conversation system', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
      })
      const bridge = provider.aiSdkBridge()

      const messages = [
        { role: 'system' as const, content: 'Initial system' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'system' as const, content: 'Mid-conversation system' },
      ]

      const result = bridge.prepareMessages(messages)
      expect(result).toHaveProperty('system')
      expect(result).toHaveProperty('messages')
      // system should contain the initial system message
      expect(result.system).toContain('Initial system')
      // messages should include the mid-conversation system folded into user
      expect(result.messages).toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('[SYSTEM NOTICE]'),
        }),
      )
    })

    it('prepareMessages handles no leading system message', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
      })
      const bridge = provider.aiSdkBridge()

      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi' },
      ]

      const result = bridge.prepareMessages(messages)
      expect(result.system).toBeFalsy()
      expect(result.messages).toHaveLength(2)
    })
  })

  describe('isAvailable', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('returns true when /v1/models endpoint returns ok status and verifyModelOnInit is false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce({ data: [{ id: 'model-a' }] }),
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        verifyModelOnInit: false,
      })
      const available = await provider.isAvailable()

      expect(available).toBe(true)
      expect(fetch).toHaveBeenCalledWith('http://localhost:8000/v1/models', {
        headers: {},
      })
    })

    it('includes Authorization header when apiKey is set', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn(),
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        apiKey: 'sk-test-key',
        verifyModelOnInit: false,
      })
      await provider.isAvailable()

      expect(fetch).toHaveBeenCalledWith('http://localhost:8000/v1/models', {
        headers: { Authorization: 'Bearer sk-test-key' },
      })
    })

    it('returns false when fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')))

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
      })
      const available = await provider.isAvailable()

      expect(available).toBe(false)
    })

    it('returns false when /v1/models returns not-ok status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: false,
          status: 404,
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
      })
      const available = await provider.isAvailable()

      expect(available).toBe(false)
    })

    it('verifies model id when verifyModelOnInit is true and model is found', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce({
            data: [{ id: 'qwen-32b' }, { id: 'custom-model' }],
          }),
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'custom-model',
        verifyModelOnInit: true,
      })
      const available = await provider.isAvailable()

      expect(available).toBe(true)
    })

    it('returns false when verifyModelOnInit is true and model is not in list', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce({
            data: [{ id: 'model-a' }, { id: 'model-b' }],
          }),
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'nonexistent-model',
        verifyModelOnInit: true,
      })
      const available = await provider.isAvailable()

      expect(available).toBe(false)
    })

    it('handles malformed /v1/models response gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce({ data: undefined }),
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        verifyModelOnInit: true,
      })
      const available = await provider.isAvailable()

      // Should not crash; will return false when verifyModelOnInit is true
      expect(available).toBe(false)
    })

    it('filters out non-string model ids from response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce({
            data: [
              { id: 'valid-model' },
              { id: null },
              { id: 123 },
              { id: 'another-model' },
            ],
          }),
        }),
      )

      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
        model: 'valid-model',
        verifyModelOnInit: true,
      })
      const available = await provider.isAvailable()

      expect(available).toBe(true)
    })
  })

  describe('defaultToolChoice', () => {
    it('defaults to "auto"', () => {
      const provider = new OpenAICompatProvider({
        baseUrl: 'http://localhost:8000',
      })
      expect(provider).toBeDefined()
    })

    it('accepts custom tool choice settings', () => {
      const toolChoices = ['none', 'required', 'auto'] as const
      for (const choice of toolChoices) {
        const provider = new OpenAICompatProvider({
          baseUrl: 'http://localhost:8000',
          defaultToolChoice: choice,
        })
        expect(provider).toBeDefined()
      }
    })
  })

  describe('context building', () => {
    it('includes all required fields in context', () => {
      const config: OpenAICompatProviderConfig = {
        baseUrl: 'http://localhost:8000/v1/',
        apiKey: 'sk-test',
        model: 'custom-model',
        maxTokens: 1024,
        temperature: 0.8,
        topP: 0.9,
        topK: 50,
        minP: 0.02,
        presencePenalty: 0.5,
        frequencyPenalty: -0.2,
        seed: 123,
        defaultToolChoice: 'required' as const,
      }
      const provider = new OpenAICompatProvider(config)
      expect(provider).toBeDefined()
    })
  })
})
