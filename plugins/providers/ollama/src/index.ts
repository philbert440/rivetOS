/**
 * @rivetos/provider-ollama
 *
 * Ollama provider — uses the AI SDK (`ollama-ai-provider-v2`) under the hood
 * for the streaming `/api/chat` path with native reasoning + tool calls + vision.
 * The class itself owns config and exposes the standard Provider surface plus
 * Ollama-specific model-management helpers (list/show/pull/unload).
 *
 * For GERTY: can also point at llama-server via the OpenAI-compat provider.
 * This plugin is specifically for Ollama instances.
 */

import type {
  Provider,
  Message,
  ChatOptions,
  LLMChunk,
  PluginManifest,
} from '@rivetos/types'
import { MODEL_DEFAULTS } from '@rivetos/types'

import { chatStreamAiSdk, type OllamaAiSdkContext } from './chat-stream-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OllamaProviderConfig {
  baseUrl?: string // Default: 'http://localhost:11434'
  model?: string // Default: 'llama3.1'
  numCtx?: number // Context window size (0 = model default)
  temperature?: number // Default: 0.7
  topP?: number // Default: 0.9
  /** Context window size in tokens (0 = unknown) */
  contextWindow?: number
  /** Max output tokens (0 = unknown) */
  maxOutputTokens?: number
}

// ---------------------------------------------------------------------------
// Ollama-specific model-management types
// ---------------------------------------------------------------------------

interface OllamaModelInfo {
  name: string
  size: number
  modified_at: string
}

interface OllamaModelListResponse {
  models?: OllamaModelInfo[]
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OllamaProvider implements Provider {
  id = 'ollama'
  name = 'Ollama'
  private baseUrl: string
  private model: string
  private numCtx: number
  private temperature: number
  private topP: number
  private contextWindowSize: number
  private outputTokenLimit: number

  constructor(config: OllamaProviderConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434'
    this.model = config.model ?? MODEL_DEFAULTS.ollama
    this.numCtx = config.numCtx ?? 0
    this.temperature = config.temperature ?? 0.7
    this.topP = config.topP ?? 0.9
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

  private buildAiSdkContext(): OllamaAiSdkContext {
    return {
      baseUrl: this.baseUrl,
      defaultModel: this.model,
      numCtx: this.numCtx,
      temperature: this.temperature,
      topP: this.topP,
    }
  }

  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    return chatStreamAiSdk(this.buildAiSdkContext(), messages, options)
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      return res.ok
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Ollama-specific: model management
  // -----------------------------------------------------------------------

  async listModels(): Promise<OllamaModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`)
    if (!res.ok) throw new Error(`Failed to list models: ${String(res.status)}`)
    const data = (await res.json()) as OllamaModelListResponse
    return data.models ?? []
  }

  async showModel(model?: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model ?? this.model }),
    })
    if (!res.ok) throw new Error(`Failed to show model: ${String(res.status)}`)
    return res.json()
  }

  async pullModel(model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
    })
    if (!res.ok) throw new Error(`Failed to pull: ${String(res.status)}`)
  }

  async unloadModel(model?: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model ?? this.model, messages: [], keep_alive: '0' }),
    })
  }

  switchModel(model: string): void {
    this.model = model
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export const manifest: PluginManifest = {
  type: 'provider',
  name: 'ollama',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new OllamaProvider({
        baseUrl: cfg.base_url as string | undefined,
        model: cfg.model as string | undefined,
        numCtx: cfg.num_ctx as number | undefined,
        temperature: cfg.temperature as number | undefined,
        topP: cfg.top_p as number | undefined,
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
