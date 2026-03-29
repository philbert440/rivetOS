/**
 * @rivetos/tool-shell
 *
 * Reference Tool implementation. Executes shell commands.
 * Supports AbortSignal for cancellation via /stop.
 */

import { exec, type ChildProcess } from 'node:child_process';
import type { Tool } from '@rivetos/types';

export interface ShellToolConfig {
  /** Working directory for commands (default: process.cwd()) */
  cwd?: string;
  /** Command timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Max output size in bytes (default: 100KB) */
  maxOutput?: number;
  /** Blocked commands (security) */
  blocked?: string[];
}

export class ShellTool implements Tool {
  name = 'shell';
  description = 'Execute a shell command and return the output. Use for: running scripts, checking system status, git operations, file operations.';
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
    },
    required: ['command'],
  };

  private config: Required<ShellToolConfig>;

  constructor(config?: ShellToolConfig) {
    this.config = {
      cwd: config?.cwd ?? process.cwd(),
      timeoutMs: config?.timeoutMs ?? 60_000,
      maxOutput: config?.maxOutput ?? 100_000,
      blocked: config?.blocked ?? ['rm -rf /', 'mkfs', ':(){:|:&};:'],
    };
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const command = String(args.command ?? '');
    const cwd = String(args.cwd ?? this.config.cwd);

    if (!command.trim()) {
      return 'Error: No command provided';
    }

    // Security check
    for (const blocked of this.config.blocked) {
      if (command.includes(blocked)) {
        return `Error: Command blocked (matches "${blocked}")`;
      }
    }

    return new Promise<string>((resolve) => {
      let child: ChildProcess;

      try {
        child = exec(command, {
          cwd,
          timeout: this.config.timeoutMs,
          maxBuffer: this.config.maxOutput,
          env: { ...process.env, TERM: 'dumb' },
        });
      } catch (err: any) {
        resolve(`Error: ${err.message}`);
        return;
      }

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => { stdout += data; });
      child.stderr?.on('data', (data) => { stderr += data; });

      // AbortSignal support
      if (signal) {
        const onAbort = () => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('exit', () => signal.removeEventListener('abort', onAbort));
      }

      child.on('error', (err) => {
        resolve(`Error: ${err.message}`);
      });

      child.on('exit', (code) => {
        const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : '')).trim();

        if (signal?.aborted) {
          resolve('Command aborted');
          return;
        }

        if (output.length > this.config.maxOutput) {
          resolve(output.slice(0, this.config.maxOutput) + `\n[truncated at ${this.config.maxOutput} bytes]`);
          return;
        }

        if (code !== 0 && code !== null) {
          resolve(`${output}\n[exit code: ${code}]`);
          return;
        }

        resolve(output || '(no output)');
      });
    });
  }
}
