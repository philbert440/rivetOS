/**
 * file_edit — Edit a file by replacing an exact string match.
 * Fails if old_string is not found or matches multiple times.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import type { Tool, ToolContext } from '@rivetos/types';

const CONTEXT_LINES = 3;

function getEditSnippet(content: string, newString: string, contextLines: number): string {
  const lines = content.split('\n');
  const newLines = newString.split('\n');

  // Find the start of the replacement in the result
  const insertIdx = content.indexOf(newString);
  if (insertIdx === -1) return '(edit applied)';

  const linesBefore = content.slice(0, insertIdx).split('\n');
  const startLine = linesBefore.length; // 1-indexed line where new content starts
  const endLine = startLine + newLines.length - 1;

  const snippetStart = Math.max(0, startLine - 1 - contextLines);
  const snippetEnd = Math.min(lines.length, endLine + contextLines);

  const maxLineNum = snippetEnd;
  const width = String(maxLineNum).length;

  const snippet = lines.slice(snippetStart, snippetEnd).map((line, i) => {
    const num = String(snippetStart + i + 1).padStart(width, ' ');
    return `${num} | ${line}`;
  });

  return snippet.join('\n');
}

export function createFileEditTool(): Tool {
  return {
    name: 'file_edit',
    description: 'Edit a file by replacing an exact string match. Fails if old_string is not found or matches multiple times.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to working directory)' },
        old_string: { type: 'string', description: 'Exact string to find (must match exactly once)' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },

    async execute(args: Record<string, unknown>, _signal?: AbortSignal, context?: ToolContext): Promise<string> {
      const filePath = String(args.path ?? '');
      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');

      if (!filePath) return 'Error: No file path provided';
      if (!oldString) return 'Error: old_string cannot be empty';

      const resolved = isAbsolute(filePath) ? filePath : resolve(context?.workingDir ?? process.cwd(), filePath);

      try {
        const content = await readFile(resolved, 'utf-8');

        // Count occurrences
        let count = 0;
        let searchIdx = 0;
        while (true) {
          const idx = content.indexOf(oldString, searchIdx);
          if (idx === -1) break;
          count++;
          searchIdx = idx + 1;
        }

        if (count === 0) {
          return 'Error: old_string not found in file';
        }

        if (count > 1) {
          return `Error: old_string matches ${count} times — be more specific`;
        }

        // Replace (exactly once)
        const updated = content.replace(oldString, newString);

        await writeFile(resolved, updated, 'utf-8');

        const snippet = getEditSnippet(updated, newString, CONTEXT_LINES);
        return `Edited ${resolved}\n\n${snippet}`;
      } catch (err: any) {
        if (err.code === 'ENOENT') return `Error: File not found: ${resolved}`;
        if (err.code === 'EACCES') return `Error: Permission denied: ${resolved}`;
        return `Error: ${err.message}`;
      }
    },
  };
}
