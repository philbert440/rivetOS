/**
 * Theme store: preference (light | dark | system) persisted via lib/theme.ts,
 * resolved against prefers-color-scheme, applied as `data-theme` on <html> so
 * the token sets + color-scheme in theme.css flip. meta theme-color tracks
 * the resolved theme for window chrome tint.
 *
 * Importing this module applies the current theme immediately (side effect at
 * the bottom); the inline boot script in index.html covers the pre-JS frame.
 */

import { create } from 'zustand'
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme.js'

interface ThemeState {
  preference: ThemePreference
  /** Live prefers-color-scheme reading; `system` resolves against it. */
  systemDark: boolean
  setPreference: (pref: ThemePreference) => void
}

const media = (): MediaQueryList | undefined =>
  typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: dark)')

export const useTheme = create<ThemeState>()((set) => ({
  preference: loadThemePreference(),
  // No matchMedia (tests, odd WebViews) → dark, the historical look.
  systemDark: media()?.matches ?? true,
  setPreference(pref: ThemePreference): void {
    saveThemePreference(pref)
    set({ preference: pref })
  },
}))

export function resolvedThemeOf(s: Pick<ThemeState, 'preference' | 'systemDark'>): ResolvedTheme {
  return resolveTheme(s.preference, s.systemDark)
}

export function useResolvedTheme(): ResolvedTheme {
  return useTheme(resolvedThemeOf)
}

function applyDom(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved
  // Keep in lockstep with theme.css --color-bg (canvas/js cannot read the
  // token before first paint, and meta theme-color takes a literal).
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0d1117' : '#f6f4ee')
}

if (typeof document !== 'undefined') {
  applyDom(resolvedThemeOf(useTheme.getState()))
  useTheme.subscribe((s) => applyDom(resolvedThemeOf(s)))
  media()?.addEventListener('change', (e) => {
    useTheme.setState({ systemDark: e.matches })
  })
}
