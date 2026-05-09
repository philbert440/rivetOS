/**
 * @rivetos/provider-anthropic
 *
 * Anthropic Claude provider — uses the AI SDK (`@ai-sdk/anthropic`) under the
 * hood for the Messages API streaming path. The class itself owns config and
 * exposes the standard Provider surface; AI SDK handles SSE parsing, tool-call
 * lifecycle, and content-block translation.
 */

import type {
  Provider,
  Message,
  ChatOptions,
  LLMChunk,
  PluginManifest,
} from '@rivetos/types'
import { ProviderError } from '@rivetos/types'

import { chatStreamAiSdk, type AnthropicAiSdkContext } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string
  model: string
  maxTokens?: number
  baseUrl?: string
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  id = 'anthropic'
  name = 'Anthropic Claude'
  private apiKey: string
  private model: string
  private maxTokens: number
  private baseUrl: string
  private contextWindow: number
  private outputTokenLimit: number

  constructor(config: AnthropicProviderConfig) {
    if (!config.model) {
      throw new ProviderError(
        'Model is required. Set config.model to a Claude model name (e.g. "claude-opus-4-7")',
        400,
        'anthropic',
        false,
      )
    }

    this.apiKey = config.apiKey
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com'
    this.contextWindow = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
  }

  getContextWindow(): number {
    return this.contextWindow
  }

  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  private buildAiSdkContext(): AnthropicAiSdkContext {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      defaultModel: this.model,
      maxTokens: this.maxTokens,
    }
  }

  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    return chatStreamAiSdk(this.buildAiSdkContext(), messages, options)
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
      })
      return res.ok || res.status === 429
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export const manifest: PluginManifest = {
  type: 'provider',
  name: 'anthropic',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const apiKey = (cfg.api_key as string | undefined) ?? ctx.env.ANTHROPIC_API_KEY ?? ''
    if (!apiKey) {
      ctx.logger.warn(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY or providers.anthropic.api_key',
      )
    }
    ctx.registerProvider(
      new AnthropicProvider({
        apiKey,
        model: cfg.model as string,
        maxTokens: cfg.max_tokens as number | undefined,
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
