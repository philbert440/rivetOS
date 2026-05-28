/**
 * Agent Loop — AI SDK implementation.
 *
 * Drives one turn of the conversation using `streamText` from the Vercel AI SDK
 * as the inner kernel. Provider-specific construction (auth, headers, response_id
 * persistence, server-side tools) lives behind `Provider.aiSdkBridge`. The loop
 * itself owns:
 *
 *   - Steer queue injection between steps
 *   - Turn-timeout abort + graceful-warning system message
 *   - Context-window nudges (40/70/90% by default)
 *   - `compact_context` as a built-in tool with deferred application via
 *     `prepareStep` (no out-of-band mutation of messages)
 *   - Hook pipeline wired as language-model middleware
 *   - Image-handling for tool results (disk archive, fire-and-forget)
 *   - StreamEvent emission via `fullStream` part translation
 *
 * Pure domain logic. No I/O except the optional image-archival side effect.
 */

import type {
  Message,
  ContentPart,
  Provider,
  Tool,
  ToolCall,
  StreamEvent,
  StreamHandler,
  ChatOptions,
  ThinkingLevel,
  HookPipeline,
} from '@rivetos/types'
import { getToolResultImages, toolResultHasImages } from '@rivetos/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  streamText,
  stepCountIs,
  tool,
  wrapLanguageModel,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from 'ai'
import { estimateTokens } from './tokens.js'
import {
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
  type AiSdkChunkAccumulator,
  type ProviderAiSdkBridge,
} from '@rivetos/aisdk'
import { toAiSdkTools } from './tools-aisdk.js'
import { hookPipelineToMiddleware, HookSkipError } from './hooks-aisdk.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  systemPrompt: string
  tools: Tool[]
  provider: Provider
  thinking?: ThinkingLevel
  /** Model override — use a specific model instead of the provider's default.
   *  Set from agent config to allow multiple agents on the same provider with different models. */
  modelOverride?: string
  onStream?: StreamHandler
  /** Agent ID — passed to tools via ToolContext */
  agentId?: string
  /** Workspace directory — passed to tools via ToolContext for resolving relative paths */
  workspaceDir?: string
  /** Directory to save tool-produced images (default: .data/images in cwd) */
  imageDir?: string
  /** Hook pipeline for lifecycle events (optional — loop works without it) */
  hooks?: HookPipeline
  /** Session ID for hook context */
  sessionId?: string
  /** Turn wall-clock timeout in ms (default: 1_800_000 = 30 min) */
  turnTimeout?: number
  /** Graceful degradation warning offset in ms before timeout (default: 180_000 = 3 min before timeout) */
  gracefulWarningMs?: number
  /** Context window size in tokens (from provider, 0 = unknown) */
  contextWindow?: number
  /** Context management thresholds */
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
  /** Callback to sync compacted history back to the session */
  onCompact?: (compactedHistory: Message[]) => void
  /** Start a fresh conversation — prevents reuse of stateful provider context (e.g. xAI previous_response_id).
   *  Set by delegation/subagent engines to isolate conversations. */
  freshConversation?: boolean
  /** Hard cap on tool-execution steps before stopWhen fires (default: 50). */
  maxSteps?: number
}

// ---------------------------------------------------------------------------
// Turn timeout sentinel
// ---------------------------------------------------------------------------

/**
 * Abort reason used when the per-turn timeout fires. Detected by identity
 * (`instanceof`) rather than by string-matching an Error message, so it can
 * never be confused with a caller-supplied abort reason that happens to carry
 * the same text.
 */
class TurnTimeoutError extends Error {
  constructor() {
    super('turn-timeout')
    this.name = 'TurnTimeoutError'
  }
}

/** True if an AbortSignal reason is our turn-timeout sentinel. */
function isTurnTimeout(reason: unknown): boolean {
  return reason instanceof TurnTimeoutError
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TurnResult {
  /** Final text response (empty if aborted) */
  response: string
  /** Tools invoked during this turn */
  toolsUsed: string[]
  /** Number of tool iterations */
  iterations: number
  /** Whether the turn was aborted (/stop or /interrupt) */
  aborted: boolean
  /** Partial response text collected before abort (for /interrupt context) */
  partialResponse?: string
  /** Token usage from provider */
  usage?: { promptTokens: number; completionTokens: number }
  /** Whether the user injected a steer message during this turn */
  hadSteer?: boolean
}

// ---------------------------------------------------------------------------
// Internal turn state
// ---------------------------------------------------------------------------

interface CompactionRequest {
  start_index: number
  end_index: number
  summary: string
}

interface TurnState {
  /** Tool names used (in order, with duplicates). */
  toolsUsed: string[]
  /** Steps that involved tool calls. Iterations == legacy "tool iterations". */
  iterations: number
  /** Pending compaction stashed by the most recent compact_context call. */
  pendingCompaction: CompactionRequest[] | null
  /** Soft+hard nudge pcts already fired this turn. */
  nudgesFired: number[]
  /** True after the [SYSTEM — Turn Timeout Warning] message has been injected. */
  gracefulWarningFired: boolean
  /** True if the user steered during this turn. */
  hadSteer: boolean
  /** Last per-step `inputTokens` reading — used for context-window % calculations. */
  lastKnownPromptTokens: number
  /** Heartbeat tracking. */
  lastProgressEmit: number
  heartbeatCount: number
  /** Turn start timestamp for elapsed/timeout calculations. */
  turnStart: number
  /** Accumulated usage across all steps (max-merged). */
  totalUsage: {
    promptTokens: number
    completionTokens: number
    reasoningTokens?: number
    cachedTokens?: number
  }
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private config: AgentLoopConfig
  private steerQueue: string[] = []

  constructor(config: AgentLoopConfig) {
    this.config = config
  }

  /** Inject a message visible on the next tool iteration. */
  steer(message: string): void {
    this.steerQueue.push(message)
  }

  /**
   * Run one turn.
   * userMessage can be a plain string or multimodal ContentPart[] (text + images).
   */
  async run(
    userMessage: string | ContentPart[],
    history: Message[],
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    // ---- Early abort -----------------------------------------------------
    if (signal?.aborted) {
      return {
        response: '',
        toolsUsed: [],
        iterations: 0,
        aborted: true,
        partialResponse: '',
        usage: { promptTokens: 0, completionTokens: 0 },
        hadSteer: false,
      }
    }

    // ---- Provider bridge -------------------------------------------------
    const bridge = this.config.provider.aiSdkBridge?.() as ProviderAiSdkBridge | undefined
    if (!bridge) {
      throw new Error(
        `Provider "${this.config.provider.id}" does not expose an aiSdkBridge — ` +
          `it must implement aiSdkBridge() to be used with the AI SDK loop.`,
      )
    }

    // ---- Prepare messages (prov-specific massaging if any) ---------------
    const rawHistory: Message[] = [...history, { role: 'user', content: userMessage }]
    const prep = bridge.prepareMessages?.(rawHistory)
    const wireMessages: Message[] = prep?.messages ?? rawHistory
    // System prompt: provider may want to merge in extra (vLLM/Qwen folding),
    // but typically just config.systemPrompt.
    const systemPrompt = prep?.system
      ? `${this.config.systemPrompt}\n\n${prep.system}`
      : this.config.systemPrompt

    let aiSdkMessages: ModelMessage[] = convertMessagesToAiSdk(wireMessages)

    // ---- Turn state ------------------------------------------------------
    const state: TurnState = {
      toolsUsed: [],
      iterations: 0,
      pendingCompaction: null,
      nudgesFired: [],
      gracefulWarningFired: false,
      hadSteer: false,
      lastKnownPromptTokens: 0,
      lastProgressEmit: Date.now(),
      heartbeatCount: 0,
      turnStart: Date.now(),
      totalUsage: { promptTokens: 0, completionTokens: 0 },
    }

    // ---- Turn timeout ----------------------------------------------------
    const turnTimeout = this.config.turnTimeout ?? 1_800_000

    // Compose abort signal: caller signal + turn-timeout
    const turnAbort = new AbortController()
    const timeoutId = setTimeout(() => {
      turnAbort.abort(new TurnTimeoutError())
    }, turnTimeout)
    const onCallerAbort = () => turnAbort.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) turnAbort.abort(signal.reason)
      else signal.addEventListener('abort', onCallerAbort, { once: true })
    }

    // ---- Build tool set --------------------------------------------------
    const userTools = toAiSdkTools(this.config.tools, {
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      workingDir: this.config.workspaceDir,
      hooks: this.config.hooks,
      onStreamEvent: (e) => this.emit(e),
    })
    const tools: ToolSet = {
      ...this.wrapToolsForImages(userTools, this.config.tools),
      compact_context: this.buildCompactContextTool(state),
      ...(bridge.getServerSideTools?.() ?? {}),
    }

    // ---- Build language model + middleware -------------------------------
    //
    // The middleware infrastructure (hookPipelineToMiddleware, step 3c) is
    // typed against `LanguageModelV2` from `@ai-sdk/provider`. AI SDK 6's
    // `streamText` / `wrapLanguageModel` expect `LanguageModelV3` at the type
    // layer but accept V2 models at runtime via internal compat shims.
    // Migrating the middleware infra to V3 is queued as its own concern; for
    // now we cast at the boundary.
    const baseModel = bridge.getModel({
      modelOverride: this.config.modelOverride,
      conversationId: this.config.sessionId,
      tools: this.config.tools.length > 0 ? this.config.tools : undefined,
      agentId: this.config.agentId,
    })
    const model: LanguageModel = this.config.hooks
      ? wrapLanguageModel({
          /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
          model: baseModel as any,
          middleware: hookPipelineToMiddleware(this.config.hooks, {
            providerId: this.config.provider.id,
            model: this.config.modelOverride ?? this.config.provider.getModel(),
            agentId: this.config.agentId,
            sessionId: this.config.sessionId,
          }) as any,
          /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
        })
      : baseModel

    // ---- Build providerOptions ------------------------------------------
    const chatOptions: ChatOptions = {
      thinking: this.config.thinking,
      modelOverride: this.config.modelOverride,
      freshConversation: this.config.freshConversation,
      agentId: this.config.agentId,
      executableTools: this.config.tools.length > 0 ? this.config.tools : undefined,
    }
    const rawProviderOptions = bridge.buildProviderOptions(wireMessages, chatOptions)
    // AI SDK's ProviderOptions is `SharedV3ProviderOptions` (Record<string,
    // Record<string, JSONValue>>); bridge returns `JSONObject`. Structurally
    // compatible at runtime, but TS narrows JSONValue strictly.
    const providerOptions = rawProviderOptions as Parameters<
      typeof streamText
    >[0]['providerOptions']

    // ---- Stream! ---------------------------------------------------------
    const acc = createLlmChunkAccumulator()
    let textContent = ''
    let lastError: string | null = null
    let timedOut = false
    let aborted = false

    // Build a TurnResult, filling the per-turn fields (toolsUsed/iterations/
    // usage/hadSteer) from `state` so the four post-init exit paths can't drift
    // apart. `partialResponse` is included only when provided.
    const makeTurnResult = (over: {
      response: string
      aborted: boolean
      partialResponse?: string
    }): TurnResult => ({
      response: over.response,
      toolsUsed: state.toolsUsed,
      iterations: state.iterations,
      aborted: over.aborted,
      ...(over.partialResponse !== undefined ? { partialResponse: over.partialResponse } : {}),
      usage: state.totalUsage,
      hadSteer: state.hadSteer,
    })

    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: aiSdkMessages,
        tools,
        stopWhen: stepCountIs(this.config.maxSteps ?? 50),
        abortSignal: turnAbort.signal,
        providerOptions,
        prepareStep: (opts) => this.handlePrepareStep(opts, state),
        onStepFinish: (stepResult) => {
          this.handleStepFinish(stepResult, state, bridge, chatOptions)
        },
      })

      // Drive the fullStream — translate parts to LLMChunks, then emit the
      // shape the channel layer expects. Tool-related events are emitted by
      // the tools-aisdk wrapper itself (tool_start/tool_result), so here we
      // only handle text/reasoning/error/status.
      for await (const part of result.fullStream as AsyncIterable<unknown>) {
        // AI SDK 6 emits an `abort` stream part when the abortSignal fires
        // mid-stream (rather than throwing). Detect timeout vs caller abort
        // by inspecting `turnAbort.signal.reason`.
        const partType = (part as { type?: string }).type
        if (partType === 'abort') {
          if (isTurnTimeout(turnAbort.signal.reason)) timedOut = true
          else aborted = true
          break
        }
        const chunks = translateAiSdkPart(part as never, acc)
        for (const c of chunks) {
          switch (c.type) {
            case 'text':
              if (c.delta) {
                textContent += c.delta
                this.emit({ type: 'text', content: c.delta })
              }
              break
            case 'reasoning':
              if (c.delta) this.emit({ type: 'reasoning', content: c.delta })
              break
            case 'error':
              if (c.error) {
                lastError = c.error
                this.emit({ type: 'error', content: c.error })
              }
              break
            case 'status':
              if (c.delta) this.emit({ type: 'status', content: `🔍 ${c.delta}` })
              break
            // tool_call_* chunks: ignored here — tools-aisdk emits tool_start /
            // tool_result events from the wrapped execute, matching legacy.
            // 'done' is terminal-only, captured via mergeUsageFromAcc.
            default:
              break
          }
        }
      }

      // After stream completes, ensure accumulator usage is merged.
      this.mergeUsageFromAcc(acc, state)
    } catch (err: unknown) {
      // Distinguish abort/timeout from real errors.
      if (err instanceof HookSkipError) {
        // Hook said skip — finish cleanly as aborted.
        clearTimeout(timeoutId)
        if (signal) signal.removeEventListener('abort', onCallerAbort)
        return makeTurnResult({ response: '', aborted: true, partialResponse: textContent })
      }

      if (turnAbort.signal.aborted) {
        // Either caller aborted or turn timeout fired.
        if (isTurnTimeout(turnAbort.signal.reason)) {
          timedOut = true
        } else {
          aborted = true
        }
      } else {
        // Real error — propagate after cleanup.
        clearTimeout(timeoutId)
        if (signal) signal.removeEventListener('abort', onCallerAbort)
        throw err
      }
    } finally {
      clearTimeout(timeoutId)
      if (signal) signal.removeEventListener('abort', onCallerAbort)
    }

    // ---- Apply any leftover compaction + sync session -------------------
    if (state.pendingCompaction) {
      aiSdkMessages = this.applyCompaction(aiSdkMessages, state.pendingCompaction)
      this.syncCompactedSession(aiSdkMessages)
      state.pendingCompaction = null
    }

    // ---- Build TurnResult ------------------------------------------------
    if (aborted) {
      return makeTurnResult({ response: '', aborted: true, partialResponse: textContent })
    }

    if (timedOut) {
      const elapsedSec = Math.floor((Date.now() - state.turnStart) / 1000)
      this.emit({
        type: 'status',
        content: `⚠️ Turn timeout (${elapsedSec}s)`,
      })
      const capNotice = '\n\n⚠️ _Turn timed out. Let me know if you want me to continue._'
      return makeTurnResult({
        response: textContent ? textContent.trim() + capNotice : capNotice.trim(),
        aborted: false,
      })
    }

    // Normal finish: prefer text, fall back to lastError, then empty.
    const finalResponse = textContent.trim() || (lastError ? `⚠️ ${lastError}` : '')
    return makeTurnResult({ response: finalResponse, aborted: false })
  }

  // -----------------------------------------------------------------------
  // prepareStep — runs before each LLM call
  // -----------------------------------------------------------------------

  private handlePrepareStep(
    opts: { messages: ModelMessage[]; stepNumber: number },
    state: TurnState,
  ): { messages: ModelMessage[] } | undefined {
    let messages = opts.messages
    let mutated = false

    // 1. Apply pending compaction (set by compact_context tool last step).
    if (state.pendingCompaction) {
      messages = this.applyCompaction(messages, state.pendingCompaction)
      this.syncCompactedSession(messages)
      state.pendingCompaction = null
      state.nudgesFired.length = 0 // reset nudges for fresh window
      mutated = true
    }

    // 2. Steer queue — drain into system messages. Only fires between
    // iterations (stepNumber > 0). Steers queued before run() starts are
    // applied on the next model call after the first step completes — this
    // matches legacy behavior and the user-intent semantic of "steer
    // mid-turn".
    if (opts.stepNumber > 0) {
      while (this.steerQueue.length > 0) {
        const steerMsg = this.steerQueue.shift()!
        state.hadSteer = true
        messages = [
          ...messages,
          {
            role: 'system',
            content: `[STEER — New message from user during execution]: ${steerMsg}`,
          },
        ]
        this.emit({
          type: 'interrupt',
          content: `📨 Steer: ${steerMsg.slice(0, 100)}`,
        })
        mutated = true
      }
    }

    // 3. Graceful warning before timeout.
    const turnTimeout = this.config.turnTimeout ?? 1_800_000
    const gracefulWarningMs = this.config.gracefulWarningMs ?? 180_000
    const gracefulThreshold = turnTimeout - gracefulWarningMs
    const elapsed = Date.now() - state.turnStart
    if (!state.gracefulWarningFired && elapsed > gracefulThreshold) {
      state.gracefulWarningFired = true
      const remainingSec = Math.floor((turnTimeout - elapsed) / 1000)
      this.emit({
        type: 'status',
        content: `⏳ Approaching turn timeout — ${remainingSec}s remaining`,
      })
      messages = [
        ...messages,
        {
          role: 'system',
          content:
            `[SYSTEM — Turn Timeout Warning]\n` +
            `You have approximately ${remainingSec} seconds before this turn times out.\n\n` +
            `Wrap up your current work now:\n` +
            `1. Finish or checkpoint your current task\n` +
            `2. Write a summary of what you accomplished and what remains to the appropriate file ` +
            `(AGENT.md, memory notes, or daily log)\n` +
            `3. List clear next steps so you (or another agent) can pick up exactly where you left off\n\n` +
            `Do NOT start new long-running operations. Focus on saving state.`,
        },
      ]
      mutated = true
    }

    // 4. Context-window nudges.
    const contextWindow = this.config.contextWindow ?? 0
    if (contextWindow > 0) {
      const softNudgePcts = this.config.contextConfig?.softNudgePct ?? [40, 70]
      const hardNudgePct = this.config.contextConfig?.hardNudgePct ?? 90

      // Token estimate: provider-reported when available, else chars/4.
      const currentTokens =
        state.lastKnownPromptTokens > 0
          ? state.lastKnownPromptTokens
          : estimateTokens(this.aiSdkToRivetosMessages(messages))
      const tokenSource = state.lastKnownPromptTokens > 0 ? 'provider' : 'estimate'
      const pct = Math.floor((currentTokens / contextWindow) * 100)

      if (pct >= hardNudgePct && !state.nudgesFired.includes(hardNudgePct)) {
        state.nudgesFired.push(hardNudgePct)
        messages = [
          ...messages,
          {
            role: 'system',
            content:
              `[SYSTEM — Context Management — REQUIRED]\n` +
              `Your context is at ${pct}% capacity (~${currentTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens, ${tokenSource}). ` +
              `You must free up space before continuing.\n\n` +
              `Use \`compact_context\` to summarize or remove the least critical material. Focus on:\n` +
              `- Completed tasks and their verbose tool output\n` +
              `- Resolved discussion threads\n` +
              `- Exploratory paths that were abandoned\n\n` +
              `Preserve: active work context, recent decisions, anything referenced in the current task.`,
          },
        ]
        mutated = true
      } else {
        for (const nudgePct of softNudgePcts) {
          if (pct >= nudgePct && !state.nudgesFired.includes(nudgePct)) {
            state.nudgesFired.push(nudgePct)
            const urgency =
              nudgePct >= 70
                ? 'You should review your conversation history and use `compact_context` to replace resolved topics with brief summaries. If everything is genuinely still needed, carry on.'
                : 'If there are completed tasks or stale tool output you no longer need, consider using `compact_context` to summarize them. Otherwise, carry on.'
            messages = [
              ...messages,
              {
                role: 'system',
                content:
                  `[SYSTEM — Context Management]\n` +
                  `Your session context is at ${pct}% (~${currentTokens.toLocaleString()} tokens of ${contextWindow.toLocaleString()} window, ${tokenSource}).\n\n` +
                  urgency,
              },
            ]
            mutated = true
          }
        }
      }
    }

    return mutated ? { messages } : undefined
  }

  // -----------------------------------------------------------------------
  // onStepFinish — runs after each LLM call
  // -----------------------------------------------------------------------

  private handleStepFinish(
    stepResult: StepResult<ToolSet>,
    state: TurnState,
    bridge: ProviderAiSdkBridge,
    options: ChatOptions,
  ): void {
    // 1. Iteration count + tool tracking.
    if (stepResult.toolCalls.length > 0) {
      state.iterations++
      for (const tc of stepResult.toolCalls) {
        state.toolsUsed.push(tc.toolName)
      }
    }

    // 2. Usage accumulation (max-merge to mirror legacy semantics).
    const u = stepResult.usage
    const promptTokens = u.inputTokens ?? 0
    const completionTokens = u.outputTokens ?? 0
    state.totalUsage.promptTokens = Math.max(state.totalUsage.promptTokens, promptTokens)
    state.totalUsage.completionTokens = Math.max(
      state.totalUsage.completionTokens,
      completionTokens,
    )
    const reasoningTokens = u.outputTokenDetails.reasoningTokens
    if (reasoningTokens) {
      state.totalUsage.reasoningTokens = reasoningTokens
    }
    const cacheReadTokens = u.inputTokenDetails.cacheReadTokens
    if (cacheReadTokens) {
      state.totalUsage.cachedTokens = cacheReadTokens
    }
    if (promptTokens > 0) state.lastKnownPromptTokens = promptTokens

    // 3. Bridge per-step capture (e.g. xAI previousResponseId).
    bridge.captureStepResult?.(stepResult, options)

    // 4. Heartbeat (every 147s).
    if (Date.now() - state.lastProgressEmit > 147_000) {
      state.heartbeatCount++
      const elapsedSec = Math.floor((Date.now() - state.turnStart) / 1000)
      this.emit({
        type: 'status',
        content: `⏳ Still working... (${state.iterations} tool calls, ${elapsedSec}s, heartbeat #${state.heartbeatCount})`,
      })
      state.lastProgressEmit = Date.now()
    }
  }

  // -----------------------------------------------------------------------
  // compact_context tool
  // -----------------------------------------------------------------------

  private buildCompactContextTool(state: TurnState): ToolSet[string] {
    const validate = this.validateCompaction.bind(this)
    return tool({
      description:
        'Summarize and compact conversation history to free context window space. ' +
        'Provide ranges of messages to replace with summaries. ' +
        'Message indices are 0-based positions in the conversation history ' +
        '(index 0 = first user or assistant message; system messages are excluded from indexing).',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          replacements: {
            type: 'array',
            description: 'Message ranges to replace with summaries',
            items: {
              type: 'object',
              properties: {
                start_index: {
                  type: 'number',
                  description: 'Start index in conversation history (0-based, inclusive)',
                },
                end_index: {
                  type: 'number',
                  description: 'End index in conversation history (0-based, inclusive)',
                },
                summary: {
                  type: 'string',
                  description:
                    'Brief summary replacing these messages. Include key decisions, ' +
                    'outcomes, and any information still relevant.',
                },
              },
              required: ['start_index', 'end_index', 'summary'],
            },
          },
        },
        required: ['replacements'],
      }),
      execute: (input, options) => {
        const args = (input ?? {}) as Record<string, unknown>
        const validation = validate(args, options.messages)
        if (typeof validation === 'string') {
          this.emit({
            type: 'tool_result',
            content: `❌ compact_context: ${validation.slice(0, 200)}`,
          })
          return validation
        }
        // Stash for deferred application — most recent call wins.
        state.pendingCompaction = validation
        const totalToRemove = validation.reduce(
          (sum, r) => sum + (r.end_index - r.start_index + 1),
          0,
        )
        const result =
          `Compaction queued: ${totalToRemove} messages will be compacted into ` +
          `${validation.length} summar${validation.length === 1 ? 'y' : 'ies'} at end of step.`
        this.emit({
          type: 'tool_result',
          content: `✅ compact_context: ${result}`,
        })
        return result
      },
    })
  }

  /**
   * Validate compact_context arguments. Indices are 0-based over the inline
   * messages array (system prompt lives in streamText's `system` param, not in
   * messages, so the user's mental "message 0" matches messages[0] cleanly).
   * Leading injected system messages (steer/nudges) are still indexable.
   */
  private validateCompaction(
    args: Record<string, unknown>,
    messages: ModelMessage[],
  ): CompactionRequest[] | string {
    const replacements = args.replacements as
      | Array<{ start_index: number; end_index: number; summary: string }>
      | undefined

    if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
      return 'Error: replacements array is required and must not be empty'
    }

    const maxIndex = messages.length - 1

    for (const r of replacements) {
      if (
        typeof r.start_index !== 'number' ||
        typeof r.end_index !== 'number' ||
        typeof r.summary !== 'string'
      ) {
        return 'Error: each replacement must have start_index (number), end_index (number), summary (string)'
      }
      if (r.start_index < 0 || r.end_index < r.start_index || r.end_index > maxIndex) {
        return `Error: invalid range [${r.start_index}, ${r.end_index}] — valid range is [0, ${maxIndex}]`
      }
    }

    const sorted = [...replacements].sort((a, b) => a.start_index - b.start_index)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_index <= sorted[i - 1].end_index) {
        return `Error: overlapping ranges at [${sorted[i - 1].start_index}, ${sorted[i - 1].end_index}] and [${sorted[i].start_index}, ${sorted[i].end_index}]`
      }
    }

    return replacements
  }

  /**
   * Apply pending compaction to a ModelMessage[] array. Returns a NEW array;
   * does not mutate input. Indices are descending so splice doesn't shift.
   */
  private applyCompaction(
    messages: ModelMessage[],
    replacements: CompactionRequest[],
  ): ModelMessage[] {
    const out = [...messages]
    const sorted = [...replacements].sort((a, b) => a.start_index - b.start_index)
    const descending = [...sorted].reverse()
    for (const r of descending) {
      const removeCount = r.end_index - r.start_index + 1
      out.splice(r.start_index, removeCount, {
        role: 'system',
        content: `[Compacted Context] ${r.summary}`,
      })
    }
    return out
  }

  /**
   * Sync compacted message state back to the session via onCompact callback.
   * Translates AI SDK ModelMessage[] → RivetOS Message[] for the session store.
   */
  private syncCompactedSession(messages: ModelMessage[]): void {
    if (!this.config.onCompact) return
    this.config.onCompact(this.aiSdkToRivetosMessages(messages))
  }

  /**
   * Convert AI SDK ModelMessage[] → RivetOS Message[] (lossy in spots, but
   * sufficient for session persistence). Used by the onCompact callback and
   * by the chars/4 token estimator.
   */
  private aiSdkToRivetosMessages(messages: ModelMessage[]): Message[] {
    const out: Message[] = []
    for (const m of messages) {
      if (m.role === 'system' || m.role === 'user') {
        const content =
          typeof m.content === 'string'
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('')
        out.push({ role: m.role, content })
      } else if (m.role === 'assistant') {
        if (typeof m.content === 'string') {
          out.push({ role: 'assistant', content: m.content })
        } else {
          let text = ''
          const toolCalls: ToolCall[] = []
          for (const part of m.content as Array<Record<string, unknown>>) {
            if (part.type === 'text' && typeof part.text === 'string') {
              text += part.text
            } else if (part.type === 'tool-call') {
              toolCalls.push({
                id: typeof part.toolCallId === 'string' ? part.toolCallId : '',
                name: typeof part.toolName === 'string' ? part.toolName : '',
                arguments: (part.input ?? {}) as Record<string, unknown>,
              })
            }
          }
          out.push({
            role: 'assistant',
            content: text,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          })
        }
      } else {
        // role === 'tool' — each ToolResultPart becomes one tool message.
        const parts = m.content as Array<Record<string, unknown>>
        for (const p of parts) {
          const callId = typeof p.toolCallId === 'string' ? p.toolCallId : ''
          const output = p.output as { type?: string; value?: unknown } | undefined
          let content: string = ''
          if (output && typeof output === 'object') {
            if (output.type === 'text' && typeof output.value === 'string') {
              content = output.value
            } else {
              content = JSON.stringify(output.value ?? '')
            }
          }
          out.push({ role: 'tool', content, toolCallId: callId })
        }
      }
    }
    return out
  }

  // -----------------------------------------------------------------------
  // Image archival — fire-and-forget wrapper around tool execute
  // -----------------------------------------------------------------------

  private wrapToolsForImages(set: ToolSet, defs: Tool[]): ToolSet {
    if (!this.hasImageProducingTools(defs)) return set
    const wrapped: ToolSet = {}
    for (const [name, t] of Object.entries(set)) {
      const original = t.execute
      if (typeof original !== 'function') {
        wrapped[name] = t
        continue
      }
      wrapped[name] = {
        ...t,
        execute: async (input: unknown, opts: never) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const result = await original(input as never, opts)
          // Fire-and-forget archival — never block the loop.
          this.archiveImagesIfAny(result).catch(() => {
            /* archival failures are non-fatal */
          })
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return result
        },
      } as ToolSet[string]
    }
    return wrapped
  }

  private hasImageProducingTools(_defs: Tool[]): boolean {
    // We can't statically know which tools return images. Always wrap; the
    // wrapper short-circuits on string results so the cost is negligible.
    return true
  }

  private async archiveImagesIfAny(result: unknown): Promise<void> {
    if (!result || typeof result === 'string') return
    if (!toolResultHasImages(result as never)) return
    const images = getToolResultImages(result as never)
    if (images.length === 0) return

    const imageDir = this.config.imageDir ?? join(process.cwd(), '.data', 'images')
    await mkdir(imageDir, { recursive: true })

    for (const img of images) {
      const ext = (img.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg')
      const fileName = `tool-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
      const filePath = join(imageDir, fileName)

      if (img.data) {
        await writeFile(filePath, Buffer.from(img.data, 'base64'))
      } else if (img.url) {
        try {
          const res = await fetch(img.url)
          if (res.ok) {
            await writeFile(filePath, Buffer.from(await res.arrayBuffer()))
          }
        } catch {
          // skip
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // StreamEvent emission helpers
  // -----------------------------------------------------------------------

  private emit(event: StreamEvent): void {
    this.config.onStream?.(event)
  }

  private mergeUsageFromAcc(acc: AiSdkChunkAccumulator, state: TurnState): void {
    state.totalUsage.promptTokens = Math.max(state.totalUsage.promptTokens, acc.usage.promptTokens)
    state.totalUsage.completionTokens = Math.max(
      state.totalUsage.completionTokens,
      acc.usage.completionTokens,
    )
    if (acc.usage.reasoningTokens) {
      state.totalUsage.reasoningTokens = acc.usage.reasoningTokens
    }
    if (acc.usage.cachedTokens) {
      state.totalUsage.cachedTokens = acc.usage.cachedTokens
    }
    if (acc.usage.promptTokens > 0) {
      state.lastKnownPromptTokens = acc.usage.promptTokens
    }
  }
}
