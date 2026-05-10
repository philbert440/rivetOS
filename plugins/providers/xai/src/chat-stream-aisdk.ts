/**
 * AI SDK-backed implementation of xAI `chatStream`.
 *
 * Delegates to shared adapters in `@rivetos/aisdk` for message conversion and
 * fullStream-part → LLMChunk translation. This file owns only the xAI-specific
 * pieces: provider construction (with `x-grok-conv-id` header), prepareTurn
 * integration, server-side tool wiring (web_search / x_search / code_execution),
 * reasoning effort mapping, and response-id persistence semantics.
 *
 * Known gaps vs. the legacy path (deliberately not wired):
 * - `xhigh` reasoning effort: `@ai-sdk/xai` schema only accepts low/medium/high.
 *   Multi-agent xhigh requests degrade to `high` with a warning.
 * - `prompt_cache_key` body field: not exposed; the `x-grok-conv-id` header
 *   still carries the cache key, which is sufficient for cache hits.
 * - `max_turns`, `tool_choice`, `parallel_tool_calls`, `truncation`,
 *   `instructions`: not configurable through the typed providerOptions schema.
 *   Wire via custom `fetch` in a later commit if needed.
 * - `include: ['reasoning.encrypted_content']`: not exposed; affects stateless
 *   continuity edge cases. `previousResponseId` itself still flows through.
 */

import { createXai, xaiTools } from '@ai-sdk/xai'
import {
  buildDoneChunk,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
} from '@rivetos/aisdk'
import { streamText, stepCountIs, jsonSchema, APICallError, type ToolSet } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import type { ChatOptions, LLMChunk, Message, ThinkingLevel, ToolDefinition } from '@rivetos/types'
import { hasImages, ProviderError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Server-side tool config types — duplicated from index.ts so this file stays
// independent and can move into its own package later.
// ---------------------------------------------------------------------------

export interface WebSearchAiSdkConfig {
  allowedDomains?: string[]
  excludedDomains?: string[]
  enableImageUnderstanding?: boolean
}

export interface XSearchAiSdkConfig {
  allowedXHandles?: string[]
  excludedXHandles?: string[]
  fromDate?: string
  toDate?: string
  enableImageUnderstanding?: boolean
  enableVideoUnderstanding?: boolean
}

// ---------------------------------------------------------------------------
// Context bridge — what the provider class hands to this implementation.
// Keeps the impl decoupled from XAIProvider's private fields.
// ---------------------------------------------------------------------------

export interface XAIAiSdkContext {
  apiKey: string
  baseUrl: string
  defaultModel: string
  store: boolean
  timeoutMs: number
  outputTokenLimit: number

  // Server-side tools
  webSearch: boolean | WebSearchAiSdkConfig
  xSearch: boolean | XSearchAiSdkConfig
  codeExecution: boolean

  // Reasoning
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined

  // Stateful session bridge — read/write from XAIProvider's private fields
  getLastResponseId: () => string | null
  getLastResponseModel: () => string | null
  setLastResponseId: (id: string | null) => void
  setLastResponseModel: (model: string | null) => void
  getPromptCacheKey: (conversationId?: string) => string

  /**
   * Returns and consumes any pendingPrepared decision left by `prepareTurn`.
   * Mirrors the legacy `pendingPrepared` field (one-shot, cleared after read).
   */
  consumePendingPrepared: () => { isContinuation: boolean } | null
}

// ---------------------------------------------------------------------------
// Tool conversion: RivetOS ToolDefinition[] → AI SDK ToolSet
// ---------------------------------------------------------------------------

function buildClientToolSet(toolDefs: ToolDefinition[] | undefined): ToolSet {
  const set: ToolSet = {}
  if (!toolDefs?.length) return set
  for (const def of toolDefs) {
    set[def.name] = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters),
      // No `execute` — RivetOS dispatches client-side tools itself. AI SDK
      // will emit `tool-call` parts that the loop translates back to LLMChunk.
    }
  }
  return set
}

function buildServerToolSet(ctx: XAIAiSdkContext): ToolSet {
  const set: ToolSet = {}

  if (ctx.webSearch) {
    if (typeof ctx.webSearch === 'object') {
      const cfg = ctx.webSearch
      const args: Record<string, unknown> = {}
      if (cfg.allowedDomains?.length || cfg.excludedDomains?.length) {
        const filters: Record<string, unknown> = {}
        if (cfg.allowedDomains?.length) filters.allowed_domains = cfg.allowedDomains
        if (cfg.excludedDomains?.length) filters.excluded_domains = cfg.excludedDomains
        args.searchParameters = { filters }
      }
      if (cfg.enableImageUnderstanding) args.enableImageUnderstanding = true
      set.web_search = xaiTools.webSearch(args)
    } else {
      set.web_search = xaiTools.webSearch()
    }
  }

  if (ctx.xSearch) {
    if (typeof ctx.xSearch === 'object') {
      const cfg = ctx.xSearch
      const args: Record<string, unknown> = {}
      if (cfg.allowedXHandles?.length) args.allowedXHandles = cfg.allowedXHandles
      if (cfg.excludedXHandles?.length) args.excludedXHandles = cfg.excludedXHandles
      if (cfg.fromDate) args.fromDate = cfg.fromDate
      if (cfg.toDate) args.toDate = cfg.toDate
      if (cfg.enableImageUnderstanding) args.enableImageUnderstanding = true
      if (cfg.enableVideoUnderstanding) args.enableVideoUnderstanding = true
      set.x_search = xaiTools.xSearch(args)
    } else {
      set.x_search = xaiTools.xSearch()
    }
  }

  if (ctx.codeExecution) {
    set.code_execution = xaiTools.codeExecution()
  }

  return set
}

// ---------------------------------------------------------------------------
// Reasoning effort mapping
// ---------------------------------------------------------------------------

function mapReasoningEffort(
  model: string,
  thinking: ThinkingLevel | undefined,
  configured: 'low' | 'medium' | 'high' | 'xhigh' | undefined,
): 'low' | 'medium' | 'high' | undefined {
  const level = thinking ?? configured
  if (!level || level === 'off') return undefined
  // Only multi-agent supports reasoning.effort at all
  if (!model.includes('multi-agent')) return undefined
  // AI SDK's typed schema currently rejects 'xhigh' — degrade with warning.
  if (level === 'xhigh') {
    console.warn(
      '[xai-aisdk] xhigh reasoning effort not supported by @ai-sdk/xai schema — degrading to high',
    )
    return 'high'
  }
  return level
}

// ---------------------------------------------------------------------------
// chatStreamAiSdk — drop-in for the legacy generator
// ---------------------------------------------------------------------------

export async function* chatStreamAiSdk(
  ctx: XAIAiSdkContext,
  messages: Message[],
  options?: ChatOptions,
): AsyncIterable<LLMChunk> {
  const model = options?.modelOverride ?? ctx.defaultModel
  const containsImages = messages.some((m) => hasImages(m.content))
  const storeThisRequest = containsImages ? false : ctx.store

  // Honor prepareTurn's decision if the loop already called it.
  const pending = ctx.consumePendingPrepared()
  let canContinue: boolean
  if (pending) {
    canContinue = pending.isContinuation
  } else {
    canContinue = !!(
      storeThisRequest &&
      ctx.getLastResponseId() &&
      !options?.freshConversation &&
      ctx.getLastResponseModel() === model
    )
  }

  const promptCacheKey = ctx.getPromptCacheKey(options?.conversationId)
  const aiSdkMessages = convertMessagesToAiSdk(messages)

  // Server-side tools always defined; function tools on top.
  const tools: ToolSet = {
    ...buildServerToolSet(ctx),
    ...buildClientToolSet(options?.tools),
  }

  const reasoningEffort = mapReasoningEffort(model, options?.thinking, ctx.reasoningEffort)

  const xaiProvider = createXai({
    apiKey: ctx.apiKey,
    baseURL: ctx.baseUrl,
    headers: { 'x-grok-conv-id': promptCacheKey },
  })

  // Abort wiring — match legacy behavior: wrap external signal + add timeout.
  const controller = new AbortController()
  if (options?.signal) {
    if (options.signal.aborted) {
      yield { type: 'error', error: 'Aborted' }
      return
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), ctx.timeoutMs)

  const acc = createLlmChunkAccumulator()

  try {
    const xaiProviderOptions: JSONObject = {
      store: storeThisRequest,
    }
    if (canContinue && ctx.getLastResponseId()) {
      xaiProviderOptions.previousResponseId = ctx.getLastResponseId()
    }
    if (reasoningEffort) {
      xaiProviderOptions.reasoningEffort = reasoningEffort
    }

    const result = streamText({
      model: xaiProvider.responses(model),
      messages: aiSdkMessages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(1),
      abortSignal: controller.signal,
      providerOptions: { xai: xaiProviderOptions },
      ...(ctx.outputTokenLimit > 0 ? { maxOutputTokens: ctx.outputTokenLimit } : {}),
    })

    for await (const part of result.fullStream) {
      const chunks = translateAiSdkPart(part, acc)
      for (const chunk of chunks) yield chunk
    }

    // Mirror legacy save semantics: only persist response ID when text was
    // emitted. Tool-call-only responses can poison server-side state.
    if (acc.responseId && storeThisRequest && acc.hadTextContent) {
      ctx.setLastResponseId(acc.responseId)
      ctx.setLastResponseModel(model)
    } else if (acc.responseId && storeThisRequest && !acc.hadTextContent) {
      ctx.setLastResponseId(null)
    }

    yield buildDoneChunk(acc)
  } catch (err) {
    // Invalidate continuation state on any failure — matches legacy behavior.
    ctx.setLastResponseId(null)
    if (err instanceof ProviderError) throw err
    if (APICallError.isInstance(err)) {
      throw new ProviderError(
        `xAI ${String(err.statusCode ?? 0)}: ${(err.responseBody ?? err.message).slice(0, 500)}`,
        err.statusCode ?? 0,
        'xai',
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new ProviderError(`xAI fetch failed: ${message}`, 0, 'xai', false)
  } finally {
    clearTimeout(timeout)
  }
}
