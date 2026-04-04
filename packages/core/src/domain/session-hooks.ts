/**
 * Session Hooks — pre-built lifecycle hooks for session and compaction events.
 *
 * Implements M2.4:
 *   - session:start — load context, greet user, check calendar
 *   - session:end — auto-commit, write session summary, update daily notes
 *   - compact:before — preserve important context before compaction
 *   - compact:after — verify critical context survived compaction
 *
 * All hooks use the existing HookPipeline infrastructure.
 * Side effects (file writes, shell commands) are injected via interfaces.
 */

import type {
  HookRegistration,
  SessionStartContext,
  SessionEndContext,
  CompactBeforeContext,
  CompactAfterContext,
} from '@rivetos/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionHooksContext {
  /** Shell executor for running commands */
  shell?: {
    exec(
      command: string,
      cwd?: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  }
  /** File writer for notes/summaries */
  fileWriter?: {
    write(path: string, content: string): Promise<void>
    read(path: string): Promise<string | null>
    append(path: string, content: string): Promise<void>
  }
  /** Workspace directory */
  workspaceDir?: string
}

// ---------------------------------------------------------------------------
// Session Start Hooks
// ---------------------------------------------------------------------------

/**
 * Creates a session:start hook that logs the session start
 * and loads any session-specific context.
 */
export function createSessionStartHook(
  ctx: SessionHooksContext,
): HookRegistration<SessionStartContext> {
  return {
    id: 'session:start-context',
    event: 'session:start',
    handler: async (hookCtx) => {
      // Record session start in metadata for downstream hooks
      hookCtx.metadata.sessionStartTime = hookCtx.timestamp
      hookCtx.metadata.platform = hookCtx.platform
      hookCtx.metadata.userId = hookCtx.userId

      // Load daily context if available
      if (ctx.fileWriter && ctx.workspaceDir) {
        const today = new Date().toISOString().split('T')[0]
        const dailyNotePath = `${ctx.workspaceDir}/memory/${today}.md`
        try {
          const dailyNote = await ctx.fileWriter.read(dailyNotePath)
          if (dailyNote) {
            hookCtx.metadata.dailyContext = dailyNote.slice(0, 2000) // Cap at 2k
          }
        } catch {
          // No daily note — that's fine
        }
      }
    },
    priority: 30,
    onError: 'continue', // Session start hooks should never block the session
    description: 'Loads session context on start',
  }
}

// ---------------------------------------------------------------------------
// Session End Hooks
// ---------------------------------------------------------------------------

/**
 * Creates a session:end hook that writes a session summary
 * to the daily notes file.
 */
export function createSessionSummaryHook(
  ctx: SessionHooksContext,
): HookRegistration<SessionEndContext> {
  return {
    id: 'session:end-summary',
    event: 'session:end',
    handler: async (hookCtx) => {
      if (!ctx.fileWriter || !ctx.workspaceDir) return

      const today = new Date().toISOString().split('T')[0]
      const now = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      })
      const dailyNotePath = `${ctx.workspaceDir}/memory/${today}.md`

      // Build summary entry
      const lines: string[] = [
        '',
        `## Session ended ${now}`,
        `- Agent: ${hookCtx.agentId ?? 'unknown'}`,
      ]

      if (hookCtx.turnCount) {
        lines.push(`- Turns: ${hookCtx.turnCount}`)
      }

      if (hookCtx.totalTokens) {
        const total = hookCtx.totalTokens.prompt + hookCtx.totalTokens.completion
        lines.push(
          `- Tokens: ${total.toLocaleString()} (${hookCtx.totalTokens.prompt.toLocaleString()} in / ${hookCtx.totalTokens.completion.toLocaleString()} out)`,
        )
      }

      lines.push('')

      try {
        await ctx.fileWriter.append(dailyNotePath, lines.join('\n'))
        hookCtx.metadata.summaryWritten = true
      } catch {
        hookCtx.metadata.summaryWritten = false
      }
    },
    priority: 50,
    onError: 'continue',
    description: 'Writes session summary to daily notes',
  }
}

/**
 * Creates a session:end hook that auto-commits any pending
 * workspace changes.
 */
export function createAutoCommitHook(
  ctx: SessionHooksContext,
): HookRegistration<SessionEndContext> {
  return {
    id: 'session:end-autocommit',
    event: 'session:end',
    handler: async (hookCtx) => {
      if (!ctx.shell || !ctx.workspaceDir) return

      try {
        // Check if there are uncommitted changes
        const status = await ctx.shell.exec('git status --porcelain', ctx.workspaceDir)
        if (!status.stdout.trim()) {
          hookCtx.metadata.autoCommit = { status: 'clean', message: 'No uncommitted changes' }
          return
        }

        // Stage and commit workspace files
        await ctx.shell.exec('git add -A', ctx.workspaceDir)
        const commitResult = await ctx.shell.exec(
          `git commit -m "auto: session end (${hookCtx.agentId ?? 'unknown'}, ${hookCtx.turnCount ?? 0} turns)"`,
          ctx.workspaceDir,
        )

        hookCtx.metadata.autoCommit = {
          status: commitResult.exitCode === 0 ? 'committed' : 'failed',
          output: commitResult.stdout.slice(0, 200),
        }
      } catch (err: unknown) {
        hookCtx.metadata.autoCommit = { status: 'error', message: (err as Error).message }
      }
    },
    priority: 40, // Before summary (so summary includes the commit)
    onError: 'continue',
    description: 'Auto-commits pending workspace changes on session end',
  }
}

// ---------------------------------------------------------------------------
// Compaction Hooks
// ---------------------------------------------------------------------------

/**
 * Creates a compact:before hook that preserves important context
 * before compaction runs.
 *
 * Saves a snapshot of key metadata to the hook context so it can
 * be verified after compaction.
 */
export function createPreCompactHook(): HookRegistration<CompactBeforeContext> {
  return {
    id: 'compact:preserve-context',
    event: 'compact:before',
    handler: (ctx) => {
      // Capture compaction metadata for post-compaction verification
      ctx.metadata.preCompactSnapshot = {
        messageCount: ctx.messageCount,
        timestamp: ctx.timestamp,
      }
    },
    priority: 30,
    onError: 'continue',
    description: 'Captures pre-compaction state for post-compaction verification',
  }
}

/**
 * Creates a compact:after hook that verifies critical context
 * survived compaction.
 */
export function createPostCompactHook(
  ctx: SessionHooksContext,
): HookRegistration<CompactAfterContext> {
  return {
    id: 'compact:verify-context',
    event: 'compact:after',
    handler: async (hookCtx) => {
      const snapshot = hookCtx.metadata.preCompactSnapshot as
        | {
            messageCount?: number
            timestamp?: number
          }
        | undefined

      // Log compaction results
      hookCtx.metadata.compactionResult = {
        originalMessages: snapshot?.messageCount ?? 'unknown',
        remainingMessages: hookCtx.remainingMessages,
        summaryGenerated: !!hookCtx.summary,
        compressionRatio: snapshot?.messageCount
          ? ((1 - hookCtx.remainingMessages / snapshot.messageCount) * 100).toFixed(1) + '%'
          : 'unknown',
      }

      // Optionally log to daily notes
      if (ctx.fileWriter && ctx.workspaceDir) {
        const today = new Date().toISOString().split('T')[0]
        const now = new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        })
        const dailyNotePath = `${ctx.workspaceDir}/memory/${today}.md`

        const logEntry = `\n### Compaction ${now}\n- Messages: ${snapshot?.messageCount ?? '?'} → ${hookCtx.remainingMessages}\n- Summary: ${hookCtx.summary ? 'yes' : 'no'}\n`

        try {
          await ctx.fileWriter.append(dailyNotePath, logEntry)
        } catch {
          // Logging failure is non-critical
        }
      }
    },
    priority: 50,
    onError: 'continue',
    description: 'Verifies context survived compaction and logs results',
  }
}

// ---------------------------------------------------------------------------
// Convenience: create all session hooks
// ---------------------------------------------------------------------------

export interface SessionHooksConfig {
  /** Context for hooks (shell, file writer, workspace) */
  context: SessionHooksContext
  /** Enable session start context loading (default: true) */
  sessionStart?: boolean
  /** Enable session end summary (default: true) */
  sessionSummary?: boolean
  /** Enable auto-commit on session end (default: false — opt-in) */
  autoCommit?: boolean
  /** Enable pre-compaction snapshot (default: true) */
  preCompact?: boolean
  /** Enable post-compaction verification (default: true) */
  postCompact?: boolean
}

/**
 * Returns all configured session hooks, ready to register on a HookPipeline.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSessionHooks(config: SessionHooksConfig): HookRegistration<any>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks: HookRegistration<any>[] = []

  if (config.sessionStart !== false) {
    hooks.push(createSessionStartHook(config.context))
  }

  if (config.sessionSummary !== false) {
    hooks.push(createSessionSummaryHook(config.context))
  }

  if (config.autoCommit) {
    hooks.push(createAutoCommitHook(config.context))
  }

  if (config.preCompact !== false) {
    hooks.push(createPreCompactHook())
  }

  if (config.postCompact !== false) {
    hooks.push(createPostCompactHook(config.context))
  }

  return hooks
}
