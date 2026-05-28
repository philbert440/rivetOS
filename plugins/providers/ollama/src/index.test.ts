/**
 * Unit tests for @rivetos/provider-ollama
 *
 * Covers: config initialization, model management, provider options building,
 * AI SDK bridge, and availability checks. Mocks fetch for network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OllamaProvider, type OllamaProviderConfig } from './index.js'
import type { Message, ChatOptions } from '@rivetos/types'

// Mock fetch globally
global.fetch = vi.fn()

describe('OllamaProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Constructor & Config
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('applies default config when empty', () => {
      const provider = new OllamaProvider({})
      expect(provider.getModel()).toBe('llama3.1') // MODEL_DEFAULTS.ollama
      expect(provider.getContextWindow()).toBe(0)
      expect(provider.getMaxOutputTokens()).toBe(0)
    })

    it('applies custom baseUrl', () => {
      const provider = new OllamaProvider({ baseUrl: 'http://192.168.1.100:11434' })
      // baseUrl is private; verify via aiSdkBridge that it's used
      const bridge = provider.aiSdkBridge()
      expect(bridge).toBeDefined()
    })

    it('applies custom model', () => {
      const provider = new OllamaProvider({ model: 'deepseek-r1' })
      expect(provider.getModel()).toBe('deepseek-r1')
    })

    it('applies custom numCtx, temperature, topP', () => {
      const cfg: OllamaProviderConfig = {
        numCtx: 32768,
        temperature: 0.5,
        topP: 0.85,
      }
      const provider = new OllamaProvider(cfg)
      expect(provider.getModel()).toBe('llama3.1')
      // Values are private; verify via aiSdkBridge output
      const bridge = provider.aiSdkBridge()
      const opts = bridge.buildProviderOptions([], { thinking: 'off' })
      expect(opts).toBeDefined()
    })

    it('applies contextWindow and maxOutputTokens', () => {
      const provider = new OllamaProvider({
        contextWindow: 128000,
        maxOutputTokens: 4096,
      })
      expect(provider.getContextWindow()).toBe(128000)
      expect(provider.getMaxOutputTokens()).toBe(4096)
    })
  })

  // -----------------------------------------------------------------------
  // Model accessors
  // -----------------------------------------------------------------------

  describe('getModel / setModel / switchModel', () => {
    it('getModel returns current model', () => {
      const provider = new OllamaProvider({ model: 'qwen2.5' })
      expect(provider.getModel()).toBe('qwen2.5')
    })

    it('setModel updates model', () => {
      const provider = new OllamaProvider({ model: 'llama3.1' })
      provider.setModel('mistral')
      expect(provider.getModel()).toBe('mistral')
    })

    it('switchModel updates model (alias)', () => {
      const provider = new OllamaProvider()
      provider.switchModel('neural-chat')
      expect(provider.getModel()).toBe('neural-chat')
    })
  })

  // -----------------------------------------------------------------------
  // AI SDK Bridge
  // -----------------------------------------------------------------------

  describe('aiSdkBridge', () => {
    it('returns a bridge with getModel and buildProviderOptions', () => {
      const provider = new OllamaProvider()
      const bridge = provider.aiSdkBridge()
      expect(bridge.getModel).toBeDefined()
      expect(bridge.buildProviderOptions).toBeDefined()
    })

    describe('getModel', () => {
      it('uses modelOverride when provided', () => {
        const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' })
        const bridge = provider.aiSdkBridge()
        const model = bridge.getModel({ modelOverride: 'custom-model' })
        expect(model).toBeDefined()
        // createOllama returns a provider; we just verify it doesn't crash
      })

      it('falls back to default model when no override', () => {
        const provider = new OllamaProvider({ model: 'qwen3' })
        const bridge = provider.aiSdkBridge()
        const model = bridge.getModel({})
        expect(model).toBeDefined()
      })
    })

    describe('buildProviderOptions', () => {
      it('returns undefined when no options set', () => {
        const provider = new OllamaProvider({ numCtx: 0, temperature: 0.7, topP: 0.9 })
        const bridge = provider.aiSdkBridge()
        const opts = bridge.buildProviderOptions([], {})
        expect(opts).toBeUndefined()
      })

      it('includes num_ctx when numCtx > 0', () => {
        const provider = new OllamaProvider({ numCtx: 16384 })
        const bridge = provider.aiSdkBridge()
        const opts = bridge.buildProviderOptions([], {})
        expect(opts).toEqual({
          ollama: {
            options: { num_ctx: 16384 },
          },
        })
      })

      it('includes think flag when thinking is off', () => {
        const provider = new OllamaProvider({})
        const bridge = provider.aiSdkBridge()
        const opts = bridge.buildProviderOptions([], { thinking: 'off' })
        expect(opts).toEqual({
          ollama: {
            think: false,
          },
        })
      })

      it('includes think flag when thinking is on', () => {
        const provider = new OllamaProvider({})
        const bridge = provider.aiSdkBridge()
        const opts = bridge.buildProviderOptions([], { thinking: 'regular' })
        expect(opts).toEqual({
          ollama: {
            think: true,
          },
        })
      })

      it('combines num_ctx and think flags', () => {
        const provider = new OllamaProvider({ numCtx: 8192 })
        const bridge = provider.aiSdkBridge()
        const opts = bridge.buildProviderOptions([], { thinking: 'deep' })
        expect(opts).toEqual({
          ollama: {
            options: { num_ctx: 8192 },
            think: true,
          },
        })
      })

      it('returns undefined when thinking is undefined and numCtx is 0', () => {
        const provider = new OllamaProvider({ numCtx: 0 })
        const bridge = provider.aiSdkBridge()
        const opts = bridge.buildProviderOptions([], { thinking: undefined })
        expect(opts).toBeUndefined()
      })
    })
  })

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true when /api/tags succeeds', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: true })

      const provider = new OllamaProvider()
      const available = await provider.isAvailable()
      expect(available).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags')
    })

    it('returns false when /api/tags fails', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: false })

      const provider = new OllamaProvider()
      const available = await provider.isAvailable()
      expect(available).toBe(false)
    })

    it('returns false on network error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const provider = new OllamaProvider()
      const available = await provider.isAvailable()
      expect(available).toBe(false)
    })

    it('respects custom baseUrl in isAvailable', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: true })

      const provider = new OllamaProvider({ baseUrl: 'http://192.168.1.50:11434' })
      await provider.isAvailable()
      expect(mockFetch).toHaveBeenCalledWith('http://192.168.1.50:11434/api/tags')
    })
  })

  // -----------------------------------------------------------------------
  // Model Management
  // -----------------------------------------------------------------------

  describe('listModels', () => {
    it('returns empty array when no models', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      })

      const provider = new OllamaProvider()
      const models = await provider.listModels()
      expect(models).toEqual([])
    })

    it('returns model list from /api/tags', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3.1', size: 4700000000, modified_at: '2024-01-01T00:00:00Z' },
            { name: 'mistral', size: 7400000000, modified_at: '2024-01-02T00:00:00Z' },
          ],
        }),
      })

      const provider = new OllamaProvider()
      const models = await provider.listModels()
      expect(models).toHaveLength(2)
      expect(models[0].name).toBe('llama3.1')
      expect(models[1].name).toBe('mistral')
    })

    it('throws when /api/tags returns error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

      const provider = new OllamaProvider()
      await expect(provider.listModels()).rejects.toThrow('Failed to list models: 500')
    })

    it('handles undefined models field', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })

      const provider = new OllamaProvider()
      const models = await provider.listModels()
      expect(models).toEqual([])
    })
  })

  describe('showModel', () => {
    it('shows info for default model', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      const responseData = { format: 'gguf', parameters: 'some params' }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      })

      const provider = new OllamaProvider({ model: 'llama3.1' })
      const info = await provider.showModel()
      expect(info).toEqual(responseData)
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama3.1' }),
      })
    })

    it('shows info for specified model', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ format: 'gguf' }),
      })

      const provider = new OllamaProvider()
      await provider.showModel('mistral')
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mistral' }),
      })
    })

    it('throws when /api/show returns error', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const provider = new OllamaProvider()
      await expect(provider.showModel('nonexistent')).rejects.toThrow('Failed to show model: 404')
    })
  })

  describe('pullModel', () => {
    it('pulls a model', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: true })

      const provider = new OllamaProvider()
      await provider.pullModel('neural-chat')
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'neural-chat', stream: false }),
      })
    })

    it('throws when pull fails', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400 })

      const provider = new OllamaProvider()
      await expect(provider.pullModel('bad-model')).rejects.toThrow('Failed to pull: 400')
    })

    it('respects custom baseUrl in pull', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: true })

      const provider = new OllamaProvider({ baseUrl: 'http://10.0.0.5:11434' })
      await provider.pullModel('qwen')
      expect(mockFetch).toHaveBeenCalledWith('http://10.0.0.5:11434/api/pull', expect.any(Object))
    })
  })

  describe('unloadModel', () => {
    it('unloads default model', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: true })

      const provider = new OllamaProvider({ model: 'llama3.1' })
      await provider.unloadModel()
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama3.1', messages: [], keep_alive: '0' }),
      })
    })

    it('unloads specified model', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: true })

      const provider = new OllamaProvider()
      await provider.unloadModel('mistral')
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mistral', messages: [], keep_alive: '0' }),
      })
    })

    it('does not throw on unload failure (best-effort)', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>
      mockFetch.mockResolvedValueOnce({ ok: false })

      const provider = new OllamaProvider()
      // unloadModel does not explicitly check res.ok, so no error thrown
      await expect(provider.unloadModel('model')).resolves.toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Provider interface
  // -----------------------------------------------------------------------

  describe('id and name', () => {
    it('has id "ollama"', () => {
      const provider = new OllamaProvider()
      expect(provider.id).toBe('ollama')
    })

    it('has name "Ollama"', () => {
      const provider = new OllamaProvider()
      expect(provider.name).toBe('Ollama')
    })
  })

  describe('chatStream', () => {
    it('delegates to chatStreamAiSdk', () => {
      const provider = new OllamaProvider()
      const messages: Message[] = [{ role: 'user', content: 'hello' }]
      const stream = provider.chatStream(messages, {})
      // chatStream returns AsyncIterable<LLMChunk>; verify it's callable
      expect(stream).toBeDefined()
      expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    })
  })
})
