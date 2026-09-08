/**
 * Lifecycle — PID file management and signal handlers for graceful shutdown.
 */

import { resolve } from 'node:path'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import type { Runtime } from '@rivetos/core'
import { logger } from '@rivetos/core'

const log = logger('Boot:Lifecycle')

const DEFAULT_PID_DIR = resolve(process.env.HOME ?? '.', '.rivetos')

/**
 * Write a PID file so external tools can find the running process.
 */
export async function writePidFile(pidDir: string = DEFAULT_PID_DIR): Promise<string> {
  await mkdir(pidDir, { recursive: true })
  const pidPath = resolve(pidDir, 'rivetos.pid')
  await writeFile(pidPath, String(process.pid))
  return pidPath
}

/**
 * Remove the PID file (best-effort, errors are swallowed).
 */
export async function removePidFile(pidDir: string = DEFAULT_PID_DIR): Promise<void> {
  try {
    await unlink(resolve(pidDir, 'rivetos.pid'))
  } catch {
    // File may already be gone — that's fine
  }
}

/**
 * Register SIGINT/SIGTERM handlers for graceful shutdown.
 * Stops the runtime, then optional afterStop (embedded PG — Runtime.stop
 * runs shutdown hooks FIFO, not LIFO, so the socket must close after
 * den/plugins), removes PID file, then exits.
 */
export function registerShutdownHandlers(
  runtime: Runtime,
  pidDir: string = DEFAULT_PID_DIR,
  afterStop?: () => Promise<void>,
): void {
  const shutdown = async () => {
    log.info('Shutting down...')
    await runtime.stop()
    if (afterStop) {
      try {
        await afterStop()
      } catch (err: unknown) {
        log.error(`After-stop hook failed: ${(err as Error).message}`)
      }
    }
    await removePidFile(pidDir)
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown().catch(() => {
      /* noop */
    })
  })
  process.on('SIGTERM', () => {
    shutdown().catch(() => {
      /* noop */
    })
  })
}
