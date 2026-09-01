/**
 * Terminal color schemes for the embedded xterm (Settings → Terminal).
 *
 * Three palette sources (stores/terminal-settings.ts `themeSource`):
 * - `app`      — derived live from theme.css tokens (what the terminal always
 *                did); ANSI ramp stays at the xterm.js defaults.
 * - `scheme`   — one of the built-in palettes below.
 * - `imported` — a palette the desktop importer (T4) parsed out of the user's
 *                own emulator config; honored verbatim when present.
 *
 * `XtermTheme` / palette mapping are pure data — no @xterm/xterm import — so
 * the schemes and the settings store stay unit-testable without the emulator.
 */

import type { ResolvedTheme } from './theme.js'

export interface TerminalPalette {
  foreground: string
  background: string
  cursor?: string
  selectionBackground?: string
  /** xterm order: black..white, then brightBlack..brightWhite. */
  ansi: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
}

/** The subset of @xterm/xterm's ITheme we ever assign. */
export interface XtermTheme {
  foreground?: string
  background?: string
  cursor?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

/** ANSI key order matching TerminalPalette.ansi. */
const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

export function paletteToXtermTheme(p: TerminalPalette): XtermTheme {
  const theme: XtermTheme = {
    foreground: p.foreground,
    background: p.background,
  }
  if (p.cursor) theme.cursor = p.cursor
  if (p.selectionBackground) theme.selectionBackground = p.selectionBackground
  ANSI_KEYS.forEach((key, i) => {
    theme[key] = p.ansi[i]
  })
  return theme
}

export function isTerminalPalette(v: unknown): v is TerminalPalette {
  if (typeof v !== 'object' || v === null) return false
  const p = v as { foreground?: unknown; background?: unknown; ansi?: unknown }
  return (
    typeof p.foreground === 'string' &&
    typeof p.background === 'string' &&
    Array.isArray(p.ansi) &&
    p.ansi.length === 16 &&
    p.ansi.every((c) => typeof c === 'string')
  )
}

/**
 * `app` theme: today's xtermTheme() from xterm-attach.tsx, moved here. Reads
 * the live theme.css tokens so the terminal tracks the app theme exactly;
 * falls back to the baked-in token values (kept in lockstep with theme.css)
 * when there is no document or the tokens are unset (unit tests, SSR).
 */
export const APP_THEME_FALLBACK: Record<
  ResolvedTheme,
  { background: string; foreground: string; cursor: string }
> = {
  dark: { background: '#0d1117', foreground: '#e6edf3', cursor: '#34d399' },
  light: { background: '#f6f4ee', foreground: '#20293a', cursor: '#059669' },
}

export function appXtermTheme(resolved: ResolvedTheme): XtermTheme {
  const fallback = APP_THEME_FALLBACK[resolved]
  if (typeof document === 'undefined') return { ...fallback }
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  const background = v('--color-bg')
  const foreground = v('--color-ink')
  const cursor = v('--color-em')
  if (!background || !foreground || !cursor) return { ...fallback }
  return { background, foreground, cursor }
}

/**
 * xterm.js's built-in ANSI defaults — the `app` source deliberately leaves
 * the ramp alone (today's behavior), so the settings preview merges these in
 * to have something to show for the 16 swatches.
 */
export const XTERM_DEFAULT_ANSI: TerminalPalette['ansi'] = [
  '#000000',
  '#cd3131',
  '#00bc00',
  '#949800',
  '#0451a5',
  '#bc05bc',
  '#0598bc',
  '#555555',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#e5e5e5',
]

export interface TerminalScheme {
  id: string
  label: string
  dark: boolean
  palette: TerminalPalette
}

/** Built-in schemes — canonical hex values for each well-known palette. */
export const TERMINAL_SCHEMES: TerminalScheme[] = [
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    dark: true,
    palette: {
      foreground: '#cdd6f4',
      background: '#1e1e2e',
      cursor: '#f5e0dc',
      selectionBackground: '#353749',
      ansi: [
        '#45475a',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#bac2de',
        '#585b70',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#a6adc8',
      ],
    },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    dark: false,
    palette: {
      foreground: '#4c4f69',
      background: '#eff1f5',
      cursor: '#dc8a78',
      selectionBackground: '#acb0be',
      ansi: [
        '#5c5f77',
        '#d20f39',
        '#40a02b',
        '#df8e1d',
        '#1e66f5',
        '#ea76cb',
        '#179299',
        '#acb0be',
        '#6c6f85',
        '#d20f39',
        '#40a02b',
        '#df8e1d',
        '#1e66f5',
        '#ea76cb',
        '#179299',
        '#bcc0cc',
      ],
    },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    dark: true,
    palette: {
      foreground: '#ebdbb2',
      background: '#282828',
      cursor: '#ebdbb2',
      selectionBackground: '#504945',
      ansi: [
        '#282828',
        '#cc241d',
        '#98971a',
        '#d79921',
        '#458588',
        '#b16286',
        '#689d6a',
        '#a89984',
        '#928374',
        '#fb4934',
        '#b8bb26',
        '#fabd2f',
        '#83a598',
        '#d3869b',
        '#8ec07c',
        '#ebdbb2',
      ],
    },
  },
  {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    dark: false,
    palette: {
      foreground: '#3c3836',
      background: '#fbf1c7',
      cursor: '#3c3836',
      selectionBackground: '#d5c4a1',
      ansi: [
        '#fbf1c7',
        '#cc241d',
        '#98971a',
        '#d79921',
        '#458588',
        '#b16286',
        '#689d6a',
        '#7c6f64',
        '#928374',
        '#9d0006',
        '#79740e',
        '#b57614',
        '#076678',
        '#8f3f71',
        '#427b58',
        '#3c3836',
      ],
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    dark: true,
    palette: {
      foreground: '#839496',
      background: '#002b36',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      ansi: [
        '#073642',
        '#dc322f',
        '#859900',
        '#b58900',
        '#268bd2',
        '#d33682',
        '#2aa198',
        '#eee8d5',
        '#002b36',
        '#cb4b16',
        '#586e75',
        '#657b83',
        '#839496',
        '#6c71c4',
        '#93a1a1',
        '#fdf6e3',
      ],
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    dark: false,
    palette: {
      foreground: '#657b83',
      background: '#fdf6e3',
      cursor: '#586e75',
      selectionBackground: '#eee8d5',
      ansi: [
        '#073642',
        '#dc322f',
        '#859900',
        '#b58900',
        '#268bd2',
        '#d33682',
        '#2aa198',
        '#eee8d5',
        '#002b36',
        '#cb4b16',
        '#586e75',
        '#657b83',
        '#839496',
        '#6c71c4',
        '#93a1a1',
        '#fdf6e3',
      ],
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    dark: true,
    palette: {
      foreground: '#f8f8f2',
      background: '#282a36',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      ansi: [
        '#21222c',
        '#ff5555',
        '#50fa7b',
        '#f1fa8c',
        '#bd93f9',
        '#ff79c6',
        '#8be9fd',
        '#f8f8f2',
        '#6272a4',
        '#ff6e6e',
        '#69ff94',
        '#ffffa5',
        '#d6acff',
        '#ff92df',
        '#a4ffff',
        '#ffffff',
      ],
    },
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    dark: true,
    palette: {
      foreground: '#abb2bf',
      background: '#282c34',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      ansi: [
        '#282c34',
        '#e06c75',
        '#98c379',
        '#e5c07b',
        '#61afef',
        '#c678dd',
        '#56b6c2',
        '#abb2bf',
        '#5c6370',
        '#e06c75',
        '#98c379',
        '#e5c07b',
        '#61afef',
        '#c678dd',
        '#56b6c2',
        '#ffffff',
      ],
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    dark: true,
    palette: {
      foreground: '#d8dee9',
      background: '#2e3440',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      ansi: [
        '#3b4252',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#88c0d0',
        '#e5e9f0',
        '#4c566a',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#8fbcbb',
        '#eceff4',
      ],
    },
  },
]

export function getTerminalScheme(id: string): TerminalScheme | undefined {
  return TERMINAL_SCHEMES.find((s) => s.id === id)
}
