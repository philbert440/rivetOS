/**
 * GrokCliModel — a LanguageModelV3 that answers each turn with ONE headless
 * Grok Build call (`grok -p … --output-format json`).
 *
 * Shape of a turn: the AI SDK loop hands us the whole conversation as a V3
 * prompt. We render it to a single text prompt (SYSTEM / USER / ASSISTANT /
 * TOOL RESULT sections), spawn grok, wait for its JSON result, and replay it
 * as stream parts (reasoning → text → finish). There is no incremental
 * streaming in v1 — `--output-format json` only arrives at the end — and no
 * RivetOS tool bridge: grok runs with its own tools (denied unless `allow`
 * rules are configured) plus whatever MCP servers ~/.grok/config.toml wires,
 * e.g. the rivet-memory plugin. That is enough for mesh delegation, heartbeat
 * tasks and chat; an MCP bridge for RivetOS tools is a later step.
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
import {
  buildArgs,
  parseGrokJson,
  spawnGrokTurn,
  type GrokJsonResult,
  type GrokReasoningEffort,
  type GrokSpawnFlags,
} from './spawn-turn.js'
import type { BridgeLogger } from './log.js'
import { createLogger } from './log.js'

export type { GrokReasoningEffort } from './spawn-turn.js'

/** How the RivetOS system prompt (agent persona + tool docs) reaches grok. */
export type GrokSystemPromptMode = 'prepend' | 'override' | 'off'

export interface GrokCliModelConfig {
  providerId: string
  modelId: string
  binary: string
  permissionMode: string
  reasoningEffort: GrokReasoningEffort | undefined
  maxTurns: number
  noPlan: boolean
  systemPromptMode: GrokSystemPromptMode
  allow: string[] | undefined
  tools: string | undefined
  cwd: string | undefined
  agentId: string | undefined
}

// ---------------------------------------------------------------------------
// Prompt rendering (V3 prompt → one text prompt)
// ---------------------------------------------------------------------------

const SEP = '\n\n---\n\n'

function userText(msg: LanguageModelV3Message): string {
  if (msg.role !== 'user') return ''
  const parts: string[] = []
  for (const p of msg.content) {
    if (p.type === 'text') parts.push(p.text)
    else parts.push(`[file: ${p.mediaType}]`)
  }
  return parts.join('\n')
}

function assistantText(msg: LanguageModelV3Message): string {
  if (msg.role !== 'assistant') return ''
  const text = msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
  const calls = msg.content
    .filter(
      (p): p is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } =>
        p.type === 'tool-call',
    )
    .map((p) => `  - ${p.toolName}(${JSON.stringify(p.input)})`)
  const chunks: string[] = []
  if (text) chunks.push(`ASSISTANT:\n${text}`)
  if (calls.length > 0) chunks.push(`ASSISTANT TOOL CALLS:\n${calls.join('\n')}`)
  return chunks.join(SEP)
}

function toolResultText(msg: LanguageModelV3Message): string {
  if (msg.role !== 'tool') return ''
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
    lines.push(`TOOL RESULT (${part.toolName}):\n${text}`)
  }
  return lines.join(SEP)
}

function chunkFor(msg: LanguageModelV3Message): string {
  if (msg.role === 'user') {
    const t = userText(msg)
    return t ? `USER:\n${t}` : ''
  }
  if (msg.role === 'assistant') return assistantText(msg)
  return toolResultText(msg)
}

export function renderPromptForCli(prompt: LanguageModelV3Prompt): {
  systemText: string
  userText: string
} {
  const system: string[] = []
  const chunks: string[] = []
  for (const msg of prompt) {
    if (msg.role === 'system') {
      system.push(msg.content)
      continue
    }
    const chunk = chunkFor(msg)
    if (chunk) chunks.push(chunk)
  }
  return { systemText: system.join('\n\n'), userText: chunks.join(SEP) }
}

/** The single `-p` argument: optional SYSTEM section + the transcript. */
export function composePrompt(
  rendered: { systemText: string; userText: string },
  mode: GrokSystemPromptMode,
): { prompt: string; systemPromptOverride: string } {
  const body = rendered.userText || 'USER:\n(no message)'
  if (mode === 'prepend' && rendered.systemText) {
    return { prompt: `SYSTEM:\n${rendered.systemText}${SEP}${body}`, systemPromptOverride: '' }
  }
  if (mode === 'override') {
    return { prompt: body, systemPromptOverride: rendered.systemText }
  }
  return { prompt: body, systemPromptOverride: '' }
}

// ---------------------------------------------------------------------------
// Effort / usage helpers
// ---------------------------------------------------------------------------

export function effortFromProviderOptions(
  providerOptions: LanguageModelV3CallOptions['providerOptions'],
  fallback: GrokReasoningEffort | undefined,
): GrokReasoningEffort | undefined {
  const raw = (providerOptions?.['grok-cli'] as { reasoningEffort?: unknown } | undefined)
    ?.reasoningEffort
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw
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

export function buildUsage(r: GrokJsonResult): LanguageModelV3Usage {
  const u = r.usage
  if (!u) return emptyUsage()
  const reasoning = u.reasoning_tokens
  const out = u.output_tokens
  return {
    inputTokens: {
      total: u.input_tokens,
      noCache:
        typeof u.input_tokens === 'number'
          ? u.input_tokens - (u.cache_read_input_tokens ?? 0) - (u.cache_creation_input_tokens ?? 0)
          : undefined,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
    },
    outputTokens: {
      total: out,
      text: typeof out === 'number' ? out - (reasoning ?? 0) : undefined,
      reasoning,
    },
  }
}

export function finishReasonFor(
  stop: string | undefined,
): LanguageModelV3GenerateResult['finishReason'] {
  if (stop === 'max_tokens' || stop === 'length') return { unified: 'length', raw: stop }
  if (stop === 'tool_use' || stop === 'tool-calls') return { unified: 'tool-calls', raw: stop }
  return { unified: 'stop', raw: stop }
}

// ---------------------------------------------------------------------------
// GrokCliModel
// ---------------------------------------------------------------------------

export class GrokCliModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly config: GrokCliModelConfig
  private readonly log: BridgeLogger

  constructor(config: GrokCliModelConfig) {
    this.config = config
    this.provider = config.providerId
    this.modelId = config.modelId || 'default'
    this.log = createLogger('grok-cli')
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()
    let text = ''
    let reasoning = ''
    let usage = emptyUsage()
    let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
      unified: 'stop',
      raw: undefined,
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      else if (value.type === 'reasoning-delta') reasoning += value.delta
      else if (value.type === 'finish') {
        usage = value.usage
        finishReason = value.finishReason
      } else if (value.type === 'error') throw value.error
    }
    const content: LanguageModelV3GenerateResult['content'] = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    if (text) content.push({ type: 'text', text })
    return { content, finishReason, usage, warnings: [] }
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const rendered = renderPromptForCli(options.prompt)
    const { prompt, systemPromptOverride } = composePrompt(rendered, this.config.systemPromptMode)
    const reasoningEffort = effortFromProviderOptions(
      options.providerOptions,
      this.config.reasoningEffort,
    )

    const flags: GrokSpawnFlags = {
      binary: this.config.binary,
      modelId: this.config.modelId === 'default' ? undefined : this.config.modelId,
      permissionMode: this.config.permissionMode,
      reasoningEffort,
      maxTurns: this.config.maxTurns,
      noPlan: this.config.noPlan,
      systemPromptOverride,
      allow: this.config.allow,
      tools: this.config.tools,
      cwd: this.config.cwd,
    }

    this.log.info('doStream.start', {
      agentId: this.config.agentId,
      model: this.modelId,
      reasoningEffort,
      maxTurns: flags.maxTurns,
      promptChars: prompt.length,
      systemPromptMode: this.config.systemPromptMode,
    })

    let turn: ReturnType<typeof spawnGrokTurn>
    try {
      turn = spawnGrokTurn(flags, prompt)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return Promise.reject(
        new APICallError({
          message: `Failed to spawn ${this.config.binary}: ${msg}`,
          url: this.config.binary,
          requestBodyValues: { args: redactArgs(buildArgs(flags, prompt)) },
          isRetryable: false,
        }),
      )
    }

    const onAbort = (): void => turn.kill()
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })

    const log = this.log
    const providerId = this.provider
    const modelId = this.modelId
    const startedAt = Date.now()

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        const TEXT_ID = 'grok-text'
        const REASON_ID = 'grok-reasoning'
        controller.enqueue({ type: 'stream-start', warnings: [] })
        try {
          const exitCode = await turn.waitExit()
          const result = parseGrokJson(turn.stdoutText())
          if (!result) {
            const err = turn.stderrText().trim() || turn.stdoutText().trim()
            throw new APICallError({
              message: `grok CLI exited ${String(exitCode)} without a JSON result: ${err.slice(0, 500)}`,
              url: 'grok-cli://json',
              requestBodyValues: {},
              statusCode: exitCode ?? 500,
              isRetryable: false,
            })
          }
          if (result.thought) {
            controller.enqueue({ type: 'reasoning-start', id: REASON_ID })
            controller.enqueue({ type: 'reasoning-delta', id: REASON_ID, delta: result.thought })
            controller.enqueue({ type: 'reasoning-end', id: REASON_ID })
          }
          const text = result.text ?? ''
          if (text) {
            controller.enqueue({ type: 'text-start', id: TEXT_ID })
            controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta: text })
            controller.enqueue({ type: 'text-end', id: TEXT_ID })
          }
          const durationMs = Date.now() - startedAt
          const usage = buildUsage(result)
          log.info('grok.exit', {
            exitCode,
            durationMs,
            sessionId: result.sessionId,
            stopReason: result.stopReason,
            numTurns: result.num_turns,
            costUsd: result.total_cost_usd,
            usage,
          })
          controller.enqueue({
            type: 'finish',
            usage,
            finishReason: finishReasonFor(result.stopReason),
            providerMetadata: {
              [providerId]: {
                model: modelId,
                durationMs,
                sessionId: result.sessionId ?? null,
                costUsd: result.total_cost_usd ?? null,
                exitCode,
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
                  url: 'grok-cli://json',
                  requestBodyValues: {},
                  isRetryable: false,
                })
          log.warn('grok.turn.failed', { error: apiError.message })
          controller.enqueue({ type: 'error', error: apiError })
          controller.error(apiError)
        } finally {
          options.abortSignal?.removeEventListener('abort', onAbort)
          turn.kill()
        }
      },
      cancel: () => {
        turn.kill()
      },
    })

    return Promise.resolve({
      stream,
      request: { body: { args: redactArgs(turn.args), promptChars: prompt.length } },
    })
  }
}

/** Keep the (possibly huge, possibly private) prompt out of request logs. */
function redactArgs(args: string[]): string[] {
  const out = [...args]
  const i = out.indexOf('-p')
  if (i >= 0 && i + 1 < out.length) out[i + 1] = `<prompt ${out[i + 1].length} chars>`
  const j = out.indexOf('--system-prompt-override')
  if (j >= 0 && j + 1 < out.length) out[j + 1] = `<system ${out[j + 1].length} chars>`
  return out
}
