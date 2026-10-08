/**
 * Keyboard decisions for the spaces canvas. The capture listener in
 * SpacesCanvas turns a key into one of these commands; this module says
 * what that does to the selection and the altitude. Thread altitude claims
 * only the chords — arrows, Enter and Esc stay with the focused session.
 */

import { neighbor, type Altitude, type Direction, type NeighborTile } from './camera.js'

export type CanvasChord = 'zoom-toggle' | 'everything'
export type CanvasNav = Direction | 'open' | 'out'

export interface CanvasKeyState {
  altitude: Altitude
  selectedId: string | undefined
}

export type CanvasEffect =
  | { type: 'open'; id: string }
  | { type: 'select'; id: string }
  | { type: 'go'; altitude: 'everything' | 'space' }
  | { type: 'noop' }

/** True when this key is claimed at `altitude` (and must not reach the session). */
export function canvasKeyClaims(
  altitude: Altitude,
  chord: CanvasChord | null,
  nav: CanvasNav | null,
): boolean {
  if (chord) return true
  if (altitude === 'thread') return false
  return nav !== null
}

export function reduceCanvasCommand(
  state: CanvasKeyState,
  command: { chord?: CanvasChord; nav?: CanvasNav },
  tiles: readonly NeighborTile[],
): CanvasEffect {
  const selected = state.selectedId ?? tiles[0]?.id
  if (command.chord === 'everything') return { type: 'go', altitude: 'everything' }
  if (command.chord === 'zoom-toggle') {
    if (state.altitude === 'thread') return { type: 'go', altitude: 'space' }
    return selected ? { type: 'open', id: selected } : { type: 'noop' }
  }
  if (!command.nav || state.altitude === 'thread') return { type: 'noop' }
  if (command.nav === 'out') {
    return state.altitude === 'space' ? { type: 'go', altitude: 'everything' } : { type: 'noop' }
  }
  if (command.nav === 'open') return selected ? { type: 'open', id: selected } : { type: 'noop' }
  const next = neighbor(state.selectedId, tiles, command.nav)
  return next ? { type: 'select', id: next.id } : { type: 'noop' }
}

/** Apply a command the way the canvas key listener does. */
export function performCanvasEffect(
  effect: CanvasEffect,
  sink: {
    open: (id: string) => void
    select: (id: string) => void
    go: (altitude: 'everything' | 'space') => void
  },
): void {
  switch (effect.type) {
    case 'open':
      sink.open(effect.id)
      return
    case 'select':
      sink.select(effect.id)
      return
    case 'go':
      sink.go(effect.altitude)
      return
    case 'noop':
      return
  }
}
