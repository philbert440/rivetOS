/**
 * AI SDK-backed implementation of xAI `chatStream`.
 *
 * Lives alongside the legacy hand-rolled implementation in `index.ts`. Step 2c
 * (next commit) wires a feature flag on the provider to pick between paths.
 * Until then this module is dead code — kept compiling so the migration is
 * incremental and reviewable.
 *
 * Maps:
 * - `prepareTurn` → `providerOptions.xai.previousResponseId`
 * - thinking effort → `providerOptions.xai.reasoningEffort`
 * - server-side tools (web_search / x_search / code_execution) → `xaiTools.*`
 * - `result.fullStream` → RivetOS `LLMChunk` events
 *
 * Known gaps vs. the legacy path (deliberately not wired in 2b):
 * - `xhigh` reasoning effort: `@ai-sdk/xai` schema only accepts low/medium/high.
 *   Multi-agent xhigh requests will degrade to `high` with a console warning.
 * - `prompt_cache_key` body field: not exposed; the `x-grok-conv-id` header
 *   still carries the cache key, which is sufficient for cache hits.
 * - `max_turns`, `tool_choice`, `parallel_tool_calls`, `truncation`,
 *   `instructions`: not configurable through the typed providerOptions schema.
 *   Wire via custom `fetch` in a later commit if needed.
 * - `include: ['reasoning.encrypted_content']`: not exposed; affects stateless
 *   continuity edge cases. `previousResponseId` itself still flows through.
 */

import { createXai, xaiTools } from '@ai-sdk/xai'
import { streamText, stepCountIs, jsonSchema, APICallError, type ModelMessage, type ToolSet } from 'ai'
import type { JSONObject, JSONValue } from '@ai-sdk/provider'
import type {
  ChatOptions,
  ContentPart,
  LLMChunk,
  LLMUsage,
  Message,
  ThinkingLevel,
  ToolDefinition,
} from '@rivetos/types'
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
// Message conversion: RivetOS Message[] → AI SDK ModelMessage[]
// ---------------------------------------------------------------------------

function partsToAiSdkUserContent(
  parts: ContentPart[],
): Array<{ type: 'text'; text: string } | { type: 'image'; image: string | URL; mediaType?: string }> {
  const out: Array<
    { type: 'text'; text: string } | { type: 'image'; image: string | URL; mediaType?: string }
  > = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text })
    } else {
      if (part.data) {
        out.push({
          type: 'image',
          image: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.data}`,
          mediaType: part.mimeType,
        })
      } else if (part.url) {
        out.push({ type: 'image', image: new URL(part.url), mediaType: part.mimeType })
      }
    }
  }
  return out
}

function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function convertMessagesToAiSdk(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = []

  // Map tool-call-id → tool name from prior assistant messages so tool result
  // messages can satisfy AI SDK's `toolName` requirement.
  const toolNameByCallId = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) toolNameByCallId.set(tc.id, tc.name)
    }
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      let value = extractText(msg.content) || ''
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const imageCount = msg.content.filter((p) => p.type === 'image').length
        if (imageCount > 0) {
          value += `\n[${String(imageCount)} image(s) returned — see image content in context]`
        }
      }
      const callId = msg.toolCallId ?? ''
      result.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            toolName: toolNameByCallId.get(callId) ?? '',
            output: { type: 'text', value },
          },
        ],
      })
    } else if (msg.role === 'assistant') {
      const text = extractText(msg.content) || ''
      const hasToolCalls = !!msg.toolCalls && msg.toolCalls.length > 0

      if (hasToolCalls) {
        const content: Array<
          | { type: 'text'; text: string }
          | {
              type: 'tool-call'
              toolCallId: string
              toolName: string
              input: unknown
            }
        > = []
        if (text) content.push({ type: 'text', text })
        for (const tc of msg.toolCalls!) {
          let input: unknown
          if (typeof tc.arguments === 'string') {
            try {
              input = JSON.parse(tc.arguments)
            } catch {
              input = { raw: tc.arguments }
            }
          } else {
            input = tc.arguments
          }
          content.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            input,
          })
        }
        result.push({ role: 'assistant', content })
      } else if (text) {
        result.push({ role: 'assistant', content: text })
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const userContent = partsToAiSdkUserContent(msg.content)
        if (userContent.length > 0) {
          result.push({ role: 'user', content: userContent })
        } else {
          const text = extractText(msg.content)
          if (text) result.push({ role: 'user', content: text })
        }
      } else {
        const text = extractText(msg.content)
        if (text) result.push({ role: 'user', content: text })
      }
    } else {
      // system
      const text = extractText(msg.content)
      if (text) result.push({ role: 'system', content: text })
    }
  }

  return result
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
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
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
      set.web_search = xaiTools.webSearch(args as never)
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
      set.x_search = xaiTools.xSearch(args as never)
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
    console.warn('[xai-aisdk] xhigh reasoning effort not supported by @ai-sdk/xai schema — degrading to high')
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

  const usage: LLMUsage = { promptTokens: 0, completionTokens: 0 }
  const citations: string[] = []
  let hadTextContent = false
  let savedResponseId: string | null = null
  const pendingToolCallIndex = new Map<string, number>()
  let nextToolCallIndex = 0

  try {
    const xaiProviderOptions: JSONObject = {
      store: storeThisRequest,
    }
    if (canContinue && ctx.getLastResponseId()) {
      xaiProviderOptions.previousResponseId = ctx.getLastResponseId() as JSONValue
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
      switch (part.type) {
        case 'text-delta': {
          if (part.text) {
            hadTextContent = true
            yield { type: 'text', delta: part.text }
          }
          break
        }
        case 'reasoning-delta': {
          if (part.text) yield { type: 'reasoning', delta: part.text }
          break
        }
        case 'tool-input-start': {
          const idx = nextToolCallIndex++
          pendingToolCallIndex.set(part.id, idx)
          yield {
            type: 'tool_call_start',
            toolCall: { index: idx, id: part.id, name: part.toolName },
          }
          break
        }
        case 'tool-input-delta': {
          const idx = pendingToolCallIndex.get(part.id) ?? 0
          yield {
            type: 'tool_call_delta',
            delta: part.delta,
            toolCall: { index: idx },
          }
          break
        }
        case 'tool-input-end': {
          const idx = pendingToolCallIndex.get(part.id) ?? 0
          yield { type: 'tool_call_done', toolCall: { index: idx } }
          break
        }
        case 'source': {
          if (part.sourceType === 'url' && part.url) citations.push(part.url)
          break
        }
        case 'finish-step': {
          if (part.usage) {
            usage.promptTokens = part.usage.inputTokens ?? 0
            usage.completionTokens = part.usage.outputTokens ?? 0
            const reasoningTokens = part.usage.outputTokenDetails?.reasoningTokens
            if (reasoningTokens) usage.reasoningTokens = reasoningTokens
            const cacheReadTokens = part.usage.inputTokenDetails?.cacheReadTokens
            if (cacheReadTokens) usage.cachedTokens = cacheReadTokens
          }
          if (part.response.id) savedResponseId = part.response.id
          break
        }
        case 'error': {
          const errMsg = part.error instanceof Error ? part.error.message : String(part.error)
          yield { type: 'error', error: errMsg }
          break
        }
        // Ignore: text-start/end, reasoning-start/end, tool-call (we already
        // emitted equivalent events from the input stream), tool-result,
        // tool-error, file, start, finish, abort, start-step
      }
    }

    // Mirror legacy save semantics: only persist response ID when text was
    // emitted. Tool-call-only responses can poison server-side state.
    if (savedResponseId && storeThisRequest && hadTextContent) {
      ctx.setLastResponseId(savedResponseId)
      ctx.setLastResponseModel(model)
    } else if (savedResponseId && storeThisRequest && !hadTextContent) {
      ctx.setLastResponseId(null)
    }

    const doneChunk: LLMChunk = { type: 'done', usage }
    if (citations.length > 0) doneChunk.citations = citations
    yield doneChunk
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
