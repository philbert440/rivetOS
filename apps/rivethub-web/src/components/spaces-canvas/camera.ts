/**
 * Spaces canvas camera — pure port of the concept mock's layout and zoom
 * math (fit, fly, insets, focus). Framework-free so the altitudes can be
 * tested without a DOM. Skin (type, colour, radius) is not part of this
 * module; only the geometry is.
 *
 * Altitudes: everything (mock "mesh", zoom capped below LIVE_LO), space
 * (mock "canvas"), thread (mock "terminal", the open tile fills the
 * viewport at 100%).
 */

export const TW = 880
export const TH = 560
export const GAP = 110
export const PAD = 90
export const CGAP = 300
/** Two tile columns plus the region's own padding. */
export const REG_W = PAD * 2 + TW * 2 + GAP
export const LIVE_LO = 0.26
export const LIVE_HI = 0.34

export type Altitude = 'everything' | 'space' | 'thread'
export type Direction = 'left' | 'right' | 'up' | 'down'

export interface Viewport {
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Cam {
  cx: number
  cy: number
  z: number
}

export interface Insets {
  t: number
  r: number
  b: number
  l: number
}

export interface LayoutRegion {
  id: string
  /** Label text. Width feeds the gap the solver leaves for a fixed-size label. */
  name: string
  /** Threads in the region. regH reserves one extra slot the way the mock does. */
  count: number
  /** Starting directory, when a later slice has one. Adds a label line. */
  dir?: string
}

export interface TileSlot {
  regionId: string
  index: number
  x: number
  y: number
  w: number
  h: number
}

export interface LaidRegion {
  id: string
  rect: Rect
  slots: TileSlot[]
}

export interface LayoutResult {
  regions: LaidRegion[]
  slots: TileSlot[]
  allRect: Rect
  cols: number
}

export interface NeighborTile {
  id: string
  x: number
  y: number
}

/** One tile inside a region. Index `count` is the phantom new-thread slot. */
export function tileSlot(regionId: string, origin: Pick<Rect, 'x' | 'y'>, index: number): TileSlot {
  return {
    regionId,
    index,
    x: origin.x + PAD + (index % 2) * (TW + GAP),
    y: origin.y + PAD + Math.floor(index / 2) * (TH + GAP),
    w: TW,
    h: TH,
  }
}

/** Region height for `n` threads. The +1 is the mock's phantom new-thread slot. */
export function regH(n: number): number {
  const rows = Math.max(1, Math.ceil((Math.max(0, n) + 1) / 2))
  return PAD * 2 + rows * TH + (rows - 1) * GAP
}

/**
 * Screen padding the camera must keep clear of the HUD. The dock is tucked
 * behind a corner toggle inside the right inset (beside the zoom panel), so
 * the bottom only needs the side margin. Narrow keeps the mock's dock floor.
 * Narrow breakpoints match the mock (720), not the app's 768 list cutoff.
 */
export function insets(mode: Altitude, vp: Viewport): Insets {
  const narrow = vp.w < 720
  if (mode === 'thread') {
    return narrow ? { t: 150, b: 96, l: 16, r: 16 } : { t: 64, b: 16, l: 16, r: 170 }
  }
  return narrow ? { t: 150, b: 110, l: 24, r: 24 } : { t: 72, b: 24, l: 24, r: 180 }
}

/**
 * Responsive grid of regions. Picks the column count whose fitted zoom is
 * highest, refusing a column count that would shrink a region below a
 * readable label. `allRect` includes the label band above the first row.
 */
export function layout(items: readonly LayoutRegion[], vp: Viewport): LayoutResult {
  const pad = insets('everything', vp)
  const bw = Math.max(40, vp.w - pad.l - pad.r)
  const bh = Math.max(40, vp.h - pad.t - pad.b)
  const sized = items.map((n) => ({ n, h: regH(n.count) }))
  if (sized.length === 0) {
    return {
      regions: [],
      slots: [],
      allRect: { x: 0, y: 0, w: REG_W, h: regH(0) },
      cols: 1,
    }
  }
  const rowHs = (cols: number): number[] => {
    const out: number[] = []
    for (let r = 0; r * cols < sized.length; r++) {
      const slice = sized.slice(r * cols, r * cols + cols)
      out.push(Math.max(...slice.map((x) => x.h)))
    }
    return out
  }
  const labelW = Math.max(0, ...items.map((n) => n.name.length * 11)) + 400
  const dirLine = items.some((n) => n.dir) ? 1 : 0
  const labelPx = (z: number): number =>
    16 + 27 * (dirLine + Math.min(4, Math.ceil(labelW / Math.max(60, REG_W * z))))
  const solve = (cols: number): number => {
    const hs = rowHs(cols)
    const gw = cols * REG_W + (cols - 1) * CGAP
    const body = hs.reduce((a, b) => a + b, 0)
    let z = bw / gw
    for (let k = 0; k < 4; k++) {
      z = Math.min(bw / gw, Math.max(0.01, bh - hs.length * labelPx(z)) / Math.max(1, body))
    }
    return z
  }
  let bestCols = 1
  let bestZ = solve(1)
  for (let cols = 2; cols <= sized.length; cols++) {
    const z = solve(cols)
    if (REG_W * z < 150) continue
    if (z > bestZ * 1.001) {
      bestZ = z
      bestCols = cols
    }
  }
  const zd = Math.min(bestZ, LIVE_LO - 0.01)
  const lp = labelPx(zd) / zd
  const gapY = Math.max(lp + 40, 160)
  const hs = rowHs(bestCols)
  let maxX = 0
  let y = 0
  const regions: LaidRegion[] = []
  const slots: TileSlot[] = []
  sized.forEach((it, k) => {
    const col = k % bestCols
    const row = Math.floor(k / bestCols)
    if (col === 0 && row > 0) y += (hs[row - 1] ?? 0) + gapY
    const rect: Rect = { x: col * (REG_W + CGAP), y, w: REG_W, h: it.h }
    maxX = Math.max(maxX, rect.x + rect.w)
    const regionSlots: TileSlot[] = []
    for (let j = 0; j < it.n.count; j++) {
      const slot = tileSlot(it.n.id, rect, j)
      regionSlots.push(slot)
      slots.push(slot)
    }
    regions.push({ id: it.n.id, rect, slots: regionSlots })
  })
  const lastH = hs[hs.length - 1] ?? 0
  const allRect: Rect = { x: 0, y: -lp, w: maxX, h: y + lastH + lp }
  return { regions, slots, allRect, cols: bestCols }
}

/** Camera that frames `rect` inside the altitude's inset box. */
export function fit(rect: Rect, mode: Altitude, vp: Viewport): Cam {
  const i = insets(mode, vp)
  const bw = Math.max(40, vp.w - i.l - i.r)
  const bh = Math.max(40, vp.h - i.t - i.b)
  const rw = rect.w > 0 ? rect.w : 1
  const rh = rect.h > 0 ? rect.h : 1
  const capped = mode === 'everything' ? LIVE_LO - 0.01 : 1
  const z = Math.min(capped, bw / rw, bh / rh)
  const safeZ = z > 0 ? z : 0.01
  const bcx = i.l + bw / 2
  const bcy = i.t + bh / 2
  return {
    cx: rect.x + rect.w / 2 - (bcx - vp.w / 2) / safeZ,
    cy: rect.y + rect.h / 2 - (bcy - vp.h / 2) / safeZ,
    z: safeZ,
  }
}

/** Thread tile: grow to the viewport minus insets, centred on its slot. */
export function focusRect(tile: { x: number; y: number }, vp: Viewport): Rect {
  const i = insets('thread', vp)
  const w = Math.max(300, vp.w - i.l - i.r)
  const h = Math.max(320, vp.h - i.t - i.b)
  return { x: tile.x + TW / 2 - w / 2, y: tile.y + TH / 2 - h / 2, w, h }
}

/** World transform. `live` crossfades cards (0) and minis (1) between the two zooms. */
export function apply(cam: Cam, vp: Viewport): { tx: number; ty: number; z: number; live: number } {
  const z = cam.z
  const tx = vp.w / 2 - cam.cx * z
  const ty = vp.h / 2 - cam.cy * z
  const live = Math.min(1, Math.max(0, (z - LIVE_LO) / (LIVE_HI - LIVE_LO)))
  return { tx, ty, z, live }
}

/**
 * Nearest tile in `dir`. Score is distance along the axis plus twice the
 * cross-axis drift, so a tile straight ahead beats a nearer diagonal.
 * Returns null when nothing lies that way; the first tile when `sel` is unknown.
 */
export function neighbor(
  sel: string | undefined,
  tiles: readonly NeighborTile[],
  dir: Direction,
): NeighborTile | null {
  const a = tiles.find((t) => t.id === sel)
  if (!a) return tiles[0] ?? null
  const ax = a.x + TW / 2
  const ay = a.y + TH / 2
  let best: NeighborTile | null = null
  let bestScore = Infinity
  for (const t of tiles) {
    if (t.id === a.id) continue
    const dx = t.x + TW / 2 - ax
    const dy = t.y + TH / 2 - ay
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    const across = dir === 'left' || dir === 'right' ? dy : dx
    if (along <= 1) continue
    const score = along + 2 * Math.abs(across)
    if (score < bestScore) {
      bestScore = score
      best = t
    }
  }
  return best
}

/** Zoom by `factor` keeping the world point under `p` (stage-local px) fixed. */
export function zoomAround(
  cam: Cam,
  p: { x: number; y: number },
  factor: number,
  vp: Viewport,
): Cam {
  const z0 = cam.z > 0 ? cam.z : 0.04
  const wx = cam.cx + (p.x - vp.w / 2) / z0
  const wy = cam.cy + (p.y - vp.h / 2) / z0
  const z = Math.min(1, Math.max(0.04, z0 * factor))
  return { cx: wx - (p.x - vp.w / 2) / z, cy: wy - (p.y - vp.h / 2) / z, z }
}

/** One fly sample. `t` is 0..1; easing is cubic ease-out, zoom is log-interpolated. */
export function flyStep(from: Cam, to: Cam, t: number): Cam {
  const clamped = Math.min(1, Math.max(0, t))
  const e = 1 - (1 - clamped) ** 3
  const z0 = from.z > 0 ? from.z : 0.04
  const z1 = to.z > 0 ? to.z : 0.04
  return {
    cx: from.cx + (to.cx - from.cx) * e,
    cy: from.cy + (to.cy - from.cy) * e,
    z: Math.exp(Math.log(z0) + (Math.log(z1) - Math.log(z0)) * e),
  }
}

/** Hand zoom never enters thread. Below LIVE_LO the canvas is everything. */
export function altitudeFromZoom(z: number): 'everything' | 'space' {
  return z < LIVE_LO ? 'everything' : 'space'
}
