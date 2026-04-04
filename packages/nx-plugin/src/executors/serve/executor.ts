/**
 * @rivetos/nx:serve executor
 *
 * Runs the RivetOS agent runtime for development.
 * Can optionally filter to a single agent or channel.
 *
 * Usage in project.json or package.json:
 *   "serve": {
 *     "executor": "@rivetos/nx:serve",
 *     "options": {
 *       "agent": "opus",
 *       "channel": "telegram"
 *     }
 *   }
 *
 * Or from CLI:
 *   nx run channel-telegram:serve --agent=opus
 */

import { execSync, type ExecSyncOptions } from 'node:child_process'
import { resolve } from 'node:path'
import type { ExecutorContext } from '@nx/devkit'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ServeExecutorSchema {
  config?: string
  agent?: string
  channel?: string
  verbose?: boolean
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export function serveExecutor(
  options: ServeExecutorSchema,
  context: ExecutorContext,
): { success: boolean } {
  const workspaceRoot = context.root

  // Resolve config path
  const configPath = options.config ?? resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')

  // Build the CLI command
  const args: string[] = ['tsx', resolve(workspaceRoot, 'packages/cli/src/index.ts'), 'start']

  if (options.config) {
    args.push('--config', configPath)
  }

  // Set environment variables for filtering
  const env: Record<string, string> = { ...process.env } as Record<string, string>

  if (options.agent) {
    env.RIVETOS_AGENT = options.agent
  }

  if (options.channel) {
    env.RIVETOS_CHANNEL = options.channel
  }

  if (options.verbose) {
    env.LOG_LEVEL = 'debug'
  }

  const execOptions: ExecSyncOptions = {
    cwd: workspaceRoot,
    env,
    stdio: 'inherit',
  }

  try {
    console.log(`\n🚀 Starting RivetOS agent runtime`)
    console.log(`   Config:  ${configPath}`)
    if (options.agent) console.log(`   Agent:   ${options.agent}`)
    if (options.channel) console.log(`   Channel: ${options.channel}`)
    console.log('')

    execSync(args.join(' '), execOptions)
    return { success: true }
  } catch (err) {
    // Process was killed (Ctrl+C) — that's normal for a dev server
    const code = (err as { status?: number }).status
    if (code === 130 || code === undefined) {
      console.log('\n👋 Agent stopped.')
      return { success: true }
    }

    console.error(`\n❌ Agent exited with code ${code}`)
    return { success: false }
  }
}

export default serveExecutor
