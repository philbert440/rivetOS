/**
 * Theme preference (`rivethub.theme` in localStorage): light | dark | system | omarchy.
 * `system` resolves against prefers-color-scheme at apply time. `omarchy`
 * resolves to the snapshot's mode (or the OS setting when none is loaded).
 * Pure helpers only — the zustand binding and DOM application live in
 * stores/theme.ts.
 */

export type ThemePreference = 'light' | 'dark' | 'system' | 'omarchy'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'rivethub.theme'

/** Stored as the bare value (no envelope), like rivethub.wikiUrl. */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' || raw === 'omarchy' ? raw : 'system'
}

export function loadThemePreference(
  get: (key: string) => string | null = (key) => localStorage.getItem(key),
): ThemePreference {
  return parseThemePreference(get(THEME_STORAGE_KEY))
}

/** The stored preference, or null when the user has never chosen one (or
 *  the stored value is unrecognized). Distinguishes "chose System" from
 *  "never chose" — only the latter follows an available Omarchy palette. */
export function loadStoredThemePreference(
  get: (key: string) => string | null = (key) => localStorage.getItem(key),
): ThemePreference | null {
  const raw = get(THEME_STORAGE_KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' || raw === 'omarchy' ? raw : null
}

/** The preference in effect: an explicit choice always wins; with none, an
 *  available Omarchy palette (live desktop theme or a saved preset) is
 *  followed, else the OS setting. */
export function effectivePreference(
  stored: ThemePreference | null,
  hasOmarchy: boolean,
): ThemePreference {
  return stored ?? (hasOmarchy ? 'omarchy' : 'system')
}

export function saveThemePreference(
  pref: ThemePreference,
  set: (key: string, value: string) => void = (key, value) => {
    localStorage.setItem(key, value)
  },
): void {
  set(THEME_STORAGE_KEY, pref)
}

export function resolveTheme(
  pref: ThemePreference,
  systemDark: boolean,
  omarchyMode?: 'dark' | 'light',
): ResolvedTheme {
  if (pref === 'omarchy') return omarchyMode ?? (systemDark ? 'dark' : 'light')
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}
