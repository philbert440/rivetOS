/**
 * Task-spawn isolation — whether a delegated `claude -p` run inherits the
 * operator's personal Claude Code setup (#1053).
 *
 * A task spawn runs as the service user, so by default it loads that user's
 * `~/.claude/settings.json` (permission rules and default mode, hooks,
 * enabled plugins), their plugins' MCP servers, and their user-level
 * CLAUDE.md. Two levels, measured against Claude Code 2.1.286:
 *
 * - `inherit` — no extra flags. Exactly the pre-existing behaviour.
 * - `isolated` — `--setting-sources project` drops the user and local
 *   settings (and with them the personal permission rules, hooks, plugins and
 *   CLAUDE.md), and `--strict-mcp-config` leaves the embedded RivetOS bridge
 *   as the only MCP server. With no plugin left to provide them, the RivetOS
 *   capture hooks are supplied from this package through an inline
 *   `--settings` object, so task transcripts keep working.
 *
 * Project settings (`.claude/settings.json` in the task's working directory)
 * stay on at both levels: they belong to the repository, not the operator.
 */

import { fileURLToPath } from 'node:url'

export type TaskIsolation = 'inherit' | 'isolated'

export const TASK_ISOLATION_LEVELS: readonly TaskIsolation[] = ['inherit', 'isolated']

/** A valid level, or undefined for anything else (callers fall back). */
export function parseTaskIsolation(raw: unknown): TaskIsolation | undefined {
  return typeof raw === 'string' && (TASK_ISOLATION_LEVELS as readonly string[]).includes(raw)
    ? (raw as TaskIsolation)
    : undefined
}

/**
 * Permission rules for `--allowedTools` (e.g. `mcp__rivetos`,
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

/** The capture-hook command for this package's own handler. */
export function captureHookCommand(): string {
  const script = fileURLToPath(new URL('./hooks.js', import.meta.url))
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
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
  /** Capture-hook command. Default is this package's handler. */
  hookCommand?: string
}

/** The spawn flags for an isolation level. `inherit` adds nothing. */
export function isolationFlags(level: TaskIsolation, deps: IsolationDeps = {}): IsolationFlags {
  if (level === 'inherit') return {}
  const command = deps.hookCommand ?? captureHookCommand()
  const hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> =
    {}
  for (const event of CAPTURE_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
  }
  return {
    settingSources: 'project',
    settingsJson: JSON.stringify({ hooks }),
    strictMcpConfig: true,
  }
}
