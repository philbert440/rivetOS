/**
 * @rivetos/provider-llama-server
 *
 * Dedicated provider for llama.cpp's `llama-server` OpenAI-compatible endpoint.
 *
 * Deliberately lean: the standard OpenAI sampling knobs plus llama.cpp's
 * `top_k` / `min_p` extensions and a generic `extra_body` escape hatch (for
 * grammar, `n_probs`, and other llama.cpp server fields). It does NOT carry
 * vLLM-only machinery (`mm_processor_kwargs`, `chat_template_kwargs`, video,
 * `min_tokens`, `repetition_penalty`) — use `@rivetos/provider-vllm` for those.
 *
 * Run a server with: `llama-server -m <model.gguf> --port 8080`. For native
 * `<think>` reasoning, start it with `--reasoning-format deepseek` so the
 * server emits `reasoning_content` (consumed via the AI SDK reasoning surface).
 *
 * Uses `@ai-sdk/openai-compatible` for the streaming path; this file owns
 * config, the `Provider` surface, and the `/v1/models` availability probe.
 */

import type { Provider, Message, PluginManifest } from '@rivetos/types'
import { MODEL_DEFAULTS } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  createAuthorizedFetch,
  createModelCatalog,
  createTokenSource,
  parseTokenCommandArgv,
  type ModelCatalog,
  type TokenSource,
} from '@rivetos/token-command'

import {
  splitAndFoldSystem,
  type LlamaServerAiSdkContext,
  type ToolChoice,
} from './chat-stream-aisdk.js'

export type { ToolChoice } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LlamaServerProviderConfig {
  /** Base URL of the llama-server, e.g. 'http://localhost:8080'.
   *  The trailing '/v1' is optional — it is normalized away and re-appended. */
  baseUrl: string
  /** Bearer token. llama-server runs without auth by default — leave unset, or
   *  set it to match `--api-key` if you started the server with one. */
  apiKey?: string
  /** Model id as exposed by `/v1/models`. Default: 'default' (auto-discovered). */
  model?: string
  /** Max tokens to generate. Default: 4096 */
  maxTokens?: number
  /** Temperature (0.0–2.0). Default: 0.7 */
  temperature?: number
  /** top-p nucleus sampling. Default: 0.95 */
  topP?: number
  /** top-k sampling. llama.cpp extension — only sent when defined. */
  topK?: number
  /** min-p sampling. llama.cpp extension — only sent when defined. */
  minP?: number
  /** Presence penalty (-2.0–2.0). Default: undefined */
  presencePenalty?: number
  /** Frequency penalty (-2.0–2.0). Default: undefined */
  frequencyPenalty?: number
  /** RNG seed. Default: undefined (random) */
  seed?: number
  /** Stop strings. Passed through as `stop`. */
  stop?: string[]
  /** Default tool_choice when tools are provided. Default: 'auto' */
  defaultToolChoice?: ToolChoice
  /** Custom provider id. Default: 'llama-server' */
  id?: string
  /** Custom display name. Default: 'llama.cpp server' */
  name?: string
  /** Context window size (informational, used for runtime budgeting). */
  contextWindow?: number
  /** Max output tokens (informational). */
  maxOutputTokens?: number
  /** If true, probe /v1/models in isAvailable() and reject when the configured
   *  model id is not listed. Default: false. */
  verifyModelOnInit?: boolean
  /**
   * Escape hatch: arbitrary top-level fields merged into every request body
   * (e.g. `grammar`, `n_probs`, server-specific knobs). Existing body fields
   * are NOT overwritten.
   */
  extraBody?: Record<string, unknown>
  /** Optional TTL-cached token mint; preferred over static apiKey when set. */
  tokenSource?: TokenSource
  /** Static model catalog floor (always present in listModels). */
  models?: string[]
  /** Background refresh interval for endpoint model catalog. */
  modelsTtlMs?: number
}

interface OAIModel {
  id?: string
  /** Some servers report the loaded context length here; used to auto-fill contextWindow. */
  max_model_len?: number
}

interface OAIModelsResponse {
  data?: OAIModel[]
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class LlamaServerProvider implements Provider {
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
  private stop: string[] | undefined
  private defaultToolChoice: ToolChoice
  private extraBody: Record<string, unknown> | undefined
  private contextWindowSize: number
  private outputTokenLimit: number
  private verifyModelOnInit: boolean
  /** True when the caller pinned a real model id (not the 'default' placeholder). */
  private modelPinned: boolean
  /** True when the caller supplied a context window — suppresses auto-fill. */
  private contextPinned: boolean
  /** Discovery runs once; cached so repeated isAvailable() calls don't re-probe. */
  private discovered = false
  private tokenSource: TokenSource | undefined
  private catalog: ModelCatalog
  /** Ids just observed by isAvailable — consumed once by catalog.fetchIds. */
  private pendingCatalogIds: string[] | undefined

  constructor(config: LlamaServerProviderConfig) {
    this.id = config.id ?? 'llama-server'
    this.name = config.name ?? 'llama.cpp server'

    // Normalize baseUrl — accept either 'http://host:port' or
    // 'http://host:port/v1'. The chat stream re-appends '/v1'.
    let base = config.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/v1')) base = base.slice(0, -3)
    this.baseUrl = base

    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? MODEL_DEFAULTS['llama-server']
    // 'default' is the placeholder we ship — treat it as "discover from server".
    this.modelPinned = !!config.model && config.model !== MODEL_DEFAULTS['llama-server']
    this.maxTokens = config.maxTokens ?? 4096
    this.temperature = config.temperature ?? 0.7
    this.topP = config.topP ?? 0.95
    this.topK = config.topK
    this.minP = config.minP
    this.presencePenalty = config.presencePenalty
    this.frequencyPenalty = config.frequencyPenalty
    this.seed = config.seed
    this.stop = config.stop
    this.defaultToolChoice = config.defaultToolChoice ?? 'auto'
    this.extraBody = config.extraBody
    this.contextWindowSize = config.contextWindow ?? 0
    this.contextPinned = (config.contextWindow ?? 0) > 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
    this.verifyModelOnInit = config.verifyModelOnInit ?? false
    this.tokenSource = config.tokenSource

    const floor = config.models ?? (this.modelPinned ? [this.model] : [])
    this.catalog = createModelCatalog({
      floor,
      ttlMs: config.modelsTtlMs,
      label: this.id,
      fetchIds: () => this.fetchCatalogIds(),
      log: (msg) => console.warn(msg),
    })
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

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.tokenSource) return this.tokenSource.authHeaders()
    const headers: Record<string, string> = {}
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  private resolveApiKey(): string {
    return this.tokenSource?.getCachedToken() ?? this.apiKey
  }

  /**
   * Floor + discovered model ids (kicks a background refresh when TTL expired).
   * Building block: no runtime UI/harness consumer reads this yet — den-server
   * model-sheets still use their own discovery. Callers that want the merge
   * must invoke this (or `createModelCatalog`) explicitly.
   */
  listModels(): string[] {
    return this.catalog.refresh()
  }

  private async fetchCatalogIds(): Promise<string[]> {
    if (this.pendingCatalogIds) {
      const ids = this.pendingCatalogIds
      this.pendingCatalogIds = undefined
      return ids
    }
    const url = `${this.baseUrl}/v1/models`
    let res = await fetch(url, { headers: await this.authHeaders() })
    if (res.status === 401 && this.tokenSource) {
      this.tokenSource.invalidate(this.tokenSource.getCachedToken())
      res = await fetch(url, { headers: await this.authHeaders() })
    }
    if (!res.ok) {
      throw new Error(`HTTP ${String(res.status)}`)
    }
    const body = (await res.json().catch(() => ({}))) as OAIModelsResponse
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
  }

  private buildAiSdkContext(): LlamaServerAiSdkContext {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.resolveApiKey(),
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

  /**
   * Apply every configured sampling param and llama.cpp extension to the
   * outbound request body. The AI SDK loop path sends only model/messages/tools,
   * so without this the server falls back to its own sampling defaults and all
   * configured knobs are silently ignored. Existing body fields are respected
   * (filled only when absent) so future loop-level overrides still win.
   */
  applyRequestExtensions(body: Record<string, unknown>): Record<string, unknown> {
    const out = { ...body }
    const fill = (key: string, value: unknown): void => {
      if (value !== undefined && out[key] === undefined) out[key] = value
    }

    // Standard OpenAI sampling — config-driven, filled when the loop didn't set them.
    fill('temperature', this.temperature)
    fill('top_p', this.topP)
    if (this.maxTokens > 0) fill('max_tokens', this.maxTokens)
    fill('presence_penalty', this.presencePenalty)
    fill('frequency_penalty', this.frequencyPenalty)
    fill('seed', this.seed)
    fill('stop', this.stop)

    // llama.cpp sampling extensions (not part of the OpenAI schema).
    if (this.topK !== undefined) out.top_k = this.topK
    if (this.minP !== undefined) out.min_p = this.minP

    // tool_choice — honor configured default when tools are present.
    if (
      Array.isArray(out.tools) &&
      out.tools.length > 0 &&
      this.defaultToolChoice !== 'auto' &&
      out.tool_choice === undefined
    ) {
      out.tool_choice = this.defaultToolChoice
    }

    // Arbitrary escape-hatch fields (filled only when absent).
    if (this.extraBody) {
      for (const [key, value] of Object.entries(this.extraBody)) fill(key, value)
    }

    return out
  }

  // -----------------------------------------------------------------------
  // aiSdkBridge — AI SDK loop adapter (consumed by the AI SDK loop)
  // -----------------------------------------------------------------------

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride }): LanguageModel => {
        const apiKey = this.resolveApiKey()
        const provider = createOpenAICompatible({
          baseURL: `${this.baseUrl}/v1`,
          name: this.name,
          apiKey: apiKey || undefined,
          includeUsage: true,
          // Single live-path body hook: the AI SDK loop sends only model +
          // messages + tools, so every sampling/llama.cpp knob is applied here.
          transformRequestBody: (body) => this.applyRequestExtensions(body),
          ...(this.tokenSource
            ? { fetch: createAuthorizedFetch({ tokenSource: this.tokenSource }) }
            : {}),
        })
        return provider.chatModel(modelOverride ?? this.model)
      },

      buildProviderOptions: (): JSONObject | undefined => {
        // Standard OpenAI knobs are owned by the loop via `streamText({ ... })`;
        // llama.cpp extensions live in `transformRequestBody` above. Reasoning is
        // a server-side concern (`--reasoning-format deepseek`), so there is no
        // per-turn thinking toggle to apply here.
        return undefined
      },

      // llama.cpp + Qwen/Llama chat templates reject mid-conversation `system`
      // messages. Fold them into user `[SYSTEM NOTICE]` content and extract any
      // leading system run as a single string for `streamText({ system })`.
      prepareMessages: (messages: Message[]) => {
        const { system, rest } = splitAndFoldSystem(messages)
        return system ? { system, messages: rest } : { messages: rest }
      },
    }
  }

  async isAvailable(): Promise<boolean> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/models`, { headers: await this.authHeaders() })
      if (res.status === 401 && this.tokenSource) {
        this.tokenSource.invalidate(this.tokenSource.getCachedToken())
        res = await fetch(`${this.baseUrl}/v1/models`, { headers: await this.authHeaders() })
      }
    } catch (err: unknown) {
      // Connection-level failure — almost always "server not running" locally.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[${this.id}] cannot reach ${this.baseUrl}/v1/models (${msg}). ` +
          `Is the server running? For llama.cpp: llama-server -m <model.gguf> --port <port>.`,
      )
      return false
    }

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' — set api_key (llama-server: pass --api-key and match it here).'
          : ''
      console.warn(
        `[${this.id}] ${this.baseUrl}/v1/models returned HTTP ${String(res.status)}${hint}`,
      )
      return false
    }

    const body = (await res.json().catch(() => ({}))) as OAIModelsResponse
    const models = body.data ?? []
    this.applyDiscovery(models)

    const ids = models.map((m) => m.id).filter((id): id is string => !!id)
    this.pendingCatalogIds = ids
    this.catalog.refresh()

    // Only fail availability on a model mismatch when the caller pinned a model
    // AND asked us to verify it. Auto-discovered models are already valid.
    if (this.verifyModelOnInit && this.modelPinned) {
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
   * base URL "just work". Explicit config always wins; runs at most once.
   */
  private applyDiscovery(models: OAIModel[]): void {
    if (this.discovered || models.length === 0) return
    this.discovered = true

    // Pick the served model when the caller left it as the 'default' placeholder.
    if (!this.modelPinned) {
      const picked = models[0].id
      if (picked) {
        this.model = picked
        console.warn(`[${this.id}] auto-selected served model "${picked}".`)
      }
    }

    // Adopt the server's context length for the chosen model when unset.
    if (!this.contextPinned) {
      const chosen = models.find((m) => m.id === this.model) ?? models[0]
      if (chosen.max_model_len && chosen.max_model_len > 0) {
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
  name: 'llama-server',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const apiKey = (cfg.api_key as string | undefined) ?? ctx.env.LLAMA_SERVER_API_KEY ?? ''

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

    ctx.registerProvider(
      new LlamaServerProvider({
        baseUrl: cfg.base_url as string,
        apiKey,
        model: cfg.model as string | undefined,
        maxTokens: cfg.max_tokens as number | undefined,
        temperature: cfg.temperature as number | undefined,
        topP: cfg.top_p as number | undefined,
        topK: cfg.top_k as number | undefined,
        minP: cfg.min_p as number | undefined,
        presencePenalty: cfg.presence_penalty as number | undefined,
        frequencyPenalty: cfg.frequency_penalty as number | undefined,
        seed: cfg.seed as number | undefined,
        stop: cfg.stop as string[] | undefined,
        defaultToolChoice: cfg.default_tool_choice as ToolChoice | undefined,
        extraBody: cfg.extra_body as Record<string, unknown> | undefined,
        verifyModelOnInit: cfg.verify_model_on_init as boolean | undefined,
        id: 'llama-server',
        name: (cfg.name as string | undefined) ?? 'llama-server',
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
        tokenSource,
        models: cfg.models as string[] | undefined,
        modelsTtlMs: cfg.models_ttl_ms as number | undefined,
      }),
    )
  },
}
