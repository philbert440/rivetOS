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
import {
  defaultSessionMapPath,
  deleteSessionMapKey,
  loadSessionMap,
  saveSessionMap,
} from './session-map.js'

export {
  defaultSessionMapPath,
  deleteSessionMapKey,
  loadSessionMap,
  saveSessionMap,
  SESSION_MAP_FILE,
} from './session-map.js'
export const CODEX_CLI_PROVIDER_ID = 'codex-cli'
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type CodexSessionMode = 'resume' | 'replay'

/** Grace period between SIGTERM and SIGKILL when aborting/cancelling the child. */
export const KILL_GRACE_MS = 3_000

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

/** SYSTEM: block (all system messages, including trailing steers) + newest user text. */
export function resumePrompt(prompt: LanguageModelV3Prompt): string {
  const systems: string[] = []
  for (const message of prompt) {
    if (message.role === 'system') systems.push(message.content)
  }
  const user = newestUserPrompt(prompt)
  if (systems.length === 0) return user
  return `SYSTEM:\n${systems.join('\n\n')}${SEP}${user}`
}

/**
 * CRITICAL: scrub OAuth-impersonating env vars. If OPENAI_API_KEY is set,
 * the CLI uses API-key auth and bills the API — defeating the entire
 * point of this provider. Strip OpenAI billing selectors so the CLI falls
 * back to its ChatGPT subscription login.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Every OPENAI_* key goes (API key, base URL, org, project): with any of them
  // present codex prefers API-key auth over the ChatGPT login and bills the API.
  return Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('OPENAI_')))
}

let sessionMapWarned = false
function warnSessionMap(err: unknown): void {
  if (sessionMapWarned) return
  sessionMapWarned = true
  const msg = err instanceof Error ? err.message : String(err)
  console.warn(`[codex-cli] failed to persist session map: ${msg}`)
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

/** `skip_git_repo_check` defaults to true only for the read-only sandbox. */
export function defaultSkipGitRepoCheck(sandbox: CodexSandbox, configured?: boolean): boolean {
  return configured ?? sandbox === 'read-only'
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
  message?: string
  item?: { type?: string; text?: string; message?: string }
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

/** Reply text lives only on completed `agent_message` items — not reasoning or tool items. */
export function agentMessageText(event: CodexEvent): string | undefined {
  if (event.type !== 'item.completed' || event.item?.type !== 'agent_message') return undefined
  return typeof event.item.text === 'string' ? event.item.text : undefined
}

function nestedErrorMessage(event: CodexEvent): string | undefined {
  if (typeof event.message === 'string' && event.message.trim()) return event.message
  if (typeof event.error?.message === 'string' && event.error.message.trim()) {
    return event.error.message
  }
  return undefined
}

/**
 * Protocol-level failure text. Codex emits a top-level `error` event (`message`
 * at the top level) as well as `turn.failed` (`error.message`). Completed
 * items with `type: "error"` are thread items, not a failed turn — they must
 * not become reply text and must not mark a later `turn.completed` as failed.
 */
export function eventFailureMessage(event: CodexEvent): string | undefined {
  if (event.type === 'turn.failed') return nestedErrorMessage(event) || 'Codex turn failed'
  if (event.type === 'error') return nestedErrorMessage(event) || 'Codex error'
  return undefined
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

function nonNeg(n: number | undefined): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  return Math.max(0, n)
}

export function usageFromEvent(event: CodexEvent): LanguageModelV3Usage {
  if (event.type !== 'turn.completed') return emptyUsage()
  const u = event.usage
  const input = nonNeg(u?.input_tokens)
  const cached = u?.cached_input_tokens ?? 0
  const cacheWrite = u?.cache_write_input_tokens ?? 0
  const output = nonNeg(u?.output_tokens)
  const reasoning = u?.reasoning_output_tokens ?? 0
  return {
    inputTokens: {
      total: input,
      noCache: typeof input === 'number' ? nonNeg(input - cached - cacheWrite) : undefined,
      cacheRead: nonNeg(u?.cached_input_tokens),
      cacheWrite: nonNeg(u?.cache_write_input_tokens),
    },
    outputTokens: {
      total: output,
      text: typeof output === 'number' ? nonNeg(output - reasoning) : undefined,
      reasoning: nonNeg(u?.reasoning_output_tokens),
    },
  }
}

export interface CodexCliModelConfig extends CodexSpawnFlags {
  providerId: string
  modelId: string
  conversationId?: string
  sessionMode: CodexSessionMode
  sessionMapPath?: string
  /** Test seam: replaces node:child_process spawn for the turn child. */
  spawnImpl?: typeof spawn
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
    let resumeId: string | undefined
    try {
      const map = loadSessionMap(mapPath)
      resumeId = this.config.sessionMode === 'resume' ? map[convKey] : undefined
    } catch (err) {
      warnSessionMap(err)
    }
    const prompt = resumeId ? resumePrompt(options.prompt) : renderPrompt(options.prompt)
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
    let closed = false
    let kill = (): void => {
      /* assigned once the child is spawned */
    }
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        const enqueue = (part: LanguageModelV3StreamPart): void => {
          if (closed) return
          try {
            controller.enqueue(part)
          } catch {
            closed = true
          }
        }
        const closeStream = (): void => {
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        enqueue({ type: 'stream-start', warnings: [] })
        const child = (this.config.spawnImpl ?? spawn)(flags.binary, args, {
          cwd: flags.cwd,
          env: buildChildEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let buffer = ''
        let stderr = ''
        let textOpen = false
        let sawText = false
        let usage = emptyUsage()
        let threadId = resumeId
        let failed = ''
        // stdin EPIPE is a symptom (codex exited without draining the prompt);
        // the real cause is on stderr / in the exit code, so it ranks last.
        let stdinError = ''
        let sawThreadStarted = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
        kill = (): void => {
          if (exited()) return
          try {
            if (!child.killed) child.kill('SIGTERM')
          } catch {
            /* gone */
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
        const emit = (text: string): void => {
          if (!text) return
          if (!textOpen) {
            enqueue({ type: 'text-start', id: 'codex-text' })
            textOpen = true
          } else if (sawText) {
            enqueue({ type: 'text-delta', id: 'codex-text', delta: '\n' })
          }
          sawText = true
          enqueue({ type: 'text-delta', id: 'codex-text', delta: text })
        }
        const persistThread = (id: string): void => {
          try {
            saveSessionMap(mapPath, { [convKey]: id })
          } catch (err) {
            warnSessionMap(err)
          }
        }
        const handle = (line: string): void => {
          try {
            const event = parseCodexLine(line)
            if (!event) return
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
              threadId = event.thread_id
              sawThreadStarted = true
              if (this.config.sessionMode === 'resume') persistThread(threadId)
              return
            }
            const reply = agentMessageText(event)
            if (reply !== undefined) {
              emit(reply)
              return
            }
            if (event.type === 'turn.completed') {
              usage = usageFromEvent(event)
              return
            }
            const failure = eventFailureMessage(event)
            if (failure) failed = failure
          } catch (err) {
            warnSessionMap(err)
          }
        }
        const ignoreStreamError = (): void => {
          /* EPIPE/ECONNRESET on kill must not become an uncaught exception */
        }
        child.stdout.setEncoding('utf8')
        child.stdout.on('error', ignoreStreamError)
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
        child.stderr.on('error', ignoreStreamError)
        child.stderr.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-64_000)
        })
        child.on('error', (error) => {
          failed = failed || error.message
        })
        child.on('close', (code) => {
          if (killTimer) clearTimeout(killTimer)
          abortSignal?.removeEventListener('abort', kill)
          if (closed) return
          if (buffer.trim()) handle(buffer.trim())
          const aborted = Boolean(abortSignal?.aborted)
          if (resumeId && !sawThreadStarted && !aborted && (failed || code !== 0)) {
            try {
              deleteSessionMapKey(mapPath, convKey)
            } catch (err) {
              warnSessionMap(err)
            }
          }
          if (textOpen) enqueue({ type: 'text-end', id: 'codex-text' })
          const error = aborted
            ? ''
            : failed ||
              stderr.trim() ||
              (code !== 0 ? `codex exited ${String(code)}` : '') ||
              stdinError
          if (error && !sawText) enqueue({ type: 'error', error: new Error(error.slice(0, 1000)) })
          enqueue({
            type: 'finish',
            finishReason: {
              unified: aborted || error ? 'error' : 'stop',
              raw: aborted ? 'aborted' : error ? String(code) : undefined,
            },
            usage,
            providerMetadata: { [this.provider]: { threadId: threadId ?? null, exitCode: code } },
          })
          closeStream()
        })
        child.stdin.on('error', (err: Error) => {
          stdinError = stdinError || err.message
        })
        child.stdin.end(prompt)
      },
      cancel: () => {
        closed = true
        kill()
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
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const child = spawn(this.config.binary ?? 'codex', ['login', 'status'], {
          stdio: 'ignore',
          env: buildChildEnv(),
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          done(false)
        }, 15_000)
        timer.unref()
        child.once('error', () => {
          clearTimeout(timer)
          done(false)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          done(code === 0)
        })
      } catch {
        done(false)
      }
    })
    this.available = available
    return available
  }
  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, conversationId }: GetModelInput) => {
        const sandbox = this.config.sandbox ?? 'read-only'
        return new CodexCliModel({
          providerId: this.id,
          binary: this.config.binary ?? 'codex',
          modelId: modelOverride ?? this.model,
          reasoningEffort: this.config.reasoningEffort,
          cwd: this.config.cwd,
          sandbox,
          approveForMe: this.config.approveForMe ?? false,
          skipGitRepoCheck: defaultSkipGitRepoCheck(sandbox, this.config.skipGitRepoCheck),
          profile: this.config.profile,
          sessionMode: this.config.session === 'replay' ? 'replay' : 'resume',
          conversationId,
        })
      },
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
