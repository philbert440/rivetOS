// Canonical room layout: the resolved furniture placements + station spots
// that every den window shares (pack defaults overridden by the node's saved
// layout). The editor mutates THESE objects — through a room's editor hooks —
// and calls notifyChange(); each room keeps per-instance render clones and
// re-syncs from here on change.

import type { Station } from '@rivetos/den-packs'
import type { LoadedPack, PackManifest } from './pack.js'
import type { RuntimePlacement, SavedLayout } from './editor.js'

export interface LayoutModel {
  /** Canonical placements — the editor mutates these in place. */
  placements: RuntimePlacement[]
  /** Canonical station spots (saved offsets already merged in). */
  stations: Record<string, Station>
  /** Subscribe to layout changes; returns an unsubscribe. */
  onChange(cb: () => void): () => void
  /** Broadcast that placements/stations were mutated. */
  notifyChange(): void
}

export function createLayoutModel(
  m: PackManifest,
  pack: LoadedPack,
  saved: SavedLayout | null,
): LayoutModel {
  const placements: RuntimePlacement[] = m.furniture
    .filter((f) => m.layout[f.id])
    .map((f) => {
      const d = m.layout[f.id]
      const o = saved?.placements?.[f.id]
      return {
        id: f.id,
        src: o?.src ?? pack.url(f.src),
        x: o?.x ?? d.x,
        y: o?.y ?? d.y,
        h: o?.h ?? d.h,
        flip: o?.flip ?? d.flip,
      }
    })
  const stations: Record<string, Station> = Object.fromEntries(
    Object.entries(m.stations).map(([k, v]) => [k, { ...v }]),
  )
  for (const [act, o] of Object.entries(saved?.stations ?? {})) {
    if (stations[act]) Object.assign(stations[act], o)
  }

  const listeners = new Set<() => void>()
  return {
    placements,
    stations,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    notifyChange() {
      for (const cb of listeners) cb()
    },
  }
}
