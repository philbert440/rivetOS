/**
 * ClaudeCliModel — custom `LanguageModelV3` implementation that wraps the
 * local `claude` binary (Claude Code CLI) as an AI SDK model.
 *
 * Inversion: instead of RivetOS driving claude as a chunk-yielding provider,
 * the AI SDK loop drives this model via `streamText`. Each `doStream()` call:
 *
 *   1. Renders the AI SDK prompt back into the single user-turn string the
 *      CLI accepts via stream-json (system text passed through
 *      --append-system-prompt).
 *   2. Brings up an embedded MCP server exposing every executable RivetOS
 *      tool to the CLI (`--mcp-config`), so claude's internal agent loop
 *      can call them directly via MCP. AI SDK never sees those tool calls.
 *   3. Spawns claude, parses stream-json, emits LanguageModelV3StreamParts
 *      for text/reasoning/finish.
 *
 * Result: claude runs its full multi-step agent loop internally; AI SDK's
 * outer loop completes after a single step (no model-side tool calls to
 * iterate on). This is the "Loop-in-AI-SDK" shape — the CLI owns the loop,
 * AI SDK owns the providerOptions / hook middleware / streaming surface.
 *
 * Constraint (locked per migration plan): no RivetOS-side max-output-tokens
 * or timeouts. Claude Code owns those; configure via SSH / claude config.
 * We forward AI SDK's `abortSignal` so the loop can still kill the spawn
 * when the user stops a turn or the outer turn-timeout fires.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import type { Tool } from '@rivetos/types'
import { embedMcpServerForTurn, type EmbeddedMcpHandle } from './mcp-bridge.js'
import {
  buildArgs,
  spawnClaudeTurn,
  type ClaudeCliEffort,
  type CliContentBlock,
  type CliResult,
  type CliStreamEvent,
  type CliSystemInit,
} from './spawn-turn.js'
import type { BridgeLogger } from './log.js'
import { createLogger } from './log.js'

// Spawn / flag-assembly / stream-json layer lives in spawn-turn.ts (shared
// with the ClaudeCliExecutor). Re-export the types this module historically
// owned so existing importers keep working.
export type { ClaudeCliEffort, CliContentBlock, CliImageSource } from './spawn-turn.js'

export interface ClaudeCliModelConfig {
  /** Provider id used for AI SDK error attribution. */
  providerId: string
  /** Resolved model identifier passed via --model (empty = CLI default). */
  modelId: string
  /** Path to the `claude` binary. */
  binary: string
  /** Built-in tool list passed via --tools ('default' = all, '' = none). */
  toolsArg: string
  /** Default reasoning effort (overridable per-call via providerOptions). */
  effort: ClaudeCliEffort
  /** Permission mode passed via --permission-mode. */
  permissionMode: string
  /** When true, append --exclude-dynamic-system-prompt-sections. */
  excludeDynamicSections: boolean
  /** When true, fold system text into --append-system-prompt. */
  appendSystemPrompt: boolean
  /** Working directory for the spawned process. */
  cwd: string | undefined
  /** Live executable tools to expose via embedded MCP bridge (loop-supplied). */
  tools: Tool[] | undefined
  /** Logical agent id — labels MCP tempfiles + log lines. */
  agentId: string | undefined
}

// ---------------------------------------------------------------------------
// Helpers — render AI SDK prompt back to CLI-friendly content blocks
// ---------------------------------------------------------------------------

function systemFromMessage(msg: LanguageModelV3Message): string | null {
  if (msg.role !== 'system') return null
  return msg.content
}

/**
 * Convert an AI SDK `file` part with an `image/*` mediaType into an
 * Anthropic image block. Returns `null` for non-image media types so the
 * caller can fall back to a text placeholder (Claude only accepts images
 * via this channel — PDFs etc. would be rejected).
 */
function fileToImageBlock(p: {
  data: Uint8Array | string | URL
  mediaType: string
}): CliContentBlock | null {
  if (!p.mediaType.startsWith('image/')) return null
  if (p.data instanceof URL) {
    return { type: 'image', source: { type: 'url', url: p.data.toString() } }
  }
  const data = typeof p.data === 'string' ? p.data : Buffer.from(p.data).toString('base64')
  return {
    type: 'image',
    source: { type: 'base64', media_type: p.mediaType, data },
  }
}

/**
 * Render the user-message parts into an array of content blocks.
 * Text parts are joined into the lead text block; image file parts become
 * image blocks; non-image file parts degrade to a `[file: <mediaType>]`
 * text placeholder (same shape as the pre-image-support behavior).
 */
function userMessageToBlocks(msg: LanguageModelV3Message): CliContentBlock[] {
  if (msg.role !== 'user') return []
  const blocks: CliContentBlock[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.length > 0) {
      blocks.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }
  for (const p of msg.content) {
    if (p.type === 'text') {
      buffer += (buffer.length > 0 ? '\n' : '') + p.text
      continue
    }
    // file part
    const img = fileToImageBlock(p)
    if (img) {
      flush()
      blocks.push(img)
    } else {
      buffer += (buffer.length > 0 ? '\n' : '') + `[file: ${p.mediaType}]`
    }
  }
  flush()
  return blocks
}

function assistantTextFromMessage(msg: LanguageModelV3Message): {
  text: string
  toolCalls: Array<{ name: string; input: unknown }>
} | null {
  if (msg.role !== 'assistant') return null
  const text = msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
  const toolCalls = msg.content
    .filter(
      (p): p is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } =>
        p.type === 'tool-call',
    )
    .map((p) => ({ name: p.toolName, input: p.input }))
  return { text, toolCalls }
}

function toolResultsFromMessage(msg: LanguageModelV3Message): string | null {
  if (msg.role !== 'tool') return null
  const lines: string[] = []
  for (const part of msg.content) {
    if (part.type !== 'tool-result') continue
    const out = part.output
    let text = ''
    if (out.type === 'text') text = out.value
    else if (out.type === 'json') text = JSON.stringify(out.value)
    else if (out.type === 'error-text') text = out.value
    else if (out.type === 'error-json') text = JSON.stringify(out.value)
    else if (out.type === 'content') {
      text = out.value.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
    }
    lines.push(`TOOL RESULT (${part.toolCallId}):\n${text}`)
  }
  return lines.length > 0 ? lines.join('\n\n') : null
}

/**
 * Render an AI SDK prompt into the single user-turn content the CLI accepts
 * via stream-json, plus a separate system-text block for --append-system-prompt.
 *
 * Returns a content-block array: text turns (USER / ASSISTANT / TOOL RESULT
 * sections) are folded into text blocks with `\n\n---\n\n` separators between
 * them, and image file parts from user messages are interleaved as Anthropic
 * image blocks at the position they appear.
 */
export function renderPromptForCli(prompt: LanguageModelV3Prompt): {
  systemText: string
  userContent: CliContentBlock[]
} {
  const systemChunks: string[] = []
  const blocks: CliContentBlock[] = []

  // Buffer text between image-block emissions so consecutive text turns
  // get joined with the `---` separator inside one text block.
  let buffer = ''
  const SEP = '\n\n---\n\n'
  const pushText = (s: string): void => {
    if (!s) return
    buffer += (buffer.length > 0 ? SEP : '') + s
  }
  const flushText = (): void => {
    if (buffer.length > 0) {
      blocks.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }

  for (const msg of prompt) {
    const sys = systemFromMessage(msg)
    if (sys !== null) {
      systemChunks.push(sys)
      continue
    }
    if (msg.role === 'user') {
      const userBlocks = userMessageToBlocks(msg)
      // Prepend the USER: header to the first text block (or as its own
      // text block if the user message leads with an image).
      let headerEmitted = false
      for (const b of userBlocks) {
        if (b.type === 'text') {
          pushText(headerEmitted ? b.text : `USER:\n${b.text}`)
          headerEmitted = true
        } else {
          if (!headerEmitted) {
            pushText('USER:')
            headerEmitted = true
          }
          flushText()
          blocks.push(b)
        }
      }
      continue
    }
    const asst = assistantTextFromMessage(msg)
    if (asst !== null) {
      if (asst.text) pushText(`ASSISTANT:\n${asst.text}`)
      if (asst.toolCalls.length > 0) {
        const calls = asst.toolCalls
          .map((tc) => `  - ${tc.name}(${JSON.stringify(tc.input)})`)
          .join('\n')
        pushText(`ASSISTANT TOOL CALLS:\n${calls}`)
      }
      continue
    }
    const tr = toolResultsFromMessage(msg)
    if (tr !== null) {
      pushText(tr)
      continue
    }
  }

  flushText()

  return {
    systemText: systemChunks.join('\n\n'),
    userContent: blocks,
  }
}

/**
 * Redact base64 image payloads for logging. Image blocks may carry
 * megabytes of data — keep the shape, drop the bytes.
 */
function redactContentForLog(blocks: CliContentBlock[]): unknown[] {
  return blocks.map((b) => {
    if (b.type === 'text') return b
    if (b.source.type === 'url') return b
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: b.source.media_type,
        data: `[base64 len=${b.source.data.length}]`,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers — providerOptions
// ---------------------------------------------------------------------------

function mapEffortFromProviderOptions(
  providerOptions: LanguageModelV3CallOptions['providerOptions'],
  fallback: ClaudeCliEffort,
): ClaudeCliEffort {
  const claudeCli = providerOptions?.['claude-cli'] as { effort?: unknown } | undefined
  const raw = claudeCli?.effort
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max') {
    return raw
  }
  return fallback
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function buildUsage(raw: {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: raw.input_tokens,
      noCache: raw.input_tokens,
      cacheRead: raw.cache_read_input_tokens,
      cacheWrite: raw.cache_creation_input_tokens,
    },
    outputTokens: {
      total: raw.output_tokens,
      text: raw.output_tokens,
      reasoning: undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// ClaudeCliModel — the LanguageModelV3 implementation
// ---------------------------------------------------------------------------

export class ClaudeCliModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly config: ClaudeCliModelConfig
  private readonly log: BridgeLogger

  constructor(config: ClaudeCliModelConfig) {
    this.provider = config.providerId
    this.modelId = config.modelId || 'default'
    this.config = config
    this.log = createLogger('claude-cli')
  }

  /**
   * Non-streaming generate: simply runs doStream and accumulates. The loop
   * uses streamText (→ doStream) exclusively; this exists only to satisfy
   * the LanguageModelV3 contract.
   */
  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options)
    let text = ''
    let usage: LanguageModelV3Usage | undefined
    let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
      unified: 'stop',
      raw: undefined,
    }
    const reader = result.stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === 'text-delta') text += value.delta
        else if (value.type === 'finish') {
          usage = value.usage
          finishReason = value.finishReason
        } else if (value.type === 'error') {
          throw value.error
        }
      }
    } finally {
      reader.releaseLock()
    }
    return {
      content: text ? [{ type: 'text', text }] : [],
      finishReason,
      usage: usage ?? emptyUsage(),
      request: result.request,
      response: result.response,
      warnings: [],
    }
  }

  /**
   * Streaming generate: spawn claude, wire MCP bridge, stream results back
   * as LanguageModelV3StreamParts.
   */
  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const { systemText, userContent } = renderPromptForCli(options.prompt)
    const effort = mapEffortFromProviderOptions(options.providerOptions, this.config.effort)

    // Bring up the embedded MCP server BEFORE spawning. Soft-fail: if it
    // fails, claude still has its native tools but won't see RivetOS tools
    // this turn. RIVETOS_DISABLE_MCP_BRIDGE=1 also takes this path.
    let bridge: EmbeddedMcpHandle | undefined
    const tools = this.config.tools
    if (tools && tools.length > 0 && process.env.RIVETOS_DISABLE_MCP_BRIDGE !== '1') {
      try {
        bridge = await embedMcpServerForTurn({
          tools,
          agentId: this.config.agentId,
          log: this.log,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log.warn('mcp.bridge.bringup.failed', { error: msg })
      }
    }

    this.log.info('doStream.start', {
      agentId: this.config.agentId,
      toolsCount: tools?.length ?? 0,
      model: this.modelId,
      effort,
      mcpEnabled: !!bridge,
    })

    // Wire stdin: one user turn as stream-json input, then close.
    // `content` is an Anthropic content-block array — text + image blocks
    // (see renderPromptForCli). Falls back to an empty string if the prompt
    // had no user-side parts at all, matching the CLI's accepted shape.
    const cliContent: string | CliContentBlock[] = userContent.length === 0 ? '' : userContent

    const flags = {
      binary: this.config.binary,
      modelId: this.config.modelId,
      toolsArg: this.config.toolsArg,
      effort,
      permissionMode: this.config.permissionMode,
      excludeDynamicSections: this.config.excludeDynamicSections,
      systemText: this.config.appendSystemPrompt ? systemText : '',
      mcpConfigPath: bridge?.configPath,
      cwd: this.config.cwd,
    }

    let turn: ReturnType<typeof spawnClaudeTurn>
    try {
      turn = spawnClaudeTurn(flags, cliContent)
    } catch (err: unknown) {
      if (bridge) await bridge.close().catch(() => undefined)
      const msg = err instanceof Error ? err.message : String(err)
      throw new APICallError({
        message: `Failed to spawn ${this.config.binary}: ${msg}`,
        url: this.config.binary,
        requestBodyValues: { args: buildArgs(flags) },
        isRetryable: false,
      })
    }
    const { proc, args } = turn
    // A single killProc() in `finally` guarantees the child is reaped on every
    // exit path (normal, error, abort, cancel), closing the zombie-on-error gap.
    const killProc = turn.kill

    this.log.info('claude.spawn', {
      pid: proc.pid,
      model: this.modelId,
      hasMcp: !!bridge,
    })

    // Forward AI SDK's abortSignal — kills the spawn if the loop stops the turn.
    const onAbort = () => {
      killProc()
    }
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })

    let bridgeClosed = false
    const closeBridge = async (): Promise<void> => {
      if (bridgeClosed) return
      bridgeClosed = true
      if (bridge) {
        await bridge.close().catch((err: unknown) => {
          this.log.warn('mcp.bridge.teardown.failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }

    const log = this.log
    const providerId = this.provider
    const modelId = this.modelId
    const startedAt = Date.now()

    // Build the stream. Each text-delta gets wrapped in text-start/text-end
    // bracketing the full assistant turn — required by V3 stream contract.
    // Reasoning gets the same start/end treatment.
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        const TEXT_ID = 'claude-text'
        const REASON_ID = 'claude-reasoning'
        let textOpen = false
        let reasoningOpen = false
        let usage: LanguageModelV3Usage | undefined
        let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
          unified: 'stop',
          raw: undefined,
        }
        let sawResult = false
        let streamedAnyText = false
        let fallbackText = ''
        let lastApiKeySource: string | undefined

        controller.enqueue({ type: 'stream-start', warnings: [] })

        try {
          for await (const event of turn.events()) {
            if (event.type === 'system') {
              lastApiKeySource = (event as CliSystemInit).apiKeySource
              log.debug('system.init', { apiKeySource: lastApiKeySource })
              if (lastApiKeySource && lastApiKeySource !== 'none') {
                killProc()
                throw new APICallError({
                  message:
                    `claude-cli: unexpected apiKeySource="${lastApiKeySource}". ` +
                    `This provider requires OAuth/keychain auth. Make sure ` +
                    `ANTHROPIC_API_KEY is not leaking into the child env and ` +
                    `that 'claude login' was completed.`,
                  url: 'claude-cli://stream-json',
                  requestBodyValues: {},
                  statusCode: 401,
                  isRetryable: false,
                })
              }
              continue
            }

            if (event.type === 'stream_event') {
              const inner = (event as CliStreamEvent).event
              if (inner.type === 'content_block_delta' && inner.delta) {
                if (inner.delta.type === 'text_delta' && inner.delta.text) {
                  if (!textOpen) {
                    if (reasoningOpen) {
                      controller.enqueue({ type: 'reasoning-end', id: REASON_ID })
                      reasoningOpen = false
                    }
                    controller.enqueue({ type: 'text-start', id: TEXT_ID })
                    textOpen = true
                  }
                  streamedAnyText = true
                  controller.enqueue({
                    type: 'text-delta',
                    id: TEXT_ID,
                    delta: inner.delta.text,
                  })
                } else if (inner.delta.type === 'thinking_delta' && inner.delta.thinking) {
                  if (!reasoningOpen) {
                    if (textOpen) {
                      controller.enqueue({ type: 'text-end', id: TEXT_ID })
                      textOpen = false
                    }
                    controller.enqueue({ type: 'reasoning-start', id: REASON_ID })
                    reasoningOpen = true
                  }
                  controller.enqueue({
                    type: 'reasoning-delta',
                    id: REASON_ID,
                    delta: inner.delta.thinking,
                  })
                }
              }
              continue
            }

            // Fallback: capture full assistant blocks so result-only turns
            // (no partial deltas) still emit text downstream.
            if (event.type === 'assistant') {
              const assistant = event as unknown as {
                message?: { content?: Array<{ type?: string; text?: string }> }
              }
              const blocks = assistant.message?.content ?? []
              for (const block of blocks) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  fallbackText += block.text
                }
              }
              continue
            }

            if (event.type === 'result') {
              const r = event as CliResult
              sawResult = true
              if (r.usage) {
                usage = buildUsage(r.usage)
              }
              if (r.is_error) {
                throw new APICallError({
                  message: `claude-cli error: ${r.result ?? 'unknown'}`,
                  url: 'claude-cli://stream-json',
                  requestBodyValues: {},
                  statusCode: 500,
                  isRetryable: false,
                })
              }
              if (!streamedAnyText) {
                const finalText = r.result ?? fallbackText
                if (finalText) {
                  if (!textOpen) {
                    controller.enqueue({ type: 'text-start', id: TEXT_ID })
                    textOpen = true
                  }
                  controller.enqueue({
                    type: 'text-delta',
                    id: TEXT_ID,
                    delta: finalText,
                  })
                }
              }
              if (r.stop_reason === 'tool_use') {
                finishReason = { unified: 'tool-calls', raw: r.stop_reason }
              } else if (r.stop_reason === 'max_tokens') {
                finishReason = { unified: 'length', raw: r.stop_reason }
              } else if (typeof r.stop_reason === 'string') {
                finishReason = { unified: 'stop', raw: r.stop_reason }
              }
            }
          }

          // Close any open content blocks.
          if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
          if (reasoningOpen) controller.enqueue({ type: 'reasoning-end', id: REASON_ID })

          // Await process close to surface non-zero exits.
          const exitCode: number | null = await turn.waitExit()

          if (exitCode !== 0 && !sawResult) {
            log.warn('claude.nonzero_exit', {
              exitCode,
              stderr: turn.stderrText().slice(0, 200),
            })
            throw new APICallError({
              message: `claude CLI exited ${String(exitCode)}: ${turn.stderrText().slice(0, 500)}`,
              url: 'claude-cli://stream-json',
              requestBodyValues: {},
              statusCode: exitCode ?? 500,
              isRetryable: false,
            })
          }

          const durationMs = Date.now() - startedAt
          log.info('claude.exit', {
            pid: proc.pid,
            exitCode,
            durationMs,
            sawResult,
            streamedAnyText,
            usage,
          })

          controller.enqueue({
            type: 'finish',
            usage: usage ?? emptyUsage(),
            finishReason,
            providerMetadata: {
              [providerId]: {
                model: modelId,
                durationMs,
              },
            },
          })
          controller.close()
        } catch (err: unknown) {
          const apiError =
            err instanceof APICallError
              ? err
              : new APICallError({
                  message: err instanceof Error ? err.message : String(err),
                  url: 'claude-cli://stream-json',
                  requestBodyValues: {},
                  isRetryable: false,
                })
          controller.enqueue({ type: 'error', error: apiError })
          controller.error(apiError)
        } finally {
          options.abortSignal?.removeEventListener('abort', onAbort)
          // Guarantee the child is reaped on every exit path. No-op if it
          // already exited cleanly (the success path awaits `close` above).
          killProc()
          await closeBridge()
        }
      },
      cancel: async () => {
        killProc()
        await closeBridge()
      },
    })

    return {
      stream,
      request: { body: { args, userContent: redactContentForLog(userContent) } },
    }
  }
}
