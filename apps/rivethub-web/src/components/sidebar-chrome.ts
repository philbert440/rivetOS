import { cn } from '../lib/utils.js'

/** Shared rail-header chrome. Vertical padding is identical in both modes so
 *  the collapse control does not add or remove a row. */
export function railHeaderClass(collapsed: boolean): string {
  return cn('relative flex items-center gap-2 py-4', collapsed ? 'justify-center px-1' : 'px-4')
}

/** Header hosts the rail toggle; there is no bottom-row control. */
export function railToggle(collapsed: boolean): {
  kind: 'collapse' | 'expand'
  label: string
  ariaExpanded: boolean
} {
  return collapsed
    ? { kind: 'expand', label: 'Expand sidebar', ariaExpanded: false }
    : { kind: 'collapse', label: 'Collapse sidebar', ariaExpanded: true }
}
