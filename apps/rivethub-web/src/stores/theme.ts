/**
 * Theme store: preference (light | dark | system | omarchy) persisted via
 * lib/theme.ts, resolved against prefers-color-scheme (or the Omarchy snapshot
 * mode), applied as `data-theme` on <html> so the token sets + color-scheme
 * in theme.css flip. When preference is omarchy, inline custom properties
 * override those tokens. meta theme-color tracks the resolved canvas.
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
import {
  applyOmarchyTokens,
  clearOmarchyTokens,
  isOmarchyColors,
  omarchyAppTokens,
  OMARCHY_TOKEN_NAMES,
  type OmarchyColors,
} from '../lib/omarchy-theme.js'

export const OMARCHY_THEME_STORAGE_KEY = 'rivethub.omarchy-theme'

export type OmarchySnapshot = { name?: string; colors: OmarchyColors }

interface ThemeState {
  preference: ThemePreference
  /** Live prefers-color-scheme reading; `system` resolves against it. */
  systemDark: boolean
  omarchy: OmarchySnapshot | null
  setPreference: (pref: ThemePreference) => void
  setOmarchy: (v: OmarchySnapshot | null) => void
}

const media = (): MediaQueryList | undefined =>
  typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: dark)')

function loadOmarchy(): OmarchySnapshot | null {
  try {
    const raw = localStorage.getItem(OMARCHY_THEME_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as { name?: unknown; colors?: unknown }
    if (o.name !== undefined && typeof o.name !== 'string') return null
    if (!isOmarchyColors(o.colors)) return null
    return o.name ? { name: o.name, colors: o.colors } : { colors: o.colors }
  } catch {
    return null
  }
}

function persistOmarchy(v: OmarchySnapshot | null): void {
  try {
    if (v === null) localStorage.removeItem(OMARCHY_THEME_STORAGE_KEY)
    else localStorage.setItem(OMARCHY_THEME_STORAGE_KEY, JSON.stringify(v))
  } catch {
    /* storage disabled */
  }
}

function safeLoadPreference(): ThemePreference {
  try {
    return loadThemePreference()
  } catch {
    return 'system'
  }
}

export const useTheme = create<ThemeState>()((set) => ({
  preference: safeLoadPreference(),
  // No matchMedia (tests, odd WebViews) → dark, the historical look.
  systemDark: media()?.matches ?? true,
  omarchy: loadOmarchy(),
  setPreference(pref: ThemePreference): void {
    saveThemePreference(pref)
    set({ preference: pref })
  },
  setOmarchy(v: OmarchySnapshot | null): void {
    persistOmarchy(v)
    set({ omarchy: v })
  },
}))

export function resolvedThemeOf(
  s: Pick<ThemeState, 'preference' | 'systemDark' | 'omarchy'>,
): ResolvedTheme {
  return resolveTheme(s.preference, s.systemDark, s.omarchy?.colors.mode)
}

export function useResolvedTheme(): ResolvedTheme {
  return useTheme(resolvedThemeOf)
}

function applyDom(
  resolved: ResolvedTheme,
  omarchy: OmarchySnapshot | null,
  preference: ThemePreference,
): void {
  document.documentElement.dataset.theme = resolved
  if (preference === 'omarchy' && omarchy) {
    applyOmarchyTokens(document.documentElement, omarchyAppTokens(omarchy.colors))
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', omarchy.colors.background)
    return
  }
  clearOmarchyTokens(document.documentElement, OMARCHY_TOKEN_NAMES)
  // Keep in lockstep with theme.css --color-bg (canvas/js cannot read the
  // token before first paint, and meta theme-color takes a literal).
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0d1117' : '#f6f4ee')
}

if (typeof document !== 'undefined') {
  const initial = useTheme.getState()
  applyDom(resolvedThemeOf(initial), initial.omarchy, initial.preference)
  useTheme.subscribe((s) => applyDom(resolvedThemeOf(s), s.omarchy, s.preference))
  media()?.addEventListener('change', (e) => {
    useTheme.setState({ systemDark: e.matches })
  })
}
