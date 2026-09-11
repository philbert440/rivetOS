/**
 * @rivetos/provider-pi-cli — Pi CLI provider.
 *
 * Each turn shells out to the local pi coding agent
 * (`pi --print --mode json -- <prompt>`) and replays assistant text / thinking
 * of its JSON stream. A `type: "session"` event carries the native UUID,
 * remembered per RivetOS conversation (~/.rivetos/pi-cli-sessions.json) and
 * passed back as `--session` so the conversation continues in one pi session.
 * Implements `aiSdkBridge()` (LanguageModelV3) for the agent loop.
 *
 * Provider id `pi-cli`; harness id `pi` (separate id-space).
 * Fleet default model is `deepseek/deepseek-v4-flash`.
 */
import { spawn } from 'node:child_process'
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

export const PI_CLI_PROVIDER_ID = 'pi-cli'
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'
export const SESSION_MAP_FILE = 'pi-cli-sessions.json'
const NO_INSTRUCTION = '(no instruction was provided for this turn)'

/** Binary name is `pi` on PATH (not `pi-coding-agent`); override via $PI_BINARY. */
export function defaultPiBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_BINARY || 'pi'
}

function binaryIsPath(binary: string): boolean {
  return binary.includes('/') || binary.includes('\\')
}

/** The newest user message as plain text — pi keeps its own history via --session. */
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

export interface PiSpawnFlags {
  binary: string
  modelId?: string
  sessionId?: string
  pinSessionId?: string
  sessionDir?: string
}

/**
 * `pi --print --mode json [--model m] [--session-id id | --session id]
 * [--session-dir d] -- <prompt>`
 */
export function buildArgs(flags: PiSpawnFlags, prompt: string): string[] {
  const args = ['--print', '--mode', 'json']
  if (flags.pinSessionId) args.push('--session-id', flags.pinSessionId)
  else if (flags.sessionId) args.push('--session', flags.sessionId)
  if (flags.sessionDir) args.push('--session-dir', flags.sessionDir)
  if (flags.modelId) args.push('--model', flags.modelId)
  args.push('--', prompt || NO_INSTRUCTION)
  return args
}

export type PiEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
      cacheWrite?: number
    }
  | { kind: 'other' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Session JSONL version 3 lines from `pi --print --mode json`.
 * `session.id` is the native UUID; assistant `message.content` yields text
 * and thinking (one event per content item); assistant `message.usage`
 * yields token counts.
 */
export function parsePiLine(line: string): PiEvent[] {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return [{ kind: 'other' }]
  }
  if (!isRecord(ev) || typeof ev.type !== 'string') return [{ kind: 'other' }]
  if (ev.type === 'session') {
    const id =
      (typeof ev.id === 'string' && ev.id) ||
      (typeof ev.session_id === 'string' && ev.session_id) ||
      (typeof ev.sessionId === 'string' && ev.sessionId) ||
      ''
    return id ? [{ kind: 'session', sessionId: id }] : [{ kind: 'other' }]
  }
  if (ev.type === 'message' && isRecord(ev.message)) {
    const msg = ev.message
    const out: PiEvent[] = []
    if (msg.role === 'assistant' && isRecord(msg.usage)) {
      const input =
        num(msg.usage.input) ||
        num(msg.usage.input_tokens) ||
        num(msg.usage.inputTokens) ||
        num(msg.usage.promptTokens)
      const output =
        num(msg.usage.output) ||
        num(msg.usage.output_tokens) ||
        num(msg.usage.outputTokens) ||
        num(msg.usage.completionTokens)
      const cacheRead = num(msg.usage.cacheRead) || num(msg.usage.cache_read_tokens)
      const cacheWrite = num(msg.usage.cacheWrite) || num(msg.usage.cache_write_tokens)
      const cache = cacheRead + cacheWrite
      if (input + cache > 0 || output > 0) {
        out.push({
          kind: 'usage',
          inputTokens: input + cache,
          outputTokens: output,
          cacheRead,
          cacheWrite,
        })
      }
    }
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : []
    if (msg.role === 'assistant') {
      for (const raw of content) {
        if (!isRecord(raw)) continue
        if (raw.type === 'text' && typeof raw.text === 'string' && raw.text) {
          out.push({ kind: 'text', text: raw.text })
        } else if (raw.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking) {
          out.push({ kind: 'reasoning', text: raw.thinking })
        }
      }
    }
    return out.length > 0 ? out : [{ kind: 'other' }]
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
  cacheWrite?: number,
): LanguageModelV3Usage {
  const u = emptyUsage()
  if (input && input > 0) u.inputTokens.total = input
  if (output && output > 0) u.outputTokens.total = output
  if (cacheRead && cacheRead > 0) u.inputTokens.cacheRead = cacheRead
  if (cacheWrite && cacheWrite > 0) u.inputTokens.cacheWrite = cacheWrite
  return u
}

export interface PiCliModelConfig {
  providerId: string
  modelId: string
  binary: string
  cwd: string | undefined
  sessionDir: string | undefined
  conversationId: string | undefined
  /** Injected in tests. */
  sessionMapPath?: string
}

export class PiCliModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly config: PiCliModelConfig

  constructor(config: PiCliModelConfig) {
    this.config = config
    this.provider = config.providerId
    this.modelId = config.modelId || DEFAULT_MODEL
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
    const { binary, cwd, sessionDir } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const args = buildArgs({ binary, modelId: this.modelId, sessionId, sessionDir }, prompt)
    const abortSignal = options.abortSignal
    const childEnv: NodeJS.ProcessEnv = { ...process.env }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'pi-text'
        const REASON_ID = 'pi-reason'
        let textOpen = false
        let reasonOpen = false
        let sawText = false
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheWriteTokens = 0
        let stderr = ''
        let buffer = ''
        controller.enqueue({ type: 'stream-start', warnings: [] })

        // Bare names (`pi`) resolve via PATH — same as isAvailable. existsSync
        // is only meaningful for an explicit path.
        if (binaryIsPath(binary) && !existsSync(binary)) {
          controller.enqueue({
            type: 'error',
            error: new Error(`pi binary not found at ${binary}`),
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'error', raw: 'missing-binary' },
            usage: emptyUsage(),
          })
          controller.close()
          return
        }

        const child = spawn(binary, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        const kill = (): void => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* already gone */
          }
        }
        if (abortSignal?.aborted) kill()
        else abortSignal?.addEventListener('abort', kill, { once: true })

        const emitText = (chunk: string): void => {
          if (!chunk) return
          if (!textOpen) {
            controller.enqueue({ type: 'text-start', id: TEXT_ID })
            textOpen = true
          }
          sawText = true
          controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta: chunk })
        }
        const emitReason = (chunk: string): void => {
          if (!chunk) return
          if (!reasonOpen) {
            controller.enqueue({ type: 'reasoning-start', id: REASON_ID })
            reasonOpen = true
          }
          controller.enqueue({ type: 'reasoning-delta', id: REASON_ID, delta: chunk })
        }
        const handleLine = (line: string): void => {
          for (const ev of parsePiLine(line)) {
            if (ev.kind === 'text') emitText(ev.text)
            else if (ev.kind === 'reasoning') emitReason(ev.text)
            else if (ev.kind === 'usage') {
              inputTokens += ev.inputTokens
              outputTokens += ev.outputTokens
              cacheReadTokens += ev.cacheRead ?? 0
              cacheWriteTokens += ev.cacheWrite ?? 0
            } else if (
              ev.kind === 'session' &&
              ev.sessionId !== sessionId &&
              map[convKey] !== ev.sessionId
            ) {
              map[convKey] = ev.sessionId
              saveSessionMap(mapPath, map)
            }
          }
        }

        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (s: string) => {
          buffer += s
          let nl = buffer.indexOf('\n')
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line) handleLine(line)
            nl = buffer.indexOf('\n')
          }
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (s: string) => {
          stderr += s
          if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
        })
        child.on('error', (err) => {
          try {
            controller.enqueue({ type: 'error', error: err })
          } catch {
            /* stream already closed */
          }
        })
        child.on('close', (code) => {
          try {
            abortSignal?.removeEventListener('abort', kill)
            const tail = buffer.trim()
            if (tail) handleLine(tail)
            if (reasonOpen) controller.enqueue({ type: 'reasoning-end', id: REASON_ID })
            if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
            if (!sawText && code !== 0) {
              controller.enqueue({ type: 'text-start', id: TEXT_ID })
              controller.enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ pi-cli bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
              })
              controller.enqueue({ type: 'text-end', id: TEXT_ID })
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: code === 0 ? 'stop' : 'error', raw: String(code) },
              usage: usageFromTokens(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
            })
            controller.close()
          } catch {
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }
        })
      },
    })

    return Promise.resolve({
      stream,
      request: {
        body: {
          args: args.map((a, i) => (i === args.length - 1 ? `<prompt ${a.length} chars>` : a)),
          sessionId,
        },
      },
    })
  }
}

export interface PiCliProviderConfig {
  name?: string
  model?: string
  binary?: string
  home?: string
  cwd?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export class PiCliProvider implements Provider {
  readonly id = PI_CLI_PROVIDER_ID
  readonly name: string
  private model: string
  private readonly binary: string
  private readonly cwd: string
  private readonly sessionDir: string | undefined
  private readonly contextWindow: number
  private readonly outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: PiCliProviderConfig = {}) {
    this.name = config.name ?? 'Pi (CLI)'
    this.model = config.model ?? DEFAULT_MODEL
    this.binary = config.binary ?? defaultPiBinary()
    this.cwd = config.cwd ?? join(homedir(), '.rivetos', 'workspace')
    this.sessionDir = config.home ? join(config.home, 'sessions') : undefined
    this.contextWindow = config.contextWindow ?? 256_000
    this.outputTokenLimit = config.maxOutputTokens ?? 8_192
  }

  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model || DEFAULT_MODEL
  }
  getContextWindow(): number {
    return this.contextWindow
  }
  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  /** `pi --version` exits 0 → available. Cached after the first probe. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available
    this.available = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const proc = spawn(this.binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
        const t = setTimeout(() => {
          proc.kill('SIGKILL')
          done(false)
        }, 15_000)
        t.unref()
        proc.once('error', () => {
          clearTimeout(t)
          done(false)
        })
        proc.once('exit', (code) => {
          clearTimeout(t)
          done(code === 0)
        })
      } catch {
        done(false)
      }
    })
    return this.available
  }

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, conversationId }: GetModelInput) =>
        new PiCliModel({
          providerId: this.id,
          modelId: modelOverride ?? this.model,
          binary: this.binary,
          cwd: this.cwd,
          sessionDir: this.sessionDir,
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
  name: PI_CLI_PROVIDER_ID,
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new PiCliProvider({
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
