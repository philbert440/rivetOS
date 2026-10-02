/**
 * Task-spawn isolation — how much of the operator's personal Claude Code
 * setup a delegated `claude -p` run inherits (#1053).
 *
 * A task spawn runs as the service user, so by default it loads that user's
 * `~/.claude/settings.json` (permission rules and default mode, hooks,
 * enabled plugins), their plugins' MCP servers, and their user-level
 * CLAUDE.md. Three levels, measured against Claude Code 2.1.286:
 *
 * - `inherit` — no extra flags. Exactly the pre-existing behaviour.
 * - `tools` — `--setting-sources project` drops the user and local settings
 *   (and with them the personal permission rules, hooks and CLAUDE.md), and a
 *   generated `--settings` object re-enables the operator's plugins, so their
 *   tools still load. Capture hooks RivetOS itself installed in the user
 *   settings are carried over so task transcripts keep working.
 * - `isolated` — as `tools` but with no plugins and `--strict-mcp-config`, so
 *   the only MCP server is the embedded RivetOS bridge. Capture hooks are
 *   supplied from this package, since no plugin is left to provide them.
 *
 * Project settings (`.claude/settings.json` in the task's working directory)
 * stay on at every level: they belong to the repository, not the operator.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type TaskIsolation = 'inherit' | 'tools' | 'isolated'

export const TASK_ISOLATION_LEVELS: readonly TaskIsolation[] = ['inherit', 'tools', 'isolated']

/** A valid level, or undefined for anything else (callers fall back). */
export function parseTaskIsolation(raw: unknown): TaskIsolation | undefined {
  return typeof raw === 'string' && (TASK_ISOLATION_LEVELS as readonly string[]).includes(raw)
    ? (raw as TaskIsolation)
    : undefined
}

/**
 * Permission rules for `--allowedTools` (e.g. `mcp__plugin_rivet-memory_rivetos`,
 * `Bash(git status:*)`). Non-strings, empty strings, anything with a control
 * character or starting with `-` (it would parse as a flag) are dropped.
 */
export function parseAllowedTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const rule = entry.trim()
    // eslint-disable-next-line no-control-regex
    if (!rule || rule.length > 200 || rule.startsWith('-') || /[\u0000-\u001f]/.test(rule)) continue
    if (!out.includes(rule)) out.push(rule)
  }
  return out.length > 0 ? out : undefined
}

/** Events the RivetOS capture hook handles (mirrors `hooks.ts`). */
export const CAPTURE_HOOK_EVENTS = [
  'Stop',
  'SubagentStop',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolUse',
] as const

/** RivetOS-installed hook entries are recognised by this substring (mirrors `hooks.ts`). */
export const CAPTURE_HOOK_MARKER = 'claude-cli/dist/hooks.js'

interface HookCommand {
  type?: string
  command?: string
  timeout?: number
}
interface HookMatcher {
  matcher?: string
  hooks?: HookCommand[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function userSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return join(dir ? dir : join(home, '.claude'), 'settings.json')
}

function defaultReadUserSettings(): unknown {
  try {
    return JSON.parse(readFileSync(userSettingsPath(), 'utf8'))
  } catch {
    return undefined
  }
}

/** The capture-hook command for this package's own handler. */
export function captureHookCommand(): string {
  const script = fileURLToPath(new URL('./hooks.js', import.meta.url))
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
}

/** Hook entries from the user's settings that RivetOS itself installed. */
function rivetHooksFrom(settings: unknown): Record<string, HookMatcher[]> {
  const out: Record<string, HookMatcher[]> = {}
  if (!isRecord(settings) || !isRecord(settings.hooks)) return out
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue
    const kept: HookMatcher[] = []
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue
      const ours = (entry.hooks as unknown[]).filter(
        (h): h is HookCommand =>
          isRecord(h) && typeof h.command === 'string' && h.command.includes(CAPTURE_HOOK_MARKER),
      )
      if (ours.length > 0) kept.push({ hooks: ours })
    }
    if (kept.length > 0) out[event] = kept
  }
  return out
}

export interface IsolationFlags {
  /** `--setting-sources <value>` */
  settingSources?: string
  /** `--settings <json>` — an inline settings object. */
  settingsJson?: string
  /** `--strict-mcp-config` */
  strictMcpConfig?: boolean
}

export interface IsolationDeps {
  /** The operator's user settings (parsed JSON). Default reads the real file. */
  readUserSettings?: () => unknown
  /** Capture-hook command for `isolated`. Default is this package's handler. */
  hookCommand?: string
}

/** The spawn flags for an isolation level. `inherit` adds nothing. */
export function isolationFlags(level: TaskIsolation, deps: IsolationDeps = {}): IsolationFlags {
  if (level === 'inherit') return {}
  if (level === 'isolated') {
    const command = deps.hookCommand ?? captureHookCommand()
    const hooks: Record<string, HookMatcher[]> = {}
    for (const event of CAPTURE_HOOK_EVENTS) {
      hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
    }
    return {
      settingSources: 'project',
      settingsJson: JSON.stringify({ hooks }),
      strictMcpConfig: true,
    }
  }
  // tools: the operator's plugins (and so their tools) without the rest.
  const user = (deps.readUserSettings ?? defaultReadUserSettings)()
  const settings: Record<string, unknown> = {}
  if (isRecord(user)) {
    if (isRecord(user.enabledPlugins) && Object.keys(user.enabledPlugins).length > 0) {
      settings.enabledPlugins = user.enabledPlugins
    }
    if (
      isRecord(user.extraKnownMarketplaces) &&
      Object.keys(user.extraKnownMarketplaces).length > 0
    ) {
      settings.extraKnownMarketplaces = user.extraKnownMarketplaces
    }
  }
  const hooks = rivetHooksFrom(user)
  if (Object.keys(hooks).length > 0) settings.hooks = hooks
  return {
    settingSources: 'project',
    ...(Object.keys(settings).length > 0 ? { settingsJson: JSON.stringify(settings) } : {}),
  }
}
