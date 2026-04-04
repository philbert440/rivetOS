/**
 * Auto-Actions — pre-built tool:after hooks for automated responses.
 *
 * Implements M2.3:
 *   - Auto-format: run prettier/eslint --fix after file edits
 *   - Auto-lint: run linter after code changes
 *   - Auto-test: run tests after source file modifications
 *   - Custom post-actions: user-defined actions per tool
 *
 * All hooks use the existing HookPipeline infrastructure (tool:after event).
 * Actions run via a shell executor interface (no direct child_process import).
 */

import type { HookRegistration, ToolAfterContext } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shell executor — injected, not imported (keeps it testable). */
export interface ShellExecutor {
  exec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export interface AutoActionConfig {
  /** Shell executor for running commands */
  shell: ShellExecutor
  /** Working directory for commands (default: process.cwd()) */
  cwd?: string
}

export interface AutoAction {
  /** Unique ID for this action */
  id: string
  /** Description */
  description: string
  /** Which tools trigger this action (empty = all) */
  tools?: string[]
  /** Filter: only trigger when the file matches this pattern */
  filePattern?: RegExp
  /** Command to run. Receives the affected file path as {{file}}. */
  command: string
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number
  /** If true, failure of this action is logged but doesn't affect the pipeline */
  softFail?: boolean
}

// ---------------------------------------------------------------------------
// Auto-Format Hook
// ---------------------------------------------------------------------------

/**
 * Creates a tool:after hook that auto-formats files after edits.
 * Runs prettier on JS/TS/JSON/CSS/MD files.
 */
export function createAutoFormatHook(config: AutoActionConfig): HookRegistration<ToolAfterContext> {
  const FORMAT_PATTERN = /\.(ts|tsx|js|jsx|json|css|scss|md|yaml|yml|html)$/i

  return {
    id: 'auto:format',
    event: 'tool:after',
    handler: async (ctx) => {
      if (ctx.isError) return // Don't format if the tool errored

      const filePath = extractFilePath(ctx.args)
      if (!filePath || !FORMAT_PATTERN.test(filePath)) return

      try {
        const result = await config.shell.exec(
          `npx prettier --write "${filePath}" 2>/dev/null`,
          config.cwd,
        )
        if (result.exitCode === 0) {
          ctx.metadata.autoFormat = { file: filePath, status: 'formatted' }
        }
      } catch {
        // Prettier not available or failed — soft fail
        ctx.metadata.autoFormat = {
          file: filePath,
          status: 'skipped',
          reason: 'prettier not available',
        }
      }
    },
    priority: 60, // After core processing, before audit
    toolFilter: ['file_write', 'file_edit'],
    onError: 'continue', // Auto-format failure should never block
    description: 'Auto-formats files after edits using prettier',
  }
}

// ---------------------------------------------------------------------------
// Auto-Lint Hook
// ---------------------------------------------------------------------------

/**
 * Creates a tool:after hook that auto-lints files after edits.
 * Runs eslint --fix on JS/TS files.
 */
export function createAutoLintHook(config: AutoActionConfig): HookRegistration<ToolAfterContext> {
  const LINT_PATTERN = /\.(ts|tsx|js|jsx)$/i

  return {
    id: 'auto:lint',
    event: 'tool:after',
    handler: async (ctx) => {
      if (ctx.isError) return

      const filePath = extractFilePath(ctx.args)
      if (!filePath || !LINT_PATTERN.test(filePath)) return

      try {
        const result = await config.shell.exec(
          `npx eslint --fix "${filePath}" 2>/dev/null`,
          config.cwd,
        )
        if (result.exitCode === 0) {
          ctx.metadata.autoLint = { file: filePath, status: 'linted' }
        } else {
          ctx.metadata.autoLint = {
            file: filePath,
            status: 'issues',
            output: result.stderr?.slice(0, 500),
          }
        }
      } catch {
        ctx.metadata.autoLint = {
          file: filePath,
          status: 'skipped',
          reason: 'eslint not available',
        }
      }
    },
    priority: 61, // After format, before audit
    toolFilter: ['file_write', 'file_edit'],
    onError: 'continue',
    description: 'Auto-lints files after edits using eslint --fix',
  }
}

// ---------------------------------------------------------------------------
// Auto-Test Hook
// ---------------------------------------------------------------------------

/**
 * Creates a tool:after hook that runs relevant tests when source files change.
 * Uses Nx affected or vitest --related to run only tests related to the change.
 */
export function createAutoTestHook(config: AutoActionConfig): HookRegistration<ToolAfterContext> {
  const SOURCE_PATTERN = /\/src\/.*\.(ts|tsx|js|jsx)$/i

  return {
    id: 'auto:test',
    event: 'tool:after',
    handler: async (ctx) => {
      if (ctx.isError) return

      const filePath = extractFilePath(ctx.args)
      if (!filePath || !SOURCE_PATTERN.test(filePath)) return

      // Skip if the file itself is a test
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(filePath)) return

      try {
        // Try vitest --related first (faster, file-level)
        const result = await config.shell.exec(
          `npx vitest run --related "${filePath}" --reporter=verbose 2>&1 | tail -20`,
          config.cwd,
        )
        ctx.metadata.autoTest = {
          file: filePath,
          status: result.exitCode === 0 ? 'passed' : 'failed',
          output: result.stdout?.slice(-500),
        }
      } catch {
        ctx.metadata.autoTest = {
          file: filePath,
          status: 'skipped',
          reason: 'test runner not available',
        }
      }
    },
    priority: 65, // After format + lint
    toolFilter: ['file_write', 'file_edit'],
    onError: 'continue',
    description: 'Runs related tests after source file changes',
  }
}

// ---------------------------------------------------------------------------
// Auto Git Commit Check Hook
// ---------------------------------------------------------------------------

/**
 * Creates a tool:after hook that runs pre-commit checks after git commits.
 * Useful for: "after any git commit, run the pre-push checks"
 */
export function createAutoGitCheckHook(
  config: AutoActionConfig,
): HookRegistration<ToolAfterContext> {
  return {
    id: 'auto:git-check',
    event: 'tool:after',
    handler: async (ctx) => {
      if (ctx.isError) return

      const command = (ctx.args.command as string) ?? ''
      if (!command.includes('git commit')) return

      try {
        // Run type-check + lint
        const result = await config.shell.exec('npx tsc --noEmit 2>&1 | tail -10', config.cwd)
        ctx.metadata.autoGitCheck = {
          status: result.exitCode === 0 ? 'passed' : 'issues',
          output: result.stdout?.slice(-300),
        }
      } catch {
        ctx.metadata.autoGitCheck = { status: 'skipped', reason: 'tsc not available' }
      }
    },
    priority: 65,
    toolFilter: ['shell'],
    onError: 'continue',
    description: 'Runs type-check after git commits',
  }
}

// ---------------------------------------------------------------------------
// Custom Post-Action
// ---------------------------------------------------------------------------

/**
 * Creates a tool:after hook from a custom action definition.
 */
export function createCustomActionHook(
  action: AutoAction,
  config: AutoActionConfig,
): HookRegistration<ToolAfterContext> {
  return {
    id: `auto:${action.id}`,
    event: 'tool:after',
    handler: async (ctx) => {
      if (ctx.isError) return

      const filePath = extractFilePath(ctx.args)

      // Check file pattern filter
      if (action.filePattern && filePath && !action.filePattern.test(filePath)) return

      // Interpolate {{file}} in command
      const command = action.command.replace(/\{\{file\}\}/g, filePath ?? '')

      try {
        const result = await config.shell.exec(command, config.cwd)
        ctx.metadata[`auto:${action.id}`] = {
          status: result.exitCode === 0 ? 'success' : 'failed',
          output: result.stdout?.slice(-300),
        }
      } catch (err: unknown) {
        ctx.metadata[`auto:${action.id}`] = {
          status: 'error',
          message: (err as Error).message,
        }
        if (!action.softFail) throw err
      }
    },
    priority: 70,
    toolFilter: action.tools,
    onError: action.softFail ? 'continue' : 'abort',
    description: action.description,
  }
}

// ---------------------------------------------------------------------------
// Convenience: create all auto-action hooks
// ---------------------------------------------------------------------------

export interface AutoActionsConfig {
  /** Shell executor */
  shell: ShellExecutor
  /** Working directory */
  cwd?: string
  /** Enable auto-format (default: false — opt-in) */
  autoFormat?: boolean
  /** Enable auto-lint (default: false — opt-in) */
  autoLint?: boolean
  /** Enable auto-test (default: false — opt-in) */
  autoTest?: boolean
  /** Enable auto git check (default: false — opt-in) */
  autoGitCheck?: boolean
  /** Custom actions */
  customActions?: AutoAction[]
}

/**
 * Returns all configured auto-action hooks, ready to register on a HookPipeline.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAutoActionHooks(config: AutoActionsConfig): HookRegistration<any>[] {
  const baseConfig: AutoActionConfig = {
    shell: config.shell,
    cwd: config.cwd,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks: HookRegistration<any>[] = []

  if (config.autoFormat) hooks.push(createAutoFormatHook(baseConfig))
  if (config.autoLint) hooks.push(createAutoLintHook(baseConfig))
  if (config.autoTest) hooks.push(createAutoTestHook(baseConfig))
  if (config.autoGitCheck) hooks.push(createAutoGitCheckHook(baseConfig))

  if (config.customActions?.length) {
    for (const action of config.customActions) {
      hooks.push(createCustomActionHook(action, baseConfig))
    }
  }

  return hooks
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a file path from tool args — handles different arg naming conventions. */
function extractFilePath(args: Record<string, unknown>): string | null {
  return (args.path ?? args.file ?? args.filename ?? null) as string | null
}
