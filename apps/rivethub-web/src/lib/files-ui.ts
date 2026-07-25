/**
 * Pure helpers for the Files browser (preview eligibility, join paths).
 */

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.json',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.log',
  '.csv',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.rs',
  '.go',
  '.env',
  '.svg', // download-as-text only server-side; we still preview as text client-side via fetch
])

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export type PreviewKind = 'text' | 'image' | 'none'

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

/** Client-side preview kind (server still fences HTML as attachment). */
export function previewKind(name: string, size: number): PreviewKind {
  // Cap text preview at 1 MiB so we don't pull huge logs into the panel.
  if (TEXT_EXT.has(extOf(name)) && size <= 1024 * 1024) return 'text'
  if (IMAGE_EXT.has(extOf(name)) && size <= 12 * 1024 * 1024) return 'image'
  return 'none'
}

/** Join root-relative path segments without trailing slash on root. */
export function joinRel(dir: string, name: string): string {
  if (!dir) return name
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** Parent of a root-relative path ('' for top-level entries). */
export function parentRel(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Basename of a root-relative path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}
