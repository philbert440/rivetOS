/**
 * One Cowork catch-up when the den starts listening. Not a poll.
 * Spawns the built sidecar `--backfill` (transcript cursors + spool drain)
 * when that bundle exists. Skips quietly when it does not — Desktop is not
 * installed here, or the kit has not been built.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function findCoworkCaptureBundle(start: string): string | undefined {
  let dir = start
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'integrations', 'cowork', 'rivet-memory', 'capture', 'dist', 'cli.js')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

type CatchUpSpawn = (
  command: string,
  args: string[],
  opts: { stdio: 'ignore'; env: NodeJS.ProcessEnv },
) => Pick<ChildProcess, 'unref' | 'on'>

/** Fire-and-forget. Does not block listen and does not throw. */
export function startCoworkCaptureCatchUp(
  opts: { bundle?: string; env?: NodeJS.ProcessEnv; spawnImpl?: CatchUpSpawn } = {},
): void {
  const env = opts.env ?? process.env
  const explicit = opts.bundle ?? env.RIVETOS_COWORK_CAPTURE_BIN?.trim()
  const bundle =
    explicit ||
    findCoworkCaptureBundle(dirname(fileURLToPath(import.meta.url)))
  if (!bundle || !existsSync(bundle)) return
  try {
    const spawnImpl = opts.spawnImpl ?? spawn
    const child = spawnImpl(process.execPath, [bundle, '--backfill'], { stdio: 'ignore', env })
    child.unref?.()
    child.on?.('error', () => {})
  } catch {
    /* A missing node or a bad bundle must not take the den down. */
  }
}
