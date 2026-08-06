/**
 * Host `step.run` executor — runs a script as a child process with
 * cwd = the run's caseDir. Lives outside @rivetos/workflows so the engine
 * package stays backend-neutral.
 *
 * - Resolves `script` relative to the workflow dir when not absolute
 * - Passes `in` as JSON on argv[1] (and WORKFLOW_INPUT env)
 * - Captures stdout; parses JSON if parseable else `{stdout, exitCode}`
 * - Respects timeoutMs via kill after deadline
 */

import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { RunExecuteOpts, RunExecutor } from '@rivetos/workflows'

export interface ScriptRunExecutorOptions {
  /** Default timeout when the step doesn't pass one (ms). */
  defaultTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

export function createScriptRunExecutor(options: ScriptRunExecutorOptions = {}): RunExecutor {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async execute(opts: RunExecuteOpts): Promise<unknown> {
      if (opts.skill && !opts.script) {
        throw new Error(
          `ScriptRunExecutor: skill "${opts.skill}" is not supported in v1 (script only)`,
        )
      }
      if (!opts.script) {
        throw new Error(`ScriptRunExecutor: step "${opts.label}" requires opts.script`)
      }

      const scriptPath = resolveScript(opts.script, opts.workflow.dir)
      if (!existsSync(scriptPath)) {
        throw new Error(`ScriptRunExecutor: script not found: ${scriptPath}`)
      }

      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
      const inputJson = JSON.stringify(opts.in ?? {})
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        WORKFLOW_INPUT: inputJson,
        WORKFLOW_CASE_DIR: opts.caseDir,
        WORKFLOW_STEP_ID: opts.stepId,
        WORKFLOW_STEP_LABEL: opts.label,
      }

      return runChild({
        scriptPath,
        caseDir: opts.caseDir,
        inputJson,
        env,
        timeoutMs,
      })
    },
  }
}

function resolveScript(script: string, workflowDir: string): string {
  if (isAbsolute(script)) return script
  return resolve(workflowDir, script)
}

/** Per-run capture cap — a chatty or runaway script must not OOM the gateway. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

function runChild(opts: {
  scriptPath: string
  caseDir: string
  inputJson: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    // Invoke via `sh` so non-executable scripts and shebang scripts both work
    // without requiring chmod in fixtures. detached puts the script in its own
    // process group so a timeout kill reaps grandchildren, not just `sh`.
    const child = spawn('sh', [opts.scriptPath, opts.inputJson], {
      cwd: opts.caseDir,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    const killTree = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree()
      reject(new Error(`Script timed out after ${opts.timeoutMs}ms: ${opts.scriptPath}`))
    }, opts.timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + stderr.length >= MAX_CAPTURE_BYTES) {
        truncated = true
        return
      }
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stdout.length + stderr.length >= MAX_CAPTURE_BYTES) {
        truncated = true
        return
      }
      stderr += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const exitCode = code ?? (signal ? 1 : 0)
      if (exitCode !== 0) {
        reject(
          new Error(
            `Script exited ${exitCode}${signal ? ` (signal ${signal})` : ''}: ${opts.scriptPath}` +
              (truncated ? ' [output truncated]' : '') +
              (stderr.trim() ? `\nstderr: ${stderr.trim().slice(0, 2000)}` : ''),
          ),
        )
        return
      }
      const parsed = parseStdout(stdout, exitCode)
      resolvePromise(
        truncated && typeof parsed === 'object' && parsed !== null
          ? { ...(parsed as Record<string, unknown>), truncated: true }
          : parsed,
      )
    })
  })
}

export function parseStdout(stdout: string, exitCode: number): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return { stdout: '', exitCode }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // Try last non-empty line as JSON (scripts that log then print JSON)
    const lines = trimmed.split('\n').filter((l) => l.trim())
    const last = lines[lines.length - 1]
    if (last) {
      try {
        return JSON.parse(last) as unknown
      } catch {
        /* fall through */
      }
    }
    return { stdout: trimmed, exitCode }
  }
}
