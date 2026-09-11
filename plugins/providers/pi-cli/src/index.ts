/**
 * @rivetos/provider-pi-cli — Pi CLI provider.
 *
 * Each turn shells out to the local pi coding agent
 * (`pi --print --mode json -- <prompt>`) and replays its runtime event stream
 * (`message_update` text/thinking deltas, `message_end` usage/stopReason,
 * `agent_settled`). A `type: "session"` event carries the native UUID,
 * remembered per RivetOS conversation (~/.rivetos/pi-cli-sessions.json) and
 * passed back as `--session` so the conversation continues in one pi session.
 * System messages go out as `--append-system-prompt`. Spawn stdin is ignored
 * (print mode blocks if it is open). Abort/cancel: SIGTERM, then SIGKILL after
 * 3s. Implements `aiSdkBridge()` (LanguageModelV3) for the agent loop.
 *
 * Provider id `pi-cli`; harness id `pi` (separate id-space).
 * Fleet default model is `deepseek/deepseek-v4-flash`.
 */
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

export const PI_CLI_PROVIDER_ID = 'pi-cli'
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'
export const SESSION_MAP_FILE = 'pi-cli-sessions.json'
const NO_INSTRUCTION = '(no instruction was provided for this turn)'

/** Grace period between SIGTERM and SIGKILL on abort / stream cancel. */
export const KILL_GRACE_MS = 3_000

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

/** Concatenate system messages for `--append-system-prompt`. */
export function systemFromV3(prompt: LanguageModelV3Prompt): string {
  const chunks: string[] = []
  for (const m of prompt) {
    if (m.role === 'system' && m.content) chunks.push(m.content)
  }
  return chunks.join('\n\n')
}

export interface PiSpawnFlags {
  binary: string
  modelId?: string
  sessionId?: string
  pinSessionId?: string
  sessionDir?: string
  appendSystemPrompt?: string
}

/**
 * `pi --print --mode json [--model m] [--session-id id | --session id]
 * [--session-dir d] [--append-system-prompt text] -- <prompt>`
 */
export function buildArgs(flags: PiSpawnFlags, prompt: string): string[] {
  const args = ['--print', '--mode', 'json']
  if (flags.pinSessionId) args.push('--session-id', flags.pinSessionId)
  else if (flags.sessionId) args.push('--session', flags.sessionId)
  if (flags.sessionDir) args.push('--session-dir', flags.sessionDir)
  if (flags.modelId) args.push('--model', flags.modelId)
  if (flags.appendSystemPrompt) args.push('--append-system-prompt', flags.appendSystemPrompt)
  args.push('--', prompt || NO_INSTRUCTION)
  return args
}

export type PiEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'text-snapshot'; text: string }
  | { kind: 'reasoning-snapshot'; text: string }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
      cacheWrite?: number
    }
  | { kind: 'tool-start'; id?: string; name: string; input?: unknown }
  | { kind: 'tool-delta'; delta: string }
  | { kind: 'tool-result'; id?: string; name?: string }
  | { kind: 'stop'; stopReason: string }
  | { kind: 'finish' }
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

function usageEvents(usage: Record<string, unknown> | undefined, stopReason?: unknown): PiEvent[] {
  if (!usage) return []
  if (stopReason === 'pending') return []
  const input =
    num(usage.input) || num(usage.input_tokens) || num(usage.inputTokens) || num(usage.promptTokens)
  const output =
    num(usage.output) ||
    num(usage.output_tokens) ||
    num(usage.outputTokens) ||
    num(usage.completionTokens)
  const cacheRead = num(usage.cacheRead) || num(usage.cache_read_tokens)
  const cacheWrite = num(usage.cacheWrite) || num(usage.cache_write_tokens)
  const cache = cacheRead + cacheWrite
  if (input + cache <= 0 && output <= 0) return []
  return [
    { kind: 'usage', inputTokens: input + cache, outputTokens: output, cacheRead, cacheWrite },
  ]
}

function toolFields(raw: Record<string, unknown>): { id?: string; name?: string; input: unknown } {
  const nested = isRecord(raw.content)
    ? raw.content
    : isRecord(raw.partial)
      ? raw.partial
      : isRecord(raw.toolCall)
        ? raw.toolCall
        : undefined
  return {
    id:
      str(raw.id) ||
      str(raw.toolCallId) ||
      (nested ? str(nested.id) || str(nested.toolCallId) : undefined),
    name:
      str(raw.name) ||
      str(raw.toolName) ||
      (nested ? str(nested.name) || str(nested.toolName) : undefined),
    input: raw.arguments ?? raw.input ?? nested?.arguments ?? nested?.input ?? {},
  }
}

function fatalStop(reason: string | undefined): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return r === 'error' || r === 'aborted'
}

/**
 * Runtime stdout lines from `pi --print --mode json` (NOT the on-disk
 * `type:message` session jsonl). `session.id` is the native UUID; text and
 * thinking arrive as `message_update.assistantMessageEvent` deltas;
 * `message_end` carries the snapshot (fallback only), usage, and stopReason;
 * `agent_end` / `agent_settled` mark finish.
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
    const id = str(ev.id) || str(ev.session_id) || str(ev.sessionId) || ''
    return id ? [{ kind: 'session', sessionId: id }] : [{ kind: 'other' }]
  }
  if (ev.type === 'agent_end' || ev.type === 'agent_settled') return [{ kind: 'finish' }]
  if (ev.type === 'message_update' && isRecord(ev.assistantMessageEvent)) {
    const inner = ev.assistantMessageEvent
    const t = inner.type
    if (t === 'text_delta' && typeof inner.delta === 'string' && inner.delta) {
      return [{ kind: 'text', text: inner.delta }]
    }
    if (t === 'thinking_delta' && typeof inner.delta === 'string' && inner.delta) {
      return [{ kind: 'reasoning', text: inner.delta }]
    }
    if (t === 'toolcall_delta' && typeof inner.delta === 'string' && inner.delta) {
      return [{ kind: 'tool-delta', delta: inner.delta }]
    }
    if (
      t === 'toolcall_start' ||
      t === 'toolcall_end' ||
      t === 'tool_call_start' ||
      t === 'tool_call_end'
    ) {
      const fields = toolFields(inner)
      return fields.name
        ? [{ kind: 'tool-start', id: fields.id, name: fields.name, input: fields.input }]
        : [{ kind: 'other' }]
    }
    return [{ kind: 'other' }]
  }
  if ((ev.type === 'message_end' || ev.type === 'turn_end') && isRecord(ev.message)) {
    const msg = ev.message
    const out: PiEvent[] = []
    if (msg.role === 'toolResult' || msg.role === 'tool_result') {
      out.push({
        kind: 'tool-result',
        id: str(msg.toolCallId) || str(msg.id),
        name: str(msg.toolName) || str(msg.name),
      })
      return out
    }
    if (msg.role === 'assistant') {
      if (isRecord(msg.usage)) out.push(...usageEvents(msg.usage, msg.stopReason))
      if (typeof msg.stopReason === 'string' && msg.stopReason && msg.stopReason !== 'pending') {
        out.push({ kind: 'stop', stopReason: msg.stopReason })
      }
      const content = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : []
      for (const raw of content) {
        if (!isRecord(raw)) continue
        if (raw.type === 'text' && typeof raw.text === 'string' && raw.text) {
          out.push({ kind: 'text-snapshot', text: raw.text })
        } else if (raw.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking) {
          out.push({ kind: 'reasoning-snapshot', text: raw.thinking })
        } else if (
          raw.type === 'toolCall' ||
          raw.type === 'tool_call' ||
          raw.type === 'toolUse' ||
          raw.type === 'tool_use'
        ) {
          const fields = toolFields(raw)
          if (fields.name)
            out.push({ kind: 'tool-start', id: fields.id, name: fields.name, input: fields.input })
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
  /** Injected in tests to assert spawn options. */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
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
    const systemText = systemFromV3(options.prompt)
    const { binary, cwd, sessionDir } = this.config
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath(SESSION_MAP_FILE)
    const map = loadSessionMap(mapPath)
    const sessionId = map[convKey]
    const args = buildArgs(
      {
        binary,
        modelId: this.modelId,
        sessionId,
        sessionDir,
        appendSystemPrompt: systemText || undefined,
      },
      prompt,
    )
    const abortSignal = options.abortSignal
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    const spawnFn = this.config.spawnImpl ?? spawn
    let closed = false
    let kill = (): void => {
      /* assigned once the child is spawned */
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const TEXT_ID = 'pi-text'
        const REASON_ID = 'pi-reason'
        let textOpen = false
        let reasonOpen = false
        let sawText = false
        let sawTextDelta = false
        let sawReasoningDelta = false
        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let cacheWriteTokens = 0
        let stopReason: string | undefined
        let stderr = ''
        let buffer = ''
        const enqueue = (part: LanguageModelV3StreamPart): void => {
          if (closed) return
          try {
            controller.enqueue(part)
          } catch {
            closed = true
          }
        }
        enqueue({ type: 'stream-start', warnings: [] })

        // Bare names (`pi`) resolve via PATH — same as isAvailable. existsSync
        // is only meaningful for an explicit path.
        if (binaryIsPath(binary) && !existsSync(binary)) {
          enqueue({
            type: 'error',
            error: new Error(`pi binary not found at ${binary}`),
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

        const child = spawnFn(binary, args, {
          cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let killTimer: ReturnType<typeof setTimeout> | undefined
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
          for (const ev of parsePiLine(line)) {
            if (ev.kind === 'text') {
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
              inputTokens = ev.inputTokens
              outputTokens = ev.outputTokens
              cacheReadTokens = ev.cacheRead ?? 0
              cacheWriteTokens = ev.cacheWrite ?? 0
            } else if (ev.kind === 'stop') {
              stopReason = ev.stopReason
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
        child.on('close', (code) => {
          if (killTimer) clearTimeout(killTimer)
          abortSignal?.removeEventListener('abort', kill)
          if (closed) return
          try {
            const tail = buffer.trim()
            if (tail) handleLine(tail)
            if (reasonOpen) enqueue({ type: 'reasoning-end', id: REASON_ID })
            if (textOpen) enqueue({ type: 'text-end', id: TEXT_ID })
            const aborted = Boolean(abortSignal?.aborted)
            const fatal = fatalStop(stopReason)
            if (!sawText && code !== 0 && !aborted && !fatal) {
              enqueue({ type: 'text-start', id: TEXT_ID })
              enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ pi-cli bridge error: ${(stderr || `exit ${String(code)}`).slice(0, 500)}`,
              })
              enqueue({ type: 'text-end', id: TEXT_ID })
            }
            if (fatal) {
              enqueue({ type: 'error', error: new Error(`pi stopReason: ${stopReason}`) })
            }
            enqueue({
              type: 'finish',
              finishReason: {
                unified: aborted || fatal || code !== 0 ? 'error' : 'stop',
                raw: aborted ? 'aborted' : fatal ? stopReason : String(code),
              },
              usage: usageFromTokens(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
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
        })
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
