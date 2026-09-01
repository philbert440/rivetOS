/**
 * Settings persistence sync: hydrate localStorage from the Electron shell's
 * settings.json on boot if Chromium store is empty, and persist writes back
 * to the file. Survives localStorage wipes (Linux updates emptying the
 * app://bundle origin's store).
 */

import { isElectronShell, rivetShell as getRivetShell } from './shell-bridge.js'

/** Keys that RivetHub settings use (rivethub.* namespace). */
const SETTINGS_KEYS = [
  'rivethub.baseUrl',
  'rivethub.roster',
  'rivethub.wikiUrl',
  'rivethub.theme',
  'rivethub.chatSettings',
  'rivethub.sessionNames',
  'rivethub.remoteUi',
  'rivethub.agent.lastSession',
] as const

/**
 * Hydrate localStorage from the shell's settings.json if Chromium store is
 * empty. Ignores the "already migrated" flag — the file is the source of
 * truth, and an empty localStorage after a wipe should restore from the file
 * even if a prior migration succeeded.
 */
export async function hydrateSettingsIfEmpty(): Promise<void> {
  const rivetShell = getRivetShell()
  if (!isElectronShell(rivetShell) || !rivetShell.settingsGetAll) return

  try {
    // Check if localStorage is empty (no rivethub.* keys)
    const hasAnySettings = SETTINGS_KEYS.some((key) => {
      try {
        return localStorage.getItem(key) !== null
      } catch {
        return false
      }
    })

    if (hasAnySettings) return // localStorage is not empty, don't hydrate

    // Read all settings from the shell's JSON file
    const settings = await rivetShell.settingsGetAll()

    // Hydrate localStorage from the file
    for (const key of SETTINGS_KEYS) {
      const value = settings[key]
      if (value !== undefined) {
        try {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
        } catch {
          /* storage full / disabled */
        }
      }
    }
  } catch {
    /* shell API unavailable or failed — graceful fallback to empty localStorage */
  }
}

/**
 * Wrap localStorage.setItem to also persist to the shell's settings.json.
 * Only intercepts rivethub.* keys; other keys are passed through.
 */
export function installSettingsSync(): void {
  const rivetShell = getRivetShell()
  if (!isElectronShell(rivetShell) || !rivetShell.settingsSet) return

  // Save original methods only when this function is called (not at module load time)
  const originalSetItem = localStorage.setItem.bind(localStorage)
  const originalRemoveItem = localStorage.removeItem.bind(localStorage)

  localStorage.setItem = (key: string, value: string): void => {
    originalSetItem(key, value)
    if (key.startsWith('rivethub.') || key.startsWith('rivethub.agent.')) {
      // Persist to the shell's settings.json asynchronously (don't block)
      const shell = getRivetShell()
      void shell?.settingsSet?.(key, tryParseJson(value))
    }
  }

  localStorage.removeItem = (key: string): void => {
    originalRemoveItem(key)
    if (key.startsWith('rivethub.') || key.startsWith('rivethub.agent.')) {
      // Remove from the shell's settings.json asynchronously (don't block)
      const shell = getRivetShell()
      void shell?.settingsRemove?.(key)
    }
  }
}

/** Try to parse a string as JSON; return the string itself if it fails. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
