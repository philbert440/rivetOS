/**
 * CodeMirror theme per resolved app theme. Dark stays oneDark (historical
 * look); light is chrome-only over CSS vars — basicSetup's default highlight
 * style is already light-oriented, so no new highlight package is needed.
 */

import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'
import type { ResolvedTheme } from './theme.js'

const lightChrome = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--color-ink)' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-panel)',
      color: 'var(--color-ink-dim)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgb(5 150 105 / 0.07)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--color-panel-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgb(5 150 105 / 0.18)',
    },
    '.cm-cursor': { borderLeftColor: 'var(--color-ink)' },
  },
  { dark: false },
)

export function editorThemeFor(theme: ResolvedTheme): Extension {
  return theme === 'light' ? lightChrome : oneDark
}
