import { cn } from '../lib/utils.js'

/** Shared rail-header chrome. Vertical padding is identical in both modes so
 *  the collapse control does not add or remove a row. */
export function railHeaderClass(collapsed: boolean): string {
  return cn('relative flex items-center gap-2 py-4', collapsed ? 'justify-center px-1' : 'px-4')
}

/** Mobile top-bar title — `/` is RivetHub; other routes match the rail labels. */
export function hubPageTitle(pathname: string): string {
  if (pathname === '/') return 'RivetHub'
  if (pathname.startsWith('/memory')) return 'Memory'
  if (pathname.startsWith('/files')) return 'Files'
  if (pathname.startsWith('/tasks')) return 'Tasks'
  if (pathname.startsWith('/workflows')) return 'Workflows'
  if (pathname.startsWith('/settings')) return 'Settings'
  return 'RivetHub'
}

/** The DenBot logo button IS the rail toggle; there is no collapse/expand icon. */
export function railToggle(collapsed: boolean): {
  kind: 'collapse' | 'expand'
  label: string
  ariaExpanded: boolean
} {
  return collapsed
    ? { kind: 'expand', label: 'Expand sidebar', ariaExpanded: false }
    : { kind: 'collapse', label: 'Collapse sidebar', ariaExpanded: true }
}
