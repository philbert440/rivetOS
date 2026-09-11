/**
 * @rivetos/provider-opencode-cli — OpenCode CLI provider.
 *
 * Each turn shells out to the local OpenCode CLI (`opencode run <prompt>
 * --format json`) and replays JSON text parts as text. Session ids are
 * remembered per RivetOS conversation (~/.rivetos/opencode-cli-sessions.json)
 * and passed back as `--session` so the conversation continues in one
 * OpenCode session. `home` sets OPENCODE_CONFIG_DIR.
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
// REVIEWER-CONFIRM: exact default model id string on the fleet (z.ai GLM).
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
}

/**
 * REVIEWER-CONFIRM: spawn argv for opencode v1.18.25.
 * Spec-confirmed positional: `opencode run "<prompt>"`.
 * Assumed flags (flags before the message so they are not swallowed as
 * prompt tokens): `--format json`, `--model <id>`, `--session <id>`.
 * ACP (`opencode acp`) is not spawned from this bridge.
 */
export function buildArgs(flags: OpencodeSpawnFlags, prompt: string): string[] {
  const args = ['run', '--format', 'json']
  if (flags.modelId) args.push('--model', flags.modelId)
  if (flags.sessionId) args.push('--session', flags.sessionId)
  args.push(prompt || NO_INSTRUCTION)
  return args
}

/** One parsed JSON line: assistant text (optional session id), a session id, or nothing of interest. */
export type OpencodeEvent =
  | { kind: 'text'; text: string; sessionId?: string }
  | { kind: 'session'; sessionId: string }
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
  // REVIEWER-CONFIRM: ACP nd-JSON `session/update` text chunks, if `run --format json`
  // ever emits them (this bridge still drives `opencode run`, not `opencode acp`).
  if (typeof o.method === 'string' && o.method === 'session/update' && o.params && typeof o.params === 'object') {
    const params = o.params as Record<string, unknown>
    const update = params.update
    if (update && typeof update === 'object') {
      const u = update as Record<string, unknown>
      if (typeof u.text === 'string' && u.text) return u.text
      const content = u.content
      if (content && typeof content === 'object') {
        const c = content as Record<string, unknown>
        if (typeof c.text === 'string' && c.text) return c.text
      }
    }
  }
  return undefined
}

/**
 * REVIEWER-CONFIRM: JSON line shapes for `opencode run --format json`.
 * Assumed (kimi-style union, plus sessionID piggybacked on text events):
 *   { type: "text", text: "..." }
 *   { type: "text", sessionID: "ses_…", part: { text: "..." } }
 *   { type: "session", sessionID: "ses_…" }
 *   ACP-ish { method: "session/update", params: { update: { content: { text } } } }
 * Non-JSON lines are ignored.
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
  const text = textFromObject(o)
  const sessionId = sessionIdFromObject(o)
  if (text) return sessionId ? { kind: 'text', text, sessionId } : { kind: 'text', text }
  if (sessionId) return { kind: 'session', sessionId }
  return { kind: 'other' }
}

/** REVIEWER-CONFIRM: headless `run` "Session not found" when --session points at a missing session. */
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
    let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
      unified: 'stop',
      raw: undefined,
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      else if (value.type === 'finish') finishReason = value.finishReason
    }
    return { content: [{ type: 'text', text }], finishReason, usage: emptyUsage(), warnings: [] }
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prompt = promptFromV3(options.prompt)
    const { binary, cwd, opencodeHome } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const args = buildArgs({ binary, modelId: this.modelId, sessionId }, prompt)
    const abortSignal = options.abortSignal
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    // REVIEWER-CONFIRM: env var OpenCode honors for a relocated data/config dir.
    if (opencodeHome) childEnv.OPENCODE_CONFIG_DIR = opencodeHome

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'opencode-text'
        let textOpen = false
        let sawText = false
        let stderr = ''
        let buffer = ''
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
            // REVIEWER-CONFIRM: drop the mapped id so the *next* turn creates a
            // session (no in-turn retry — keeps the stream one-spawn like kimi).
            if (isSessionNotFound(stderr) || isSessionNotFound(tail)) {
              if (map[convKey]) {
                delete map[convKey]
                saveSessionMap(mapPath, map)
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
              usage: emptyUsage(),
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
  isAvailable(): Promise<boolean> {
    return Promise.resolve(existsSync(this.binary))
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
        contextWindow: num(cfg.context_window),
        maxOutputTokens: num(cfg.max_output_tokens),
      }),
    )
  },
}

export default manifest
