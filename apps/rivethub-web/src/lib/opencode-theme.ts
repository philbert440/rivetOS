/**
 * RivetHub Omarchy snapshot → opencode custom theme.
 *
 * opencode (the TUI) loads user themes from `~/.config/opencode/themes/*.json`
 * (docs: opencode.ai/docs/themes). The desktop app resolves its own palette in
 * omarchy-theme.ts; this module projects those same resolved tokens onto the
 * opencode theme keys so a terminal running next to the app paints with the
 * identical palette. Output is a plain JSON-serializable object.
 */

import { omarchyAppTokens, mixHex, type OmarchyColors } from './omarchy-theme.js'

/** Every color key the opencode theme format accepts (docs example key set). */
export const OPENCODE_THEME_KEYS = [
  'background',
  'backgroundPanel',
  'backgroundElement',
  'backgroundMenu',
  'text',
  'textMuted',
  'primary',
  'secondary',
  'accent',
  'error',
  'warning',
  'success',
  'info',
  'selectedListItemText',
  'border',
  'borderActive',
  'borderSubtle',
  'diffAdded',
  'diffRemoved',
  'diffContext',
  'diffHunkHeader',
  'diffHighlightAdded',
  'diffHighlightRemoved',
  'diffAddedBg',
  'diffRemovedBg',
  'diffContextBg',
  'diffLineNumber',
  'diffAddedLineNumberBg',
  'diffRemovedLineNumberBg',
  'markdownText',
  'markdownHeading',
  'markdownLink',
  'markdownLinkText',
  'markdownCode',
  'markdownBlockQuote',
  'markdownEmph',
  'markdownStrong',
  'markdownHorizontalRule',
  'markdownListItem',
  'markdownListEnumeration',
  'markdownImage',
  'markdownImageText',
  'markdownCodeBlock',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
] as const

export type OpencodeThemeKey = (typeof OPENCODE_THEME_KEYS)[number]

/** `"none"` inherits the terminal default (docs: opencode.ai/docs/themes#terminal-defaults). */
const NONE = 'none'

export interface OmarchyToOpencodeOptions {
  /**
   * Emit `"none"` for the canvas + panel surfaces so the terminal's own
   * background shows through (the RivetHub "terminal theme comes through"
   * look) instead of painting the Omarchy canvas color.
   */
  transparent?: boolean
}

/**
 * Project the resolved Omarchy palette onto opencode's theme keys.
 *
 * The mapping mirrors how the app uses each token: emerald-accent surfaces,
 * panel-2 for element/menu chrome, ink-dim for secondary text, and the app's
 * role colors (user=emerald, error=red, warn=amber, link=blue) driving the
 * diff/markdown/syntax families. Diff tints are mixed into the panel color so
 * they stay subtle over either the Omarchy canvas or a transparent terminal.
 */
export function omarchyToOpencodeTheme(
  colors: OmarchyColors,
  opts: OmarchyToOpencodeOptions = {},
): Record<OpencodeThemeKey, string> {
  const t = omarchyAppTokens(colors)
  const bg = t['--color-bg'] ?? '#0d1117'
  const panel = t['--color-panel'] ?? '#131a22'
  const panel2 = t['--color-panel-2'] ?? '#1a232e'
  const line = t['--color-line'] ?? '#253041'
  const ink = t['--color-ink'] ?? '#e6edf3'
  const inkDim = t['--color-ink-dim'] ?? '#8b98a9'
  const em = t['--color-em'] ?? '#34d399'
  const emDim = t['--color-em-dim'] ?? '#10b981'
  const red = t['--color-red'] ?? '#f87171'
  const warn = t['--color-warn'] ?? '#fbbf24'
  const link = t['--color-link'] ?? '#79c0ff'

  const panelOrNone = opts.transparent ? NONE : panel

  return {
    background: opts.transparent ? NONE : bg,
    backgroundPanel: opts.transparent ? NONE : panel,
    backgroundElement: panel2,
    backgroundMenu: panel2,
    text: ink,
    textMuted: inkDim,
    primary: em,
    secondary: emDim,
    accent: em,
    error: red,
    warning: warn,
    success: em,
    info: link,
    selectedListItemText: bg,
    border: line,
    borderActive: em,
    borderSubtle: line,
    diffAdded: em,
    diffRemoved: red,
    diffContext: inkDim,
    diffHunkHeader: inkDim,
    diffHighlightAdded: em,
    diffHighlightRemoved: red,
    diffAddedBg: mixHex(em, panel, 0.82),
    diffRemovedBg: mixHex(red, panel, 0.82),
    diffContextBg: panelOrNone,
    diffLineNumber: inkDim,
    diffAddedLineNumberBg: mixHex(em, panel, 0.88),
    diffRemovedLineNumberBg: mixHex(red, panel, 0.88),
    markdownText: ink,
    markdownHeading: em,
    markdownLink: link,
    markdownLinkText: emDim,
    markdownCode: link,
    markdownBlockQuote: inkDim,
    markdownEmph: warn,
    markdownStrong: ink,
    markdownHorizontalRule: line,
    markdownListItem: em,
    markdownListEnumeration: emDim,
    markdownImage: link,
    markdownImageText: emDim,
    markdownCodeBlock: ink,
    syntaxComment: inkDim,
    syntaxKeyword: link,
    syntaxFunction: em,
    syntaxVariable: ink,
    syntaxString: emDim,
    syntaxNumber: warn,
    syntaxType: link,
    syntaxOperator: link,
    syntaxPunctuation: inkDim,
  }
}

/** Full opencode theme document, ready to write into `themes/<name>.json`. */
export function omarchyOpencodeThemeDoc(
  colors: OmarchyColors,
  opts: OmarchyToOpencodeOptions = {},
): { $schema: string; theme: Record<OpencodeThemeKey, string> } {
  return {
    $schema: 'https://opencode.ai/theme.json',
    theme: omarchyToOpencodeTheme(colors, opts),
  }
}
