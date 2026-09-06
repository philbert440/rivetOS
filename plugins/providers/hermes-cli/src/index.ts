/**
 * @rivetos/provider-hermes-cli — Hermes Agent CLI provider.
 *
 * Each turn shells out to the local Hermes Agent (`hermes chat -q <prompt>
 * -Q --yolo --cli`), so the agent gets Hermes's own tools, skills, memory
 * plugin and model config (~/.hermes/config.yaml). Quiet mode puts the final
 * answer on stdout and the session id on stderr (`session_id: …`); the id is
 * remembered per RivetOS conversation (~/.rivetos/hermes-cli-sessions.json)
 * and passed back as `--resume` so the conversation continues in one Hermes
 * session. Implements `aiSdkBridge()` (LanguageModelV3) for the agent loop.
 *
 * TypeScript port (2026-09-05) of the CommonJS plugin that ran untracked on
 * ct113/ct114 since 2026-08-18 — behavior unchanged.
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

export const HERMES_CLI_PROVIDER_ID = 'hermes-cli'
export const DEFAULT_MODEL = 'qwen-27b'
export const SESSION_MAP_FILE = 'hermes-cli-sessions.json'

export function defaultHermesBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_BINARY || join(homedir(), '.local/bin/hermes')
}

/** The newest user message as plain text — Hermes keeps its own history via --resume. */
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

export interface HermesSpawnFlags {
  binary: string
  modelId?: string
  cwd?: string
  sessionId?: string
}

export function buildArgs(flags: HermesSpawnFlags, prompt: string): string[] {
  const args = ['chat', '-q', prompt || '(empty)', '-Q', '--yolo', '--cli']
  if (flags.modelId) args.push('-m', flags.modelId)
  if (flags.cwd) args.push('--in', flags.cwd)
  if (flags.sessionId) args.push('--resume', flags.sessionId)
  return args
}

const SESSION_RE = /session_id:\s*(\S+)/

/** Session id announced on stderr in quiet mode, or undefined. */
export function sessionIdFromStderr(stderr: string): string | undefined {
  const m = SESSION_RE.exec(stderr)
  return m?.[1] || undefined
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

export interface HermesCliModelConfig {
  providerId: string
  modelId: string
  binary: string
  cwd: string | undefined
  conversationId: string | undefined
  /** Injected in tests. */
  sessionMapPath?: string
}

export class HermesCliModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private readonly config: HermesCliModelConfig

  constructor(config: HermesCliModelConfig) {
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
    const { binary, cwd } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const args = buildArgs({ binary, modelId: this.modelId, cwd, sessionId }, prompt)
    const abortSignal = options.abortSignal

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'hermes-text'
        let textOpen = false
        let sawText = false
        let stderr = ''
        controller.enqueue({ type: 'stream-start', warnings: [] })

        if (!existsSync(binary)) {
          controller.enqueue({
            type: 'error',
            error: new Error(`hermes binary not found at ${binary}`),
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'error', raw: 'missing-binary' },
            usage: emptyUsage(),
          })
          controller.close()
          return
        }

        const child = spawn(binary, args, {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
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

        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (s: string) => emitText(s))
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (s: string) => {
          stderr += s
          if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
          const sid = sessionIdFromStderr(stderr)
          if (sid && sid !== sessionId && map[convKey] !== sid) {
            map[convKey] = sid
            saveSessionMap(mapPath, map)
          }
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
            if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
            if (!sawText && code !== 0) {
              controller.enqueue({ type: 'text-start', id: TEXT_ID })
              controller.enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ hermes-cli bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
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
        body: { args: args.map((a, i) => (i === 2 ? `<prompt ${a.length} chars>` : a)), sessionId },
      },
    })
  }
}

export interface HermesCliProviderConfig {
  name?: string
  model?: string
  binary?: string
  cwd?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export class HermesCliProvider implements Provider {
  readonly id = HERMES_CLI_PROVIDER_ID
  readonly name: string
  private model: string
  private readonly binary: string
  private readonly cwd: string
  private readonly contextWindow: number
  private readonly outputTokenLimit: number

  constructor(config: HermesCliProviderConfig = {}) {
    this.name = config.name ?? 'Hermes Agent (CLI)'
    this.model = config.model ?? DEFAULT_MODEL
    this.binary = config.binary ?? defaultHermesBinary()
    this.cwd = config.cwd ?? join(homedir(), '.rivetos', 'workspace')
    this.contextWindow = config.contextWindow ?? 262_144
    this.outputTokenLimit = config.maxOutputTokens ?? 81_920
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
        new HermesCliModel({
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

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const manifest: PluginManifest = {
  type: 'provider',
  name: HERMES_CLI_PROVIDER_ID,
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new HermesCliProvider({
        name: cfg.name as string | undefined,
        model: cfg.model as string | undefined,
        binary: cfg.binary as string | undefined,
        cwd: cfg.cwd as string | undefined,
        contextWindow: num(cfg.context_window),
        maxOutputTokens: num(cfg.max_output_tokens),
      }),
    )
  },
}

export default manifest
