/**
 * file_write — Write content to a file. Creates parent directories if needed.
 */

import { writeFile, copyFile, stat, mkdir } from 'node:fs/promises'
import { resolve, isAbsolute, dirname } from 'node:path'
import type { Tool, ToolContext } from '@rivetos/types'

export function createFileWriteTool(): Tool {
  return {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (absolute or relative to working directory)',
        },
        content: { type: 'string', description: 'Content to write' },
        backup: {
          type: 'boolean',
          description: 'Create .bak backup if file exists (default: false)',
        },
      },
      required: ['path', 'content'],
    },

    async execute(
      args: Record<string, unknown>,
      _signal?: AbortSignal,
      context?: ToolContext,
    ): Promise<string> {
      const filePath = (args.path as string | undefined) ?? ''
      const content = (args.content as string | undefined) ?? ''
      const backup = args.backup === true

      if (!filePath) return 'Error: No file path provided'

      const resolved = isAbsolute(filePath)
        ? filePath
        : resolve(context?.workingDir ?? process.cwd(), filePath)

      try {
        // Ensure parent directories exist
        await mkdir(dirname(resolved), { recursive: true })

        // Check if file exists (for reporting and backup)
        let existed = false
        try {
          await stat(resolved)
          existed = true
        } catch {
          // File doesn't exist, that's fine
        }

        // Backup if requested and file exists
        if (backup && existed) {
          await copyFile(resolved, resolved + '.bak')
        }

        await writeFile(resolved, content, 'utf-8')

        const bytes = Buffer.byteLength(content, 'utf-8')
        const action = existed ? 'Updated' : 'Created'
        const backupNote = backup && existed ? ' (backup saved as .bak)' : ''

        return `${action} ${resolved} (${bytes} bytes)${backupNote}`
      } catch (err: unknown) {
        if (err.code === 'EACCES') return `Error: Permission denied: ${resolved}`
        return `Error: ${(err as Error).message}`
      }
    },
  }
}
