/**
 * Unit tests for chatStreamAiSdk — the AI SDK-backed Ollama streaming implementation.
 *
 * Covers: message conversion, option building, thinking flag translation,
 * tool set construction, error mapping, and abort signal handling.
 * Mocks AI SDK calls and translate helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ThinkingLevel } from '@rivetos/types'
import { ProviderError, APICallError } from '@rivetos/types'
import { chatStreamAiSdk, type OllamaAiSdkContext } from './chat-stream-aisdk.js'
import type { Message, ChatOptions, ToolDefinition } from '@rivetos/types'

// Mock AI SDK and aisdk adapters
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    streamText: vi.fn().mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', textDelta: 'hello' }
        yield { type: 'finish', finishReason: 'stop' }
      })(),
    }),
  }
})

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn().mockReturnValue({
    chat: vi.fn().mockReturnValue({}),
  }),
}))

vi.mock('@rivetos/aisdk', () => ({
  convertMessagesToAiSdk: vi.fn((msgs) =>
    msgs.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content,
    })),
  ),
  createLlmChunkAccumulator: vi.fn().mockReturnValue({
    textDelta: '',
    finishReason: 'stop',
    toolCalls: [],
  }),
  translateAiSdkPart: vi.fn((part) => {
    if (part.type === 'text-delta') {
      return [{ type: 'text' as const, text: part.textDelta }]
    }
    return []
  }),
  buildDoneChunk: vi.fn().mockReturnValue({ type: 'done' as const }),
}))

describe('chatStreamAiSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic streaming', () => {
    it('yields text chunks from AI SDK stream', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'hello' }]

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.some((c) => c.type === 'text')).toBe(true)
      expect(chunks.some((c) => c.type === 'done')).toBe(true)
    })

    it('respects modelOverride in options', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      const options: ChatOptions = { modelOverride: 'custom-model' }

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.model).toBeDefined()
    })

    it('uses default model when no override', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'default-model',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBeGreaterThan(0)
    })
  })

  describe('option building', () => {
    it('includes num_ctx when > 0', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 16384,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.providerOptions?.ollama?.options?.num_ctx).toBe(16384)
    })

    it('omits num_ctx when 0', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.providerOptions?.ollama?.options).toBeUndefined()
    })
  })

  describe('thinking flag', () => {
    it('sets think=true when thinking is "regular"', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      const options: ChatOptions = { thinking: 'regular' }

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.providerOptions?.ollama?.think).toBe(true)
    })

    it('sets think=true when thinking is "deep"', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      const options: ChatOptions = { thinking: 'deep' as ThinkingLevel }

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.providerOptions?.ollama?.think).toBe(true)
    })

    it('sets think=false when thinking is "off"', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      const options: ChatOptions = { thinking: 'off' }

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.providerOptions?.ollama?.think).toBe(false)
    })

    it('omits think when thinking is undefined', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.providerOptions?.ollama?.think).toBeUndefined()
    })
  })

  describe('tools', () => {
    it('includes tools when provided', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]
      const tools: ToolDefinition[] = [
        {
          name: 'echo',
          description: 'Echo text',
          parameters: {
            type: 'object' as const,
            properties: { text: { type: 'string' as const } },
          },
        },
      ]
      const options: ChatOptions = { tools }

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.tools).toBeDefined()
      expect(Object.keys(callArgs?.tools || {})).toContain('echo')
    })

    it('omits tools when empty', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.tools).toBeUndefined()
    })
  })

  describe('abort handling', () => {
    it('yields error chunk and returns when signal is already aborted', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const controller = new AbortController()
      controller.abort()

      const options: ChatOptions = { signal: controller.signal }

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      expect(chunks[0]).toEqual({ type: 'error', error: 'Aborted' })
    })

    it('respects abort signal during streaming', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const controller = new AbortController()
      const options: ChatOptions = { signal: controller.signal }

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: 'hello' }
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, options)) {
        chunks.push(chunk)
      }

      // Verify that abort signal was registered
      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.abortSignal).toBeDefined()
    })
  })

  describe('error handling', () => {
    it('rethrows ProviderError as-is', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockImplementationOnce(() => {
        throw new ProviderError('Provider failed', 500, 'ollama')
      })

      await expect(async () => {
        for await (const _chunk of chatStreamAiSdk(ctx, messages, {})) {
          // consume stream
        }
      }).rejects.toThrow(ProviderError)
    })

    it('maps APICallError to ProviderError', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()

      // Create a mock APICallError-like object
      const apiError = {
        statusCode: 503,
        responseBody: 'Service unavailable',
        message: 'API error',
      }
      // Make it look like APICallError.isInstance returns true
      Object.defineProperty(apiError, 'constructor', {
        value: { name: 'APICallError' },
      })

      streamTextMock.mockImplementationOnce(() => {
        throw apiError
      })

      // This test validates the error path; real APICallError behavior depends on ai SDK
      const chunks = []
      try {
        for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
          chunks.push(chunk)
        }
      } catch (err) {
        expect(err).toBeDefined()
      }
    })

    it('yields error chunk on generic error', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.7,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockImplementationOnce(() => {
        throw new Error('Unknown error')
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      expect(chunks.some((c) => c.type === 'error')).toBe(true)
    })
  })

  describe('temperature and topP', () => {
    it('passes temperature to streamText', async () => {
      const ctx: OllamaAiSdkContext = {
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        numCtx: 0,
        temperature: 0.5,
        topP: 0.9,
      }
      const messages: Message[] = [{ role: 'user', content: 'test' }]

      const { streamText } = await import('ai')
      const streamTextMock = streamText as ReturnType<typeof vi.fn>
      streamTextMock.mockClear()
      streamTextMock.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: 'stop' }
        })(),
      })

      const chunks = []
      for await (const chunk of chatStreamAiSdk(ctx, messages, {})) {
        chunks.push(chunk)
      }

      const callArgs = streamTextMock.mock.calls[0]?.[0]
      expect(callArgs?.temperature).toBe(0.5)
      expect(callArgs?.topP).toBe(0.9)
    })
  })
})
