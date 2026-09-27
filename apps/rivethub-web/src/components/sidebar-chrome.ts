import { cn } from '../lib/utils.js'

/** Shared rail-header chrome. Vertical padding is identical in both modes so
 *  the collapse control does not add or remove a row. */
export function railHeaderClass(collapsed: boolean): string {
  return cn('relative flex items-center gap-2 py-4', collapsed ? 'justify-center px-1' : 'px-4')
}

/** Mobile top-bar title — `/` is RivetHub; other routes match the rail labels. */
export function hubPageTitle(pathname: string): string {
  if (pathname === '/') return 'RivetHub'
  if (pathname.startsWith('/sessions')) return 'Sessions'
  if (pathname.startsWith('/memory')) return 'Memory'
  if (pathname.startsWith('/files')) return 'Files'
  if (pathname.startsWith('/tasks')) return 'Tasks'
  if (pathname.startsWith('/workflows')) return 'Workflows'
  if (pathname.startsWith('/settings')) return 'Settings'
  return 'RivetHub'
}

/** The brand (wordmark expanded, R-H monogram collapsed) IS the rail toggle;
 *  there is no separate collapse/expand icon. */
export function railToggle(collapsed: boolean): {
  kind: 'collapse' | 'expand'
  label: string
  ariaExpanded: boolean
} {
  return collapsed
    ? { kind: 'expand', label: 'Expand sidebar', ariaExpanded: false }
    : { kind: 'collapse', label: 'Collapse sidebar', ariaExpanded: true }
}

/** Label for the strip's theme slot: the Omarchy theme name when one drives
 *  the palette, else the preference itself. */
export function themeLabel(preference: string, omarchyName: string | undefined): string {
  if (preference === 'omarchy') return omarchyName ?? 'omarchy'
  return preference
}

/** The roster name for the active endpoint, else its host. */
export function nodeLabel(
  baseUrl: string,
  roster: readonly { name: string; baseUrl: string }[],
): string {
  const hit = roster.find((n) => n.baseUrl === baseUrl)
  if (hit) return hit.name
  try {
    return new URL(baseUrl).host
  } catch {
    return 'no node'
  }
}
