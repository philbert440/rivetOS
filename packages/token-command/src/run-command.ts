/**
 * Argv runner — execFile only (no shell). Shared by token minting and tests.
 */

import { execFile } from 'node:child_process'

/** Max stdout retained from a mint command (tokens are short). */
export const TOKEN_COMMAND_MAX_BUFFER = 64 * 1024

export type RunCommand = (
  argv: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<string>

/**
 * Run argv[0] with argv.slice(1) via execFile. Rejects on non-zero exit,
 * timeout, or spawn failure. Stdout is returned trimmed; stderr is never
 * included in the error message (may contain secrets from the helper).
 */
export const defaultRunCommand: RunCommand = (argv, opts) =>
  new Promise((resolve, reject) => {
    if (argv.length === 0 || !argv[0]) {
      reject(new Error('token_command argv is empty'))
      return
    }
    execFile(
      argv[0],
      argv.slice(1),
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: TOKEN_COMMAND_MAX_BUFFER,
        env: opts.env ?? process.env,
        encoding: 'utf8',
      },
      (err, stdout) => {
        if (err) {
          const timedOut =
            'killed' in err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true
          const code = (err as NodeJS.ErrnoException).code
          reject(
            new Error(
              timedOut
                ? `token_command timed out after ${opts.timeoutMs} ms`
                : `token_command failed (exit ${code ?? 'error'})`,
            ),
          )
          return
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout))
      },
    )
  })
