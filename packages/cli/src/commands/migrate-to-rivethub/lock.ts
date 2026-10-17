/**
 * One migrate-to-rivethub run (migration or rollback) per node at a time.
 *
 * The lock lives outside ~/.rivetos because the migration moves that
 * directory. It holds the owner's pid; a lock whose pid is gone (a run that
 * was SIGKILLed, or a reboot) is stale and taken over.
 */

import { dirname, join } from 'node:path'
import type { Host } from './host.js'

/** Per-node scratch directory (relative to home): run lock and --mesh run logs. */
export const RUN_DIR = '.cache/rivethub-migrate'

export function lockPath(home: string): string {
  return join(home, RUN_DIR, 'migrate.lock')
}

function pidIn(text: string | undefined): number | undefined {
  if (!text) return undefined
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function alive(host: Host, pid: number): boolean {
  return host.run(`kill -0 ${String(pid)} 2>/dev/null`).code === 0
}

/** Pid of a live run holding the lock, or undefined (no lock, or a stale one). */
export function lockHolder(host: Host, path: string): number | undefined {
  const pid = pidIn(host.readText(path))
  return pid !== undefined && pid !== host.pid && alive(host, pid) ? pid : undefined
}

export type LockResult = { ok: true; release(): void } | { ok: false; holder?: number }

/** Take the run lock, replacing a stale one. */
export function acquireLock(host: Host, path: string, purpose: string): LockResult {
  const body = `${JSON.stringify({ pid: host.pid, purpose, since: host.now().toISOString() })}\n`
  const release = (): void => {
    if (pidIn(host.readText(path)) === host.pid) host.remove(path)
  }
  host.mkdirp(dirname(path))
  for (let attempt = 0; attempt < 2; attempt++) {
    if (host.createExclusive(path, body, 0o600)) return { ok: true, release }
    const stale = host.readText(path)
    const holder = lockHolder(host, path)
    if (holder !== undefined) return { ok: false, holder }
    // Only remove the lock we judged stale, not one another run just took.
    if (host.readText(path) !== stale) continue
    host.log(`  ℹ️  Removing a stale lock (${path}).`)
    host.remove(path)
  }
  return { ok: false }
}
