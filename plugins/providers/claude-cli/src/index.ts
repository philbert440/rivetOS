/**
 * @rivetos/provider-claude-cli
 *
 * Shells out to the local `claude` binary (Claude Code CLI) and drives it via
 * the stream-json protocol. Uses the user's Claude subscription OAuth token
 * — the sanctioned pattern per Anthropic's April 2026 third-party harness
 * policy.
 *
 * The banned pattern is extracting OAuth tokens and impersonating Claude Code.
 * The allowed pattern — what this provider does — is letting the CLI own auth,
 * keychain, session caching, and the wire protocol.
 *
 * Architecture (post step 7 / AI SDK migration):
 *   - `ClaudeCliProvider` exposes only `aiSdkBridge()` to the loop.
 *   - The bridge constructs a per-call `ClaudeCliModel` (a custom
 *     `LanguageModelV3`) wrapping the CLI subprocess.
 *   - The model brings up an embedded MCP server per spawn so claude-cli
 *     sees every executable RivetOS tool (`memory_*`, `skill_*`, `web_fetch`,
 *     `delegate_task`, ...) via `--mcp-config`. Native Claude Code tools
 *     (Bash/Read/Edit/Grep/Glob/...) keep their lane.
 *   - Each spawn is one full claude turn. Claude runs its OWN multi-step
 *     agent loop internally (calling MCP tools as needed); AI SDK's outer
 *     loop completes after a single `streamText` step since the model
 *     output contains text only — no model-side tool calls to iterate on.
 *
 * Constraint: no RivetOS-side max-output-tokens or per-spawn timeouts.
 * Claude Code owns those — configure on the box via `claude config` /
 * env if they need to change. AI SDK's `abortSignal` is forwarded so the
 * outer loop can still kill spawns on user stop / turn timeout.
 *
 * Set `RIVETOS_DISABLE_MCP_BRIDGE=1` to skip the embedded bridge (useful for
 * smoke testing the bare CLI shellout).
 */

import { spawn } from 'node:child_process'
import type { Provider, PluginManifest } from '@rivetos/types'
import type { ProviderAiSdkBridge, GetModelInput } from '@rivetos/aisdk'
import { ClaudeCliModel, type ClaudeCliEffort } from './claude-cli-model.js'

// Real-time Claude Code session capture — hooks ingest interactive
// transcripts into the memory DB. See transcript-capture.ts / hooks.ts.
export {
  ingestTranscript,
  ingestHookEvent,
  parseTranscript,
  deriveSessionKey,
  sessionKeyFromId,
  resolvePgUrl,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
} from './transcript-capture.js'
// Task engine (phase 1 step (b)) — HarnessExecutor over headless claude -p.
export { ClaudeCliExecutor, parseTaskResultBlock, buildTaskSystemAppend } from './executor.js'
export type { ClaudeCliExecutorConfig } from './executor.js'

export type {
  IngestOptions,
  IngestResult,
  HookEventOptions,
  HookEventResult,
  HookEventPayload,
  ParsedMessage,
  ParsedTranscript,
} from './transcript-capture.js'

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
  /** Default reasoning effort. Override per-call via providerOptions['claude-cli'].effort. */
  effort?: ClaudeCliEffort
  /** Permission mode. Default: 'default'. 'bypassPermissions' refuses to run as root.
   *  RivetOS containers run as root, so set explicitly per-host if non-default needed. */
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'
  /** Move cwd/env/git-status out of the default system prompt into the first
   *  user message. Improves prompt-cache reuse. Default: true. */
  excludeDynamicSections?: boolean
  /** Fold Rivet's system messages into --append-system-prompt (keep the CLI's
   *  default Claude Code system prompt). Default: true. */
  appendSystemPrompt?: boolean
  /** Working directory for the spawned process. Default: process.cwd(). */
  cwd?: string
  /** Context window (informational). */
  contextWindow?: number
  /** Max output tokens (informational only — not passed to CLI; Claude Code owns it). */
  maxOutputTokens?: number
  /** Override the provider id / display name (used when boot registers us). */
  id?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS = 'Bash,Read,Edit,Grep,Glob,WebFetch,WebSearch,TodoWrite,Write'

/**
 * CRITICAL: scrub OAuth-impersonating env vars before any CLI invocation.
 * Mirrors the same scrub in claude-cli-model.ts; used here for `--version`
 * probes during isAvailable.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ClaudeCliProvider implements Provider {
  id: string
  name: string
  private binary: string
  private model: string
  private toolsArg: string
  private effort: ClaudeCliEffort
  private permissionMode: string
  private excludeDynamicSections: boolean
  private appendSystemPromptFlag: boolean
  private cwd: string | undefined
  private contextWindow: number
  private outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: ClaudeCliProviderConfig) {
    this.id = config.id ?? 'claude-cli'
    this.name = config.name ?? 'Claude Code CLI (subscription)'
    this.binary = config.binary ?? 'claude'
    this.model = config.model ?? ''
    this.toolsArg = config.tools ?? DEFAULT_TOOLS
    this.effort = config.effort ?? 'medium'
    this.permissionMode = config.permissionMode ?? 'default'
    this.excludeDynamicSections = config.excludeDynamicSections ?? true
    this.appendSystemPromptFlag = config.appendSystemPrompt ?? true
    this.cwd = config.cwd
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
          env: buildChildEnv(),
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
  // aiSdkBridge — AI SDK loop adapter
  // -----------------------------------------------------------------------

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, tools, agentId }: GetModelInput) => {
        return new ClaudeCliModel({
          providerId: this.id,
          modelId: modelOverride ?? this.model,
          binary: this.binary,
          toolsArg: this.toolsArg,
          effort: this.effort,
          permissionMode: this.permissionMode,
          excludeDynamicSections: this.excludeDynamicSections,
          appendSystemPrompt: this.appendSystemPromptFlag,
          cwd: this.cwd,
          tools,
          agentId,
        })
      },

      // Claude Code owns reasoning effort via --effort, mapped from
      // providerOptions['claude-cli'].effort inside ClaudeCliModel.doStream.
      // Surface the per-turn `thinking` level as a providerOptions hint so
      // the model's effort mapper picks it up.
      buildProviderOptions: (_messages, options) => {
        const thinking = options?.thinking
        if (!thinking || thinking === 'off') return undefined
        return { 'claude-cli': { effort: thinking satisfies ClaudeCliEffort } }
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export const manifest: PluginManifest = {
  type: 'provider',
  name: 'claude-cli',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new ClaudeCliProvider({
        binary: cfg.binary as string | undefined,
        model: cfg.model as string | undefined,
        tools: cfg.tools as string | undefined,
        effort: cfg.effort as ClaudeCliEffort | undefined,
        permissionMode: cfg.permission_mode as ClaudeCliProviderConfig['permissionMode'],
        excludeDynamicSections: cfg.exclude_dynamic_sections as boolean | undefined,
        appendSystemPrompt: cfg.append_system_prompt as boolean | undefined,
        cwd: cfg.cwd as string | undefined,
        id: 'claude-cli',
        name: (cfg.name as string | undefined) ?? 'claude-cli',
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}
