/**
 * GrokCliModel — a LanguageModelV3 that answers each turn with ONE headless
 * Grok Build call (`grok -p … --output-format streaming-messages-json
 * --include-partial-messages`).
 *
 * Default `session: resume` keeps ONE grok session per RivetOS conversation
 * (`--session-id` on the first turn with the full transcript, `--resume` after
 * with only the newest USER chunk). `session: replay` is the old behavior:
 * every turn re-sends the whole conversation as one prompt, no session flags.
 *
 * Stdout is Anthropic Messages API NDJSON (same wire format claude-cli
 * parses): `stream_event` lines become `text-delta` / `reasoning-delta` as
 * they arrive. Grok owns its tool loop — this model does not emit V3
 * tool-call parts, matching claude-cli and the old json-blob path. There is
 * no RivetOS tool bridge: grok runs with its own tools (denied unless
 * `allow` rules are configured) plus whatever MCP servers
 * ~/.grok/config.toml wires, e.g. the rivet-memory plugin.
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
  type GrokCliEvent,
  type GrokJsonResult,
  type GrokReasoningEffort,
  type GrokSpawnFlags,
  type GrokUsage,
} from './spawn-turn.js'
import type { BridgeLogger } from './log.js'
import { createLogger } from './log.js'
import {
  defaultSessionMapPath,
  loadSessionMap,
  saveSessionMap,
  uuidForConversation,
} from './session-map.js'

export type { GrokReasoningEffort } from './spawn-turn.js'

/** How the RivetOS system prompt (agent persona + tool docs) reaches grok. */
export type GrokSystemPromptMode = 'prepend' | 'override' | 'off'

/** Per-conversation grok session vs. re-send the whole transcript every turn. */
export type GrokSessionMode = 'resume' | 'replay'

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
  /** Default `resume`. */
  sessionMode?: GrokSessionMode
  /** RivetOS conversation id; session map key. Falls back to `default`. */
  conversationId?: string
  /** Injected in tests. Default `~/.rivetos/grok-cli-sessions.json`. */
  sessionMapPath?: string
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
  chunks: string[]
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
  return { systemText: system.join('\n\n'), userText: chunks.join(SEP), chunks }
}

/** Newest `USER:` chunk for a `--resume` turn. Grok already holds the rest. */
export function newestUserChunk(chunks: string[]): string {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].startsWith('USER:')) return chunks[i]
  }
  return 'USER:\n(no message)'
}

/**
 * The prompt travels as ONE argv argument. Linux caps a single argument at
 * MAX_ARG_STRLEN = 128 KiB (E2BIG past that), so long conversations are
 * trimmed from the OLDEST turn forward until the composed prompt fits; the
 * system text and the newest turns always survive. 100 KB leaves headroom
 * for the other flags and multi-byte text.
 */
export const MAX_PROMPT_BYTES = 100_000
const TRUNCATION_NOTE = '[… earlier conversation trimmed to fit the CLI argument limit …]'

/** The single `-p` argument: optional SYSTEM section + the transcript. */
export function composePrompt(
  rendered: { systemText: string; chunks: string[] },
  mode: GrokSystemPromptMode,
  maxBytes: number = MAX_PROMPT_BYTES,
): { prompt: string; systemPromptOverride: string; trimmedChunks: number } {
  const head =
    mode === 'prepend' && rendered.systemText ? `SYSTEM:\n${rendered.systemText}${SEP}` : ''
  const systemPromptOverride = mode === 'override' ? rendered.systemText : ''
  const build = (chunks: string[], trimmed: boolean): string => {
    const parts = trimmed ? [TRUNCATION_NOTE, ...chunks] : chunks
    return head + (parts.length > 0 ? parts.join(SEP) : 'USER:\n(no message)')
  }
  let chunks = rendered.chunks
  let trimmedChunks = 0
  let prompt = build(chunks, false)
  while (Buffer.byteLength(prompt, 'utf8') > maxBytes && chunks.length > 1) {
    chunks = chunks.slice(1)
    trimmedChunks++
    prompt = build(chunks, true)
  }
  if (Buffer.byteLength(prompt, 'utf8') > maxBytes && chunks.length === 1) {
    // A single oversized turn (or system text): keep its tail, which holds the actual ask.
    const keep = Math.max(0, maxBytes - Buffer.byteLength(head + TRUNCATION_NOTE + SEP, 'utf8'))
    const last = chunks[0]
    prompt = head + TRUNCATION_NOTE + SEP + last.slice(Math.max(0, last.length - keep))
    trimmedChunks++
  }
  return { prompt, systemPromptOverride, trimmedChunks }
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

/** Merge sparse usage objects (message_start input + message_delta output). Defined numbers win. */
export function mergeGrokUsage(prev: GrokUsage | undefined, next: GrokUsage): GrokUsage {
  if (!prev) return { ...next }
  const out: GrokUsage = { ...prev }
  if (typeof next.input_tokens === 'number') out.input_tokens = next.input_tokens
  if (typeof next.output_tokens === 'number') out.output_tokens = next.output_tokens
  if (typeof next.cache_read_input_tokens === 'number') {
    out.cache_read_input_tokens = next.cache_read_input_tokens
  }
  if (typeof next.cache_creation_input_tokens === 'number') {
    out.cache_creation_input_tokens = next.cache_creation_input_tokens
  }
  if (typeof next.reasoning_tokens === 'number') out.reasoning_tokens = next.reasoning_tokens
  if (typeof next.total_tokens === 'number') out.total_tokens = next.total_tokens
  return out
}

export function finishReasonFor(
  stop: string | undefined,
): LanguageModelV3GenerateResult['finishReason'] {
  if (stop === 'max_tokens' || stop === 'length') return { unified: 'length', raw: stop }
  if (stop === 'tool_use' || stop === 'tool-calls') return { unified: 'tool-calls', raw: stop }
  return { unified: 'stop', raw: stop }
}

// ---------------------------------------------------------------------------
// streaming-messages-json (Anthropic Messages wire, same as claude-cli)
// ---------------------------------------------------------------------------

const RECOGNIZED_STREAM_TYPES = new Set([
  'stream_event',
  'assistant',
  'user',
  'result',
  'error',
  'system',
  'message',
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
])

export function isRecognizedStreamEvent(ev: unknown): ev is GrokCliEvent {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false
  const t = (ev as GrokCliEvent).type
  return typeof t === 'string' && RECOGNIZED_STREAM_TYPES.has(t)
}

export function sessionIdOf(ev: GrokCliEvent): string | undefined {
  if (typeof ev.session_id === 'string' && ev.session_id) return ev.session_id
  if (typeof ev.sessionId === 'string' && ev.sessionId) return ev.sessionId
  return undefined
}

export function streamErrorMessage(ev: GrokCliEvent): string | undefined {
  if (ev.type === 'error') {
    const err = ev.error
    if (typeof err === 'string' && err) return err
    if (err && typeof err === 'object' && !Array.isArray(err)) {
      const msg = (err as { message?: unknown }).message
      if (typeof msg === 'string' && msg) return msg
    }
    if (typeof ev.message === 'string' && ev.message) return ev.message
    return 'grok stream error'
  }
  if (ev.type === 'result' && ev.is_error) {
    if (typeof ev.result === 'string' && ev.result) return ev.result
    if (typeof ev.message === 'string' && ev.message) return ev.message
    return 'grok result is_error'
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asUsage(raw: unknown): GrokUsage | undefined {
  return asRecord(raw)
}

/** Unwrap `{type:"stream_event", event}` or accept a bare Anthropic event. */
export function innerStreamEvent(ev: GrokCliEvent): Record<string, unknown> | undefined {
  if (ev.type === 'stream_event') return asRecord(ev.event)
  if (
    ev.type === 'content_block_delta' ||
    ev.type === 'content_block_start' ||
    ev.type === 'message_delta' ||
    ev.type === 'message_start' ||
    ev.type === 'message_stop' ||
    ev.type === 'content_block_stop'
  ) {
    return ev
  }
  return undefined
}

export function deltaOf(inner: Record<string, unknown>): { text?: string; thinking?: string } {
  if (inner.type !== 'content_block_delta') return {}
  const d = asRecord(inner.delta)
  if (!d) return {}
  if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) return { text: d.text }
  if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
    return { thinking: d.thinking }
  }
  return {}
}

function contentBlocks(ev: GrokCliEvent): Array<Record<string, unknown>> {
  const msg = asRecord(ev.message)
  const content = msg?.content ?? ev.content
  if (!Array.isArray(content)) return []
  const out: Array<Record<string, unknown>> = []
  for (const block of content) {
    const rec = asRecord(block)
    if (rec) out.push(rec)
  }
  return out
}

function thinkingFromBlock(block: Record<string, unknown>): string {
  if (block.type === 'thinking' || block.type === 'reasoning') {
    if (typeof block.thinking === 'string') return block.thinking
    if (typeof block.text === 'string') return block.text
  }
  return ''
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
    const full = composePrompt(rendered, this.config.systemPromptMode)
    const sessionMode = this.config.sessionMode ?? 'resume'
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath()

    let prompt = full.prompt
    let systemPromptOverride = full.systemPromptOverride
    let trimmedChunks = full.trimmedChunks
    let sessionId: string | undefined
    let resume = false

    if (sessionMode === 'resume') {
      const map = loadSessionMap(mapPath)
      const existing = map[convKey]
      if (existing) {
        const delta = composePrompt(
          { systemText: rendered.systemText, chunks: [newestUserChunk(rendered.chunks)] },
          this.config.systemPromptMode,
        )
        prompt = delta.prompt
        systemPromptOverride = delta.systemPromptOverride
        trimmedChunks = delta.trimmedChunks
        sessionId = existing
        resume = true
      } else {
        sessionId = uuidForConversation(convKey)
        resume = false
      }
    }

    if (trimmedChunks > 0) {
      this.log.warn('prompt.trimmed', {
        trimmedChunks,
        promptChars: prompt.length,
        maxBytes: MAX_PROMPT_BYTES,
      })
    }
    const reasoningEffort = effortFromProviderOptions(
      options.providerOptions,
      this.config.reasoningEffort,
    )

    const baseFlags = {
      binary: this.config.binary,
      modelId: this.config.modelId === 'default' ? undefined : this.config.modelId,
      permissionMode: this.config.permissionMode,
      reasoningEffort,
      maxTurns: this.config.maxTurns,
      noPlan: this.config.noPlan,
      allow: this.config.allow,
      tools: this.config.tools,
      cwd: this.config.cwd,
    }

    const flagsFor = (
      p: string,
      override: string,
      sid: string | undefined,
      isResume: boolean,
    ): GrokSpawnFlags => ({
      ...baseFlags,
      systemPromptOverride: override,
      sessionId: sid,
      resume: Boolean(sid) && isResume,
    })

    let flags: GrokSpawnFlags = flagsFor(prompt, systemPromptOverride, sessionId, resume)

    this.log.info('doStream.start', {
      agentId: this.config.agentId,
      conversationId: convKey,
      model: this.modelId,
      reasoningEffort,
      maxTurns: flags.maxTurns,
      promptChars: prompt.length,
      systemPromptMode: this.config.systemPromptMode,
      sessionMode,
      sessionId: sessionId ?? null,
      resume,
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
    const persistSessions = sessionMode === 'resume'
    const requestedSessionId = sessionId
    const wasResume = resume
    const fullPrompt = full.prompt
    const fullOverride = full.systemPromptOverride

    const rememberSession = (returned: string | undefined, requested: string | undefined): void => {
      const keep = returned || requested
      if (!keep) return
      if (returned && requested && returned !== requested) {
        log.warn('session.id.mismatch', {
          conversationId: convKey,
          requested,
          returned,
        })
      }
      const map = loadSessionMap(mapPath)
      map[convKey] = keep
      saveSessionMap(mapPath, map)
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        const TEXT_ID = 'grok-text'
        const REASON_ID = 'grok-reasoning'
        controller.enqueue({ type: 'stream-start', warnings: [] })
        try {
          let textOpen = false
          let reasoningOpen = false
          let streamedAnyText = false
          let streamedAnyReasoning = false
          let recognizedEvents = 0
          let sawResult = false
          let usage = emptyUsage()
          let grokUsage: GrokUsage | undefined
          let stopReason: string | undefined
          let returnedSessionId: string | undefined
          let costUsd: number | undefined
          let numTurns: number | undefined
          let fallbackText = ''
          let fallbackThinking = ''
          let streamError: APICallError | undefined
          let usedSessionId = requestedSessionId

          const closeText = (): void => {
            if (!textOpen) return
            controller.enqueue({ type: 'text-end', id: TEXT_ID })
            textOpen = false
          }
          const closeReasoning = (): void => {
            if (!reasoningOpen) return
            controller.enqueue({ type: 'reasoning-end', id: REASON_ID })
            reasoningOpen = false
          }
          const emitText = (delta: string): void => {
            if (!delta) return
            if (reasoningOpen) closeReasoning()
            if (!textOpen) {
              controller.enqueue({ type: 'text-start', id: TEXT_ID })
              textOpen = true
            }
            streamedAnyText = true
            controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta })
          }
          const emitThinking = (delta: string): void => {
            if (!delta) return
            if (textOpen) closeText()
            if (!reasoningOpen) {
              controller.enqueue({ type: 'reasoning-start', id: REASON_ID })
              reasoningOpen = true
            }
            streamedAnyReasoning = true
            controller.enqueue({ type: 'reasoning-delta', id: REASON_ID, delta })
          }
          const applyUsage = (raw: unknown, replace = false): void => {
            const u = asUsage(raw)
            if (!u) return
            grokUsage = replace ? { ...u } : mergeGrokUsage(grokUsage, u)
            usage = buildUsage({ usage: grokUsage })
          }
          const applyStop = (raw: unknown): void => {
            if (typeof raw === 'string' && raw) stopReason = raw
          }

          const handleEvent = (event: GrokCliEvent): void => {
            const sid = sessionIdOf(event)
            if (sid) returnedSessionId = sid

            const errMsg = streamErrorMessage(event)
            if (errMsg) {
              streamError = new APICallError({
                message: errMsg,
                url: 'grok-cli://stream',
                requestBodyValues: {},
                statusCode: 500,
                isRetryable: false,
              })
              return
            }

            const inner = innerStreamEvent(event)
            if (inner) {
              const delta = deltaOf(inner)
              if (delta.thinking) emitThinking(delta.thinking)
              if (delta.text) emitText(delta.text)
              if (inner.type === 'message_delta') {
                const d = asRecord(inner.delta)
                applyStop(d?.stop_reason ?? d?.stopReason)
                applyUsage(inner.usage)
              }
              if (inner.type === 'message_start') {
                const msg = asRecord(inner.message)
                applyUsage(msg?.usage)
                const msgSid = sessionIdOf(msg ?? {})
                if (msgSid) returnedSessionId = msgSid
              }
              return
            }

            if (event.type === 'assistant' || event.type === 'message') {
              for (const block of contentBlocks(event)) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  fallbackText += block.text
                } else {
                  const thought = thinkingFromBlock(block)
                  if (thought) fallbackThinking += thought
                }
              }
              const msg = asRecord(event.message)
              applyUsage(msg?.usage ?? event.usage)
              applyStop(
                msg?.stop_reason ?? msg?.stopReason ?? event.stop_reason ?? event.stopReason,
              )
              return
            }

            if (event.type === 'result') {
              sawResult = true
              applyUsage(event.usage, true)
              applyStop(event.stop_reason ?? event.stopReason)
              if (typeof event.total_cost_usd === 'number') costUsd = event.total_cost_usd
              if (typeof event.num_turns === 'number') numTurns = event.num_turns
              if (typeof event.result === 'string' && event.result && !fallbackText) {
                fallbackText = event.result
              }
              if (typeof event.thought === 'string' && event.thought && !fallbackThinking) {
                fallbackThinking = event.thought
              }
            }
          }

          const drain = async (): Promise<number | null> => {
            for await (const event of turn.events()) {
              if (!isRecognizedStreamEvent(event)) continue
              recognizedEvents++
              handleEvent(event)
              if (streamError) {
                turn.kill()
                throw streamError
              }
            }
            return turn.waitExit()
          }

          let exitCode = await drain()

          if (
            persistSessions &&
            wasResume &&
            exitCode !== 0 &&
            !streamedAnyText &&
            !streamedAnyReasoning &&
            !options.abortSignal?.aborted
          ) {
            const freshId = uuidForConversation(convKey)
            log.warn('session.resume.failed', {
              conversationId: convKey,
              sessionId: requestedSessionId,
              exitCode,
              fallbackSessionId: freshId,
            })
            turn.kill()
            flags = flagsFor(fullPrompt, fullOverride, freshId, false)
            try {
              turn = spawnGrokTurn(flags, fullPrompt)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              throw new APICallError({
                message: `Failed to spawn ${baseFlags.binary}: ${msg}`,
                url: baseFlags.binary,
                requestBodyValues: { args: redactArgs(buildArgs(flags, fullPrompt)) },
                isRetryable: false,
              })
            }
            usedSessionId = freshId
            recognizedEvents = 0
            sawResult = false
            streamError = undefined
            fallbackText = ''
            fallbackThinking = ''
            usage = emptyUsage()
            grokUsage = undefined
            stopReason = undefined
            returnedSessionId = undefined
            costUsd = undefined
            numTurns = undefined
            exitCode = await drain()
          }

          if (streamError) throw streamError

          if (recognizedEvents === 0 && exitCode === 0) {
            const blob = parseGrokJson(turn.stdoutText())
            if (blob) {
              if (persistSessions) rememberSession(blob.sessionId, usedSessionId)
              if (blob.thought) emitThinking(blob.thought)
              if (blob.text) emitText(blob.text)
              closeText()
              closeReasoning()
              const durationMs = Date.now() - startedAt
              const blobUsage = buildUsage(blob)
              log.info('grok.exit', {
                exitCode,
                durationMs,
                sessionId: blob.sessionId,
                stopReason: blob.stopReason,
                numTurns: blob.num_turns,
                costUsd: blob.total_cost_usd,
                usage: blobUsage,
                via: 'json-blob-fallback',
              })
              controller.enqueue({
                type: 'finish',
                usage: blobUsage,
                finishReason: finishReasonFor(blob.stopReason),
                providerMetadata: {
                  [providerId]: {
                    model: modelId,
                    durationMs,
                    sessionId: blob.sessionId ?? usedSessionId ?? null,
                    costUsd: blob.total_cost_usd ?? null,
                    exitCode,
                  },
                },
              })
              controller.close()
              return
            }
          }

          if (exitCode !== 0 && !sawResult) {
            const err = turn.stderrText().trim() || turn.stdoutText().trim()
            throw new APICallError({
              message: `grok CLI exited ${String(exitCode)}: ${err.slice(0, 500)}`,
              url: 'grok-cli://stream',
              requestBodyValues: {},
              statusCode: exitCode ?? 500,
              isRetryable: false,
            })
          }

          if (!streamedAnyReasoning && fallbackThinking) emitThinking(fallbackThinking)
          if (!streamedAnyText && fallbackText) emitText(fallbackText)

          closeText()
          closeReasoning()

          if (!streamedAnyText && !streamedAnyReasoning && recognizedEvents === 0) {
            const err = turn.stderrText().trim() || turn.stdoutText().trim()
            throw new APICallError({
              message: `grok CLI exited ${String(exitCode)} without a JSON result: ${err.slice(0, 500)}`,
              url: 'grok-cli://stream',
              requestBodyValues: {},
              statusCode: exitCode ?? 500,
              isRetryable: false,
            })
          }

          if (persistSessions) rememberSession(returnedSessionId, usedSessionId)
          const durationMs = Date.now() - startedAt
          log.info('grok.exit', {
            exitCode,
            durationMs,
            sessionId: returnedSessionId ?? usedSessionId,
            stopReason,
            numTurns,
            costUsd,
            usage,
            recognizedEvents,
          })
          controller.enqueue({
            type: 'finish',
            usage,
            finishReason: finishReasonFor(stopReason),
            providerMetadata: {
              [providerId]: {
                model: modelId,
                durationMs,
                sessionId: returnedSessionId ?? usedSessionId ?? null,
                costUsd: costUsd ?? null,
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
                  url: 'grok-cli://stream',
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
