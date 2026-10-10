import { cn } from '../lib/utils.js'

/** Shared rail-header chrome. Vertical padding is identical in both modes so
 *  the collapse control does not add or remove a row. */
export function railHeaderClass(collapsed: boolean): string {
  return cn('relative flex items-center gap-2 py-4', collapsed ? 'justify-center px-1' : 'px-4')
}

/** Mobile top-bar title — `/` is RivetHub; other routes match the rail labels.
 *  Sessions is a Memory tab, so it titles as Memory. */
export function hubPageTitle(pathname: string): string {
  if (pathname === '/') return 'RivetHub'
  if (pathname.startsWith('/sessions')) return 'Memory'
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

/** A rail item is active on its own route and its children, and on any route
 *  it hosts as a tab (`also`) — Memory stays lit on `/sessions`. */
export function navItemActive(pathname: string, to: string, also: readonly string[] = []): boolean {
  if (to === '/') return pathname === '/'
  return [to, ...also].some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
