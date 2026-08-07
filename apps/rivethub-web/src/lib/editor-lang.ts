/**
 * Pure language-mode picker for the shared CodeMirror file editor.
 * Extension → mode id; the component maps ids onto @codemirror/lang-* packages.
 */

export type EditorLanguage = 'yaml' | 'javascript' | 'typescript' | 'markdown' | 'json' | 'plain'

const EXT_MAP: Record<string, EditorLanguage> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
}

/** Basename or path → CodeMirror language id. */
export function languageForPath(path: string): EditorLanguage {
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plain'
  const ext = base.slice(dot).toLowerCase()
  return EXT_MAP[ext] ?? 'plain'
}
