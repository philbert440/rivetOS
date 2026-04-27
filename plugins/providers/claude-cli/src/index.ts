/**
 * @rivetos/provider-claude-cli
 *
 * Shells out to the local `claude` binary (Claude Code CLI) and drives it via
 * the stream-json protocol. Uses the user's Claude subscription OAuth token
 * — the sanctioned pattern per Anthropic's April 2026 third-party harness
 * policy (April 4, 2026 announcement).
 *
 * The banned pattern is extracting OAuth tokens and impersonating Claude Code.
 * The allowed pattern — what this provider does — is letting the CLI own auth,
 * keychain, session caching, and the wire protocol.
 *
 * Phase 1.C: hybrid tools mode + embedded MCP bridge. Claude's built-in
 * tools (Bash/Read/Edit/Grep/Glob/WebFetch/Task/...) keep their lane. On
 * top of that, every chatStream() turn brings up a per-spawn MCP server
 * exposing every executable RivetOS tool (memory_*, skill_*, web_fetch,
 * delegate_task, ...) directly to claude-cli via `--mcp-config`. Because
 * the MCP server is *embedded in this provider's process*, tool execute
 * closures retain runtime context (DelegationEngine, channel handle,
 * conversation buffer) without a separate adapter layer.
 *
 * See `./mcp-bridge.ts` for transport details. Set
 * `RIVETOS_DISABLE_MCP_BRIDGE=1` to skip the bridge entirely (useful for
 * smoke testing the bare CLI shellout).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  Provider,
  Message,
  ContentPart,
  ChatOptions,
  LLMChunk,
  LLMResponse,
  LLMUsage,
  ThinkingLevel,
} from '@rivetos/types'
import { ProviderError } from '@rivetos/types'
import { embedMcpServerForTurn, type EmbeddedMcpHandle } from './mcp-bridge.js'
import { createLogger } from './log.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeCliProviderConfig {
  /** Path to the `claude` binary. Default: 'claude' (resolved via PATH). */
  binary?: string
  /** Model alias or full id passed via --model. Default: CLI default. */
  model?: string
  /** Built-in tool list passed via --tools. 'default' = all, '' = none.
   *  Default: a curated file/shell/web set suitable for coding work. */
  tools?: string
  /** Effort level for reasoning. Default: 'medium'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Permission mode. Default: 'bypassPermissions' (we are a non-interactive
   *  server — no one to click "approve"). */
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'
  /** Move cwd/env/git-status out of the default system prompt into the first
   *  user message. Improves prompt-cache reuse. Default: true. */
  excludeDynamicSections?: boolean
  /** Fold Rivet's system messages into --append-system-prompt (keep the CLI's
   *  default Claude Code system prompt). Default: true. */
  appendSystemPrompt?: boolean
  /** Working directory for the spawned process. Default: process.cwd(). */
  cwd?: string
  /** Request timeout in milliseconds. Default: 10 minutes. */
  timeoutMs?: number
  /** Context window (informational). */
  contextWindow?: number
  /** Max output tokens (informational — not passed to CLI). */
  maxOutputTokens?: number
  /** Override the provider id / display name (used when boot registers us). */
  id?: string
  name?: string
}

// ---------------------------------------------------------------------------
// CLI stream-json event shapes (partial — only the bits we consume)
// ---------------------------------------------------------------------------

interface CliSystemInit {
  type: 'system'
  subtype: 'init'
  session_id: string
  model: string
  apiKeySource?: string
  tools: string[]
}

interface CliStreamEvent {
  type: 'stream_event'
  event: {
    type: string
    index?: number
    content_block?: { type?: string }
    delta?: {
      type?: string
      text?: string
      thinking?: string
    }
  }
  session_id: string
}

interface CliResult {
  type: 'result'
  subtype: string
  is_error: boolean
  result?: string
  stop_reason?: string
  session_id: string
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

type CliEvent =
  | CliSystemInit
  | CliStreamEvent
  | CliResult
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS = 'Bash,Read,Edit,Grep,Glob,WebFetch,WebSearch,TodoWrite,Write'

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function messageToText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return partsToText(m.content)
}

/**
 * Serialize a RivetOS message history into the single user-turn string
 * that we feed to the CLI. System messages are extracted separately and
 * passed via --append-system-prompt; tool messages are rendered inline.
 *
 * This is Phase 1 — a single-turn shellout. Multi-turn resumption via
 * --resume / --session-id is a follow-up.
 */
function renderConversationForCli(messages: Message[]): {
  systemText: string
  userPrompt: string
} {
  const systemChunks: string[] = []
  const turnChunks: string[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemChunks.push(messageToText(msg))
      continue
    }
    if (msg.role === 'user') {
      turnChunks.push(`USER:\n${messageToText(msg)}`)
      continue
    }
    if (msg.role === 'assistant') {
      const text = messageToText(msg)
      if (text) turnChunks.push(`ASSISTANT:\n${text}`)
      if (msg.toolCalls?.length) {
        const calls = msg.toolCalls
          .map((tc) => `  - ${tc.name}(${JSON.stringify(tc.arguments)})`)
          .join('\n')
        turnChunks.push(`ASSISTANT TOOL CALLS:\n${calls}`)
      }
      continue
    }
    if (msg.role === 'tool') {
      turnChunks.push(`TOOL RESULT (${msg.toolCallId ?? '?'}):\n${messageToText(msg)}`)
      continue
    }
  }

  const systemText = systemChunks.join('\n\n')
  const userPrompt = turnChunks.join('\n\n---\n\n')
  return { systemText, userPrompt }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ClaudeCliProvider implements Provider {
  id: string
  name: string
  private binary: string
  private model: string
  private tools: string
  private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  private permissionMode: string
  private excludeDynamicSections: boolean
  private appendSystemPromptFlag: boolean
  private cwd: string | undefined
  private timeoutMs: number
  private contextWindow: number
  private outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: ClaudeCliProviderConfig) {
    this.id = config.id ?? 'claude-cli'
    this.name = config.name ?? 'Claude Code CLI (subscription)'
    this.binary = config.binary ?? 'claude'
    this.model = config.model ?? ''
    this.tools = config.tools ?? DEFAULT_TOOLS
    this.effort = config.effort ?? 'medium'
    // Default permission mode: 'default'. 'bypassPermissions' maps to
    // --dangerously-skip-permissions which refuses to run as root — and
    // RivetOS containers run as root. With tools='' this doesn't matter;
    // with a tool set enabled on a non-root host, set 'bypassPermissions'
    // explicitly via config.
    this.permissionMode = config.permissionMode ?? 'default'
    this.excludeDynamicSections = config.excludeDynamicSections ?? true
    this.appendSystemPromptFlag = config.appendSystemPrompt ?? true
    this.cwd = config.cwd
    this.timeoutMs = config.timeoutMs ?? 10 * 60 * 1000
    this.contextWindow = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
  }

  getModel(): string {
    return this.model || 'default'
  }

  setModel(model: string): void {
    this.model = model
  }

  getContextWindow(): number {
    return this.contextWindow
  }

  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.binary, ['--version'], {
          env: this.buildChildEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stderr = ''
        proc.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`claude --version exited ${String(code)}: ${stderr}`))
        })
      })
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  // -----------------------------------------------------------------------
  // Env scrubbing — CRITICAL
  //
  // If ANTHROPIC_API_KEY is in the env, the CLI uses API-key auth and bills
  // against the console, defeating the entire point of this provider. We
  // strip it (and the token env var, for belt-and-suspenders) so the CLI
  // falls back to its OAuth keychain.
  // -----------------------------------------------------------------------

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    return env
  }

  // -----------------------------------------------------------------------
  // Arg builder
  // -----------------------------------------------------------------------

  private buildArgs(
    options: ChatOptions | undefined,
    systemText: string,
    mcpConfigPath?: string,
  ): string[] {
    const args: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      this.permissionMode,
      '--effort',
      this.mapEffort(options?.thinking),
      '--tools',
      this.tools,
    ]

    const model = options?.modelOverride ?? this.model
    if (model) {
      args.push('--model', model)
    }

    if (this.excludeDynamicSections) {
      args.push('--exclude-dynamic-system-prompt-sections')
    }

    if (this.appendSystemPromptFlag && systemText) {
      args.push('--append-system-prompt', systemText)
    }

    // Embedded MCP bridge — wire claude-cli at the per-spawn `.mcp-config.json`
    // synthesized by `embedMcpServerForTurn`. Tools land in claude-cli's tool
    // catalog as `mcp__rivetos__<name>` (rivetos = the server label in the
    // config). Native Claude Code tools keep their lane.
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath)
    }

    // Disable session persistence when we are not stitching turns together —
    // avoids polluting the user's ~/.claude/projects history with one-shot
    // server calls. We can opt into --session-id later for multi-turn.
    args.push('--no-session-persistence')

    return args
  }

  private mapEffort(thinking?: ThinkingLevel): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    if (!thinking || thinking === 'off') return 'low'
    if (thinking === 'low') return 'low'
    if (thinking === 'medium') return 'medium'
    if (thinking === 'high') return 'high'
    if (thinking === 'xhigh') return 'xhigh'
    return this.effort
  }

  // -----------------------------------------------------------------------
  // chatStream
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const startedAt = Date.now()
    const log = createLogger('claude-cli')
    const { systemText, userPrompt } = renderConversationForCli(messages)

    // Bring up the embedded MCP server BEFORE spawning claude. If this fails,
    // we fall through to a no-MCP spawn so the provider stays usable as a
    // pure shellout (claude still has its native tools). The kill switch
    // RIVETOS_DISABLE_MCP_BRIDGE=1 also takes this path.
    let bridge: EmbeddedMcpHandle | undefined
    const tools = options?.executableTools
    if (tools && tools.length > 0 && process.env.RIVETOS_DISABLE_MCP_BRIDGE !== '1') {
      try {
        bridge = await embedMcpServerForTurn({
          tools,
          agentId: options.agentId,
          log,
        })
      } catch (err: unknown) {
        // Soft-fail: log and continue without the bridge.
        // The CLI still works; claude-cli just won't see Rivet tools this turn.
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('mcp.bridge.bringup.failed', { error: msg })
      }
    }

    log.info('chatStream.start', {
      agentId: options?.agentId,
      toolsCount: tools?.length ?? 0,
      model: options?.modelOverride ?? this.model,
      mcpEnabled: !!bridge,
    })

    const args = this.buildArgs(options, systemText, bridge?.configPath)

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(this.binary, args, {
        env: this.buildChildEnv(),
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      // Bridge already up — clean it up before bubbling the error.
      if (bridge) {
        await bridge.close().catch(() => undefined)
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`Failed to spawn ${this.binary}: ${msg}`, 0, this.id, false)
    }

    log.info('claude.spawn', {
      pid: proc.pid,
      model: options?.modelOverride ?? this.model,
      hasMcp: !!bridge,
    })

    // Wire stdin: one user turn as stream-json input, then close.
    const inputLine =
      JSON.stringify({ type: 'user', message: { role: 'user', content: userPrompt } }) + '\n'
    proc.stdin.write(inputLine)
    proc.stdin.end()

    // Abort plumbing
    const onAbort = () => {
      if (!proc.killed) proc.kill('SIGTERM')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    // Timeout
    const timeout = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM')
    }, this.timeoutMs)

    // Track whether we yielded `done` so the outer finally can avoid
    // double-close issues. Bridge teardown happens regardless.
    let bridgeClosed = false
    const closeBridge = async (): Promise<void> => {
      if (bridgeClosed) return
      bridgeClosed = true
      if (bridge) {
        await bridge.close().catch((err: unknown) => {
          process.stderr.write(
            `[claude-cli] warning: MCP bridge teardown failed (${err instanceof Error ? err.message : String(err)})\n`,
          )
        })
      }
    }

    // --- collect stderr for error reporting ---
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    // --- line-buffered stdout parser ---
    const lineIter = iterateLines(proc.stdout)
    let usage: LLMUsage | undefined
    let sawResult = false
    let lastApiKeySource: string | undefined
    let streamedAnyText = false
    let fallbackText = ''

    try {
      for await (const line of lineIter) {
        if (!line.trim()) continue
        let event: CliEvent
        try {
          event = JSON.parse(line) as CliEvent
        } catch {
          // Ignore non-JSON (shouldn't happen with stream-json, but be safe)
          continue
        }

        if (event.type === 'system' && (event as CliSystemInit).subtype === 'init') {
          lastApiKeySource = (event as CliSystemInit).apiKeySource
          log.debug('system.init', { apiKeySource: lastApiKeySource })
          // Hard-fail if we somehow ended up on API key auth — that is not the
          // point of this provider and would silently bill the console.
          if (lastApiKeySource && lastApiKeySource !== 'none') {
            if (!proc.killed) proc.kill('SIGTERM')
            throw new ProviderError(
              `claude-cli: unexpected apiKeySource="${lastApiKeySource}". ` +
                `This provider requires OAuth/keychain auth. Make sure ANTHROPIC_API_KEY ` +
                `is not leaking into the child env and that 'claude login' was completed.`,
              401,
              this.id,
              false,
            )
          }
          continue
        }

        if (event.type === 'stream_event') {
          const inner = (event as CliStreamEvent).event
          if (inner.type === 'content_block_delta' && inner.delta) {
            if (inner.delta.type === 'text_delta' && inner.delta.text) {
              streamedAnyText = true
              yield { type: 'text', delta: inner.delta.text }
            } else if (inner.delta.type === 'thinking_delta' && inner.delta.thinking) {
              yield { type: 'reasoning', delta: inner.delta.thinking }
            }
          }
          continue
        }

        // Capture whole assistant messages (always emitted, even without
        // --include-partial-messages). Used as a fallback if deltas didn't
        // arrive, or for turns that contain tool_use blocks we don't render.
        if (event.type === 'assistant') {
          const assistant = event as unknown as {
            message?: { content?: Array<{ type?: string; text?: string }> }
          }
          const blocks = assistant.message?.content ?? []
          for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
              fallbackText += block.text
            }
          }
          continue
        }

        if (event.type === 'result') {
          const r = event as CliResult
          sawResult = true
          if (r.usage) {
            usage = {
              promptTokens: r.usage.input_tokens ?? 0,
              completionTokens: r.usage.output_tokens ?? 0,
              cacheCreationTokens: r.usage.cache_creation_input_tokens ?? 0,
              cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
            }
          }
          if (r.is_error) {
            throw new ProviderError(`claude-cli error: ${r.result ?? 'unknown'}`, 500, this.id)
          }
          // If the delta stream was empty (e.g. provider was invoked without
          // --include-partial-messages, or the run was tool-only), emit the
          // final result text so callers aren't left with nothing.
          if (!streamedAnyText) {
            const finalText = r.result ?? fallbackText
            if (finalText) yield { type: 'text', delta: finalText }
          }
        }
      }
    } finally {
      clearTimeout(timeout)
      options?.signal?.removeEventListener('abort', onAbort)
      // Close the embedded MCP server. Idempotent — safe regardless of exit
      // path (success, error thrown from the loop, abort, timeout).
      await closeBridge()
    }

    // Await process close to surface non-zero exits
    const exitCode: number | null = await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve(proc.exitCode)
      proc.once('close', (code) => resolve(code))
    })

    if (exitCode !== 0 && !sawResult) {
      log.warn('claude.nonzero_exit', { exitCode, stderr: stderr.slice(0, 200) })
      throw new ProviderError(
        `claude CLI exited ${String(exitCode)}: ${stderr.slice(0, 500)}`,
        exitCode ?? 500,
        this.id,
      )
    }

    const durationMs = Date.now() - startedAt
    log.info('claude.exit', {
      pid: proc.pid,
      exitCode,
      durationMs,
      sawResult,
      streamedAnyText,
      usage,
    })

    yield { type: 'done', usage }
  }

  // -----------------------------------------------------------------------
  // chat (non-streaming convenience)
  // -----------------------------------------------------------------------

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    let text = ''
    let usage: LLMUsage | undefined
    for await (const chunk of this.chatStream(messages, options)) {
      if (chunk.type === 'text' && chunk.delta) text += chunk.delta
      if (chunk.type === 'done') usage = chunk.usage
    }
    return { type: 'text', content: text, usage }
  }
}

// ---------------------------------------------------------------------------
// Line iterator over a Readable
// ---------------------------------------------------------------------------

async function* iterateLines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = ''
  for await (const chunk of stream) {
    const str: string = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    buffer += str
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      yield line
      idx = buffer.indexOf('\n')
    }
  }
  if (buffer.length > 0) yield buffer
}
