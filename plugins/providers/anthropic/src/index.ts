/**
 * @rivetos/provider-anthropic
 *
 * Anthropic Claude provider — uses the AI SDK (`@ai-sdk/anthropic`) under the
 * hood for the Messages API streaming path. The class itself owns config and
 * exposes the standard Provider surface; AI SDK handles SSE parsing, tool-call
 * lifecycle, and content-block translation.
 */

import type { Provider, PluginManifest, ThinkingLevel } from '@rivetos/types'
import { ProviderError } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  createAuthorizedFetch,
  createTokenSource,
  parseTokenCommandArgv,
  type TokenSource,
} from '@rivetos/token-command'

import type { AnthropicAiSdkContext } from './chat-stream-aisdk.js'

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
  /** Optional TTL-cached token mint; preferred over static apiKey when set. */
  tokenSource?: TokenSource
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
  private tokenSource: TokenSource | undefined

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
    this.tokenSource = config.tokenSource
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
      apiKey: this.tokenSource?.getCachedToken() ?? this.apiKey,
      baseUrl: this.baseUrl,
      defaultModel: this.model,
      maxTokens: this.maxTokens,
    }
  }

  private resolveApiKey(): string {
    return this.tokenSource?.getCachedToken() ?? this.apiKey
  }

  // -----------------------------------------------------------------------
  // aiSdkBridge — AI SDK loop adapter (consumed by the AI SDK loop)
  // -----------------------------------------------------------------------

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride }): LanguageModel => {
        const provider = createAnthropic({
          apiKey: this.resolveApiKey(),
          baseURL: `${this.baseUrl}/v1`,
          ...(this.tokenSource
            ? {
                fetch: createAuthorizedFetch({
                  tokenSource: this.tokenSource,
                  headerName: 'x-api-key',
                }),
              }
            : {}),
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

  private async authHeaders(token?: string): Promise<Record<string, string>> {
    if (this.tokenSource) {
      const resolved = token ?? (await this.tokenSource.getToken())
      return {
        'Content-Type': 'application/json',
        'x-api-key': resolved,
        'anthropic-version': '2023-06-01',
      }
    }
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const body = JSON.stringify({
        model: this.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      })
      // Capture the token actually sent so a staggered 401 cannot wipe a newer mint.
      const sentToken = this.tokenSource ? await this.tokenSource.getToken() : undefined
      let res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: await this.authHeaders(sentToken),
        body,
      })
      if (res.status === 401 && this.tokenSource && sentToken !== undefined) {
        this.tokenSource.invalidate(sentToken)
        res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: await this.authHeaders(),
          body,
        })
      }
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

    let tokenSource: TokenSource | undefined
    const parsed = parseTokenCommandArgv(cfg.token_command)
    if (typeof parsed === 'string') {
      ctx.logger.warn(parsed)
    } else if (parsed) {
      tokenSource = createTokenSource({
        argv: parsed,
        ttlMs: cfg.token_ttl_ms as number | undefined,
        timeoutMs: cfg.token_command_timeout_ms as number | undefined,
      })
      void tokenSource.getToken().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        ctx.logger.warn(`token_command warm failed: ${msg}`)
      })
    }

    if (!apiKey && !tokenSource) {
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
        tokenSource,
      }),
    )
  },
}
