/**
 * Shell utility tool — `shell`.
 *
 * Wraps the in-process `ShellTool` from `@rivetos/tool-shell` so external MCP
 * clients can execute shell commands through the same surface a local agent
 * uses. The shell tool maintains a session-scoped working directory across
 * calls (so `cd /foo` followed by `ls` works as expected) — that state is
 * scoped to one `createShellTool` instance, which the caller owns for the
 * lifetime of the MCP server.
 *
 * **Security:** This is a write surface. Anyone who can call this tool can
 * run arbitrary shell commands as the MCP server process. The tool itself
 * applies category-based safety controls (`block` for dangerous, `allow` for
 * read/write by default), but ultimate access control is the bearer token
 * (TCP) or unix-socket file permissions (local).
 *
 * Disabled by default — pass `enabled: true` (or set `RIVETOS_MCP_ENABLE_SHELL=1`
 * in the CLI) to opt in.
 */

import { ShellTool, type ShellToolConfig } from '@rivetos/tool-shell'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface ShellToolOptions extends ShellToolConfig {
  /** Override the wire-name prefix. Default `` (no prefix). claude-cli prefixes MCP tools as `mcp__<server>__<name>` so we keep the wire name clean. */
  prefix?: string
}

export interface ShellToolHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** No-op for shell, included for symmetry with other tool factories. */
  close: () => Promise<void>
  /** Underlying tool — exposed for tests / observability. */
  shellTool: ShellTool
}

/**
 * Build the shell tool surface — `shell` — wrapping the in-process
 * implementation from `@rivetos/tool-shell`.
 */
export function createShellTool(options: ShellToolOptions = {}): ShellToolHandle {
  const { prefix = '', ...shellConfig } = options
  const shellTool = new ShellTool(shellConfig)

  const tools: ToolRegistration[] = [
    adaptRivetTool(shellTool, shellInputSchema, {
      name: `${prefix}shell`,
      description:
        'Execute a shell command and return the output. Maintains a session ' +
        'working directory across calls (cd persists). Use for: running ' +
        'scripts, checking system status, git operations, file operations. ' +
        'Mirrors the in-process `shell` tool exposed to local agents.',
    }),
  ]

  return {
    tools,
    async close() {
      /* nothing to drain */
    },
    shellTool,
  }
}

// ---------------------------------------------------------------------------
// Input schema — hand-mapped from plugins/tools/shell/src/index.ts
// ---------------------------------------------------------------------------

export const shellInputSchema = {
  command: z.string().describe('Shell command to execute'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory override for this single call (does not affect session cwd)'),
} satisfies z.ZodRawShape
