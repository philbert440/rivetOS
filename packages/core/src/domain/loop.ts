/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * Agent Loop — the core execution cycle.
 *
 * Consumes a streaming provider (AsyncIterable<LLMChunk>).
 * Supports: abort (/stop, /interrupt), steer, thinking levels,
 * tool iteration limits, and stream events.
 *
 * Pure domain logic. No I/O. Works with interfaces only.
 */

import type {
  Message,
  ContentPart,
  Provider,
  Tool,
  ToolDefinition,
  ToolCall,
  ToolResult,
  StreamEvent,
  StreamHandler,
  ChatOptions,
  ThinkingLevel,
  HookPipeline,
  ProviderBeforeContext,
  ProviderAfterContext,
  ProviderErrorContext,
  ToolBeforeContext,
  ToolAfterContext,
} from '@rivetos/types'
import {
  getToolResultText,
  toolResultHasImages,
  getToolResultImages,
  ProviderError,
} from '@rivetos/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { estimateTokens } from './tokens.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  systemPrompt: string
  tools: Tool[]
  provider: Provider
  thinking?: ThinkingLevel
  onStream?: StreamHandler
  /** Agent ID — passed to tools via ToolContext */
  agentId?: string
  /** Directory to save tool-produced images (default: .data/images in cwd) */
  imageDir?: string
  /** Hook pipeline for lifecycle events (optional — loop works without it) */
  hooks?: HookPipeline
  /** Session ID for hook context */
  sessionId?: string
  /** Resolve a provider by ID (for fallback chains) */
  resolveProvider?: (providerId: string) => Provider | undefined
  /** Turn wall-clock timeout in ms (default: 600_000 = 10 min) */
  turnTimeout?: number
  /** Context window size in tokens (from provider, 0 = unknown) */
  contextWindow?: number
  /** Context management thresholds */
  contextConfig?: { softNudgePct?: number[]; hardNudgePct?: number }
  /** Callback to sync compacted history back to the session */
  onCompact?: (compactedHistory: Message[]) => void
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
    const messages: Message[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ]

    const toolDefs: ToolDefinition[] = this.config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    // Add compact_context as a built-in tool (always available)
    toolDefs.push({
      name: 'compact_context',
      description:
        'Summarize and compact conversation history to free context window space. ' +
        'Provide ranges of messages to replace with summaries. ' +
        'Message indices are 0-based positions in the conversation history (excludes system prompt).',
      parameters: {
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
      },
    })

    const toolsUsed: string[] = []
    let iterations = 0
    const totalUsage = { promptTokens: 0, completionTokens: 0 }
    let partialResponse = ''
    let lastError = ''
    let hadSteer = false

    // Turn timeout replaces maxIterations hard cap
    const turnStart = Date.now()
    const turnTimeout = this.config.turnTimeout ?? 600_000
    let lastProgressEmit = Date.now()
    let heartbeatCount = 0

    // Context window management
    const contextWindow = this.config.contextWindow ?? 0
    const softNudgePcts = this.config.contextConfig?.softNudgePct ?? [40, 70]
    const hardNudgePct = this.config.contextConfig?.hardNudgePct ?? 90
    const nudgesFired = new Set<number>()

    let activeModelOverride: string | undefined
    let activeProvider = this.config.provider

    while (true) {
      if (signal?.aborted) {
        return {
          response: '',
          toolsUsed,
          iterations,
          aborted: true,
          partialResponse,
          usage: totalUsage,
          hadSteer,
        }
      }

      // Turn timeout — wall-clock safety cap
      if (Date.now() - turnStart > turnTimeout) {
        this.emit({
          type: 'status',
          content: `⚠️ Turn timeout (${Math.floor(turnTimeout / 1000)}s)`,
        })
        const capNotice =
          '\n\n⚠️ _Turn timed out. Let me know if you want me to continue._'
        return {
          response: partialResponse
            ? partialResponse.trim() + capNotice
            : capNotice.trim(),
          toolsUsed,
          iterations,
          aborted: false,
          usage: totalUsage,
          hadSteer,
        }
      }

      // Check steer queue
      const steerMsg = this.steerQueue.shift()
      if (steerMsg) {
        hadSteer = true
        messages.push({
          role: 'system',
          content: `[STEER — New message from user during execution]: ${steerMsg}`,
        })
        this.emit({ type: 'interrupt', content: `📨 Steer: ${steerMsg.slice(0, 100)}` })
      }

      // --- Context window nudges ---
      if (contextWindow > 0) {
        const currentTokens = estimateTokens(messages)
        const pct = Math.floor((currentTokens / contextWindow) * 100)

        if (pct >= hardNudgePct && !nudgesFired.has(hardNudgePct)) {
          nudgesFired.add(hardNudgePct)
          messages.push({
            role: 'system',
            content:
              `[SYSTEM — Context Management — REQUIRED]\n` +
              `Your context is at ${pct}% capacity (~${currentTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens). ` +
              `You must free up space before continuing.\n\n` +
              `Use \`compact_context\` to summarize or remove the least critical material. Focus on:\n` +
              `- Completed tasks and their verbose tool output\n` +
              `- Resolved discussion threads\n` +
              `- Exploratory paths that were abandoned\n\n` +
              `Preserve: active work context, recent decisions, anything referenced in the current task.`,
          })
        } else {
          for (const nudgePct of softNudgePcts) {
            if (pct >= nudgePct && !nudgesFired.has(nudgePct)) {
              nudgesFired.add(nudgePct)
              const urgency =
                nudgePct >= 70
                  ? 'You should review your conversation history and use `compact_context` to replace resolved topics with brief summaries. If everything is genuinely still needed, carry on.'
                  : 'If there are completed tasks or stale tool output you no longer need, consider using `compact_context` to summarize them. Otherwise, carry on.'
              messages.push({
                role: 'system',
                content:
                  `[SYSTEM — Context Management]\n` +
                  `Your session context is at ${pct}% (~${currentTokens.toLocaleString()} tokens of ${contextWindow.toLocaleString()} window).\n\n` +
                  urgency,
              })
            }
          }
        }
      }

      // Stream from provider
      const options: ChatOptions = {
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        signal,
        thinking: this.config.thinking,
        modelOverride: activeModelOverride,
      }

      // --- Hook: provider:before ---
      if (this.config.hooks) {
        const beforeCtx: ProviderBeforeContext = {
          event: 'provider:before',
          providerId: activeProvider.id,
          model:
            ((activeProvider as unknown as Record<string, unknown>).model as string | undefined) ??
            'unknown',
          messages: messages as unknown[],
          tools: toolDefs as unknown[],
          agentId: this.config.agentId,
          sessionId: this.config.sessionId,
          timestamp: Date.now(),
          metadata: {},
        }
        const beforeResult = await this.config.hooks.run(beforeCtx)
        if (beforeResult.aborted || beforeCtx.skip) {
          // Hook said skip this provider — return empty (fallback will handle via provider:error)
          return {
            response: '',
            toolsUsed,
            iterations,
            aborted: true,
            partialResponse,
            usage: totalUsage,
            hadSteer,
          }
        }
      }

      let textContent = ''
      let _reasoningContent = ''
      const pendingToolCalls: Map<number, ToolCall> = new Map()
      const argsDelta: Map<number, string> = new Map()
      let hasToolCalls = false
      const streamStartTime = Date.now()

      try {
        for await (const chunk of activeProvider.chatStream(messages, options)) {
          // Capture usage from ANY chunk (not just 'done') — prevents lost tracking on abort
          if (chunk.usage) {
            totalUsage.promptTokens = Math.max(totalUsage.promptTokens, chunk.usage.promptTokens)
            totalUsage.completionTokens = Math.max(
              totalUsage.completionTokens,
              chunk.usage.completionTokens,
            )
          }

          if (signal?.aborted) {
            return {
              response: '',
              toolsUsed,
              iterations,
              aborted: true,
              partialResponse: textContent || partialResponse,
              usage: totalUsage,
              hadSteer,
            }
          }

          switch (chunk.type) {
            case 'text':
              if (chunk.delta) {
                textContent += chunk.delta
                this.emit({ type: 'text', content: chunk.delta })
              }
              break

            case 'reasoning':
              if (chunk.delta) {
                _reasoningContent += chunk.delta
                this.emit({ type: 'reasoning', content: chunk.delta })
              }
              break

            case 'tool_call_start':
              if (chunk.toolCall?.index !== undefined) {
                hasToolCalls = true
                pendingToolCalls.set(chunk.toolCall.index, {
                  id: chunk.toolCall.id ?? `tc-${Date.now()}-${chunk.toolCall.index}`,
                  name: chunk.toolCall.name ?? '',
                  arguments: {},
                  thoughtSignature: chunk.toolCall.thoughtSignature,
                })
              }
              break

            case 'tool_call_delta':
              // Arguments stream as JSON string deltas — accumulate
              if (chunk.toolCall?.index !== undefined && chunk.delta) {
                const tc = pendingToolCalls.get(chunk.toolCall.index)
                if (tc) {
                  // Store raw delta, parse when done
                  argsDelta.set(
                    chunk.toolCall.index,
                    (argsDelta.get(chunk.toolCall.index) ?? '') + chunk.delta,
                  )
                }
              }
              break

            case 'tool_call_done':
              if (chunk.toolCall?.index !== undefined) {
                const tc = pendingToolCalls.get(chunk.toolCall.index)
                const rawArgs = argsDelta.get(chunk.toolCall.index)
                if (tc && rawArgs) {
                  try {
                    tc.arguments = JSON.parse(rawArgs)
                  } catch {
                    tc.arguments = { raw: rawArgs }
                  }
                  argsDelta.delete(chunk.toolCall.index)
                }
              }
              break

            case 'done':
              if (chunk.usage) {
                totalUsage.promptTokens += chunk.usage.promptTokens
                totalUsage.completionTokens += chunk.usage.completionTokens
              }
              break

            case 'error':
              lastError = chunk.error ?? 'Unknown provider error'
              this.emit({ type: 'error', content: lastError })
              break
          }
        }
      } catch (err: unknown) {
        if (signal?.aborted) {
          return {
            response: '',
            toolsUsed,
            iterations,
            aborted: true,
            partialResponse: textContent || partialResponse,
            usage: totalUsage,
            hadSteer,
          }
        }

        // --- Hook: provider:error (fallback chain) ---
        if (this.config.hooks) {
          const isProviderError = err instanceof ProviderError
          const statusCode = isProviderError ? err.statusCode : undefined
          const errorProviderId = isProviderError ? err.providerId : activeProvider.id
          const errorCtx: ProviderErrorContext = {
            event: 'provider:error',
            providerId: errorProviderId,
            model:
              activeModelOverride ??
              ((activeProvider as unknown as Record<string, unknown>).model as
                | string
                | undefined) ??
              'unknown',
            error: err instanceof Error ? err : new Error(String(err)),
            statusCode,
            agentId: this.config.agentId,
            sessionId: this.config.sessionId,
            timestamp: Date.now(),
            metadata: {},
          }
          const _errorResult = await this.config.hooks.run(errorCtx)

          // If a fallback hook set retry info, switch provider and retry this iteration
          if (errorCtx.retry) {
            const fallbackProvider = this.config.resolveProvider?.(errorCtx.retry.providerId)
            if (fallbackProvider) {
              const statusLabel = statusCode ? ` (${statusCode})` : ''
              this.emit({
                type: 'status',
                content: `⚠️ ${errorProviderId}${statusLabel} — falling back to ${errorCtx.retry.providerId}/${errorCtx.retry.model}`,
              })
              activeProvider = fallbackProvider
              activeModelOverride = errorCtx.retry.model
              continue // Retry the while loop with the new provider/model
            }
          }
        }

        throw err
      }

      // --- Hook: provider:after ---
      if (this.config.hooks) {
        const afterCtx: ProviderAfterContext = {
          event: 'provider:after',
          providerId: activeProvider.id,
          model:
            ((activeProvider as unknown as Record<string, unknown>).model as string | undefined) ??
            'unknown',
          usage: { ...totalUsage },
          latencyMs: Date.now() - streamStartTime,
          hasToolCalls,
          agentId: this.config.agentId,
          sessionId: this.config.sessionId,
          timestamp: Date.now(),
          metadata: {},
        }
        await this.config.hooks.run(afterCtx)
      }

      // Text response — done
      if (!hasToolCalls) {
        // If no text was produced but an error occurred, surface the error
        // so the user doesn't get a blank message
        const finalResponse = textContent.trim() || (lastError ? `⚠️ ${lastError}` : '')
        return {
          response: finalResponse,
          toolsUsed,
          iterations,
          aborted: false,
          usage: totalUsage,
          hadSteer,
        }
      }

      // Tool calls — execute and loop
      const toolCalls = [...pendingToolCalls.values()]

      messages.push({
        role: 'assistant',
        content: textContent,
        toolCalls,
      })

      for (const tc of toolCalls) {
        if (signal?.aborted) {
          return {
            response: '',
            toolsUsed,
            iterations,
            aborted: true,
            partialResponse: textContent,
            usage: totalUsage,
            hadSteer,
          }
        }

        // --- Built-in: compact_context ---
        if (tc.name === 'compact_context') {
          toolsUsed.push(tc.name)
          this.emit({
            type: 'tool_start',
            content: `🔧 compact_context`,
            metadata: { args: this.summarizeArgs(tc.arguments) },
          })
          const compactResult = this.executeCompactContext(tc.arguments, messages, nudgesFired)
          const isError = compactResult.startsWith('Error')
          this.emit({
            type: 'tool_result',
            content: `${isError ? '❌' : '✅'} compact_context: ${compactResult.slice(0, 200)}`,
          })
          messages.push({ role: 'tool', content: compactResult, toolCallId: tc.id })
          continue
        }

        const tool = this.config.tools.find((t) => t.name === tc.name)
        toolsUsed.push(tc.name)

        // --- Hook: tool:before ---
        if (this.config.hooks) {
          const toolBeforeCtx: ToolBeforeContext = {
            event: 'tool:before',
            toolName: tc.name,
            args: { ...tc.arguments },
            agentId: this.config.agentId,
            sessionId: this.config.sessionId,
            timestamp: Date.now(),
            metadata: {},
          }
          const _toolBeforeResult = await this.config.hooks.run(toolBeforeCtx)

          if (toolBeforeCtx.blocked) {
            // Tool was blocked by a safety hook
            const blockMsg = toolBeforeCtx.blockReason ?? 'Blocked by safety hook'
            this.emit({ type: 'tool_result', content: `🚫 ${tc.name}: ${blockMsg}` })
            messages.push({ role: 'tool', content: `Blocked: ${blockMsg}`, toolCallId: tc.id })
            continue
          }

          // Hooks may have modified args
          tc.arguments = toolBeforeCtx.args
        }

        this.emit({
          type: 'tool_start',
          content: `🔧 ${tc.name}`,
          metadata: { args: this.summarizeArgs(tc.arguments) },
        })

        const toolStartTime = Date.now()
        let rawResult: ToolResult
        if (!tool) {
          rawResult = `Error: Unknown tool "${tc.name}"`
        } else {
          try {
            rawResult = await tool.execute(tc.arguments, signal, { agentId: this.config.agentId })
          } catch (err: unknown) {
            rawResult = `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        // --- Hook: tool:after ---
        if (this.config.hooks) {
          const resultText = getToolResultText(rawResult)
          const toolAfterCtx: ToolAfterContext = {
            event: 'tool:after',
            toolName: tc.name,
            args: tc.arguments,
            result: rawResult,
            durationMs: Date.now() - toolStartTime,
            isError: resultText.startsWith('Error'),
            agentId: this.config.agentId,
            sessionId: this.config.sessionId,
            timestamp: Date.now(),
            metadata: {},
          }
          await this.config.hooks.run(toolAfterCtx)
        }

        // Process tool result — handle multimodal (images)
        const resultText = getToolResultText(rawResult)
        const isError = resultText.startsWith('Error')

        this.emit({
          type: 'tool_result',
          content: `${isError ? '❌' : '✅'} ${tc.name}: ${resultText.slice(0, 200)}`,
        })

        // If tool returned images, save them to disk and build multimodal message
        if (toolResultHasImages(rawResult)) {
          const images = getToolResultImages(rawResult)
          const contentParts: ContentPart[] = []
          const savedPaths: string[] = []

          // Add text part if present
          if (resultText) {
            contentParts.push({ type: 'text', text: resultText })
          }

          // Save each image and add to content
          for (const img of images) {
            const imageDir = this.config.imageDir ?? join(process.cwd(), '.data', 'images')
            await mkdir(imageDir, { recursive: true })
            const ext = (img.mimeType?.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg')
            const fileName = `tool-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
            const filePath = join(imageDir, fileName)

            if (img.data) {
              await writeFile(filePath, Buffer.from(img.data, 'base64'))
              savedPaths.push(filePath)
              contentParts.push({
                type: 'image',
                data: img.data,
                mimeType: img.mimeType ?? 'image/jpeg',
              })
            } else if (img.url) {
              // Download and save
              try {
                const imgRes = await fetch(img.url)
                if (imgRes.ok) {
                  const buf = Buffer.from(await imgRes.arrayBuffer())
                  await writeFile(filePath, buf)
                  savedPaths.push(filePath)
                  const b64 = buf.toString('base64')
                  contentParts.push({
                    type: 'image',
                    data: b64,
                    mimeType: img.mimeType ?? 'image/jpeg',
                  })
                }
              } catch {
                // Skip failed image downloads
              }
            }
          }

          // Send multimodal content to provider for this turn,
          // but store [image:path] references in the message for history
          messages.push({ role: 'tool', content: contentParts, toolCallId: tc.id })
        } else {
          // Plain text result
          messages.push({
            role: 'tool',
            content: typeof rawResult === 'string' ? rawResult : resultText,
            toolCallId: tc.id,
          })
        }
      }

      partialResponse = textContent
      iterations++

      // Time-based progress heartbeat (every 147s)
      if (Date.now() - lastProgressEmit > 147_000) {
        heartbeatCount++
        this.emit({
          type: 'status',
          content: `⏳ Still working... (${iterations} tool calls, ${Math.floor((Date.now() - turnStart) / 1000)}s, heartbeat #${heartbeatCount})`,
        })
        lastProgressEmit = Date.now()
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emit(event: StreamEvent): void {
    this.config.onStream?.(event)
  }

  private summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        summary[key] = value.slice(0, 200) + '…'
      } else {
        summary[key] = value
      }
    }
    return summary
  }
}
