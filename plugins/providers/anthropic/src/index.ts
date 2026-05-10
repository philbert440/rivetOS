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
  ThinkingLevel,
} from '@rivetos/types'
import { ProviderError } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'

import { chatStreamAiSdk, type AnthropicAiSdkContext } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isClaude4Model(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-4(-\d+)?/i.test(model)
}

const CLAUDE3_BUDGET_TOKENS: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 2000,
  medium: 10000,
  high: 50000,
  xhigh: 50000,
}

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

  // -----------------------------------------------------------------------
  // aiSdkBridge — AI SDK loop adapter (consumed by step 8b's loop)
  // -----------------------------------------------------------------------

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride }): LanguageModel => {
        const provider = createAnthropic({
          apiKey: this.apiKey,
          baseURL: `${this.baseUrl}/v1`,
        })
        return provider(modelOverride ?? this.model)
      },

      buildProviderOptions: (_messages, options): JSONObject | undefined => {
        const model = options?.modelOverride ?? this.model
        const thinking = options?.thinking ?? 'off'
        const opts: JSONObject = {
          // Preserve ephemeral system-block caching for ~90% savings on hits.
          cacheControl: { type: 'ephemeral' },
          // Surface reasoning back to the application layer.
          sendReasoning: true,
        }

        if (thinking !== 'off') {
          if (isClaude4Model(model)) {
            opts.thinking = { type: 'adaptive' }
            opts.effort = thinking
          } else {
            const budget = CLAUDE3_BUDGET_TOKENS[thinking]
            if (budget !== null) {
              opts.thinking = { type: 'enabled', budgetTokens: budget }
            }
          }
        }

        return { anthropic: opts }
      },
    }
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
