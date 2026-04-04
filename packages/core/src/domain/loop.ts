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
import { getToolResultText, toolResultHasImages, getToolResultImages } from '@rivetos/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  maxIterations?: number
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
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private config: AgentLoopConfig
  private maxIterations: number
  private steerQueue: string[] = []

  constructor(config: AgentLoopConfig) {
    this.config = config
    this.maxIterations = config.maxIterations ?? 15
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

    const toolsUsed: string[] = []
    let iterations = 0
    const totalUsage = { promptTokens: 0, completionTokens: 0 }
    let partialResponse = ''
    let lastError = ''

    const hardCap = this.maxIterations * 5 // Safety cap (default: 75)

    while (iterations < hardCap) {
      if (signal?.aborted) {
        return {
          response: '',
          toolsUsed,
          iterations,
          aborted: true,
          partialResponse,
          usage: totalUsage,
        }
      }

      // Check steer queue
      const steerMsg = this.steerQueue.shift()
      if (steerMsg) {
        messages.push({
          role: 'system',
          content: `[STEER — New message from user during execution]: ${steerMsg}`,
        })
        this.emit({ type: 'interrupt', content: `📨 Steer: ${steerMsg.slice(0, 100)}` })
      }

      // Stream from provider
      const options: ChatOptions = {
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        signal,
        thinking: this.config.thinking,
      }

      // --- Hook: provider:before ---
      let activeProvider = this.config.provider
      if (this.config.hooks) {
        const beforeCtx: ProviderBeforeContext = {
          event: 'provider:before',
          providerId: activeProvider.id,
          model:
            ((activeProvider as Record<string, unknown>).model as string | undefined) ?? 'unknown',
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
          }
        }

        // --- Hook: provider:error (fallback chain) ---
        if (this.config.hooks) {
          const errObj = err as Record<string, unknown>
          const errMsg = typeof errObj.message === 'string' ? errObj.message : ''
          const statusCode =
            (errObj.status as number | undefined) ??
            (errObj.statusCode as number | undefined) ??
            (errMsg.includes('429') ? 429 : undefined)
          const errorCtx: ProviderErrorContext = {
            event: 'provider:error',
            providerId: activeProvider.id,
            model:
              ((activeProvider as Record<string, unknown>).model as string | undefined) ??
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
              this.emit({
                type: 'status',
                content: `⚡ Falling back: ${activeProvider.id} → ${errorCtx.retry.providerId}:${errorCtx.retry.model}`,
              })
              activeProvider = fallbackProvider // eslint-disable-line no-useless-assignment
              continue // Retry the while loop with the new provider
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
            ((activeProvider as Record<string, unknown>).model as string | undefined) ?? 'unknown',
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
          }
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

      // Progress update every maxIterations
      if (iterations > 0 && iterations % this.maxIterations === 0) {
        this.emit({
          type: 'status',
          content: `⏳ Still working... (${iterations} tool calls so far: ${[...new Set(toolsUsed)].join(', ')})`,
        })
      }
    }

    // Hard cap reached — safety stop
    // Preserve any partial text the model has produced so the streaming message
    // isn't overwritten with a generic boilerplate string.
    const capNotice = `\n\n⚠️ _Safety cap reached (${iterations} tool iterations). Let me know if you want me to continue._`
    this.emit({ type: 'status', content: `⚠️ Safety cap reached (${iterations} tool iterations)` })
    return {
      response: partialResponse ? partialResponse.trim() + capNotice : capNotice.trim(),
      toolsUsed,
      iterations,
      aborted: false,
      partialResponse,
      usage: totalUsage,
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
