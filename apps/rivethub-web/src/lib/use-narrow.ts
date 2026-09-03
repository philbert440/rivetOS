/**
 * Viewport narrow-ness for layout branches that must not render the desktop
 * pane (CSS hide is not enough — chat unmounts the idle column).
 *
 * SSR / no-matchMedia: false (desktop), so the first paint matches ≥768px.
 */

import { useSyncExternalStore } from 'react'

export const NARROW_MAX_PX = 767

export function narrowMediaQuery(maxPx = NARROW_MAX_PX): string {
  return `(max-width: ${maxPx}px)`
}

export function readIsNarrow(maxPx = NARROW_MAX_PX): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(narrowMediaQuery(maxPx)).matches
}

export function subscribeIsNarrow(onStoreChange: () => void, maxPx = NARROW_MAX_PX): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined
  }
  const mql = window.matchMedia(narrowMediaQuery(maxPx))
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

const subscribeByMaxPx = new Map<number, (onStoreChange: () => void) => () => void>()

function subscribeForMaxPx(maxPx: number): (onStoreChange: () => void) => () => void {
  let subscribe = subscribeByMaxPx.get(maxPx)
  if (!subscribe) {
    subscribe = (onStoreChange) => subscribeIsNarrow(onStoreChange, maxPx)
    subscribeByMaxPx.set(maxPx, subscribe)
  }
  return subscribe
}

function getServerSnapshot(): boolean {
  return false
}

export function useIsNarrow(maxPx = NARROW_MAX_PX): boolean {
  return useSyncExternalStore(
    subscribeForMaxPx(maxPx),
    () => readIsNarrow(maxPx),
    getServerSnapshot,
  )
}
