/**
 * @rivetos/provider-pi-cli — Pi CLI provider.
 *
 * Each turn shells out to the local pi coding agent (`pi -p <prompt>
 * --mode json`) and replays assistant text events of its JSON stream.
 * A `type: "session"` event carries the session id, remembered per
 * RivetOS conversation (~/.rivetos/pi-cli-sessions.json) and passed
 * back as `--session` so the conversation continues in one pi session.
 * `home` sets PI_HOME. Implements `aiSdkBridge()` (LanguageModelV3)
 * for the agent loop.
 *
 * Provider id `pi-cli`; harness id `pi` (separate id-space).
 * Backend is pi-ai; fleet default is z.ai GLM.
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
export const DEFAULT_MODEL = 'glm-5.3-flash'
export const SESSION_MAP_FILE = 'pi-cli-sessions.json'
const NO_INSTRUCTION = '(no instruction was provided for this turn)'

/** REVIEWER-CONFIRM: bin name is `pi` (not `pi-coding-agent`); override via $PI_BINARY. */
export function defaultPiBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_BINARY || join(homedir(), '.local/bin/pi')
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
}

/**
 * REVIEWER-CONFIRM: print/JSON spawn args against the installed
 * `@earendil-works/pi-coding-agent`. Assumed: `pi -p <prompt> --mode json`
 * plus optional `--model` and `--session`. Alternatives to check: `--json`
 * boolean, `--output-format json`, `--resume` instead of `--session`.
 */
export function buildArgs(flags: PiSpawnFlags, prompt: string): string[] {
  const args = ['-p', prompt || NO_INSTRUCTION, '--mode', 'json']
  if (flags.modelId) args.push('--model', flags.modelId)
  if (flags.sessionId) args.push('--session', flags.sessionId)
  return args
}

/** One parsed print/JSON line: assistant text, a session id, or nothing of interest. */
export type PiEvent =
  { kind: 'text'; text: string } | { kind: 'session'; sessionId: string } | { kind: 'other' }

/**
 * REVIEWER-CONFIRM: NDJSON event shapes from `pi --mode json`. Assumed:
 *   { "type": "text", "text": "..." }
 *   { "type": "session", "sessionId": "..." }
 * Confirm (and extend) against a real `pi -p --mode json` capture.
 */
export function parsePiLine(line: string): PiEvent {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (!ev || typeof ev !== 'object') return { kind: 'other' }
  const o = ev as Record<string, unknown>
  if (o.type === 'text' && typeof o.text === 'string' && o.text) {
    return { kind: 'text', text: o.text }
  }
  if (o.type === 'session' && typeof o.sessionId === 'string' && o.sessionId) {
    return { kind: 'session', sessionId: o.sessionId }
  }
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

export interface PiCliModelConfig {
  providerId: string
  modelId: string
  binary: string
  cwd: string | undefined
  piHome: string | undefined
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
    const { binary, cwd, piHome } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const args = buildArgs({ binary, modelId: this.modelId, sessionId }, prompt)
    const abortSignal = options.abortSignal
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (piHome) childEnv.PI_HOME = piHome

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'pi-text'
        let textOpen = false
        let sawText = false
        let stderr = ''
        let buffer = ''
        controller.enqueue({ type: 'stream-start', warnings: [] })

        if (!existsSync(binary)) {
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
        const handleLine = (line: string): void => {
          const ev = parsePiLine(line)
          if (ev.kind === 'text') emitText(ev.text)
          else if (
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
                delta: `⚠️ pi-cli bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
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
        body: { args: args.map((a, i) => (i === 1 ? `<prompt ${a.length} chars>` : a)), sessionId },
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
  private readonly piHome: string
  private readonly contextWindow: number
  private readonly outputTokenLimit: number

  constructor(config: PiCliProviderConfig = {}) {
    this.name = config.name ?? 'Pi (CLI)'
    this.model = config.model ?? DEFAULT_MODEL
    this.binary = config.binary ?? defaultPiBinary()
    this.cwd = config.cwd ?? join(homedir(), '.rivetos', 'workspace')
    this.piHome = config.home ?? join(homedir(), '.pi')
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
  isAvailable(): Promise<boolean> {
    return Promise.resolve(existsSync(this.binary))
  }

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, conversationId }: GetModelInput) =>
        new PiCliModel({
          providerId: this.id,
          modelId: modelOverride ?? this.model,
          binary: this.binary,
          cwd: this.cwd,
          piHome: this.piHome,
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
        contextWindow: num(cfg.context_window),
        maxOutputTokens: num(cfg.max_output_tokens),
      }),
    )
  },
}

export default manifest
