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

interface OAIModel {
  id?: string
  /** vLLM reports the served context length here; used to auto-fill contextWindow. */
  max_model_len?: number
}

interface OAIModelsResponse {
  data?: OAIModel[]
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
  /** True when the caller pinned a real model id (not the 'default' placeholder). */
  private modelPinned: boolean
  /** True when the caller supplied a context window — suppresses auto-fill. */
  private contextPinned: boolean
  /** Discovery runs once; cached so repeated isAvailable() calls don't re-probe. */
  private discovered = false

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
    // 'default' is the placeholder we ship — treat it as "discover from server".
    this.modelPinned = !!config.model && config.model !== MODEL_DEFAULTS['openai-compat']
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
    this.contextPinned = (config.contextWindow ?? 0) > 0
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
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() })
    } catch (err: unknown) {
      // Connection-level failure — almost always "server not running" locally.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[${this.id}] cannot reach ${this.baseUrl}/v1/models (${msg}). ` +
          `Is the server running? For local vLLM: vllm serve <model> --port <port>.`,
      )
      return false
    }

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' — set api_key (vLLM: pass --api-key and match it here).'
          : ''
      console.warn(
        `[${this.id}] ${this.baseUrl}/v1/models returned HTTP ${String(res.status)}${hint}`,
      )
      return false
    }

    const body = (await res.json().catch(() => ({}))) as OAIModelsResponse
    const models = body.data ?? []
    this.applyDiscovery(models)

    // Only fail availability on a model mismatch when the caller pinned a model
    // AND asked us to verify it. Auto-discovered models are already valid.
    if (this.verifyModelOnInit && this.modelPinned) {
      const ids = models.map((m) => m.id).filter((id): id is string => !!id)
      if (!ids.includes(this.model)) {
        console.warn(
          `[${this.id}] configured model "${this.model}" not in /v1/models ` +
            `(served: ${ids.join(', ') || 'none'}).`,
        )
        return false
      }
    }
    return true
  }

  /**
   * Fill in model id and context window from the server's /v1/models listing
   * when the caller didn't pin them. Lets a local config that only knows the
   * base URL "just work": no need to hardcode the exact served model name, and
   * runtime budgeting gets a real context window instead of 0/unknown.
   *
   * Explicit config always wins; runs at most once.
   */
  private applyDiscovery(models: OAIModel[]): void {
    if (this.discovered || models.length === 0) return
    this.discovered = true

    // Pick the served model when the caller left it as the 'default' placeholder.
    if (!this.modelPinned) {
      const picked = models[0].id
      if (picked) {
        this.model = picked
        if (models.length > 1) {
          const others = models
            .slice(1)
            .map((m) => m.id)
            .filter(Boolean)
            .join(', ')
          console.warn(
            `[${this.id}] auto-selected model "${picked}" (also available: ${others}). ` +
              `Set "model" in config to choose another.`,
          )
        } else {
          console.warn(`[${this.id}] auto-selected served model "${picked}".`)
        }
      }
    }

    // Adopt the server's context length for the chosen model when unset.
    if (!this.contextPinned) {
      const chosen = models.find((m) => m.id === this.model) ?? models[0]
      if (chosen?.max_model_len && chosen.max_model_len > 0) {
        this.contextWindowSize = chosen.max_model_len
      }
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
