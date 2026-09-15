/**
 * @rivetos/provider-qwen-code — Qwen Code CLI provider.
 *
 * Each turn shells out to the local Qwen Code CLI
 * (`qwen -p <prompt> --output-format stream-json --include-partial-messages
 * --approval-mode yolo`) and replays its Claude-shaped stream-json wire
 * (content_block_delta text/thinking, assistant snapshots, result usage).
 * Native `tool_use` / `tool_result` stay inside the CLI (already executed);
 * they are not emitted as LanguageModelV3 tool-call parts.
 * The first turn of a conversation pins `--session-id <uuid>` (minted here,
 * stored in ~/.rivetos/qwen-code-sessions.json); later turns pass
 * `--resume <uuid>`. System messages go out as `--append-system-prompt`.
 * Spawn stdin is ignored. Abort/cancel: SIGTERM, then SIGKILL after 3s.
 * Implements `aiSdkBridge()` (LanguageModelV3) for the agent loop.
 *
 * Provider id and harness id are both `qwen-code`. Model is optional — when
 * unset the CLI's configured default applies.
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import type { Provider, PluginManifest } from '@rivetos/types'
import type { ProviderAiSdkBridge, GetModelInput } from '@rivetos/aisdk'
import { defaultSessionMapPath, loadSessionMap, saveSessionMap } from './session-map.js'

export { loadSessionMap, saveSessionMap } from './session-map.js'

export const QWEN_CODE_PROVIDER_ID = 'qwen-code'
export const SESSION_MAP_FILE = 'qwen-code-sessions.json'
const NO_INSTRUCTION = '(no instruction was provided for this turn)'
const RESUME_REJECTED_RE = /No saved session found with ID/i
const SEMVER_RE = /\d+\.\d+\.\d+/
const VERSION_PROBE_MS = 8_000

/** Grace period between SIGTERM and SIGKILL on abort / stream cancel. */
export const KILL_GRACE_MS = 3_000

/** Binary name is `qwen` on PATH; override via $QWEN_BINARY. */
export function defaultQwenBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.QWEN_BINARY || 'qwen'
}

function binaryIsPath(binary: string): boolean {
  return binary.includes('/') || binary.includes('\\')
}

/** The newest user message as plain text — qwen keeps its own history via --resume. */
export function promptFromV3(prompt: LanguageModelV3Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]
    if (m.role !== 'user') continue
    return m.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Concatenate system messages for `--append-system-prompt`. */
export function systemFromV3(prompt: LanguageModelV3Prompt): string {
  const chunks: string[] = []
  for (const m of prompt) {
    if (m.role === 'system' && m.content) chunks.push(m.content)
  }
  return chunks.join('\n\n')
}

export interface QwenSpawnFlags {
  binary: string
  modelId?: string
  sessionId?: string
  pinSessionId?: string
  appendSystemPrompt?: string
}

/**
 * `qwen -p <prompt> --output-format stream-json --include-partial-messages
 * --approval-mode yolo [--session-id id | --resume id] [-m model]
 * [--append-system-prompt text]`
 */
export function buildArgs(flags: QwenSpawnFlags, prompt: string): string[] {
  const args = [
    '-p',
    prompt || NO_INSTRUCTION,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--approval-mode',
    'yolo',
  ]
  if (flags.pinSessionId) args.push('--session-id', flags.pinSessionId)
  else if (flags.sessionId) args.push('--resume', flags.sessionId)
  if (flags.modelId) args.push('-m', flags.modelId)
  if (flags.appendSystemPrompt) args.push('--append-system-prompt', flags.appendSystemPrompt)
  return args
}

export type QwenEvent =
  | { kind: 'init'; sessionId?: string }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'text-snapshot'; text: string }
  | { kind: 'reasoning-snapshot'; text: string }
  | { kind: 'tool-call'; id: string; name: string; input: unknown }
  | { kind: 'tool-input'; delta: string }
  | { kind: 'tool-result'; id?: string; result?: string; isError?: boolean }
  | {
      kind: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
    }
  | {
      kind: 'finish'
      isError: boolean
      subtype?: string
      resultText?: string
      usage?: { inputTokens: number; outputTokens: number; cacheRead?: number }
    }
  | { kind: 'resume-rejected' }
  | { kind: 'other' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function usageFromBag(usage: Record<string, unknown> | undefined): QwenEvent | undefined {
  if (!usage) return undefined
  const input = num(usage.input_tokens) || num(usage.input) || num(usage.inputTokens)
  const output = num(usage.output_tokens) || num(usage.output) || num(usage.outputTokens)
  const cacheRead =
    num(usage.cache_read_input_tokens) || num(usage.cacheRead) || num(usage.cache_read)
  if (input <= 0 && output <= 0 && cacheRead <= 0) return undefined
  return { kind: 'usage', inputTokens: input, outputTokens: output, cacheRead }
}

/**
 * One stdout line from `qwen -p --output-format stream-json`. Same Claude
 * stream-json wire as claude-cli (self-contained — no import from that package).
 */
export function parseQwenLine(line: string): QwenEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return [{ kind: 'other' }]
  if (RESUME_REJECTED_RE.test(trimmed) && !trimmed.startsWith('{')) {
    return [{ kind: 'resume-rejected' }]
  }
  let ev: unknown
  try {
    ev = JSON.parse(trimmed)
  } catch {
    return RESUME_REJECTED_RE.test(trimmed) ? [{ kind: 'resume-rejected' }] : [{ kind: 'other' }]
  }
  if (!isRecord(ev) || typeof ev.type !== 'string') return [{ kind: 'other' }]

  if (ev.type === 'system' && ev.subtype === 'init') {
    return [{ kind: 'init', sessionId: str(ev.session_id) }]
  }

  if (ev.type === 'stream_event' && isRecord(ev.event)) {
    const inner = ev.event
    if (inner.type === 'content_block_delta' && isRecord(inner.delta)) {
      const d = inner.delta
      if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        return [{ kind: 'text', text: d.text }]
      }
      if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
        return [{ kind: 'reasoning', text: d.thinking }]
      }
      if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && d.partial_json) {
        return [{ kind: 'tool-input', delta: d.partial_json }]
      }
    }
    return [{ kind: 'other' }]
  }

  if (ev.type === 'assistant' && isRecord(ev.message)) {
    const out: QwenEvent[] = []
    const usage = isRecord(ev.message.usage) ? usageFromBag(ev.message.usage) : undefined
    if (usage) out.push(usage)
    const content = Array.isArray(ev.message.content) ? ev.message.content : []
    for (const raw of content) {
      if (!isRecord(raw)) continue
      if (raw.type === 'text' && typeof raw.text === 'string' && raw.text) {
        out.push({ kind: 'text-snapshot', text: raw.text })
      } else if (raw.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking) {
        out.push({ kind: 'reasoning-snapshot', text: raw.thinking })
      } else if (raw.type === 'tool_use') {
        const id = str(raw.id) || ''
        const name = str(raw.name)
        if (name) out.push({ kind: 'tool-call', id, name, input: raw.input ?? {} })
      }
    }
    return out.length > 0 ? out : [{ kind: 'other' }]
  }

  if (ev.type === 'user' && isRecord(ev.message) && Array.isArray(ev.message.content)) {
    const out: QwenEvent[] = []
    for (const raw of ev.message.content) {
      if (!isRecord(raw) || raw.type !== 'tool_result') continue
      const id = str(raw.tool_use_id) || str(raw.toolUseId)
      const result =
        typeof raw.content === 'string'
          ? raw.content
          : raw.content != null
            ? JSON.stringify(raw.content)
            : undefined
      out.push({
        kind: 'tool-result',
        id,
        result,
        isError: raw.is_error === true,
      })
    }
    return out.length > 0 ? out : [{ kind: 'other' }]
  }

  if (ev.type === 'result') {
    const usage = isRecord(ev.usage) ? usageFromBag(ev.usage) : undefined
    return [
      {
        kind: 'finish',
        isError: ev.is_error === true,
        subtype: str(ev.subtype),
        resultText: typeof ev.result === 'string' ? ev.result : undefined,
        usage:
          usage && usage.kind === 'usage'
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheRead: usage.cacheRead,
              }
            : undefined,
      },
    ]
  }

  return [{ kind: 'other' }]
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

function usageFromTokens(
  input?: number,
  output?: number,
  cacheRead?: number,
): LanguageModelV3Usage {
  const u = emptyUsage()
  if (input && input > 0) u.inputTokens.total = input
  if (output && output > 0) u.outputTokens.total = output
  if (cacheRead && cacheRead > 0) u.inputTokens.cacheRead = cacheRead
  return u
}

export interface QwenCodeModelConfig {
  providerId: string
  modelId: string
  binary: string
  cwd: string | undefined
  conversationId: string | undefined
  /** Injected in tests. */
  sessionMapPath?: string
  /** Injected in tests to assert spawn options. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  /** Injected in tests. */
  randomUUID?: () => string
}

export class QwenCodeModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly config: QwenCodeModelConfig

  constructor(config: QwenCodeModelConfig) {
    this.config = config
    this.provider = config.providerId
    this.modelId = config.modelId
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()
    let text = ''
    let reasoning = ''
    let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
      unified: 'stop',
      raw: undefined,
    }
    let usage = emptyUsage()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      else if (value.type === 'reasoning-delta') reasoning += value.delta
      else if (value.type === 'finish') {
        finishReason = value.finishReason
        usage = value.usage
      }
    }
    const content: LanguageModelV3GenerateResult['content'] = [{ type: 'text', text }]
    if (reasoning) content.unshift({ type: 'reasoning', text: reasoning })
    return { content, finishReason, usage, warnings: [] }
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prompt = promptFromV3(options.prompt)
    const systemText = systemFromV3(options.prompt)
    const { binary, cwd } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const mint = this.config.randomUUID ?? randomUUID
    const abortSignal = options.abortSignal
    const spawnFn = this.config.spawnImpl ?? spawn
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    }
    let closed = false
    let kill = (): void => {
      /* assigned once the child is spawned */
    }

    const resolveSession = (
      forceFresh: boolean,
    ): { pinSessionId?: string; sessionId?: string; nativeId: string } => {
      let map = loadSessionMap(mapPath)
      if (forceFresh) {
        map = Object.fromEntries(Object.entries(map).filter(([key]) => key !== convKey))
      }
      const existing = map[convKey]
      if (!forceFresh && existing) {
        return { sessionId: existing, nativeId: existing }
      }
      const nativeId = mint()
      map[convKey] = nativeId
      saveSessionMap(mapPath, map)
      return { pinSessionId: nativeId, nativeId }
    }

    const makeArgs = (sess: { pinSessionId?: string; sessionId?: string }): string[] =>
      buildArgs(
        {
          binary,
          modelId: this.modelId || undefined,
          sessionId: sess.sessionId,
          pinSessionId: sess.pinSessionId,
          appendSystemPrompt: systemText || undefined,
        },
        prompt,
      )

    const firstSess = resolveSession(false)
    const firstArgs = makeArgs(firstSess)

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        const TEXT_ID = 'qwen-text'
        const REASON_ID = 'qwen-reason'
        let textOpen = false
        let reasonOpen = false
        let sawText = false
        let sawTextDelta = false
        let sawReasoningDelta = false
        let sawInit = false
        let resumeRejected = false
        let retried = false
        let resultError = false
        let resultSubtype: string | undefined
        /** A `result` event with `is_error:false` — the only terminal success. */
        let sawTerminalSuccess = false
        let lastNonZeroUsage: { input: number; output: number; cacheRead: number } | undefined
        let resultUsage: { input: number; output: number; cacheRead: number } | undefined
        let stderr = ''
        let buffer = ''
        let killTimer: ReturnType<typeof setTimeout> | undefined

        const enqueue = (part: LanguageModelV3StreamPart): void => {
          if (closed) return
          try {
            controller.enqueue(part)
          } catch {
            closed = true
          }
        }
        enqueue({ type: 'stream-start', warnings: [] })

        if (binaryIsPath(binary) && !existsSync(binary)) {
          enqueue({
            type: 'error',
            error: new Error(`qwen binary not found at ${binary}`),
          })
          enqueue({
            type: 'finish',
            finishReason: { unified: 'error', raw: 'missing-binary' },
            usage: emptyUsage(),
          })
          try {
            controller.close()
          } catch {
            /* already closed */
          }
          return
        }

        const emitText = (chunk: string): void => {
          if (!chunk) return
          if (!textOpen) {
            enqueue({ type: 'text-start', id: TEXT_ID })
            textOpen = true
          }
          sawText = true
          enqueue({ type: 'text-delta', id: TEXT_ID, delta: chunk })
        }
        const emitReason = (chunk: string): void => {
          if (!chunk) return
          if (!reasonOpen) {
            enqueue({ type: 'reasoning-start', id: REASON_ID })
            reasonOpen = true
          }
          enqueue({ type: 'reasoning-delta', id: REASON_ID, delta: chunk })
        }

        const handleLine = (line: string): void => {
          for (const ev of parseQwenLine(line)) {
            if (ev.kind === 'init') {
              sawInit = true
            } else if (ev.kind === 'resume-rejected') {
              resumeRejected = true
            } else if (ev.kind === 'text') {
              sawTextDelta = true
              emitText(ev.text)
            } else if (ev.kind === 'reasoning') {
              sawReasoningDelta = true
              emitReason(ev.text)
            } else if (ev.kind === 'text-snapshot') {
              if (!sawTextDelta) emitText(ev.text)
            } else if (ev.kind === 'reasoning-snapshot') {
              if (!sawReasoningDelta) emitReason(ev.text)
            } else if (ev.kind === 'usage') {
              if (ev.inputTokens > 0 || ev.outputTokens > 0) {
                lastNonZeroUsage = {
                  input: ev.inputTokens,
                  output: ev.outputTokens,
                  cacheRead: ev.cacheRead ?? 0,
                }
              }
            } else if (ev.kind === 'finish') {
              resultError = ev.isError
              resultSubtype = ev.subtype
              if (!ev.isError) sawTerminalSuccess = true
              if (ev.usage) {
                resultUsage = {
                  input: ev.usage.inputTokens,
                  output: ev.usage.outputTokens,
                  cacheRead: ev.usage.cacheRead ?? 0,
                }
              }
              if (!sawTextDelta && !sawText && ev.resultText) emitText(ev.resultText)
            }
          }
        }

        const finishStream = (code: number | null, signal: NodeJS.Signals | null = null): void => {
          if (closed) return
          try {
            const tail = buffer.trim()
            if (tail) handleLine(tail)
            if (reasonOpen) enqueue({ type: 'reasoning-end', id: REASON_ID })
            if (textOpen) enqueue({ type: 'text-end', id: TEXT_ID })
            const aborted = Boolean(abortSignal?.aborted)
            const processFailed = code !== 0
            const missingSuccess = !sawTerminalSuccess
            if (!sawText && code !== 0 && !aborted && !resultError) {
              enqueue({ type: 'text-start', id: TEXT_ID })
              enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ qwen-code bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
              })
              enqueue({ type: 'text-end', id: TEXT_ID })
            }
            const chosen = lastNonZeroUsage ?? resultUsage
            const failed = aborted || resultError || processFailed || missingSuccess
            enqueue({
              type: 'finish',
              finishReason: {
                unified: failed ? 'error' : 'stop',
                raw: aborted
                  ? 'aborted'
                  : resultError
                    ? (resultSubtype ?? 'error')
                    : processFailed
                      ? (signal ?? (code === null ? 'killed' : String(code)))
                      : missingSuccess
                        ? 'missing-result'
                        : String(code ?? 0),
              },
              usage: usageFromTokens(chosen?.input, chosen?.output, chosen?.cacheRead),
            })
            closed = true
            controller.close()
          } catch {
            closed = true
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }
        }

        const attach = (child: ChildProcess, allowRetry: boolean): void => {
          buffer = ''
          sawInit = false
          resumeRejected = false
          const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
          kill = (): void => {
            if (exited()) return
            try {
              if (!child.killed) child.kill('SIGTERM')
            } catch {
              /* already gone */
            }
            if (!killTimer) {
              killTimer = setTimeout(() => {
                if (!exited()) {
                  try {
                    child.kill('SIGKILL')
                  } catch {
                    /* gone */
                  }
                }
              }, KILL_GRACE_MS)
              killTimer.unref()
            }
          }
          if (abortSignal?.aborted) kill()
          else abortSignal?.addEventListener('abort', kill, { once: true })

          child.stdout?.setEncoding('utf8')
          child.stdout?.on('data', (s: string) => {
            buffer += s
            let nl = buffer.indexOf('\n')
            while (nl >= 0) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              if (line) handleLine(line)
              nl = buffer.indexOf('\n')
            }
          })
          child.stderr?.setEncoding('utf8')
          child.stderr?.on('data', (s: string) => {
            stderr += s
            if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
          })
          child.on('error', (err) => {
            enqueue({ type: 'error', error: err })
          })
          child.on('close', (code, signal) => {
            if (killTimer) {
              clearTimeout(killTimer)
              killTimer = undefined
            }
            abortSignal?.removeEventListener('abort', kill)
            const leftover = buffer
            if (leftover.trim()) handleLine(leftover.trim())
            buffer = ''
            const shouldRetry =
              allowRetry && !retried && !sawInit && resumeRejected && !abortSignal?.aborted
            if (shouldRetry) {
              retried = true
              const fresh = resolveSession(true)
              const retryArgs = makeArgs(fresh)
              const next = spawnFn(binary, retryArgs, {
                cwd,
                env: childEnv,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              attach(next, false)
              return
            }
            finishStream(code, signal)
          })
        }

        const child = spawnFn(binary, firstArgs, {
          cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        attach(child, Boolean(firstSess.sessionId))
      },
      cancel() {
        closed = true
        kill()
      },
    })

    return Promise.resolve({
      stream,
      request: {
        body: {
          args: firstArgs.map((a, i) => (i === 1 ? `<prompt ${a.length} chars>` : a)),
          sessionId: firstSess.nativeId,
        },
      },
    })
  }
}

export interface QwenCodeProviderConfig {
  name?: string
  model?: string
  binary?: string
  home?: string
  cwd?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export class QwenCodeProvider implements Provider {
  readonly id = QWEN_CODE_PROVIDER_ID
  readonly name: string
  private model: string
  private readonly binary: string
  private readonly cwd: string
  readonly home: string | undefined
  private readonly contextWindow: number
  private readonly outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: QwenCodeProviderConfig = {}) {
    this.name = config.name ?? QWEN_CODE_PROVIDER_ID
    this.model = config.model ?? ''
    this.binary = config.binary ?? defaultQwenBinary()
    this.cwd = config.cwd ?? join(homedir(), '.rivetos', 'workspace')
    this.home = config.home
    this.contextWindow = config.contextWindow ?? 262_144
    this.outputTokenLimit = config.maxOutputTokens ?? 8_192
  }

  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model ?? ''
  }
  getContextWindow(): number {
    return this.contextWindow
  }
  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  /**
   * `qwen --version` exits 0 with a semver on stdout → available. Cached.
   * If spawn is impossible, fall back to existsSync for an explicit path
   * (bare names that cannot spawn are not on PATH).
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available
    this.available = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      const fallback = (): boolean => {
        if (binaryIsPath(this.binary)) return existsSync(this.binary)
        return false
      }
      try {
        const proc = spawn(this.binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        proc.stdout?.setEncoding('utf8')
        proc.stdout?.on('data', (s: string) => {
          stdout += s
          if (stdout.length > 4_096) stdout = stdout.slice(0, 4_096)
        })
        const t = setTimeout(() => {
          proc.kill('SIGKILL')
          done(false)
        }, VERSION_PROBE_MS)
        t.unref()
        proc.once('error', () => {
          clearTimeout(t)
          done(fallback())
        })
        proc.once('exit', (code) => {
          clearTimeout(t)
          done(code === 0 && SEMVER_RE.test(stdout))
        })
      } catch {
        done(fallback())
      }
    })
    return this.available
  }

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, conversationId }: GetModelInput) =>
        new QwenCodeModel({
          providerId: this.id,
          modelId: modelOverride ?? this.model,
          binary: this.binary,
          cwd: this.cwd,
          conversationId,
        }),
      buildProviderOptions: () => undefined,
    }
  }
}

function cfgNum(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const manifest: PluginManifest = {
  type: 'provider',
  name: QWEN_CODE_PROVIDER_ID,
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new QwenCodeProvider({
        name: cfg.name as string | undefined,
        model: cfg.model as string | undefined,
        binary: cfg.binary as string | undefined,
        home: cfg.home as string | undefined,
        cwd: cfg.cwd as string | undefined,
        contextWindow: cfgNum(cfg.context_window),
        maxOutputTokens: cfgNum(cfg.max_output_tokens),
      }),
    )
  },
}

export default manifest
