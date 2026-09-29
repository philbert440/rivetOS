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
  effectivePreference,
  loadStoredThemePreference,
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
import { OMARCHY_PRESETS, omarchyPresetColors } from '../lib/omarchy-presets.js'

export const OMARCHY_THEME_STORAGE_KEY = 'rivethub.omarchy-theme'

/** `live` = read from the desktop's current Omarchy theme (lib/omarchy-sync);
 *  `preset` = a built-in palette picked in Settings (lib/omarchy-presets). */
export type OmarchySnapshot = {
  name?: string
  colors: OmarchyColors
  source?: 'live' | 'preset'
}

interface ThemeState {
  preference: ThemePreference
  /** True once the user picked a preference; until then an Omarchy palette,
   *  when one is available, is followed automatically. */
  preferenceExplicit: boolean
  /** Live prefers-color-scheme reading; `system` resolves against it. */
  systemDark: boolean
  omarchy: OmarchySnapshot | null
  setPreference: (pref: ThemePreference) => void
  setOmarchy: (v: OmarchySnapshot | null) => void
  /** Apply a built-in Omarchy palette and switch to it. */
  applyPreset: (id: string) => boolean
}

const media = (): MediaQueryList | undefined =>
  typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: dark)')

function loadOmarchy(): OmarchySnapshot | null {
  try {
    const raw = localStorage.getItem(OMARCHY_THEME_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as { name?: unknown; colors?: unknown; source?: unknown }
    if (o.name !== undefined && typeof o.name !== 'string') return null
    if (!isOmarchyColors(o.colors)) return null
    const source = o.source === 'live' || o.source === 'preset' ? o.source : undefined
    return {
      ...(o.name ? { name: o.name } : {}),
      colors: o.colors,
      ...(source ? { source } : {}),
    }
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

function safeLoadStoredPreference(): ThemePreference | null {
  try {
    return loadStoredThemePreference()
  } catch {
    return null
  }
}

const initialStored = safeLoadStoredPreference()
const initialOmarchy = loadOmarchy()

export const useTheme = create<ThemeState>()((set, get) => ({
  preference: effectivePreference(initialStored, initialOmarchy !== null),
  preferenceExplicit: initialStored !== null,
  // No matchMedia (tests, odd WebViews) → dark, the historical look.
  systemDark: media()?.matches ?? true,
  omarchy: initialOmarchy,
  setPreference(pref: ThemePreference): void {
    saveThemePreference(pref)
    set({ preference: pref, preferenceExplicit: true })
  },
  setOmarchy(v: OmarchySnapshot | null): void {
    persistOmarchy(v)
    // Not persisted as a preference: an unset preference keeps following
    // whatever Omarchy palette is (or stops being) available.
    if (get().preferenceExplicit) set({ omarchy: v })
    else set({ omarchy: v, preference: effectivePreference(null, v !== null) })
  },
  applyPreset(id: string): boolean {
    const preset = OMARCHY_PRESETS.find((p) => p.id === id)
    const colors = preset ? omarchyPresetColors(preset.id) : null
    if (!preset || !colors) return false
    get().setOmarchy({ name: preset.name, colors, source: 'preset' })
    get().setPreference('omarchy')
    return true
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
