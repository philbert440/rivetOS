import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional class names, de-duping conflicting Tailwind utilities.
 *  The shadcn-style `cn` — lets the ported UI primitives take className
 *  overrides cleanly. Our custom color tokens (em/panel/ink) are opaque to
 *  tailwind-merge, which just preserves them; only stock utilities dedupe. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
