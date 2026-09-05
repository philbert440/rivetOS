/**
 * @rivetos/provider-grok-cli — Grok Build CLI provider.
 *
 * Shells out to the local `grok` binary (Grok Build, the xAI coding agent
 * CLI) for every turn: `grok -p <prompt> --output-format json`. Uses the
 * user's Grok Build subscription/OIDC login in ~/.grok — no xAI API key, no
 * metered API (see the `xai` provider for that).
 *
 * Config (`providers.grok-cli` in config.yaml):
 *   binary            path to grok (default ~/.grok/bin/grok, then `grok` on PATH)
 *   model             `-m` model id (default: the CLI's configured model)
 *   permission_mode   --permission-mode (default dontAsk — tools denied unless allowed)
 *   reasoning_effort  low|medium|high (default: CLI default; per-turn `thinking` overrides)
 *   max_turns         --max-turns (default 1 = answer only, no tool loop)
 *   no_plan           --no-plan (default true)
 *   system_prompt     prepend|override|off — how the RivetOS system prompt reaches grok (default prepend)
 *   allow             list of --allow rules for tool-using turns (max_turns > 1)
 *   tools             --tools pass-through
 *   cwd               working directory for the spawned grok
 *   context_window / max_output_tokens / name
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Provider, PluginManifest, ChatOptions, Message } from '@rivetos/types'
import type { ProviderAiSdkBridge, GetModelInput } from '@rivetos/aisdk'
import type { JSONObject } from '@ai-sdk/provider'
import {
  GrokCliModel,
  type GrokReasoningEffort,
  type GrokSystemPromptMode,
} from './grok-cli-model.js'
import { createLogger } from './log.js'

export {
  GrokCliModel,
  renderPromptForCli,
  composePrompt,
  buildUsage,
  finishReasonFor,
  effortFromProviderOptions,
} from './grok-cli-model.js'
export { buildArgs, parseGrokJson, spawnGrokTurn } from './spawn-turn.js'
export type { GrokReasoningEffort, GrokSystemPromptMode } from './grok-cli-model.js'
export type { GrokSpawnFlags, GrokJsonResult, GrokTurn } from './spawn-turn.js'

export const GROK_CLI_PROVIDER_ID = 'grok-cli'

/** Default Grok Build install location, then PATH. */
export function defaultGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir()
  const candidate = join(home, '.grok', 'bin', 'grok')
  return existsSync(candidate) ? candidate : 'grok'
}

export interface GrokCliProviderConfig {
  binary?: string
  model?: string
  permissionMode?: string
  reasoningEffort?: GrokReasoningEffort
  maxTurns?: number
  noPlan?: boolean
  systemPrompt?: GrokSystemPromptMode
  allow?: string[]
  tools?: string
  cwd?: string
  id?: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
}

const log = createLogger('grok-cli')

function effortFromThinking(thinking: ChatOptions['thinking']): GrokReasoningEffort | undefined {
  switch (thinking) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
      return 'high'
    default:
      return undefined
  }
}

export class GrokCliProvider implements Provider {
  readonly id: string
  readonly name: string
  private binary: string
  private model: string
  private permissionMode: string
  private reasoningEffort: GrokReasoningEffort | undefined
  private maxTurns: number
  private noPlan: boolean
  private systemPromptMode: GrokSystemPromptMode
  private allow: string[] | undefined
  private tools: string | undefined
  private cwd: string | undefined
  private contextWindow: number
  private outputTokenLimit: number
  private available: boolean | null = null

  constructor(config: GrokCliProviderConfig = {}) {
    this.id = config.id ?? GROK_CLI_PROVIDER_ID
    this.name = config.name ?? this.id
    this.binary = config.binary ?? defaultGrokBinary()
    this.model = config.model ?? 'default'
    this.permissionMode = config.permissionMode ?? 'dontAsk'
    this.reasoningEffort = config.reasoningEffort
    this.maxTurns = config.maxTurns && config.maxTurns > 0 ? Math.floor(config.maxTurns) : 1
    this.noPlan = config.noPlan ?? true
    this.systemPromptMode = config.systemPrompt ?? 'prepend'
    this.allow = config.allow && config.allow.length > 0 ? [...config.allow] : undefined
    this.tools = config.tools || undefined
    this.cwd = config.cwd
    this.contextWindow = config.contextWindow ?? 0
    this.outputTokenLimit = config.maxOutputTokens ?? 0
  }

  getModel(): string {
    return this.model || 'default'
  }

  setModel(model: string): void {
    this.model = model || 'default'
  }

  getContextWindow(): number {
    return this.contextWindow
  }

  getMaxOutputTokens(): number {
    return this.outputTokenLimit
  }

  /** `grok --version` exits 0 → available. Cached after the first probe. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available
    this.available = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean, why?: string): void => {
        if (settled) return
        settled = true
        if (!ok) log.warn('grok.unavailable', { binary: this.binary, reason: why })
        resolve(ok)
      }
      try {
        const proc = spawn(this.binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
        const t = setTimeout(() => {
          proc.kill('SIGKILL')
          done(false, 'timeout')
        }, 15_000)
        t.unref()
        proc.once('error', (err) => {
          clearTimeout(t)
          done(false, err.message)
        })
        proc.once('exit', (code) => {
          clearTimeout(t)
          done(code === 0, code === 0 ? undefined : `exit ${String(code)}`)
        })
      } catch (err: unknown) {
        done(false, err instanceof Error ? err.message : String(err))
      }
    })
    return this.available
  }

  aiSdkBridge(): ProviderAiSdkBridge {
    return {
      getModel: ({ modelOverride, agentId }: GetModelInput) =>
        new GrokCliModel({
          providerId: this.id,
          modelId: modelOverride ?? this.getModel(),
          binary: this.binary,
          permissionMode: this.permissionMode,
          reasoningEffort: this.reasoningEffort,
          maxTurns: this.maxTurns,
          noPlan: this.noPlan,
          systemPromptMode: this.systemPromptMode,
          allow: this.allow,
          tools: this.tools,
          cwd: this.cwd,
          agentId,
        }),
      buildProviderOptions: (
        _messages: Message[],
        options?: ChatOptions,
      ): JSONObject | undefined => {
        const effort = effortFromThinking(options?.thinking)
        if (!effort) return undefined
        return { [this.id]: { reasoningEffort: effort } }
      },
    }
  }
}

export const manifest: PluginManifest = {
  type: 'provider',
  name: GROK_CLI_PROVIDER_ID,
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new GrokCliProvider({
        binary: cfg.binary as string | undefined,
        model: cfg.model as string | undefined,
        permissionMode: cfg.permission_mode as string | undefined,
        reasoningEffort: cfg.reasoning_effort as GrokReasoningEffort | undefined,
        maxTurns: cfg.max_turns as number | undefined,
        noPlan: cfg.no_plan as boolean | undefined,
        systemPrompt: cfg.system_prompt as GrokSystemPromptMode | undefined,
        allow: cfg.allow as string[] | undefined,
        tools: cfg.tools as string | undefined,
        cwd: cfg.cwd as string | undefined,
        id: GROK_CLI_PROVIDER_ID,
        name: (cfg.name as string | undefined) ?? GROK_CLI_PROVIDER_ID,
        contextWindow: cfg.context_window as number | undefined,
        maxOutputTokens: cfg.max_output_tokens as number | undefined,
      }),
    )
  },
}

export default manifest
