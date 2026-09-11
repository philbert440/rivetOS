/**
 * @rivetos/provider-kimi-code — Kimi Code CLI provider.
 *
 * Each turn shells out to the local Kimi Code CLI (`kimi -p <prompt>
 * --output-format stream-json`) and replays the assistant lines of its JSON
 * stream as text. The stream's `session.resume_hint` meta event carries the
 * session id, remembered per RivetOS conversation
 * (~/.rivetos/kimi-code-sessions.json) and passed back as `-S` so the
 * conversation continues in one Kimi session. `home` sets KIMI_CODE_HOME.
 * Implements `aiSdkBridge()` (LanguageModelV3) for the agent loop.
 *
 * TypeScript port (2026-09-05) of the CommonJS plugin that ran untracked on
 * ct116 since 2026-08-18 (it never had a manifest, so boot never loaded it).
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

export const KIMI_CODE_PROVIDER_ID = 'kimi-code'
export const DEFAULT_MODEL = 'moonshotai/kimi-k3'
export const SESSION_MAP_FILE = 'kimi-code-sessions.json'
const NO_INSTRUCTION = '(no instruction was provided for this turn)'

export function defaultKimiBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIMI_BINARY || join(homedir(), '.local/bin/kimi')
}

/** The newest user message as plain text — Kimi keeps its own history via -S. */
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

export interface KimiSpawnFlags {
  binary: string
  modelId?: string
  sessionId?: string
}

export function buildArgs(flags: KimiSpawnFlags, prompt: string): string[] {
  const args = ['-p', prompt || NO_INSTRUCTION, '--output-format', 'stream-json']
  if (flags.modelId) args.push('-m', flags.modelId)
  if (flags.sessionId) args.push('-S', flags.sessionId)
  return args
}

/** One parsed stream-json line: assistant text, a session resume hint, usage, or nothing of interest. */
export type KimiEvent =
  | { kind: 'text'; text: string; usage?: LanguageModelV3Usage }
  | { kind: 'session'; sessionId: string }
  | { kind: 'usage'; usage: LanguageModelV3Usage }
  | { kind: 'other' }

function numField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * kimi 0.36.0 stream-json usage on the final assistant/result line.
 * Wire.jsonl `step.end` uses `inputOther` / `inputCacheRead` / `inputCacheCreation` /
 * `output`; the abbreviated `cacheRead` / `cacheCreation` aliases are accepted too.
 */
export function extractKimiUsage(obj: Record<string, unknown>): LanguageModelV3Usage | undefined {
  const bagRaw = obj.usage ?? obj.token ?? obj.tokens
  if (!bagRaw || typeof bagRaw !== 'object' || Array.isArray(bagRaw)) return undefined
  const u = bagRaw as Record<string, unknown>
  const other = numField(u.inputOther) ?? numField(u.input) ?? numField(u.input_tokens)
  const cacheRead = numField(u.inputCacheRead) ?? numField(u.cacheRead) ?? numField(u.cache_read)
  const cacheWrite =
    numField(u.inputCacheCreation) ?? numField(u.cacheCreation) ?? numField(u.cache_write)
  const output = numField(u.output) ?? numField(u.outputTokens) ?? numField(u.output_tokens)
  if (
    other === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined
  ) {
    return undefined
  }
  const prompt = (other ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const hasInput = other !== undefined || cacheRead !== undefined || cacheWrite !== undefined
  return {
    inputTokens: {
      total: hasInput ? prompt : undefined,
      noCache: other,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  }
}

export function parseKimiLine(line: string): KimiEvent {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (!ev || typeof ev !== 'object') return { kind: 'other' }
  const o = ev as Record<string, unknown>
  if (o.role === 'assistant' && typeof o.content === 'string' && o.content) {
    const usage = extractKimiUsage(o)
    return usage ? { kind: 'text', text: o.content, usage } : { kind: 'text', text: o.content }
  }
  if (
    o.role === 'meta' &&
    o.type === 'session.resume_hint' &&
    typeof o.session_id === 'string' &&
    o.session_id
  ) {
    return { kind: 'session', sessionId: o.session_id }
  }
  const usage = extractKimiUsage(o)
  if (usage) return { kind: 'usage', usage }
  return { kind: 'other' }
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

export interface KimiCodeModelConfig {
  providerId: string
  modelId: string
  binary: string
  cwd: string | undefined
  kimiHome: string | undefined
  conversationId: string | undefined
  /** Injected in tests. */
  sessionMapPath?: string
}

export class KimiCodeModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly config: KimiCodeModelConfig

  constructor(config: KimiCodeModelConfig) {
    this.config = config
    this.provider = config.providerId
    this.modelId = config.modelId || DEFAULT_MODEL
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()
    let text = ''
    let usage = emptyUsage()
    let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
      unified: 'stop',
      raw: undefined,
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      else if (value.type === 'finish') {
        usage = value.usage
        finishReason = value.finishReason
      }
    }
    return { content: [{ type: 'text', text }], finishReason, usage, warnings: [] }
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prompt = promptFromV3(options.prompt)
    const { binary, cwd, kimiHome } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const args = buildArgs({ binary, modelId: this.modelId, sessionId }, prompt)
    const abortSignal = options.abortSignal
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (kimiHome) childEnv.KIMI_CODE_HOME = kimiHome

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'kimi-text'
        let textOpen = false
        let sawText = false
        let stderr = ''
        let buffer = ''
        let usage = emptyUsage()
        controller.enqueue({ type: 'stream-start', warnings: [] })

        if (!existsSync(binary)) {
          controller.enqueue({
            type: 'error',
            error: new Error(`kimi binary not found at ${binary}`),
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
        const handleLine = (line: string): void => {
          const ev = parseKimiLine(line)
          if (ev.kind === 'text') {
            emitText(ev.text)
            if (ev.usage) usage = ev.usage
          } else if (ev.kind === 'usage') {
            usage = ev.usage
          } else if (
            ev.kind === 'session' &&
            ev.sessionId !== sessionId &&
            map[convKey] !== ev.sessionId
          ) {
            map[convKey] = ev.sessionId
            saveSessionMap(mapPath, map)
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
            if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
            if (!sawText && code !== 0) {
              controller.enqueue({ type: 'text-start', id: TEXT_ID })
              controller.enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ kimi-code bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
              })
              controller.enqueue({ type: 'text-end', id: TEXT_ID })
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: code === 0 ? 'stop' : 'error', raw: String(code) },
              usage,
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
        body: { args: args.map((a, i) => (i === 1 ? `<prompt ${a.length} chars>` : a)), sessionId },
      },
    })
  }
}

export interface KimiCodeProviderConfig {
  name?: string
  model?: string
  binary?: string
  home?: string
  cwd?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export class KimiCodeProvider implements Provider {
  readonly id = KIMI_CODE_PROVIDER_ID
  readonly name: string
  private model: string
  private readonly binary: string
  private readonly cwd: string
  private readonly kimiHome: string
  private readonly contextWindow: number
  private readonly outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: KimiCodeProviderConfig = {}) {
    this.name = config.name ?? 'Kimi Code (CLI)'
    this.model = config.model ?? DEFAULT_MODEL
    this.binary = config.binary ?? defaultKimiBinary()
    this.cwd = config.cwd ?? join(homedir(), '.rivetos', 'workspace')
    this.kimiHome = config.home ?? join(homedir(), '.kimi')
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
  /** `kimi --version` exits 0 → available. Cached after the first probe. */
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
        new KimiCodeModel({
          providerId: this.id,
          modelId: modelOverride ?? this.model,
          binary: this.binary,
          cwd: this.cwd,
          kimiHome: this.kimiHome,
          conversationId,
        }),
      buildProviderOptions: () => undefined,
    }
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const manifest: PluginManifest = {
  type: 'provider',
  name: KIMI_CODE_PROVIDER_ID,
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new KimiCodeProvider({
        name: cfg.name as string | undefined,
        model: cfg.model as string | undefined,
        binary: cfg.binary as string | undefined,
        home: cfg.home as string | undefined,
        cwd: cfg.cwd as string | undefined,
        contextWindow: num(cfg.context_window),
        maxOutputTokens: num(cfg.max_output_tokens),
      }),
    )
  },
}

export default manifest
