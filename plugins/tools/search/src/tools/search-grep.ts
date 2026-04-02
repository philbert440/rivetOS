/**
 * search_grep — Search file contents by pattern.
 * Shells out to grep for speed, returns file:line:match format.
 */

import { exec } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import type { Tool, ToolContext } from '@rivetos/types';

export interface SearchGrepConfig {
  /** Max results to return (default: 100) */
  maxResults?: number;
  /** Directories to exclude from search */
  excludeDirs?: string[];
}

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function createSearchGrepTool(config?: SearchGrepConfig): Tool {
  const maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
  const excludeDirs = config?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;

  return {
    name: 'search_grep',
    description: 'Search file contents by regex or string pattern. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: { type: 'string', description: 'Directory or file to search (defaults to working directory)' },
        include: { type: 'string', description: 'File pattern to include (e.g. "*.ts")' },
        fixed_strings: { type: 'boolean', description: 'Treat pattern as literal string, not regex (default: false)' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
      },
      required: ['pattern'],
    },

    async execute(args: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<string> {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return 'Error: No search pattern provided';

      const searchPath = args.path
        ? (isAbsolute(String(args.path)) ? String(args.path) : resolve(context?.workingDir ?? process.cwd(), String(args.path)))
        : (context?.workingDir ?? process.cwd());

      const fixedStrings = args.fixed_strings === true;
      const caseInsensitive = args.case_insensitive === true;
      const include = args.include ? String(args.include) : undefined;

      // Build grep command
      const parts: string[] = ['grep', '-rn', '--color=never', `-m ${maxResults}`];

      if (fixedStrings) parts.push('-F');
      if (caseInsensitive) parts.push('-i');
      if (include) parts.push(`--include=${shellEscape(include)}`);

      for (const dir of excludeDirs) {
        parts.push(`--exclude-dir=${shellEscape(dir)}`);
      }

      parts.push('--', shellEscape(pattern), shellEscape(searchPath));

      const command = parts.join(' ');

      return new Promise<string>((resolvePromise) => {
        const child = exec(command, {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, TERM: 'dumb' },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => { stdout += data; });
        child.stderr?.on('data', (data) => { stderr += data; });

        if (signal) {
          const onAbort = () => child.kill('SIGTERM');
          signal.addEventListener('abort', onAbort, { once: true });
          child.on('exit', () => signal.removeEventListener('abort', onAbort));
        }

        child.on('error', (err) => {
          resolvePromise(`Error: ${err.message}`);
        });

        child.on('exit', (code) => {
          if (signal?.aborted) {
            resolvePromise('Search aborted');
            return;
          }

          const output = stdout.trim();

          // grep exit 1 = no matches, exit 0 = matches found
          if (!output) {
            resolvePromise(`No matches for "${pattern}" in ${searchPath}`);
            return;
          }

          if (code && code > 1) {
            resolvePromise(`Error: ${stderr.trim() || `grep exited with code ${code}`}`);
            return;
          }

          const lines = output.split('\n');
          const truncated = lines.length >= maxResults;

          resolvePromise(
            truncated
              ? `${output}\n\n[${maxResults}+ matches, results truncated]`
              : output,
          );
        });
      });
    },
  };
}
