/**
 * Is a harness INSTALLED on this node — can the den actually launch it?
 *
 * "Installed" means exactly what the spawn path will find: the roster entry's
 * argv[0], resolved against the PATH the terminal manager hands the PTY
 * (service PATH + `~/.local/bin`, then roster/entry `env.PATH` overrides —
 * see `harnessSpawnPath`). No extra guessed dirs: a binary only a login shell
 * can see (e.g. mise shims off the service PATH) is one the den cannot spawn,
 * so advertising it would be a lie.
 *
 * Registration is unaffected. Every driver stays registered so sessions of a
 * harness that was since uninstalled still resolve and render; the verdict
 * rides `GET /api/harnesses` as `installed` and pickers filter on it.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId } from '@rivetos/types'
import type { RosterEntry, TermRoster } from '../term/roster.js'
import { findOnPath } from '../term/tmux.js'
import { ROSTER_TO_HARNESS } from './model-sheets.js'

/** Re-check at most this often, so installing a CLI shows up without a restart. */
export const INSTALLED_TTL_MS = 60_000

/** Service managers do not source login profiles; the manager appends this. */
export function withUserLocalBin(pathEnv: string | undefined, home: string = homedir()): string {
  const localBin = join(home, '.local', 'bin')
  if ((pathEnv ?? '').split(':').includes(localBin)) return pathEnv ?? ''
  return [pathEnv, localBin].filter(Boolean).join(':')
}

/** The PATH a PTY for `entry` is spawned with (mirrors `TermManager` spawn env). */
export function harnessSpawnPath(
  roster: Pick<TermRoster, 'env'>,
  entry: Pick<RosterEntry, 'env'>,
  basePath: string | undefined = process.env.PATH,
  home?: string,
): string {
  return entry.env?.PATH ?? roster.env?.PATH ?? withUserLocalBin(basePath, home)
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Can the roster entry under `key` be spawned? Absent entry = no. */
export function rosterEntrySpawnable(
  roster: TermRoster,
  key: string,
  basePath?: string,
  home?: string,
): boolean {
  if (!Object.hasOwn(roster.commands, key)) return false
  const entry = roster.commands[key]
  const argv0 = entry.cmd[0]
  if (!argv0) return false
  if (argv0.includes('/')) return isExecutableFile(argv0)
  return findOnPath(argv0, harnessSpawnPath(roster, entry, basePath, home)) !== null
}

const HARNESS_TO_ROSTER = new Map<HarnessId, string>(
  Object.entries(ROSTER_TO_HARNESS).map(([key, id]) => [id, key]),
)

export interface InstalledProbeDeps {
  roster: () => TermRoster
  /** Harnesses that are reachable without a local binary (e.g. codex app-server). */
  alwaysInstalled?: (harnessId: HarnessId) => boolean
  now?: () => number
  basePath?: () => string | undefined
  home?: string
}

/** TTL-cached `harnessId → installed` verdicts for the list route. */
export function createInstalledProbe(deps: InstalledProbeDeps): (harnessId: HarnessId) => boolean {
  const now = deps.now ?? Date.now
  const cache = new Map<HarnessId, { value: boolean; at: number }>()
  return (harnessId) => {
    const t = now()
    const hit = cache.get(harnessId)
    if (hit && t - hit.at < INSTALLED_TTL_MS) return hit.value
    let value = deps.alwaysInstalled?.(harnessId) ?? false
    if (!value) {
      const key = HARNESS_TO_ROSTER.get(harnessId)
      value =
        key !== undefined &&
        rosterEntrySpawnable(deps.roster(), key, deps.basePath?.() ?? process.env.PATH, deps.home)
    }
    cache.set(harnessId, { value, at: t })
    return value
  }
}
