/**
 * @rivetos/tool-shell
 *
 * Shell tool for agent command execution.
 *
 * Features:
 *   - Command categorization (read-only / write / dangerous)
 *   - Configurable approval per category (allow / warn / block)
 *   - Background mode for long-running commands
 *   - Git-aware safety warnings
 *   - Session working directory persistence
 *   - Abort signal support
 */

import { exec, type ChildProcess } from 'node:child_process'
import type { Tool, ToolContext } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Command categories
// ---------------------------------------------------------------------------

type CommandCategory = 'read' | 'write' | 'dangerous'
type ApprovalLevel = 'allow' | 'warn' | 'block'

/** Commands considered read-only (safe). */
const READ_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'find',
  'which',
  'whoami',
  'hostname',
  'date',
  'uptime',
  'df',
  'du',
  'free',
  'top',
  'ps',
  'env',
  'printenv',
  'echo',
  'pwd',
  'id',
  'groups',
  'file',
  'stat',
  'readlink',
  'realpath',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git stash list',
  'git tag',
  'git describe',
  'git rev-parse',
  'npm ls',
  'npm view',
  'npm outdated',
  'npx nx graph',
  'docker ps',
  'docker images',
  'docker logs',
  'curl',
  'wget',
  'dig',
  'nslookup',
  'ping',
  'traceroute',
  'tree',
  'less',
  'more',
  'grep',
  'awk',
  'sed',
  'sort',
  'uniq',
  'cut',
  'jq',
  'yq',
])

/** Commands that are destructive / dangerous. */
const DANGEROUS_PATTERNS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  'mkfs',
  ':(){:|:&};:', // fork bomb
  'dd if=',
  '> /dev/sda',
  'chmod -R 777 /',
  'chown -R',
  'shutdown',
  'reboot',
  'init 0',
  'systemctl stop',
  'kill -9 1',
  'pkill -9',
]

/** Git commands that warrant a warning. */
const GIT_WARN_PATTERNS = [
  'git push --force',
  'git push -f',
  'git reset --hard',
  'git clean -fd',
  'git checkout -- .',
  'git stash drop',
  'git branch -D',
]

function categorizeCommand(command: string): CommandCategory {
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0]

  // Check dangerous first
  for (const pattern of DANGEROUS_PATTERNS) {
    if (trimmed.includes(pattern)) return 'dangerous'
  }

  // Check read-only
  if (READ_COMMANDS.has(firstWord)) return 'read'

  // Check multi-word read commands (like 'git status')
  for (const readCmd of READ_COMMANDS) {
    if (readCmd.includes(' ') && trimmed.startsWith(readCmd)) return 'read'
  }

  // Everything else is 'write'
  return 'write'
}

function checkGitWarnings(command: string): string | null {
  for (const pattern of GIT_WARN_PATTERNS) {
    if (command.includes(pattern)) {
      return `⚠️ Git warning: "${pattern}" detected. This can cause data loss.`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ShellToolConfig {
  /** Working directory for commands (default: process.cwd()) */
  cwd?: string
  /** Command timeout in ms (default: 60000) */
  timeoutMs?: number
  /** Max output size in bytes (default: 100KB) */
  maxOutput?: number
  /** Blocked commands (security) */
  blocked?: string[]
  /** Approval levels per category */
  approval?: {
    read?: ApprovalLevel
    write?: ApprovalLevel
    dangerous?: ApprovalLevel
  }
}

// ---------------------------------------------------------------------------
// ShellTool
// ---------------------------------------------------------------------------

export class ShellTool implements Tool {
  name = 'shell'
  description =
    'Execute a shell command and return the output. Use for: running scripts, ' +
    'checking system status, git operations, file operations.'
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
    },
    required: ['command'],
  }

  private config: Required<ShellToolConfig>
  private sessionCwd: string

  constructor(config?: ShellToolConfig) {
    this.config = {
      cwd: config?.cwd ?? process.cwd(),
      timeoutMs: config?.timeoutMs ?? 60_000,
      maxOutput: config?.maxOutput ?? 100_000,
      blocked: config?.blocked ?? ['rm -rf /', 'mkfs', ':(){:|:&};:'],
      approval: {
        read: config?.approval?.read ?? 'allow',
        write: config?.approval?.write ?? 'allow',
        dangerous: config?.approval?.dangerous ?? 'block',
        ...config?.approval,
      },
    }
    this.sessionCwd = this.config.cwd
  }

  async execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    _ctx?: ToolContext,
  ): Promise<string> {
    const command = (args.command as string | undefined) ?? ''
    const cwdOverride = args.cwd as string | undefined

    if (!command.trim()) {
      return 'Error: No command provided'
    }

    // Security: blocked patterns
    for (const blocked of this.config.blocked) {
      if (command.includes(blocked)) {
        return `Error: Command blocked (matches "${blocked}")`
      }
    }

    // Command categorization
    const category = categorizeCommand(command)
    const approval = this.config.approval[category]

    if (approval === 'block') {
      return `Error: Command blocked (category: ${category}). This command requires elevated approval.`
    }

    // Determine working directory
    const cwd = cwdOverride ?? this.sessionCwd

    // Build output parts
    const warnings: string[] = []

    if (approval === 'warn') {
      warnings.push(`⚠️ Warning: This is a ${category} command. Proceeding anyway.`)
    }

    // Git safety
    const gitWarning = checkGitWarnings(command)
    if (gitWarning) {
      warnings.push(gitWarning)
    }

    // Handle `cd` — update session cwd
    const cdMatch = command.match(/^cd\s+(.+)$/)
    if (cdMatch) {
      const targetDir = cdMatch[1].trim().replace(/^["']|["']$/g, '')
      // Resolve relative to current session cwd
      const { resolve } = await import('node:path')
      const newCwd = resolve(cwd, targetDir)

      // Verify it exists
      try {
        const { statSync } = await import('node:fs')
        const stat = statSync(newCwd)
        if (!stat.isDirectory()) {
          return `Error: ${newCwd} is not a directory`
        }
        this.sessionCwd = newCwd
        return `Changed directory to ${newCwd}`
      } catch {
        return `Error: Directory not found: ${newCwd}`
      }
    }

    // Execute
    return new Promise<string>((resolve) => {
      let child: ChildProcess

      try {
        child = exec(command, {
          cwd,
          timeout: this.config.timeoutMs,
          maxBuffer: this.config.maxOutput,
          env: { ...process.env, TERM: 'dumb' },
        })
      } catch (err: unknown) {
        resolve(`Error: ${(err as Error).message}`)
        return
      }

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += String(data)
      })
      child.stderr?.on('data', (data) => {
        stderr += String(data)
      })

      // AbortSignal support
      if (signal) {
        const onAbort = () => {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 2000)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        child.on('exit', () => signal.removeEventListener('abort', onAbort))
      }

      child.on('error', (err) => {
        resolve(formatOutput(warnings, `Error: ${err.message}`))
      })

      child.on('exit', (code) => {
        const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : '')).trim()

        if (signal?.aborted) {
          resolve('Command aborted')
          return
        }

        if (output.length > this.config.maxOutput) {
          resolve(
            formatOutput(
              warnings,
              output.slice(0, this.config.maxOutput) +
                `\n[truncated at ${this.config.maxOutput} bytes]`,
            ),
          )
          return
        }

        if (code !== 0 && code !== null) {
          resolve(formatOutput(warnings, `${output}\n[exit code: ${code}]`))
          return
        }

        resolve(formatOutput(warnings, output || '(no output)'))
      })
    })
  }

  /** Get the current session working directory. */
  getSessionCwd(): string {
    return this.sessionCwd
  }

  /** Reset session cwd to the original config cwd. */
  resetSessionCwd(): void {
    this.sessionCwd = this.config.cwd
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatOutput(warnings: string[], output: string): string {
  if (warnings.length === 0) return output
  return warnings.join('\n') + '\n\n' + output
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { categorizeCommand, checkGitWarnings }
export type { CommandCategory }
