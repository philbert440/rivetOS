/**
 * @rivetos/provider-opencode-cli — OpenCode CLI provider.
 *
 * Each turn shells out to the local OpenCode CLI (`opencode run --format json
 * <prompt>`) and replays JSON text parts as text. Session ids are
 * remembered per RivetOS conversation (~/.rivetos/opencode-cli-sessions.json)
 * and passed back as `--session` so the conversation continues in one
 * OpenCode session. `home` is the data dir (`$XDG_DATA_HOME/opencode`).
 * Implements `aiSdkBridge()` (LanguageModelV3) for the agent loop.
 *
 * Drive contract is per-turn `opencode run`, not the long-lived ACP
 * nd-JSON server (`opencode acp`). The harness package owns ACP/PTY.
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

export const OPENCODE_CLI_PROVIDER_ID = 'opencode-cli'
/** Fleet default — the `[1m]` suffix is not valid on z.ai. */
export const DEFAULT_MODEL = 'zai/glm-5.3-flash'
export const SESSION_MAP_FILE = 'opencode-cli-sessions.json'
const NO_INSTRUCTION = '(no instruction was provided for this turn)'

export function defaultOpencodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_BINARY || join(homedir(), '.local/bin/opencode')
}

/** The newest user message as plain text — OpenCode keeps its own history via --session. */
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

export interface OpencodeSpawnFlags {
  binary: string
  modelId?: string
  sessionId?: string
  /** RivetOS effort id; mapped to `--variant`. */
  effort?: string
}

/**
 * Map a RivetOS effort id onto OpenCode `--variant`.
 * low→minimal, medium→omit, high→high, xhigh/max→max.
 */
export function variantForEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined
  const key = effort.trim().toLowerCase()
  if (key === 'low' || key === 'minimal') return 'minimal'
  if (key === 'medium' || key === 'default' || key === '') return undefined
  if (key === 'high') return 'high'
  if (key === 'xhigh' || key === 'max') return 'max'
  return undefined
}

/**
 * Spawn argv for opencode 1.18.30:
 *   opencode run --format json [-m model] [--variant v] [-s id] <prompt>
 */
export function buildArgs(flags: OpencodeSpawnFlags, prompt: string): string[] {
  const args = ['run', '--format', 'json']
  if (flags.modelId) args.push('--model', flags.modelId)
  const variant = variantForEffort(flags.effort)
  if (variant) args.push('--variant', variant)
  if (flags.sessionId) args.push('--session', flags.sessionId)
  args.push(prompt || NO_INSTRUCTION)
  return args
}

/** One parsed JSON line: assistant text, a session id, usage, or nothing of interest. */
export type OpencodeEvent =
  | { kind: 'text'; text: string; sessionId?: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'usage'; usage: LanguageModelV3Usage }
  | { kind: 'other' }

function stringField(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = o[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function sessionIdFromObject(o: Record<string, unknown>): string | undefined {
  const direct = stringField(o, ['sessionID', 'sessionId', 'session_id'])
  if (direct) return direct
  if (o.session && typeof o.session === 'object') {
    const id = (o.session as Record<string, unknown>).id
    if (typeof id === 'string' && id) return id
  }
  if (o.part && typeof o.part === 'object') {
    const nested = sessionIdFromObject(o.part as Record<string, unknown>)
    if (nested) return nested
  }
  if (o.params && typeof o.params === 'object') {
    const nested = sessionIdFromObject(o.params as Record<string, unknown>)
    if (nested) return nested
  }
  return undefined
}

function textFromObject(o: Record<string, unknown>): string | undefined {
  if (typeof o.text === 'string' && o.text) return o.text
  if (o.part && typeof o.part === 'object') {
    const p = o.part as Record<string, unknown>
    if (typeof p.text === 'string' && p.text) return p.text
  }
  return undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function usageFromTokens(tokens: Record<string, unknown>): LanguageModelV3Usage {
  const cache =
    tokens.cache && typeof tokens.cache === 'object' && !Array.isArray(tokens.cache)
      ? (tokens.cache as Record<string, unknown>)
      : undefined
  const input = num(tokens.input)
  const output = num(tokens.output)
  const reasoning = num(tokens.reasoning)
  const cacheRead = cache ? num(cache.read) : undefined
  const cacheWrite = cache ? num(cache.write) : undefined
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total:
        output !== undefined || reasoning !== undefined
          ? (output ?? 0) + (reasoning ?? 0)
          : undefined,
      text: output,
      reasoning,
    },
  }
}

/**
 * JSON line shapes for `opencode run --format json` (same objects as
 * message/part rows). Unknown `type` → ignore.
 */
export function parseOpencodeLine(line: string): OpencodeEvent {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (!ev || typeof ev !== 'object') return { kind: 'other' }
  const o = ev as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : ''
  const text = type === 'text' || type === '' ? textFromObject(o) : undefined
  const sessionId = sessionIdFromObject(o)
  if (text) return sessionId ? { kind: 'text', text, sessionId } : { kind: 'text', text }
  if (o.role === 'assistant' && o.tokens && typeof o.tokens === 'object') {
    return { kind: 'usage', usage: usageFromTokens(o.tokens as Record<string, unknown>) }
  }
  if (type === 'step-finish' || type === 'step_finish') {
    if (o.tokens && typeof o.tokens === 'object') {
      return { kind: 'usage', usage: usageFromTokens(o.tokens as Record<string, unknown>) }
    }
  }
  if (sessionId) return { kind: 'session', sessionId }
  return { kind: 'other' }
}

/** A missing `-s` id exits non-zero; wording is unknown so this is a stderr hint. */
export function isSessionNotFound(text: string): boolean {
  return /session not found/i.test(text)
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

export interface OpencodeCliModelConfig {
  providerId: string
  modelId: string
  binary: string
  cwd: string | undefined
  opencodeHome: string | undefined
  conversationId: string | undefined
  /** RivetOS effort id; mapped to `--variant`. */
  effort?: string
  /** Injected in tests. */
  sessionMapPath?: string
}

export class OpencodeCliModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly config: OpencodeCliModelConfig

  constructor(config: OpencodeCliModelConfig) {
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
        finishReason = value.finishReason
        if (value.usage) usage = value.usage
      }
    }
    return { content: [{ type: 'text', text }], finishReason, usage, warnings: [] }
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prompt = promptFromV3(options.prompt)
    const { binary, cwd, opencodeHome } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const effortFromOpts = options.providerOptions?.['opencode-cli']
    const effortRaw =
      effortFromOpts && typeof effortFromOpts === 'object' && !Array.isArray(effortFromOpts)
        ? ((effortFromOpts as Record<string, unknown>).variant ??
          (effortFromOpts as Record<string, unknown>).effort)
        : undefined
    const effort = typeof effortRaw === 'string' ? effortRaw : this.config.effort
    const args = buildArgs({ binary, modelId: this.modelId, sessionId, effort }, prompt)
    const abortSignal = options.abortSignal
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (opencodeHome) {
      childEnv.XDG_DATA_HOME =
        opencodeHome.endsWith('/opencode') || opencodeHome.endsWith('\\opencode')
          ? opencodeHome.slice(0, opencodeHome.lastIndexOf('opencode') - 1)
          : opencodeHome
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'opencode-text'
        let textOpen = false
        let sawText = false
        let stderr = ''
        let buffer = ''
        let usage = emptyUsage()
        controller.enqueue({ type: 'stream-start', warnings: [] })

        if (!existsSync(binary)) {
          controller.enqueue({
            type: 'error',
            error: new Error(`opencode binary not found at ${binary}`),
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
        const rememberSession = (id: string): void => {
          if (id !== sessionId && map[convKey] !== id) {
            map[convKey] = id
            saveSessionMap(mapPath, map)
          }
        }
        const handleLine = (line: string): void => {
          const ev = parseOpencodeLine(line)
          if (ev.kind === 'text') {
            emitText(ev.text)
            if (ev.sessionId) rememberSession(ev.sessionId)
          } else if (ev.kind === 'session') {
            rememberSession(ev.sessionId)
          } else if (ev.kind === 'usage') {
            usage = ev.usage
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
            // A missing `-s` id exits non-zero. Drop the mapped id so the
            // next turn creates a session (no in-turn retry).
            if (sessionId && (code !== 0 || isSessionNotFound(stderr) || isSessionNotFound(tail))) {
              if (map[convKey]) {
                const next = Object.fromEntries(
                  Object.entries(map).filter(([k]) => k !== convKey),
                )
                saveSessionMap(mapPath, next)
              }
            }
            if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
            if (!sawText && code !== 0) {
              controller.enqueue({ type: 'text-start', id: TEXT_ID })
              controller.enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ opencode-cli bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
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
        body: {
          args: args.map((a, i) => (i === args.length - 1 ? `<prompt ${a.length} chars>` : a)),
          sessionId,
        },
      },
    })
  }
}

export interface OpencodeCliProviderConfig {
  name?: string
  model?: string
  binary?: string
  home?: string
  cwd?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export class OpencodeCliProvider implements Provider {
  readonly id = OPENCODE_CLI_PROVIDER_ID
  readonly name: string
  private model: string
  private readonly binary: string
  private readonly cwd: string
  private readonly opencodeHome: string
  private readonly contextWindow: number
  private readonly outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: OpencodeCliProviderConfig = {}) {
    this.name = config.name ?? 'OpenCode (CLI)'
    this.model = config.model ?? DEFAULT_MODEL
    this.binary = config.binary ?? defaultOpencodeBinary()
    this.cwd = config.cwd ?? join(homedir(), '.rivetos', 'workspace')
    this.opencodeHome = config.home ?? join(homedir(), '.local/share/opencode')
    this.contextWindow = config.contextWindow ?? 1_000_000
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
  /** `opencode --version` exits 0 → available. Cached after the first probe. */
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
        new OpencodeCliModel({
          providerId: this.id,
          modelId: modelOverride ?? this.model,
          binary: this.binary,
          cwd: this.cwd,
          opencodeHome: this.opencodeHome,
          conversationId,
        }),
      buildProviderOptions: (_messages, options) => {
        const thinking = options?.thinking
        if (!thinking || thinking === 'off') return undefined
        const variant = variantForEffort(thinking)
        if (!variant) return undefined
        return { [OPENCODE_CLI_PROVIDER_ID]: { variant } }
      },
    }
  }
}

function positiveNum(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const manifest: PluginManifest = {
  type: 'provider',
  name: OPENCODE_CLI_PROVIDER_ID,
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new OpencodeCliProvider({
        name: cfg.name as string | undefined,
        model: cfg.model as string | undefined,
        binary: cfg.binary as string | undefined,
        home: cfg.home as string | undefined,
        cwd: cfg.cwd as string | undefined,
        contextWindow: positiveNum(cfg.context_window),
        maxOutputTokens: positiveNum(cfg.max_output_tokens),
      }),
    )
  },
}

export default manifest
