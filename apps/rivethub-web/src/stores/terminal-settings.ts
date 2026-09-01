/**
 * Terminal settings store (`rivethub.terminal` in localStorage): font, cursor,
 * scrollback, renderer, bell, clipboard gestures, and palette source for the
 * embedded xterm. zustand + persist, same pattern as stores/wiki-settings.ts.
 *
 * `rendererActual` is runtime state, NOT persisted: xterm-attach flips it to
 * 'canvas' when the WebGL addon fails to load or loses its context, so
 * Settings can show "WebGL unavailable, using canvas" without the preference
 * itself changing.
 *
 * All writes go through normalizeSettings — persisted values are re-validated
 * on rehydrate (merge), so a hand-edited or stale localStorage blob can never
 * push fontSize/scrollback out of range or invent an enum value.
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ResolvedTheme } from '../lib/theme.js'
import {
  appXtermTheme,
  getTerminalScheme,
  isTerminalPalette,
  paletteToXtermTheme,
  type TerminalPalette,
  type XtermTheme,
} from '../lib/terminal-schemes.js'

export type { TerminalPalette, XtermTheme }

export const TERMINAL_STORAGE_KEY = 'rivethub.terminal'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  ligatures: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  renderer: 'webgl' | 'canvas'
  bell: 'none' | 'visual'
  copyOnSelect: boolean
  rightClickPaste: boolean
  themeSource: 'app' | 'scheme' | 'imported'
  /** Built-in scheme id (lib/terminal-schemes.ts) when themeSource==='scheme'. */
  scheme: string
  /** Palette parsed from the user's emulator config by the desktop importer
   *  (T4). Honored when themeSource==='imported' and it is present. */
  imported?: TerminalPalette
}

export const TERMINAL_LIMITS = {
  fontSize: { min: 8, max: 32 },
  lineHeight: { min: 0.8, max: 2.0 },
  scrollback: { min: 500, max: 100_000 },
} as const

/** macOS reserves right-click for the context menu; paste-on-right-click is
 *  an everywhere-else default. */
function defaultRightClickPaste(): boolean {
  if (typeof navigator === 'undefined') return true
  return !/mac/i.test(navigator.platform) && !/mac os/i.test(navigator.userAgent)
}

export const TERMINAL_DEFAULTS: TerminalSettings = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  lineHeight: 1.0,
  letterSpacing: 0,
  ligatures: false,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  renderer: 'webgl',
  bell: 'none',
  copyOnSelect: false,
  rightClickPaste: defaultRightClickPaste(),
  themeSource: 'app',
  scheme: 'catppuccin-mocha',
  imported: undefined,
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function normalizeSettings(s: Partial<TerminalSettings>): TerminalSettings {
  const d = TERMINAL_DEFAULTS
  return {
    fontFamily:
      typeof s.fontFamily === 'string' && s.fontFamily.trim() ? s.fontFamily : d.fontFamily,
    fontSize: clamp(
      num(s.fontSize, d.fontSize),
      TERMINAL_LIMITS.fontSize.min,
      TERMINAL_LIMITS.fontSize.max,
    ),
    lineHeight: clamp(
      num(s.lineHeight, d.lineHeight),
      TERMINAL_LIMITS.lineHeight.min,
      TERMINAL_LIMITS.lineHeight.max,
    ),
    letterSpacing: num(s.letterSpacing, d.letterSpacing),
    ligatures: s.ligatures === true,
    cursorStyle:
      s.cursorStyle === 'underline' || s.cursorStyle === 'bar' ? s.cursorStyle : d.cursorStyle,
    cursorBlink: s.cursorBlink !== false,
    scrollback: Math.round(
      clamp(
        num(s.scrollback, d.scrollback),
        TERMINAL_LIMITS.scrollback.min,
        TERMINAL_LIMITS.scrollback.max,
      ),
    ),
    renderer: s.renderer === 'canvas' ? 'canvas' : 'webgl',
    bell: s.bell === 'visual' ? 'visual' : 'none',
    copyOnSelect: s.copyOnSelect === true,
    rightClickPaste: typeof s.rightClickPaste === 'boolean' ? s.rightClickPaste : d.rightClickPaste,
    themeSource: s.themeSource === 'scheme' || s.themeSource === 'imported' ? s.themeSource : 'app',
    scheme: typeof s.scheme === 'string' && s.scheme ? s.scheme : d.scheme,
    imported: isTerminalPalette(s.imported) ? s.imported : undefined,
  }
}

interface TerminalSettingsState extends TerminalSettings {
  /** Renderer actually in use; flips to 'canvas' on WebGL failure/context
   *  loss. Runtime-only — excluded from persistence. */
  rendererActual: 'webgl' | 'canvas'
  update: (patch: Partial<TerminalSettings>) => void
  setRendererActual: (r: 'webgl' | 'canvas') => void
  resetToDefaults: () => void
}

/** Strip the runtime/action fields down to the persisted settings shape. */
function pickSettings(s: TerminalSettingsState): TerminalSettings {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    ligatures: s.ligatures,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    renderer: s.renderer,
    bell: s.bell,
    copyOnSelect: s.copyOnSelect,
    rightClickPaste: s.rightClickPaste,
    themeSource: s.themeSource,
    scheme: s.scheme,
    imported: s.imported,
  }
}

export const useTerminalSettings = create<TerminalSettingsState>()(
  persist(
    (set, get) => ({
      ...TERMINAL_DEFAULTS,
      rendererActual: TERMINAL_DEFAULTS.renderer,
      update(patch: Partial<TerminalSettings>): void {
        set(normalizeSettings({ ...pickSettings(get()), ...patch }))
      },
      setRendererActual(r: 'webgl' | 'canvas'): void {
        // Guard: xterm-attach calls this from its settings effect — an
        // unguarded set would re-render the subscriber and loop.
        if (get().rendererActual !== r) set({ rendererActual: r })
      },
      resetToDefaults(): void {
        // Reset keeps a T4-imported palette: it is data, not a preference.
        set({ ...TERMINAL_DEFAULTS, imported: get().imported })
      },
    }),
    {
      name: TERMINAL_STORAGE_KEY,
      // Explicit global localStorage, not the default window.localStorage —
      // the default leaves persistence disabled outright under non-window
      // hosts (vitest's node environment), which also hides the .persist API.
      storage: createJSONStorage(() => localStorage),
      partialize: pickSettings,
      merge: (persisted, current) => ({
        ...current,
        ...normalizeSettings({
          ...pickSettings(current),
          ...(persisted as Partial<TerminalSettings> | undefined),
        }),
      }),
    },
  ),
)

/**
 * The xterm theme for the current settings + app theme. `app` tracks the
 * theme.css tokens (ANSI ramp left at xterm defaults, as before); `scheme`
 * maps the chosen built-in palette; `imported` honors the T4-imported palette
 * when present, and both `imported`-without-palette and an unknown scheme id
 * fall back to `app` rather than a broken theme.
 */
export function resolveXtermTheme(
  settings: Pick<TerminalSettings, 'themeSource' | 'scheme' | 'imported'>,
  resolvedAppTheme: ResolvedTheme,
): XtermTheme {
  if (settings.themeSource === 'scheme') {
    const scheme = getTerminalScheme(settings.scheme)
    if (scheme) return paletteToXtermTheme(scheme.palette)
  }
  if (settings.themeSource === 'imported' && settings.imported) {
    return paletteToXtermTheme(settings.imported)
  }
  return appXtermTheme(resolvedAppTheme)
}
