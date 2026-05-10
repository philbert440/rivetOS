/**
 * @rivetos/provider-google
 *
 * Google Gemini provider — uses the AI SDK (`@ai-sdk/google`) under the hood
 * for the Generative Language API streaming path. Owns config and the standard
 * Provider surface; AI SDK handles SSE parsing, tool-call lifecycle, and
 * content-part translation.
 */

import type {
  Provider,
  Message,
  ChatOptions,
  LLMChunk,
  PluginManifest,
  ThinkingLevel,
} from '@rivetos/types'
import { MODEL_DEFAULTS } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/core'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

import { chatStreamAiSdk, type GoogleAiSdkContext } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOOGLE_THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: 0,
  low: 1024,
  medium: 8192,
  high: 32768,
  xhigh: 32768,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GoogleProviderConfig {
  apiKey: string
  model?: string // Default: 'gemini-2.5-pro'
  maxTokens?: number // Default: 8192
  baseUrl?: string // Default: 'https://generativelanguage.googleapis.com/v1beta'
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GoogleProvider implements Provider {
  id = 'google'
  name = 'Google Gemini'
  private apiKey: string
  private model: string
  private maxTokens: number
  private baseUrl: string
  private contextWindowSize: number
  private outputTokenLimit: number

  constructor(config: GoogleProviderConfig) {
    this.apiKey = config.apiKey
    this.model = config.model ?? MODEL_DEFAULTS.google
    this.maxTokens = config.maxTokens ?? 8192
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    this.contextWindowSize = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
  }

  getContextWindow(): number {
    return this.contextWindowSize
  }

  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  private buildAiSdkContext(): GoogleAiSdkContext {
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
        const provider = createGoogleGenerativeAI({
          apiKey: this.apiKey,
          baseURL: this.baseUrl,
        })
        return provider(modelOverride ?? this.model)
      },

      buildProviderOptions: (_messages, options): JSONObject | undefined => {
        const thinking = options?.thinking ?? 'off'
        const budget = GOOGLE_THINKING_BUDGETS[thinking]
        if (budget === null || budget === 0) return undefined
        return {
          google: {
            thinkingConfig: {
              thinkingBudget: budget,
              includeThoughts: true,
            },
          },
        }
      },
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models/${this.model}?key=${this.apiKey}`)
      return res.ok
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
  name: 'google',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new GoogleProvider({
        apiKey: (cfg.api_key as string | undefined) ?? ctx.env.GOOGLE_API_KEY ?? '',
        model: cfg.model as string | undefined,
        maxTokens: cfg.max_tokens as number | undefined,
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
