/**
 * search_glob — Find files matching a glob pattern.
 * Uses Node 22's built-in fs/promises.glob.
 */

import { glob } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import type { Tool, ToolContext } from '@rivetos/types';

export interface SearchGlobConfig {
  /** Max results to return (default: 200) */
  maxResults?: number;
  /** Directory names to exclude */
  excludeDirs?: string[];
}

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
]);

export function createSearchGlobTool(config?: SearchGlobConfig): Tool {
  const maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
  const excludeDirs = new Set(config?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);

  return {
    name: 'search_glob',
    description: 'Find files matching a glob pattern. Searches from the working directory.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")' },
        cwd: { type: 'string', description: 'Directory to search from (optional, defaults to working directory)' },
      },
      required: ['pattern'],
    },

    async execute(args: Record<string, unknown>, _signal?: AbortSignal, context?: ToolContext): Promise<string> {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return 'Error: No glob pattern provided';

      const searchDir = args.cwd
        ? (isAbsolute(String(args.cwd)) ? String(args.cwd) : resolve(context?.workingDir ?? process.cwd(), String(args.cwd)))
        : (context?.workingDir ?? process.cwd());

      try {
        const results: string[] = [];

        for await (const entry of glob(pattern, {
          cwd: searchDir,
          exclude: (name) => excludeDirs.has(name),
        })) {
          results.push(entry);
          if (results.length >= maxResults) break;
        }

        if (results.length === 0) {
          return `No files matching "${pattern}" in ${searchDir}`;
        }

        const sorted = results.sort();
        const truncated = sorted.length >= maxResults;
        const header = `Found ${sorted.length}${truncated ? '+' : ''} files:`;
        return `${header}\n${sorted.join('\n')}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}
