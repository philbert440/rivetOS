/**
 * Live Omarchy theme switches. Watches each Omarchy `current/` directory that
 * exists and calls `onChange` once per theme switch, so the hub restyles the
 * moment the theme changes instead of on the next window focus.
 *
 * The DIRECTORY is watched, not a file: `omarchy-theme-set` replaces
 * `current/theme` wholesale (rm + mv) and then writes `current/theme.name`
 * last, once the new theme is fully in place. A watch on either file would
 * die with the old inode. One switch fires a burst of events, so they are
 * debounced into a single call. fs.watch is inotify-backed on Linux — no
 * polling, nothing runs while the theme sits still.
 */

import fs from 'node:fs'
import path from 'node:path'
import { candidatePaths, defaultEnv, type ConfigEnv } from './terminal-config.js'

export const OMARCHY_WATCH_DEBOUNCE_MS = 150

/** Entries in `current/` whose change means a new theme landed. */
const THEME_ENTRIES = new Set(['theme.name', 'theme'])

type Watch = (
  dir: string,
  listener: (event: string, filename: string | null) => void,
) => {
  close(): void
}

export interface OmarchyWatchDeps {
  env?: ConfigEnv
  watch?: Watch
  isDir?: (p: string) => boolean
}

/** Existing Omarchy `current/` directories, deduped, in candidate order. */
export function omarchyCurrentDirs(env: ConfigEnv, isDir: (p: string) => boolean): string[] {
  const dirs = candidatePaths(env)
    .filter((c) => c.kind === 'omarchy')
    .map((c) => path.dirname(c.path))
  return [...new Set(dirs)].filter(isDir)
}

export function watchOmarchyTheme(onChange: () => void, deps: OmarchyWatchDeps = {}): () => void {
  const env = deps.env ?? defaultEnv()
  const watch: Watch = deps.watch ?? ((dir, listener) => fs.watch(dir, listener))
  const isDir =
    deps.isDir ??
    ((p: string): boolean => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    })

  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, OMARCHY_WATCH_DEBOUNCE_MS)
  }

  const watchers: Array<{ close(): void }> = []
  for (const dir of omarchyCurrentDirs(env, isDir)) {
    try {
      watchers.push(
        watch(dir, (_event, filename) => {
          // A null filename (platform could not say) is treated as a match.
          if (filename === null || THEME_ENTRIES.has(filename)) fire()
        }),
      )
    } catch {
      // Unwatchable (permissions, inotify limit): the focus sync still covers it.
    }
  }

  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}
