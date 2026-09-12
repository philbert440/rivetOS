/**
 * Asserts `api_prefix` is threaded into the AI SDK `baseURL`
 * (`<baseURL>/chat/completions` is what the SDK hits).
 *
 * Isolated file so the `@ai-sdk/openai-compatible` mock does not
 * disturb the rest of the provider tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { VllmProvider } from './index.js'

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((opts: { baseURL: string }) => ({
    chatModel: () => ({}),
  })),
}))

describe('vllm AI SDK baseURL (api_prefix)', () => {
  beforeEach(() => {
    vi.mocked(createOpenAICompatible).mockClear()
  })

  it('default prefix passes <base>/v1 as baseURL (chat at <base>/v1/chat/completions)', () => {
    const provider = new VllmProvider({ baseUrl: 'http://localhost:8000' })
    provider.aiSdkBridge().getModel({})
    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:8000/v1' }),
    )
  })

  it("api_prefix: '' passes the bare base as baseURL (chat at <base>/chat/completions)", () => {
    const base = 'https://api.z.ai/api/coding/paas/v4'
    const provider = new VllmProvider({ baseUrl: base, apiPrefix: '' })
    provider.aiSdkBridge().getModel({})
    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: base }),
    )
  })

  it('strips a trailing /v1 from base_url then re-appends the default prefix', () => {
    const provider = new VllmProvider({ baseUrl: 'https://api.deepseek.com/v1' })
    provider.aiSdkBridge().getModel({})
    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.deepseek.com/v1' }),
    )
  })
})
