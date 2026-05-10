/**
 * hookPipelineToMiddleware — translates RivetOS HookPipeline events into AI SDK
 * LanguageModelV2 middleware so the same registered hooks fire when the loop is
 * driven by `streamText` instead of the legacy `loop.ts`.
 *
 * Mapping:
 *   provider:before → middleware.transformParams
 *     - Builds a ProviderBeforeContext with `messages = params.prompt`,
 *       `tools = params.tools`. Pipeline may reassign either; the new arrays
 *       are written back into params.
 *     - If a hook sets `ctx.skip = true` or returns `'abort'` / `'skip'`,
 *       we throw `HookSkipError` to short-circuit the call before the model
 *       is hit. The loop wrapper above the AI SDK call is responsible for
 *       catching this and finishing the turn cleanly.
 *
 *   provider:after  → middleware.wrapStream (post-stream)
 *     - Wraps the model's stream and observes `tool-call` parts (to set
 *       `hasToolCalls`) and the terminal `finish` part (to capture `usage`
 *       and stop the latency timer). After the stream completes successfully,
 *       runs the pipeline. Hook return values do not affect the stream — this
 *       is observation only.
 *
 *   provider:error  → middleware.wrapStream (catch path)
 *     - On any error from `doStream()` itself or while pulling chunks, runs
 *       the pipeline with the error and `statusCode` (when the error is an
 *       APICallError). The error is always re-thrown — provider fallback was
 *       removed in step 3a, this hook is observation only.
 *
 * What this factory does NOT do:
 *   - tool:before / tool:after — those are tool-execution lifecycle, not
 *     provider-call lifecycle. They are wired in the tool registry (step 4).
 *   - Loop wiring. The factory is pure; the loop calls `wrapLanguageModel`
 *     in a later step (step 6+).
 *
 * Composition order: middleware passed to `wrapLanguageModel` is applied
 * right-to-left (the last entry runs nearest the model). HookPipeline already
 * orders hooks by priority (lower number = first). This factory emits a
 * single middleware whose internal pipeline.run() honors that ordering, so
 * priority semantics are preserved without callers needing to think about it.
 */

import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Middleware,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import type {
  HookPipeline,
  ProviderAfterContext,
  ProviderBeforeContext,
  ProviderErrorContext,
} from '@rivetos/types'

// ---------------------------------------------------------------------------
// Sentinel error — short-circuit signal from provider:before hooks
// ---------------------------------------------------------------------------

/**
 * Thrown from `transformParams` when a `provider:before` hook sets `skip`
 * or aborts the pipeline. The loop wrapper around `streamText` is expected
 * to catch this and finish the turn without surfacing it as a real error.
 */
export class HookSkipError extends Error {
  readonly reason: 'aborted' | 'skipped' | 'skip-flag'
  readonly hookId?: string

  constructor(reason: 'aborted' | 'skipped' | 'skip-flag', hookId?: string) {
    super(
      `Provider call short-circuited by hook (reason=${reason}` +
        (hookId ? `, hook=${hookId}` : '') +
        ')',
    )
    this.name = 'HookSkipError'
    this.reason = reason
    this.hookId = hookId
  }
}

// ---------------------------------------------------------------------------
// Factory options — contextual binding the middleware needs at construction
// ---------------------------------------------------------------------------

export interface HookMiddlewareBinding {
  /** Stable provider identifier (e.g. 'xai', 'anthropic'). */
  providerId: string
  /** Model id (e.g. 'grok-4', 'claude-sonnet-4-6'). */
  model: string
  /** Optional agent id for hook agent-filters. */
  agentId?: string
  /** Optional session id passed through to hook contexts. */
  sessionId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(
  usage: LanguageModelV2Usage | undefined,
): { promptTokens: number; completionTokens: number } | undefined {
  if (!usage) return undefined
  const promptTokens = usage.inputTokens ?? 0
  const completionTokens = usage.outputTokens ?? 0
  if (promptTokens === 0 && completionTokens === 0) return undefined
  return { promptTokens, completionTokens }
}

function statusCodeOf(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) {
    return err.statusCode ?? undefined
  }
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const sc = (err as { statusCode?: unknown }).statusCode
    if (typeof sc === 'number') return sc
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function hookPipelineToMiddleware(
  pipeline: HookPipeline,
  binding: HookMiddlewareBinding,
): LanguageModelV2Middleware {
  const { providerId, model, agentId, sessionId } = binding

  return {
    middlewareVersion: 'v2',

    // ---- provider:before ------------------------------------------------
    async transformParams({ params }) {
      const ctx: ProviderBeforeContext = {
        event: 'provider:before',
        providerId,
        model,
        agentId,
        sessionId,
        messages: params.prompt,
        tools: params.tools,
        timestamp: Date.now(),
        metadata: {},
      }

      const result = await pipeline.run(ctx)

      // Hard stop: hook returned 'abort'.
      if (result.aborted) {
        const lastHook = result.ran[result.ran.length - 1]
        throw new HookSkipError('aborted', lastHook)
      }

      // Soft stop: hook set ctx.skip or returned 'skip'.
      if (result.context.skip || result.skipped) {
        const lastHook = result.ran[result.ran.length - 1]
        throw new HookSkipError(result.context.skip ? 'skip-flag' : 'skipped', lastHook)
      }

      // Carry hook reassignments back into params. Hooks that didn't touch
      // these fields hand back the same array reference, so equality short-
      // circuits no-op cases and we only build a new params object when
      // something actually changed.
      const nextPrompt = result.context.messages
      const nextTools = result.context.tools
      const promptChanged = nextPrompt !== params.prompt
      const toolsChanged = nextTools !== params.tools
      if (!promptChanged && !toolsChanged) {
        return params
      }

      const out: LanguageModelV2CallOptions = {
        ...params,
        prompt: promptChanged
          ? (nextPrompt as LanguageModelV2CallOptions['prompt'])
          : params.prompt,
      }
      if (toolsChanged) {
        out.tools = nextTools as LanguageModelV2CallOptions['tools']
      }
      return out
    },

    // ---- provider:after / provider:error -------------------------------
    async wrapStream({ doStream }) {
      const startedAt = Date.now()

      let baseStream: Awaited<ReturnType<typeof doStream>>
      try {
        baseStream = await doStream()
      } catch (err) {
        await runErrorHook(pipeline, err, {
          providerId,
          model,
          agentId,
          sessionId,
        })
        throw err
      }

      let hasToolCalls = false
      let finalUsage: LanguageModelV2Usage | undefined
      let afterRan = false

      const observed = baseStream.stream.pipeThrough(
        new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
          transform(chunk, controller) {
            if (chunk.type === 'tool-call') hasToolCalls = true
            if (chunk.type === 'finish') finalUsage = chunk.usage
            controller.enqueue(chunk)
          },
          async flush() {
            // flush() only runs on normal stream completion. If the stream
            // is cancelled mid-flight (abort signal, downstream cancel),
            // neither transform nor flush fires for the remaining chunks
            // and provider:after stays silent — which is what we want.
            // The loop wrapper surfaces aborts separately; provider:error
            // is reserved for genuine doStream() failures.
            if (afterRan) return
            afterRan = true
            await runAfterHook(pipeline, {
              providerId,
              model,
              agentId,
              sessionId,
              latencyMs: Date.now() - startedAt,
              hasToolCalls,
              usage: mapUsage(finalUsage),
            })
          },
        }),
      )

      return {
        ...baseStream,
        stream: observed,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Internal — pipeline runners with consistent context shape
// ---------------------------------------------------------------------------

interface AfterArgs {
  providerId: string
  model: string
  agentId?: string
  sessionId?: string
  latencyMs: number
  hasToolCalls: boolean
  usage?: { promptTokens: number; completionTokens: number }
}

async function runAfterHook(pipeline: HookPipeline, args: AfterArgs): Promise<void> {
  const ctx: ProviderAfterContext = {
    event: 'provider:after',
    providerId: args.providerId,
    model: args.model,
    agentId: args.agentId,
    sessionId: args.sessionId,
    timestamp: Date.now(),
    metadata: {},
    latencyMs: args.latencyMs,
    hasToolCalls: args.hasToolCalls,
    usage: args.usage,
  }
  await pipeline.run(ctx)
}

interface ErrorArgs {
  providerId: string
  model: string
  agentId?: string
  sessionId?: string
}

async function runErrorHook(pipeline: HookPipeline, err: unknown, args: ErrorArgs): Promise<void> {
  const errorObj = err instanceof Error ? err : new Error(String(err))
  const ctx: ProviderErrorContext = {
    event: 'provider:error',
    providerId: args.providerId,
    model: args.model,
    agentId: args.agentId,
    sessionId: args.sessionId,
    timestamp: Date.now(),
    metadata: {},
    error: errorObj,
    statusCode: statusCodeOf(err),
  }
  // Errors inside provider:error hooks are isolated by HookPipeline itself
  // (per-hook onError mode). We don't need extra try/catch here — a faulty
  // hook should never mask the original provider failure.
  await pipeline.run(ctx)
}
