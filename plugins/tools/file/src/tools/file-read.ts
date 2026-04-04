/**
 * file_read — Read file contents with optional line range and line numbers.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import type { Tool, ToolContext } from '@rivetos/types'

export interface FileReadConfig {
  /** Max file size in bytes before refusing to read (default: 10MB) */
  maxFileSize?: number
  /** Show line numbers by default (default: true) */
  defaultLineNumbers?: boolean
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const BINARY_CHECK_SIZE = 8192

function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, Math.min(buffer.length, BINARY_CHECK_SIZE))
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true
  }
  return false
}

function formatLineNumber(lineNum: number, maxLineNum: number): string {
  const width = String(maxLineNum).length
  return String(lineNum).padStart(width, ' ')
}

export function createFileReadTool(config?: FileReadConfig): Tool {
  const maxFileSize = config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const defaultLineNumbers = config?.defaultLineNumbers ?? true

  return {
    name: 'file_read',
    description: 'Read file contents. Returns text with optional line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (absolute or relative to working directory)',
        },
        start_line: { type: 'number', description: 'First line to read (1-indexed)' },
        end_line: { type: 'number', description: 'Last line to read (1-indexed, inclusive)' },
        line_numbers: { type: 'boolean', description: 'Show line numbers (default: true)' },
      },
      required: ['path'],
    },

    async execute(
      args: Record<string, unknown>,
      _signal?: AbortSignal,
      context?: ToolContext,
    ): Promise<string> {
      const filePath = (args.path as string | undefined) ?? ''
      if (!filePath) return 'Error: No file path provided'

      const resolved = isAbsolute(filePath)
        ? filePath
        : resolve(context?.workingDir ?? process.cwd(), filePath)
      const showLineNumbers =
        typeof args.line_numbers === 'boolean' ? args.line_numbers : defaultLineNumbers
      const startLine = typeof args.start_line === 'number' ? args.start_line : undefined
      const endLine = typeof args.end_line === 'number' ? args.end_line : undefined

      try {
        const fileStat = await stat(resolved)

        if (fileStat.size > maxFileSize) {
          const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1)
          const maxMB = (maxFileSize / (1024 * 1024)).toFixed(1)
          return `Error: File is ${sizeMB}MB, exceeds ${maxMB}MB limit`
        }

        const buffer = await readFile(resolved)

        if (isBinary(buffer)) {
          return `Binary file detected (${fileStat.size} bytes). Cannot display as text.`
        }

        const content = buffer.toString('utf-8')
        let lines = content.split('\n')

        // Handle trailing newline — don't show empty last line
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines = lines.slice(0, -1)
        }

        const totalLines = lines.length

        // Empty file
        if (totalLines === 0) {
          return ''
        }

        // Apply line range
        const start = startLine ? Math.max(1, startLine) : 1
        const end = endLine ? Math.min(totalLines, endLine) : totalLines

        if (start > totalLines) {
          return `Error: start_line ${start} exceeds file length (${totalLines} lines)`
        }

        const sliced = lines.slice(start - 1, end)
        const maxLineNum = end

        if (showLineNumbers) {
          const formatted = sliced.map((line, i) => {
            const num = formatLineNumber(start + i, maxLineNum)
            return `${num} | ${line}`
          })
          return formatted.join('\n')
        }

        return sliced.join('\n')
      } catch (err: unknown) {
        if (err.code === 'ENOENT') return `Error: File not found: ${resolved}`
        if (err.code === 'EACCES') return `Error: Permission denied: ${resolved}`
        if (err.code === 'EISDIR') return `Error: Path is a directory: ${resolved}`
        return `Error: ${(err as Error).message}`
      }
    },
  }
}
