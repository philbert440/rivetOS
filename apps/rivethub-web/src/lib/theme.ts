/**
 * Theme preference (`rivethub.theme` in localStorage): light | dark | system.
 * `system` resolves against prefers-color-scheme at apply time. Pure helpers
 * only — the zustand binding and DOM application live in stores/theme.ts.
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'rivethub.theme'

/** Stored as the bare value (no envelope), like rivethub.wikiUrl. */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

export function loadThemePreference(
  get: (key: string) => string | null = (key) => localStorage.getItem(key),
): ThemePreference {
  return parseThemePreference(get(THEME_STORAGE_KEY))
}

export function saveThemePreference(
  pref: ThemePreference,
  set: (key: string, value: string) => void = (key, value) => {
    localStorage.setItem(key, value)
  },
): void {
  set(THEME_STORAGE_KEY, pref)
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}
