/**
 * @rivetos/provider-vllm
 *
 * Dedicated provider for vLLM's OpenAI-compatible server. Owns the full vLLM
 * surface: native sampling extensions (`top_k`, `min_p`, `repetition_penalty`,
 * `min_tokens`), `mm_processor_kwargs` / `chat_template_kwargs`, the `extra_body`
 * escape hatch, `video_url` content blocks, and `reasoning_content` parsing.
 *
 * Run a server with: `vllm serve <model> --port <port> [--reasoning-parser ...]
 * [--enable-auto-tool-choice]`. For a generic OpenAI-compatible endpoint that
 * is NOT vLLM (TGI, Groq, Together, LocalAI, …), there is no generic provider
 * anymore — point this provider at it if it speaks the vLLM dialect, or use
 * `llama-server` for llama.cpp.
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

import type {
  Provider,
  Message,
  ChatOptions,
  LLMChunk,
  PluginManifest,
  ContentPart,
} from '@rivetos/types'
import { MODEL_DEFAULTS } from '@rivetos/types'
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import {
  chatStreamAiSdk,
  splitAndFoldSystem,
  type VllmAiSdkContext,
  type ToolChoice,
} from './chat-stream-aisdk.js'

export type { ToolChoice } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VllmProviderConfig {
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
  /** Custom provider id. Default: 'vllm' */
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
  /** Repetition penalty (vLLM extension, ~1.0–1.3). Only sent when defined. */
  repetitionPenalty?: number
  /** Minimum tokens to generate before EOS is allowed (vLLM extension). */
  minTokens?: number
  /** Stop strings. Passed through as `stop`. */
  stop?: string[]
  /**
   * vLLM `mm_processor_kwargs` — multimodal processor controls (e.g. video
   * `fps`/`num_frames`, image `min_pixels`/`max_pixels`). Merged into the
   * request body. See the served model's processor for accepted keys.
   */
  mmProcessorKwargs?: Record<string, unknown>
  /**
   * vLLM `chat_template_kwargs` — extra args forwarded to the chat template
   * (e.g. `enable_thinking`). Merged with the per-turn thinking toggle.
   */
  chatTemplateKwargs?: Record<string, unknown>
  /**
   * Escape hatch: arbitrary top-level fields merged into every request body
   * (e.g. `guided_decoding_backend`, `repetition_penalty`, server-specific
   * knobs). Existing body fields are NOT overwritten.
   */
  extraBody?: Record<string, unknown>
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
// Video — vLLM accepts OpenAI `video_url` content blocks, but the AI SDK's
// openai-compatible serializer throws on non-image media types. So video is
// carried out of the AI SDK message path: prepareMessages() replaces each
// VideoPart with an inline text marker, and the request-body transform turns
// markers back into `video_url` blocks. Marker-based (stateless) so concurrent
// turns on a shared provider instance can't cross-contaminate.
// ---------------------------------------------------------------------------

const VIDEO_MARKER_RE = /RVT_VIDEO\[([A-Za-z0-9+/=]*)\]/g

interface OpenAIContentPart {
  type: string
  text?: string
  [k: string]: unknown
}

/** Replace VideoParts with inline text markers, stripping them from content. */
export function encodeVideoMarkers(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m
    const markers: string[] = []
    const kept: ContentPart[] = []
    for (const part of m.content) {
      if (part.type === 'video') {
        const url =
          part.url ?? (part.data ? `data:${part.mimeType ?? 'video/mp4'};base64,${part.data}` : '')
        if (url) markers.push(`RVT_VIDEO[${Buffer.from(url, 'utf8').toString('base64')}]`)
      } else {
        kept.push(part)
      }
    }
    if (markers.length === 0) return m
    kept.push({ type: 'text', text: markers.join('') })
    return { ...m, content: kept }
  })
}

/** Turn video markers in the serialized OpenAI body back into `video_url` blocks. */
export function spliceVideoUrls(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages
  if (!Array.isArray(messages)) return body

  const out = messages.map((msg: unknown) => {
    const m = msg as { role?: string; content?: unknown }
    const urls: string[] = []
    const strip = (text: string): string =>
      text.replace(VIDEO_MARKER_RE, (_full, u: string) => {
        urls.push(Buffer.from(u, 'base64').toString('utf8'))
        return ''
      })

    let content: unknown = m.content
    if (typeof content === 'string') {
      const stripped = strip(content)
      if (urls.length === 0) return msg
      const parts: OpenAIContentPart[] = []
      if (stripped.trim()) parts.push({ type: 'text', text: stripped })
      content = parts
    } else if (Array.isArray(content)) {
      const mapped = (content as OpenAIContentPart[]).map((p) =>
        p.type === 'text' && typeof p.text === 'string' ? { ...p, text: strip(p.text) } : p,
      )
      if (urls.length === 0) return msg
      content = mapped.filter((p) => !(p.type === 'text' && p.text === ''))
    } else {
      return msg
    }

    for (const u of urls) {
      ;(content as OpenAIContentPart[]).push({ type: 'video_url', video_url: { url: u } })
    }
    return { ...m, content }
  })

  // Each unchanged message maps to its original ref above, so when nothing had
  // a video marker we hand back the original body untouched.
  const unchanged = out.every((m, i) => m === messages[i])
  return unchanged ? body : { ...body, messages: out }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class VllmProvider implements Provider {
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
  private repetitionPenalty: number | undefined
  private minTokens: number | undefined
  private stop: string[] | undefined
  private mmProcessorKwargs: Record<string, unknown> | undefined
  private chatTemplateKwargs: Record<string, unknown> | undefined
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
  /**
   * Per-turn flag: when the loop's thinking level is 'off', send
   * `chat_template_kwargs.enable_thinking=false` so Qwen3/vLLM models skip
   * reasoning (otherwise their chat template reasons on every turn regardless).
   * Set in buildProviderOptions (has chatOptions), read in transformRequestBody
   * (runs at request time, after buildProviderOptions for the same turn).
   */
  private suppressThinking = false

  constructor(config: VllmProviderConfig) {
    this.id = config.id ?? 'vllm'
    this.name = config.name ?? 'vLLM'

    // Normalize baseUrl — accept either 'http://host:port' or
    // 'http://host:port/v1'. The chat stream re-appends '/v1'.
    let base = config.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/v1')) base = base.slice(0, -3)
    this.baseUrl = base

    this.apiKey = config.apiKey ?? ''
    this.model = config.model ?? MODEL_DEFAULTS['vllm']
    // 'default' is the placeholder we ship — treat it as "discover from server".
    this.modelPinned = !!config.model && config.model !== MODEL_DEFAULTS['vllm']
    this.maxTokens = config.maxTokens ?? 4096
    this.temperature = config.temperature ?? 0.7
    this.topP = config.topP ?? 0.95
    this.topK = config.topK
    this.minP = config.minP
    this.presencePenalty = config.presencePenalty
    this.frequencyPenalty = config.frequencyPenalty
    this.seed = config.seed
    this.defaultToolChoice = config.defaultToolChoice ?? 'auto'
    this.repetitionPenalty = config.repetitionPenalty
    this.minTokens = config.minTokens
    this.stop = config.stop
    this.mmProcessorKwargs = config.mmProcessorKwargs
    this.chatTemplateKwargs = config.chatTemplateKwargs
    this.extraBody = config.extraBody
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

  private buildAiSdkContext(): VllmAiSdkContext {
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

  /**
   * Apply every configured sampling param and vLLM extension to the outbound
   * request body. The AI SDK loop path sends only model/messages/tools, so
   * without this the server falls back to its own sampling defaults and all
   * configured knobs are silently ignored. Existing body fields are respected
   * (filled only when absent) so future loop-level overrides still win.
   */
  applyVllmRequestExtensions(body: Record<string, unknown>): Record<string, unknown> {
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

    // vLLM sampling extensions (not part of the OpenAI schema).
    if (this.topK !== undefined) out.top_k = this.topK
    if (this.minP !== undefined) out.min_p = this.minP
    if (this.repetitionPenalty !== undefined) out.repetition_penalty = this.repetitionPenalty
    if (this.minTokens !== undefined) out.min_tokens = this.minTokens

    // tool_choice — honor configured default when tools are present.
    if (
      Array.isArray(out.tools) &&
      out.tools.length > 0 &&
      this.defaultToolChoice !== 'auto' &&
      out.tool_choice === undefined
    ) {
      out.tool_choice = this.defaultToolChoice
    }

    // chat_template_kwargs — merge config + per-turn thinking suppression.
    const ctk: Record<string, unknown> = {
      ...this.chatTemplateKwargs,
      ...((out.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}),
    }
    if (this.suppressThinking) ctk.enable_thinking = false
    if (Object.keys(ctk).length > 0) out.chat_template_kwargs = ctk

    // mm_processor_kwargs — multimodal processor controls (image/video).
    if (this.mmProcessorKwargs) {
      out.mm_processor_kwargs = {
        ...this.mmProcessorKwargs,
        ...(out.mm_processor_kwargs ?? {}),
      }
    }

    // Arbitrary escape-hatch fields (filled only when absent).
    if (this.extraBody) {
      for (const [key, value] of Object.entries(this.extraBody)) fill(key, value)
    }

    // Reinstate any video markers as OpenAI `video_url` content blocks.
    return spliceVideoUrls(out)
  }

  // -----------------------------------------------------------------------
  // aiSdkBridge — AI SDK loop adapter (consumed by the AI SDK loop)
  // -----------------------------------------------------------------------

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride }): LanguageModel => {
        const provider = createOpenAICompatible({
          baseURL: `${this.baseUrl}/v1`,
          name: this.name,
          apiKey: this.apiKey || undefined,
          includeUsage: true,
          // Single live-path body hook: the AI SDK loop sends only model +
          // messages + tools, so every sampling/vLLM knob is applied here.
          transformRequestBody: (body) => this.applyVllmRequestExtensions(body),
        })
        return provider.chatModel(modelOverride ?? this.model)
      },

      buildProviderOptions: (_messages, chatOptions): JSONObject | undefined => {
        // Standard OpenAI knobs (temperature, topP, presencePenalty, etc.) are
        // owned by the loop via `streamText({ ... })`. vLLM extensions live in
        // `transformRequestBody` above. We do use the thinking level here:
        // 'off' => suppress the model's chat-template reasoning for this turn.
        this.suppressThinking = chatOptions?.thinking === 'off'
        return undefined
      },

      // vLLM + Qwen/Llama chat templates reject mid-conversation `system`
      // messages. Fold them into user `[SYSTEM NOTICE]` content and extract
      // any leading system run as a single string for `streamText({ system })`.
      prepareMessages: (messages: Message[]) => {
        const { system, rest } = splitAndFoldSystem(messages)
        // Pull VideoParts out of the AI SDK path (it can't serialize them) and
        // leave inline markers; spliceVideoUrls() reinstates them as video_url.
        const cleaned = encodeVideoMarkers(rest)
        return system ? { system, messages: cleaned } : { messages: cleaned }
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
  name: 'vllm',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new VllmProvider({
        baseUrl: cfg.base_url as string,
        apiKey: (cfg.api_key as string | undefined) ?? ctx.env.VLLM_API_KEY ?? '',
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
        repetitionPenalty: cfg.repetition_penalty as number | undefined,
        minTokens: cfg.min_tokens as number | undefined,
        stop: cfg.stop as string[] | undefined,
        mmProcessorKwargs: cfg.mm_processor_kwargs as Record<string, unknown> | undefined,
        chatTemplateKwargs: cfg.chat_template_kwargs as Record<string, unknown> | undefined,
        extraBody: cfg.extra_body as Record<string, unknown> | undefined,
        verifyModelOnInit: cfg.verify_model_on_init as boolean | undefined,
        id: 'vllm',
        name: (cfg.name as string | undefined) ?? 'vllm',
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
