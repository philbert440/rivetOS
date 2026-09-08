import { access, readdir, readFile, readlink } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

/** Codex has no session-start hook. On Linux, its writable rollout file provides
 * an exact room → transcript link, without guessing from cwd or recency.
 * Other platforms and inaccessible processes simply leave the room unresolved.
 */
export async function findCodexRoomRollout(
  room: string,
  sessionsDir: string,
  procDir = '/proc',
): Promise<string | undefined> {
  if (!room || room.includes('\0')) return undefined
  const paths = new Set<string>()
  const root = resolve(sessionsDir) + sep
  let pids: string[]
  try {
    pids = await readdir(procDir)
  } catch {
    return undefined
  }
  await Promise.all(
    pids
      .filter((pid) => /^\d+$/.test(pid))
      .map(async (pid) => {
        const dir = join(procDir, pid)
        try {
          const argv = (await readFile(join(dir, 'cmdline'), 'utf8')).split('\0')
          if (basename(argv[0] ?? '') !== 'codex') return
          const env = (await readFile(join(dir, 'environ'), 'utf8')).split('\0')
          if (!env.includes(`RIVET_DEN_SESSION=${room}`)) return
          for (const fd of await readdir(join(dir, 'fd'))) {
            try {
              const path = await readlink(join(dir, 'fd', fd))
              // Startup/history scans open other conversations read-only.
              // Only the writable rollout belongs to this running session.
              const info = await readFile(join(dir, 'fdinfo', fd), 'utf8')
              const flags = /^flags:\s+([0-7]+)$/m.exec(info)?.[1]
              if (!flags || (Number.parseInt(flags, 8) & 3) === 0) continue
              if (
                path.startsWith(root) &&
                /^rollout-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(
                  basename(path),
                )
              )
                paths.add(path)
            } catch {
              // A descriptor may close during discovery.
            }
          }
        } catch {
          // Processes can exit or belong to another user.
        }
      }),
  )
  // An ambiguous room must never display another conversation's transcript.
  return paths.size === 1 ? [...paths][0] : undefined
}

// Bound both staleness after a room restarts and memory use across many rooms.
const roomRollouts = new Map<string, { path: string; expires: number }>()
export async function resolveCodexRoomRollout(
  room: string,
  sessionsDir: string,
  procDir = '/proc',
): Promise<string | undefined> {
  const key = JSON.stringify([resolve(sessionsDir), procDir, room])
  const cached = roomRollouts.get(key)
  if (cached && cached.expires > Date.now()) {
    try {
      await access(cached.path)
      return cached.path
    } catch {
      // Removed rollouts must be rediscovered immediately.
    }
  }
  roomRollouts.delete(key)
  const path = await findCodexRoomRollout(room, sessionsDir, procDir)
  if (path) {
    if (roomRollouts.size >= 256) roomRollouts.delete(roomRollouts.keys().next().value!)
    roomRollouts.set(key, { path, expires: Date.now() + 30_000 })
  }
  return path
}
