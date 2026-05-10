/**
 * @rivetos/provider-openai-compat
 *
 * OpenAI-compatible chat-completions provider tuned for strict servers.
 *
 * Target servers:
 *   - vLLM (`--enable-auto-tool-choice`, `--reasoning-parser`)
 *   - Text Generation Inference (TGI)
 *   - LocalAI, Together, Fireworks, Groq, or any other OpenAI-compatible API
 *
 * Uses `@ai-sdk/openai-compatible` for the streaming path; this file owns
 * config, the `Provider` surface, and the `/v1/models` availability probe.
 *
 * Behavioral notes (see `chat-stream-aisdk.ts` header):
 *   - Mid-conversation `system` messages are folded into `user [SYSTEM NOTICE]`
 *     to satisfy strict chat templates (vLLM + Qwen/Llama).
 *   - `top_k` / `min_p` (vLLM extensions) are sent via `transformRequestBody`
 *     when set; standard OpenAI knobs flow through `streamText`.
 *   - Reasoning relies on AI SDK's first-class reasoning surface, which maps
 *     from vLLM's `reasoning_content` field when `--reasoning-parser` is
 *     configured. The legacy inline `<think>` content fallback was dropped.
 *   - Per-chunk stall timeouts were dropped — the loop-level `abortSignal`
 *     handles cancellation.
 */

import type { Provider, Message, ChatOptions, LLMChunk, PluginManifest } from '@rivetos/types'
import { MODEL_DEFAULTS } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import {
  chatStreamAiSdk,
  splitAndFoldSystem,
  type OpenAICompatAiSdkContext,
  type ToolChoice,
} from './chat-stream-aisdk.js'

export type { ToolChoice } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAICompatProviderConfig {
  /** Base URL of the OpenAI-compatible server, e.g. 'http://localhost:8000'.
   *  The trailing '/v1' is optional — it is normalized away and re-appended. */
  baseUrl: string
  /** Bearer token. Send a placeholder like 'sk-no-key-required' for servers
   *  that do not enforce auth. If unset, no Authorization header is sent. */
  apiKey?: string
  /** Model id as exposed by `/v1/models`. Default: 'default'. */
  model?: string
  /** Max tokens to generate. Default: 4096 */
  maxTokens?: number
  /** Temperature (0.0–2.0). Default: 0.7 */
  temperature?: number
  /** top-p nucleus sampling. Default: 0.95 */
  topP?: number
  /** top-k sampling. vLLM extension — only sent when defined.
   *  Default: undefined (server default). */
  topK?: number
  /** min-p sampling. vLLM extension — only sent when defined.
   *  Default: undefined (server default). */
  minP?: number
  /** Presence penalty (-2.0–2.0). Default: undefined */
  presencePenalty?: number
  /** Frequency penalty (-2.0–2.0). Default: undefined */
  frequencyPenalty?: number
  /** RNG seed. Default: undefined (random) */
  seed?: number
  /** Default tool_choice when tools are provided. Default: 'auto' */
  defaultToolChoice?: ToolChoice
  /** Custom provider id. Default: 'openai-compat' */
  id?: string
  /** Custom display name. Default: 'OpenAI-compatible server' */
  name?: string
  /** Context window size (informational, used for runtime budgeting). */
  contextWindow?: number
  /** Max output tokens (informational). */
  maxOutputTokens?: number
  /** If true, probe /v1/models in isAvailable() and reject when the
   *  configured model id is not listed. Default: false — strict servers
   *  sometimes do not list all aliases. */
  verifyModelOnInit?: boolean
}

interface OAIModelsResponse {
  data?: Array<{ id?: string }>
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAICompatProvider implements Provider {
  id: string
  name: string
  private baseUrl: string
  private apiKey: string
  private model: string
  private maxTokens: number
  private temperature: number
  private topP: number
  private topK: number | undefined
  private minP: number | undefined
  private presencePenalty: number | undefined
  private frequencyPenalty: number | undefined
  private seed: number | undefined
  private defaultToolChoice: ToolChoice
  private contextWindowSize: number
  private outputTokenLimit: number
  private verifyModelOnInit: boolean

  constructor(config: OpenAICompatProviderConfig) {
    this.id = config.id ?? 'openai-compat'
    this.name = config.name ?? 'OpenAI-compatible server'

    // Normalize baseUrl — accept either 'http://host:port' or
    // 'http://host:port/v1'. The chat stream re-appends '/v1'.
    let base = config.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/v1')) base = base.slice(0, -3)
    this.baseUrl = base

    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? MODEL_DEFAULTS['openai-compat']
    this.maxTokens = config.maxTokens ?? 4096
    this.temperature = config.temperature ?? 0.7
    this.topP = config.topP ?? 0.95
    this.topK = config.topK
    this.minP = config.minP
    this.presencePenalty = config.presencePenalty
    this.frequencyPenalty = config.frequencyPenalty
    this.seed = config.seed
    this.defaultToolChoice = config.defaultToolChoice ?? 'auto'
    this.contextWindowSize = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
    this.verifyModelOnInit = config.verifyModelOnInit ?? false
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

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  private buildAiSdkContext(): OpenAICompatAiSdkContext {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      defaultModel: this.model,
      providerName: this.name,
      providerId: this.id,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      topP: this.topP,
      topK: this.topK,
      minP: this.minP,
      presencePenalty: this.presencePenalty,
      frequencyPenalty: this.frequencyPenalty,
      seed: this.seed,
      defaultToolChoice: this.defaultToolChoice,
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
        const provider = createOpenAICompatible({
          baseURL: `${this.baseUrl}/v1`,
          name: this.name,
          apiKey: this.apiKey || undefined,
          includeUsage: true,
          // vLLM extensions — top_k / min_p flow via the request-body transform.
          // tool_choice is owned by the loop (passed via streamText options).
          transformRequestBody: (body) => {
            const out = { ...body } as Record<string, unknown>
            if (this.topK !== undefined) out.top_k = this.topK
            if (this.minP !== undefined) out.min_p = this.minP
            return out
          },
        })
        return provider.chatModel(modelOverride ?? this.model)
      },

      buildProviderOptions: (): JSONObject | undefined => {
        // Standard OpenAI knobs (temperature, topP, presencePenalty, etc.) are
        // owned by the loop via `streamText({ ... })`. vLLM extensions live in
        // `transformRequestBody` above. No provider-keyed options for this one.
        return undefined
      },

      // vLLM + Qwen/Llama chat templates reject mid-conversation `system`
      // messages. Fold them into user `[SYSTEM NOTICE]` content and extract
      // any leading system run as a single string for `streamText({ system })`.
      prepareMessages: (messages: Message[]) => {
        const { system, rest } = splitAndFoldSystem(messages)
        return system ? { system, messages: rest } : { messages: rest }
      },
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() })
      if (!res.ok) return false

      if (!this.verifyModelOnInit) return true

      const body = (await res.json()) as OAIModelsResponse
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
      return ids.includes(this.model)
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
  name: 'openai-compat',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new OpenAICompatProvider({
        baseUrl: cfg.base_url as string,
        apiKey: (cfg.api_key as string | undefined) ?? ctx.env.OPENAI_COMPAT_API_KEY ?? '',
        model: cfg.model as string | undefined,
        maxTokens: cfg.max_tokens as number | undefined,
        temperature: cfg.temperature as number | undefined,
        topP: cfg.top_p as number | undefined,
        topK: cfg.top_k as number | undefined,
        minP: cfg.min_p as number | undefined,
        presencePenalty: cfg.presence_penalty as number | undefined,
        frequencyPenalty: cfg.frequency_penalty as number | undefined,
        seed: cfg.seed as number | undefined,
        defaultToolChoice: cfg.default_tool_choice as ToolChoice | undefined,
        verifyModelOnInit: cfg.verify_model_on_init as boolean | undefined,
        id: 'openai-compat',
        name: (cfg.name as string | undefined) ?? 'openai-compat',
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
