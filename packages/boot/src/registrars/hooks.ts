/**
 * Hook Registrar — wires up safety, auto-action, and session hooks.
 * Learning hooks moved to memory plugin (M4.2 — background review loop).
 * Provider fallback was removed in the AI SDK migration.
 */

import { resolve } from 'node:path'
import type { RivetConfig } from '../config.js'
import { logger } from '@rivetos/core'
import {
  HookPipelineImpl,
  createSafetyHooks,
  createAutoActionHooks,
  createSessionHooks,
  RULE_NPM_DRY_RUN,
  RULE_WARN_CONFIG_WRITE,
  RULE_NO_DELETE_GIT,
} from '@rivetos/core'
import type { AuditWriter, AuditEntry, ShellExecutor } from '@rivetos/core'

const log = logger('Boot:Hooks')

export async function registerHooks(
  config: RivetConfig,
  workspaceDir: string,
): Promise<HookPipelineImpl> {
  const pipeline = new HookPipelineImpl(log)

  // --- Safety hooks ---
  const safety = config.runtime.safety
  {
    const auditWriter: AuditWriter = {
      write: async (entry: AuditEntry) => {
        const { appendFile, mkdir } = await import('node:fs/promises')
        const auditDir = resolve(workspaceDir, '.data', 'audit')
        await mkdir(auditDir, { recursive: true })
        const today = new Date().toISOString().split('T')[0]
        const auditPath = resolve(auditDir, `${today}.jsonl`)
        await appendFile(auditPath, JSON.stringify(entry) + '\n')
      },
    }

    const safetyHooks = createSafetyHooks({
      shellDanger: safety?.shellDanger !== false,
      workspaceFence: safety?.workspaceFence,
      auditWriter: safety?.audit !== false ? auditWriter : undefined,
      customRules: [RULE_NPM_DRY_RUN, RULE_NO_DELETE_GIT, RULE_WARN_CONFIG_WRITE],
    })

    for (const hook of safetyHooks) {
      pipeline.register(hook)
    }
    log.info(`Hooks: ${safetyHooks.length} safety hook(s) registered`)
  }

  // --- Auto-action hooks ---
  const autoActions = config.runtime.auto_actions
  if (autoActions) {
    const shellExec: ShellExecutor = {
      exec: async (command: string, cwd?: string) => {
        const { execSync } = await import('node:child_process')
        try {
          const stdout = execSync(command, {
            cwd: cwd ?? workspaceDir,
            timeout: 30000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          return { stdout, stderr: '', exitCode: 0 }
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; status?: number }
          return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: e.status ?? 1,
          }
        }
      },
    }

    const autoHooks = createAutoActionHooks({
      shell: shellExec,
      cwd: workspaceDir,
      autoFormat: autoActions.format === true,
      autoLint: autoActions.lint === true,
      autoTest: autoActions.test === true,
      autoGitCheck: autoActions.gitCheck === true,
    })

    for (const hook of autoHooks) {
      pipeline.register(hook)
    }
    if (autoHooks.length > 0) {
      log.info(`Hooks: ${autoHooks.length} auto-action hook(s) registered`)
    }
  }

  // --- Session hooks ---
  {
    const { appendFile, readFile, writeFile, mkdir } = await import('node:fs/promises')
    const sessionHooks = createSessionHooks({
      context: {
        workspaceDir,
        fileWriter: {
          write: async (path: string, content: string) => {
            const dir = resolve(path, '..')
            await mkdir(dir, { recursive: true })
            await writeFile(path, content)
          },
          read: async (path: string) => {
            try {
              return await readFile(path, 'utf-8')
            } catch {
              return null
            }
          },
          append: async (path: string, content: string) => {
            const dir = resolve(path, '..')
            await mkdir(dir, { recursive: true })
            await appendFile(path, content)
          },
        },
      },
      sessionStart: true,
      sessionSummary: true,
      autoCommit: false,
      preCompact: true,
      postCompact: true,
    })

    for (const hook of sessionHooks) {
      pipeline.register(hook)
    }
    log.info(`Hooks: ${sessionHooks.length} session hook(s) registered`)
  }

  return pipeline
}
