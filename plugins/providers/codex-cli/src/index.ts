/** Codex CLI provider. Uses `codex exec --json` and the user's Codex/ChatGPT login. */
import { spawn } from 'node:child_process'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import type { ProviderAiSdkBridge, GetModelInput } from '@rivetos/aisdk'
import type { Provider, PluginManifest, ChatOptions, Message } from '@rivetos/types'
import type { JSONObject } from '@ai-sdk/provider'
import { defaultSessionMapPath, loadSessionMap, saveSessionMap } from './session-map.js'

export {
  defaultSessionMapPath,
  loadSessionMap,
  saveSessionMap,
  SESSION_MAP_FILE,
} from './session-map.js'
export const CODEX_CLI_PROVIDER_ID = 'codex-cli'
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type CodexSessionMode = 'resume' | 'replay'

const SEP = '\n\n---\n\n'
const NO_PROMPT = 'USER:\n(no message)'

export function renderPrompt(prompt: LanguageModelV3Prompt): string {
  const chunks: string[] = []
  for (const message of prompt) {
    if (message.role === 'system') chunks.push(`SYSTEM:\n${message.content}`)
    else if (message.role === 'user') {
      const text = message.content
        .map((p) => (p.type === 'text' ? p.text : `[attachment: ${p.mediaType}]`))
        .join('\n')
      if (text) chunks.push(`USER:\n${text}`)
    } else if (message.role === 'assistant') {
      const text = message.content
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('')
      if (text) chunks.push(`ASSISTANT:\n${text}`)
    } else {
      for (const p of message.content) {
        if (p.type !== 'tool-result') continue
        const o = p.output
        const text =
          o.type === 'text' || o.type === 'error-text'
            ? o.value
            : o.type === 'json' || o.type === 'error-json'
              ? JSON.stringify(o.value)
              : `[${o.type}]`
        chunks.push(`TOOL RESULT (${p.toolName}):\n${text}`)
      }
    }
  }
  return chunks.join(SEP) || NO_PROMPT
}

export function newestUserPrompt(prompt: LanguageModelV3Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]
    if (m.role !== 'user') continue
    const text = m.content
      .map((p) => (p.type === 'text' ? p.text : `[attachment: ${p.mediaType}]`))
      .join('\n')
    return text || NO_PROMPT
  }
  return NO_PROMPT
}

export interface CodexSpawnFlags {
  binary: string
  modelId?: string
  reasoningEffort?: CodexReasoningEffort
  cwd?: string
  sandbox: CodexSandbox
  approveForMe: boolean
  skipGitRepoCheck: boolean
  profile?: string
  sessionId?: string
}

export function buildArgs(flags: CodexSpawnFlags): string[] {
  const args = ['exec']
  if (flags.sessionId) args.push('resume', flags.sessionId)
  args.push('--json', '-s', flags.sandbox)
  if (flags.approveForMe) args.push('--approve-for-me')
  if (flags.skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (flags.cwd) args.push('-C', flags.cwd)
  if (flags.modelId) args.push('-m', flags.modelId)
  if (flags.profile) args.push('-p', flags.profile)
  if (flags.reasoningEffort) args.push('-c', `model_reasoning_effort=${flags.reasoningEffort}`)
  args.push('-')
  return args
}

export interface CodexEvent {
  type: string
  thread_id?: string
  item?: { type?: string; text?: string }
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    cache_write_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
  }
  error?: { message?: string }
  [key: string]: unknown
}

export function parseCodexLine(line: string): CodexEvent | null {
  try {
    const value: unknown = JSON.parse(line)
    return value &&
      typeof value === 'object' &&
      typeof (value as { type?: unknown }).type === 'string'
      ? (value as CodexEvent)
      : null
  } catch {
    return null
  }
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

export function usageFromEvent(event: CodexEvent): LanguageModelV3Usage {
  if (event.type !== 'turn.completed') return emptyUsage()
  const u = event.usage
  return {
    inputTokens: {
      total: u?.input_tokens,
      noCache:
        typeof u?.input_tokens === 'number'
          ? u.input_tokens - (u.cached_input_tokens ?? 0) - (u.cache_write_input_tokens ?? 0)
          : undefined,
      cacheRead: u?.cached_input_tokens,
      cacheWrite: u?.cache_write_input_tokens,
    },
    outputTokens: {
      total: u?.output_tokens,
      text:
        typeof u?.output_tokens === 'number'
          ? u.output_tokens - (u.reasoning_output_tokens ?? 0)
          : undefined,
      reasoning: u?.reasoning_output_tokens,
    },
  }
}

export interface CodexCliModelConfig extends CodexSpawnFlags {
  providerId: string
  modelId: string
  conversationId?: string
  sessionMode: CodexSessionMode
  sessionMapPath?: string
}

export class CodexCliModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}
  constructor(private readonly config: CodexCliModelConfig) {
    this.provider = config.providerId
    this.modelId = config.modelId || 'default'
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
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
      } else if (value.type === 'error') throw value.error
    }
    return { content: text ? [{ type: 'text', text }] : [], usage, finishReason, warnings: [] }
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const convKey = this.config.conversationId || 'default'
    const mapPath = this.config.sessionMapPath ?? defaultSessionMapPath()
    const map = loadSessionMap(mapPath)
    const resumeId = this.config.sessionMode === 'resume' ? map[convKey] : undefined
    const prompt = resumeId ? newestUserPrompt(options.prompt) : renderPrompt(options.prompt)
    const raw = (
      options.providerOptions?.[this.provider] as { reasoningEffort?: unknown } | undefined
    )?.reasoningEffort
    const reasoningEffort =
      raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh'
        ? raw
        : this.config.reasoningEffort
    const flags = {
      ...this.config,
      modelId: this.modelId === 'default' ? undefined : this.modelId,
      reasoningEffort,
      sessionId: resumeId,
    }
    const args = buildArgs(flags)
    const request = { body: { args, promptChars: prompt.length } }
    const abortSignal = options.abortSignal
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        const child = spawn(flags.binary, args, {
          cwd: flags.cwd,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let buffer = ''
        let stderr = ''
        let textOpen = false
        let sawText = false
        let usage = emptyUsage()
        let threadId = resumeId
        let failed = ''
        const kill = (): void => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* gone */
          }
        }
        if (abortSignal?.aborted) kill()
        else abortSignal?.addEventListener('abort', kill, { once: true })
        const emit = (text: string): void => {
          if (!text) return
          if (!textOpen) {
            controller.enqueue({ type: 'text-start', id: 'codex-text' })
            textOpen = true
          }
          sawText = true
          controller.enqueue({ type: 'text-delta', id: 'codex-text', delta: text })
        }
        const handle = (line: string): void => {
          const event = parseCodexLine(line)
          if (!event) return
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            threadId = event.thread_id
            if (this.config.sessionMode === 'resume') {
              map[convKey] = threadId
              saveSessionMap(mapPath, map)
            }
          } else if (
            event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            typeof event.item.text === 'string'
          )
            emit(event.item.text)
          else if (event.type === 'turn.completed') usage = usageFromEvent(event)
          else if (event.type === 'turn.failed')
            failed = event.error?.message || 'Codex turn failed'
        }
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk
          let nl = buffer.indexOf('\n')
          while (nl >= 0) {
            handle(buffer.slice(0, nl).trim())
            buffer = buffer.slice(nl + 1)
            nl = buffer.indexOf('\n')
          }
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-64_000)
        })
        child.on('error', (error) => {
          failed = error.message
        })
        child.on('close', (code) => {
          abortSignal?.removeEventListener('abort', kill)
          if (buffer.trim()) handle(buffer.trim())
          if (textOpen) controller.enqueue({ type: 'text-end', id: 'codex-text' })
          const error =
            failed || (code !== 0 ? stderr.trim() || `codex exited ${String(code)}` : '')
          if (error && !sawText)
            controller.enqueue({ type: 'error', error: new Error(error.slice(0, 1000)) })
          controller.enqueue({
            type: 'finish',
            finishReason: {
              unified: error ? 'error' : 'stop',
              raw: error ? String(code) : undefined,
            },
            usage,
            providerMetadata: { [this.provider]: { threadId: threadId ?? null, exitCode: code } },
          })
          controller.close()
        })
        child.stdin.end(prompt)
      },
    })
    return Promise.resolve({ stream, request })
  }
}

export interface CodexCliProviderConfig {
  binary?: string
  model?: string
  reasoningEffort?: CodexReasoningEffort
  cwd?: string
  sandbox?: CodexSandbox
  approveForMe?: boolean
  skipGitRepoCheck?: boolean
  profile?: string
  session?: CodexSessionMode
  id?: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
}

function effortFromThinking(thinking: ChatOptions['thinking']): CodexReasoningEffort | undefined {
  return thinking === 'low' || thinking === 'medium' || thinking === 'high' || thinking === 'xhigh'
    ? thinking
    : undefined
}

export class CodexCliProvider implements Provider {
  readonly id: string
  readonly name: string
  private model: string
  private available: boolean | null = null
  constructor(private readonly config: CodexCliProviderConfig = {}) {
    this.id = config.id ?? CODEX_CLI_PROVIDER_ID
    this.name = config.name ?? this.id
    this.model = config.model ?? 'default'
  }
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model || 'default'
  }
  getContextWindow(): number {
    return this.config.contextWindow ?? 0
  }
  getMaxOutputTokens(): number {
    return this.config.maxOutputTokens ?? 0
  }
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available
    const available = await new Promise<boolean>((resolve) => {
      const child = spawn(this.config.binary ?? 'codex', ['login', 'status'], { stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 15_000)
      timer.unref()
      child.once('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
    this.available = available
    return available
  }
  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, conversationId }: GetModelInput) =>
        new CodexCliModel({
          providerId: this.id,
          binary: this.config.binary ?? 'codex',
          modelId: modelOverride ?? this.model,
          reasoningEffort: this.config.reasoningEffort,
          cwd: this.config.cwd,
          sandbox: this.config.sandbox ?? 'read-only',
          approveForMe: this.config.approveForMe ?? false,
          skipGitRepoCheck: this.config.skipGitRepoCheck ?? true,
          profile: this.config.profile,
          sessionMode: this.config.session === 'replay' ? 'replay' : 'resume',
          conversationId,
        }),
      buildProviderOptions: (
        _messages: Message[],
        options?: ChatOptions,
      ): JSONObject | undefined => {
        const effort = effortFromThinking(options?.thinking)
        return effort ? { [this.id]: { reasoningEffort: effort } } : undefined
      },
    }
  }
}

export const manifest: PluginManifest = {
  type: 'provider',
  name: CODEX_CLI_PROVIDER_ID,
  register(ctx) {
    const c = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new CodexCliProvider({
        binary: c.binary as string | undefined,
        model: c.model as string | undefined,
        reasoningEffort: c.reasoning_effort as CodexReasoningEffort | undefined,
        cwd: c.cwd as string | undefined,
        sandbox: c.sandbox as CodexSandbox | undefined,
        approveForMe: c.approve_for_me as boolean | undefined,
        skipGitRepoCheck: c.skip_git_repo_check as boolean | undefined,
        profile: c.profile as string | undefined,
        session: c.session as CodexSessionMode | undefined,
        contextWindow: c.context_window as number | undefined,
        maxOutputTokens: c.max_output_tokens as number | undefined,
      }),
    )
  },
}
export default manifest
