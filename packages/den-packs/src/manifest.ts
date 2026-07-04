// SpritePack manifest types — spec v1. See PACK.md for the authored contract.
// Everything a den needs that was once hand-tuned in viewer code lives here
// as pack data: art grid, chroma key, pose sets, furniture geometry, layout.

import type { Activity } from '@rivetos/den-protocol'

export const PACK_SPEC_VERSION = 1 as const

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One animation: ordered frame images + timing. frameMs 0 = static (frame 0). */
export interface Pose {
  /** Pack-relative PNG paths, all frames the same pixel dimensions. */
  frames: string[]
  /** Milliseconds per frame; 0 renders frame 0 only. */
  frameMs: number
  /** First N frames play ONCE on entering the pose (e.g. climbing into
   *  bed), then the remaining frames loop. */
  intro?: number
  /** Content height in shell units when this pose overrides the character
   *  default (e.g. lying-down sleep sprite). */
  height?: number
  /** Attachment points in frame-image coordinates — where the renderer
   *  pins Z's, thought bubbles, props. */
  attachments?: Record<string, { x: number; y: number }>
  /** Composite pose: this art contains the character AND the named
   *  furniture piece(s) interacting. While active, the renderer hides that
   *  furniture and draws this pose at its anchor instead (anchored to the
   *  first id when several are replaced). */
  replaces?: string | string[]
}

export interface CharacterSpec {
  /** Default content height in shell units. */
  height: number
  poses: Record<string, Pose>
  /** Every protocol activity must map to a pose. 'walk' is the reserved
   *  locomotion pose used between stations. */
  activities: Record<Activity, string>
  /** Optional per-tool pose overrides, keyed by raw tool name
   *  (fallback chain: tool → activity → 'idle'). */
  tools?: Record<string, string>
}

export interface FurnitureSpec {
  id: string
  /** Pack-relative sprite path. Bottom-center anchored. */
  src: string
  /** Night-time art (local 19:00–07:00); day `src` is the fallback. */
  nightSrc?: string
  /** Alternate art the renderer may swap in (EDIT mode). */
  variants?: string[]
  /** Monitor glass in ORIGINAL image coordinates — desk terminal text area. */
  screen?: Rect
  /** Writable surface in ORIGINAL image coordinates — whiteboard text area. */
  textRect?: Rect
  /** Side-view sprite for seat-sequence furniture (chair hop-on animation). */
  sideSrc?: string
  /** Render layer: 'floor' pieces (rugs) draw under everything and never
   *  occlude the character; default is depth-sorted standing furniture. */
  layer?: 'floor'
}

export interface Placement {
  x: number // bottom-center x, shell units
  y: number // bottom (base) y, shell units
  h: number // target content height, shell units
  flip?: boolean
}

/** Where the character's feet go per activity — furniture-anchored (+offset)
 *  or absolute, in shell units. */
export interface Station {
  furn?: string
  dx?: number
  dy?: number
  x?: number
  y?: number
}

/** Viewer tuning knobs — every field optional, viewer defaults apply.
 *  These were hardcoded viewer constants; packs whose art disagrees with the
 *  defaults (floor line, terminal density) override them here. */
export interface ViewerTuning {
  /** Where the character stands when a station has neither furn nor x/y
   *  (shell units). */
  fallbackStation?: { x: number; y: number }
  /** Fraction of shell height where the walkable floor starts (stations are
   *  clamped below this line). Default 0.755. */
  floorTop?: number
  /** Character columns rendered on the desk terminal glass. Default 17. */
  termCols?: number
}

export interface PackManifest {
  spec: typeof PACK_SPEC_VERSION
  name: string
  version: string
  author: string
  license: string
  /** Size of one art-pixel in shell units — the global pixel grid. */
  grid: { pxPerUnit: number }
  /** Chroma key applied to sprites (not the shell). */
  chroma: { color: string; threshold: number }
  /** Room backdrop. Drawn unkeyed at shell size. `nightSrc` swaps in at night. */
  shell: { src: string; w: number; h: number; nightSrc?: string }
  character: CharacterSpec
  furniture: FurnitureSpec[]
  /** Default arrangement, keyed by furniture id. */
  layout: Record<string, Placement>
  stations: Record<Activity, Station>
  /** Optional viewer tuning; omit to accept the viewer defaults. */
  viewer?: ViewerTuning
}
