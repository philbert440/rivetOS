/**
 * File utility tools — `rivetos.file_read`, `rivetos.file_write`,
 * `rivetos.file_edit`.
 *
 * Wraps the in-process tools from `@rivetos/tool-file` so external MCP clients
 * can read, write, and edit files through the same surface a local agent
 * uses. Path resolution mirrors the in-process behavior — absolute paths
 * are used verbatim; relative paths resolve against the MCP server's cwd
 * (since there's no `ToolContext.session.workingDir` over the wire).
 *
 * **Security:** `file_write` and `file_edit` are write surfaces. Bearer token
 * (TCP) or unix-socket file permissions (local) are the access boundary.
 *
 * Disabled by default — pass `enabled: true` (or set `RIVETOS_MCP_ENABLE_FILE=1`
 * in the CLI) to opt in.
 */

import {
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  type FileReadConfig,
} from '@rivetos/tool-file'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'
import { adaptRivetTool } from './adapt.js'

export interface FileToolsOptions extends FileReadConfig {
  /** Override the wire-name prefix. Default `rivetos.`. */
  prefix?: string
}

export interface FileToolsHandle {
  /** All MCP tool registrations — pass into `createMcpServer({ tools: [...] })`. */
  tools: ToolRegistration[]
  /** No-op for file tools, included for symmetry with other factories. */
  close: () => Promise<void>
}

/**
 * Build the full file tool surface — `file_read`, `file_write`, `file_edit` —
 * wrapping the in-process implementations from `@rivetos/tool-file`.
 */
export function createFileTools(options: FileToolsOptions = {}): FileToolsHandle {
  const { prefix = 'rivetos.', ...readConfig } = options

  const tools: ToolRegistration[] = [
    adaptRivetTool(createFileReadTool(readConfig), fileReadInputSchema, {
      name: `${prefix}file_read`,
      description:
        'Read file contents. Returns text with optional line numbers and an ' +
        'optional line range. Binary files are detected and refused. Mirrors ' +
        'the in-process `file_read` tool.',
    }),
    adaptRivetTool(createFileWriteTool(), fileWriteInputSchema, {
      name: `${prefix}file_write`,
      description:
        'Write content to a file. Creates parent directories if needed. ' +
        'Optional `backup: true` writes a `.bak` copy of the previous content ' +
        'before overwriting. Mirrors the in-process `file_write` tool.',
    }),
    adaptRivetTool(createFileEditTool(), fileEditInputSchema, {
      name: `${prefix}file_edit`,
      description:
        'Edit a file by replacing an exact string match. Fails if `old_string` ' +
        'is not found or matches multiple times — caller must add surrounding ' +
        'context to disambiguate. Mirrors the in-process `file_edit` tool.',
    }),
  ]

  return {
    tools,
    async close() {
      /* nothing to drain */
    },
  }
}

// ---------------------------------------------------------------------------
// Input schemas — hand-mapped from plugins/tools/file/src/tools/*.ts
// ---------------------------------------------------------------------------

export const fileReadInputSchema = {
  path: z.string().describe('File path (absolute or relative to MCP server cwd)'),
  start_line: z.number().int().min(1).optional().describe('First line to read (1-indexed)'),
  end_line: z.number().int().min(1).optional().describe('Last line to read (1-indexed, inclusive)'),
  line_numbers: z.boolean().optional().describe('Show line numbers (default: true)'),
} satisfies z.ZodRawShape

export const fileWriteInputSchema = {
  path: z.string().describe('File path (absolute or relative to MCP server cwd)'),
  content: z.string().describe('Content to write'),
  backup: z.boolean().optional().describe('Create .bak backup if file exists (default: false)'),
} satisfies z.ZodRawShape

export const fileEditInputSchema = {
  path: z.string().describe('File path (absolute or relative to MCP server cwd)'),
  old_string: z.string().describe('Exact string to find — must match exactly once in the file'),
  new_string: z.string().describe('Replacement string'),
} satisfies z.ZodRawShape
