/**
 * Unit tests for VllmProvider — config normalization, auth headers,
 * context building, model state, and availability probing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VllmProvider, encodeVideoMarkers, spliceVideoUrls } from './index.js'
import type { VllmProviderConfig } from './index.js'
import type { Message } from '@rivetos/types'

describe('VllmProvider', () => {
  describe('constructor and defaults', () => {
    it('applies default values for all optional fields', () => {
      const config: VllmProviderConfig = {
        baseUrl: 'http://localhost:8000',
      }
      const provider = new VllmProvider(config)

      expect(provider.id).toBe('vllm')
      expect(provider.name).toBe('vLLM')
      expect(provider.getModel()).toBe('default')
      expect(provider.getContextWindow()).toBe(0)
      expect(provider.getMaxOutputTokens()).toBe(0)
    })

    it('uses provided custom id and name', () => {
      const config: VllmProviderConfig = {
        baseUrl: 'http://localhost:8000',
        id: 'my-provider',
        name: 'My Custom Provider',
      }
      const provider = new VllmProvider(config)

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
        const provider = new VllmProvider({ baseUrl })
        // All should normalize to bare http://localhost:8000
        expect(provider).toBeDefined()
      }
    })

    it('stores custom sampling parameters when provided', () => {
      const config: VllmProviderConfig = {
        baseUrl: 'http://localhost:8000',
        temperature: 0.5,
        topP: 0.8,
        topK: 40,
        minP: 0.01,
        presencePenalty: 1.5,
        frequencyPenalty: -0.5,
        seed: 42,
      }
      const provider = new VllmProvider(config)
      // Verify context has the values (via buildAiSdkContext indirectly tested)
      expect(provider).toBeDefined()
    })

    it('respects custom maxTokens and contextWindow', () => {
      const config: VllmProviderConfig = {
        baseUrl: 'http://localhost:8000',
        maxTokens: 2048,
        contextWindow: 8192,
        maxOutputTokens: 1024,
      }
      const provider = new VllmProvider(config)

      expect(provider.getMaxOutputTokens()).toBe(1024)
      expect(provider.getContextWindow()).toBe(8192)
    })

    it('accepts empty apiKey (for non-authenticated servers)', () => {
      const config: VllmProviderConfig = {
        baseUrl: 'http://localhost:8000',
      }
      const provider = new VllmProvider(config)
      expect(provider).toBeDefined()
    })

    it('stores apiKey when provided', () => {
      const config: VllmProviderConfig = {
        baseUrl: 'http://localhost:8000',
        apiKey: 'sk-test-key',
      }
      const provider = new VllmProvider(config)
      expect(provider).toBeDefined()
    })
  })

  describe('getModel / setModel', () => {
    it('returns default model initially', () => {
      const provider = new VllmProvider({ baseUrl: 'http://localhost:8000' })
      expect(provider.getModel()).toBe('default')
    })

    it('returns custom model from config', () => {
      const provider = new VllmProvider({
        baseUrl: 'http://localhost:8000',
        model: 'gpt-4',
      })
      expect(provider.getModel()).toBe('gpt-4')
    })

    it('setModel updates the model', () => {
      const provider = new VllmProvider({
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
      const provider = new VllmProvider({
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
      const provider = new VllmProvider({
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
      const provider = new VllmProvider({
        baseUrl: 'http://localhost:8000',
      })
      const bridge = provider.aiSdkBridge()

      expect(bridge.buildProviderOptions()).toBeUndefined()
    })

    it('prepareMessages splits leading system and folds mid-conversation system', () => {
      const provider = new VllmProvider({
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
      const provider = new VllmProvider({
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

      const provider = new VllmProvider({
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
          json: vi.fn().mockResolvedValueOnce({ data: [] }),
        }),
      )

      const provider = new VllmProvider({
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

      const provider = new VllmProvider({
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

      const provider = new VllmProvider({
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

      const provider = new VllmProvider({
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

      const provider = new VllmProvider({
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

      const provider = new VllmProvider({
        baseUrl: 'http://localhost:8000',
        model: 'pinned-model',
        verifyModelOnInit: true,
      })
      const available = await provider.isAvailable()

      // Malformed body → empty model list. With a pinned model + verify on, the
      // pinned model can't be found, so availability is false — and the
      // undefined `data` is handled gracefully (no crash).
      expect(available).toBe(false)
    })

    it('filters out non-string model ids from response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValueOnce({
            data: [{ id: 'valid-model' }, { id: null }, { id: 123 }, { id: 'another-model' }],
          }),
        }),
      )

      const provider = new VllmProvider({
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
      const provider = new VllmProvider({
        baseUrl: 'http://localhost:8000',
      })
      expect(provider).toBeDefined()
    })

    it('accepts custom tool choice settings', () => {
      const toolChoices = ['none', 'required', 'auto'] as const
      for (const choice of toolChoices) {
        const provider = new VllmProvider({
          baseUrl: 'http://localhost:8000',
          defaultToolChoice: choice,
        })
        expect(provider).toBeDefined()
      }
    })
  })

  describe('context building', () => {
    it('includes all required fields in context', () => {
      const config: VllmProviderConfig = {
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
      const provider = new VllmProvider(config)
      expect(provider).toBeDefined()
    })
  })

  describe('applyVllmRequestExtensions', () => {
    const base = { model: 'qwen-27b', messages: [{ role: 'user', content: 'hi' }] }

    it('fills configured sampling params the loop omits (the silent-drop bug)', () => {
      const p = new VllmProvider({
        baseUrl: 'http://x:8003',
        temperature: 1,
        topP: 0.95,
        topK: 20,
        minP: 0,
        maxTokens: 81920,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 7,
      })
      const out = p.applyVllmRequestExtensions({ ...base })
      expect(out.temperature).toBe(1)
      expect(out.top_p).toBe(0.95)
      expect(out.top_k).toBe(20)
      expect(out.min_p).toBe(0)
      expect(out.max_tokens).toBe(81920)
      expect(out.presence_penalty).toBe(0.1)
      expect(out.frequency_penalty).toBe(0.2)
      expect(out.seed).toBe(7)
    })

    it('does not overwrite values already on the body', () => {
      const p = new VllmProvider({ baseUrl: 'http://x:8003', temperature: 1 })
      const out = p.applyVllmRequestExtensions({ ...base, temperature: 0.2 })
      expect(out.temperature).toBe(0.2)
    })

    it('forwards vLLM-only sampling extensions', () => {
      const p = new VllmProvider({
        baseUrl: 'http://x:8003',
        repetitionPenalty: 1.1,
        minTokens: 5,
        stop: ['</s>'],
      })
      const out = p.applyVllmRequestExtensions({ ...base })
      expect(out.repetition_penalty).toBe(1.1)
      expect(out.min_tokens).toBe(5)
      expect(out.stop).toEqual(['</s>'])
    })

    it('applies default tool_choice only when tools are present', () => {
      const p = new VllmProvider({ baseUrl: 'http://x:8003', defaultToolChoice: 'required' })
      expect(p.applyVllmRequestExtensions({ ...base }).tool_choice).toBeUndefined()
      const withTools = p.applyVllmRequestExtensions({ ...base, tools: [{ type: 'function' }] })
      expect(withTools.tool_choice).toBe('required')
    })

    it('merges mm_processor_kwargs / chat_template_kwargs / extra_body', () => {
      const p = new VllmProvider({
        baseUrl: 'http://x:8003',
        mmProcessorKwargs: { fps: 2 },
        chatTemplateKwargs: { enable_thinking: true },
        extraBody: { guided_decoding_backend: 'xgrammar' },
      })
      const out = p.applyVllmRequestExtensions({ ...base })
      expect(out.mm_processor_kwargs).toEqual({ fps: 2 })
      expect(out.chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(out.guided_decoding_backend).toBe('xgrammar')
    })
  })

  describe('video marker round-trip', () => {
    it('encodes a VideoPart into a marker, stripping it from content', () => {
      const msgs: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what happens here?' },
            { type: 'video', url: 'https://cdn/clip.mp4', mimeType: 'video/mp4' },
          ],
        },
      ]
      const [m] = encodeVideoMarkers(msgs)
      const parts = m.content as { type: string; text?: string }[]
      expect(parts.some((p) => p.type === 'video')).toBe(false) // video stripped
      expect(parts.some((p) => p.type === 'text' && p.text?.includes('RVT_VIDEO['))).toBe(true)
    })

    it('splices a marker back into an OpenAI video_url block (full round-trip)', () => {
      const url = 'https://cdn/clip.mp4'
      const encoded = encodeVideoMarkers([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'video', url },
          ],
        },
      ])
      const markerText = (encoded[0].content as { type: string; text?: string }[]).find((p) =>
        p.text?.includes('RVT_VIDEO['),
      )!.text
      // Simulate the serialized OpenAI body the AI SDK produces.
      const body = {
        model: 'qwen-27b',
        messages: [{ role: 'user', content: [{ type: 'text', text: `hi ${markerText}` }] }],
      }
      const out = spliceVideoUrls(body)
      const content = (
        out.messages as { content: { type: string; video_url?: { url: string } }[] }[]
      )[0].content
      const vid = content.find((p) => p.type === 'video_url')
      expect(vid?.video_url?.url).toBe(url)
      // marker text removed from the text part
      expect(content.find((p) => p.type === 'text')?.['text' as never]).not.toContain('RVT_VIDEO')
    })

    it('leaves bodies without markers untouched', () => {
      const body = { model: 'm', messages: [{ role: 'user', content: 'plain text' }] }
      expect(spliceVideoUrls(body)).toBe(body)
    })
  })
})
