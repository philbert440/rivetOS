/**
 * Spaces canvas camera — pure port of the concept mock's layout and zoom
 * math (fit, fly, insets, focus). Framework-free so the altitudes can be
 * tested without a DOM. Skin (type, colour, radius) is not part of this
 * module; only the geometry is.
 *
 * Altitudes: everything (mock "mesh", zoom capped below the live band), space
 * (mock "canvas"), thread (mock "terminal", the open tile fills the
 * viewport at 100%).
 */

export const TW = 880
export const TH = 210
export const GAP = 80
export const PAD = 70
/**
 * The region's top band holds the "active · waiting on you" count and, under
 * it, the first row's title pills. Both grow with --inv as the camera pulls
 * back (count capped at 22px top + 1.2 × 30px; pills at --ch 2.2, about
 * 65px), so PAD alone let the pills cover the count past ~1.5× out.
 */
export const PAD_TOP = 130
export const CGAP = 300
/** The "+ New session" bar under a project's cards: one column wide, well
 *  short of a card, so adding a session never costs a whole card slot. */
export const ADD_H = 96
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
  /** Threads in the region. regH leaves room for the "+ New session" bar. */
  count: number
  /** Starting directory, when a later slice has one. Adds a label line. */
  dir?: string
  /** Fixed height in place of regH(count), for a box that holds no tiles. */
  h?: number
}

/** Height of the "+ New space" box. It holds no tiles, so a short strip. */
export const NEW_SPACE_H = 240

export interface TileSlot {
  regionId: string
  index: number
  x: number
  y: number
  w: number
  h: number
}

/** A region's inner padding around its cards. */
export interface RegionPad {
  x: number
  top: number
  bottom: number
}

/** The box's own padding: room for the counts and title pills far out. */
export const BOX_PAD: RegionPad = { x: PAD, top: PAD_TOP, bottom: PAD }

export interface LaidRegion {
  id: string
  rect: Rect
  slots: TileSlot[]
  /** Card height in this region: TH, or taller while it is stretched. */
  tileH: number
  pad: RegionPad
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

/** One tile inside a region. */
export function tileSlot(
  regionId: string,
  origin: Pick<Rect, 'x' | 'y'>,
  index: number,
  tileH: number = TH,
  pad: RegionPad = BOX_PAD,
): TileSlot {
  const tw = (REG_W - 2 * pad.x - GAP) / 2
  return {
    regionId,
    index,
    x: origin.x + pad.x + (index % 2) * (tw + GAP),
    y: origin.y + pad.top + Math.floor(index / 2) * (tileH + GAP),
    w: tw,
    h: tileH,
  }
}

/** Card rows for `n` threads. An empty region keeps one row for its button. */
function tileRows(n: number): number {
  return Math.max(1, Math.ceil(n / 2))
}

/** Height the "+ New session" bar adds below the cards. With an odd count it
 *  sits beside the last card and adds nothing. */
function addRowH(n: number): number {
  return n > 0 && n % 2 === 0 ? GAP + ADD_H : 0
}

/** The "+ New session" bar for a region holding `n` threads: the next free
 *  column, ADD_H tall. */
export function addSlot(
  regionId: string,
  origin: Pick<Rect, 'x' | 'y'>,
  n: number,
  tileH: number = TH,
  pad: RegionPad = BOX_PAD,
): TileSlot {
  return { ...tileSlot(regionId, origin, n, tileH, pad), index: n, h: ADD_H }
}

/** Card height that makes `n` threads' rows fill a region `h` tall. Never
 *  below TH. */
export function stretchTileH(n: number, h: number, pad: RegionPad = BOX_PAD): number {
  const rows = tileRows(n)
  return Math.max(TH, (h - pad.top - pad.bottom - addRowH(n) - (rows - 1) * GAP) / rows)
}

/** Region height for `n` threads, with room for the "+ New session" bar. */
export function regH(n: number, pad: RegionPad = BOX_PAD): number {
  const rows = tileRows(n)
  return pad.top + pad.bottom + rows * TH + (rows - 1) * GAP + addRowH(n)
}

/**
 * Screen padding the camera must keep clear of the HUD. The HUD is one top
 * band (breadcrumb left; History and the shortcuts toggle right, the dock
 * dropping from them), so the top inset clears it and the sides only need a
 * margin: an open thread runs to the right edge. Narrow keeps the mock's
 * dock floor. Narrow breakpoints match the mock (720), not the app's 768
 * list cutoff.
 */
export function insets(mode: Altitude, vp: Viewport): Insets {
  const narrow = vp.w < 720
  if (mode === 'thread') {
    return narrow ? { t: 150, b: 96, l: 16, r: 16 } : { t: 64, b: 16, l: 16, r: 16 }
  }
  // Space fills the window with one project: its box runs close to the edges
  // and its name lives in the breadcrumb, so the top only clears the HUD.
  if (mode === 'space') {
    return narrow ? { t: 150, b: 110, l: 12, r: 12 } : { t: 64, b: 12, l: 12, r: 12 }
  }
  return narrow ? { t: 150, b: 110, l: 24, r: 24 } : { t: 72, b: 24, l: 24, r: 24 }
}

/**
 * Responsive grid of regions. Picks the column count whose fitted zoom is
 * highest, refusing a column count that would shrink a region below a
 * readable label. `allRect` includes the label band above the first row.
 */
export function layout(
  items: readonly LayoutRegion[],
  vp: Viewport,
  /** Region to stretch to at least `h` tall, its cards growing to match and
   *  set inside `pad`. The column count ignores it, so stretching never
   *  reshuffles the grid. */
  stretch?: { id: string; h: number; pad: RegionPad },
): LayoutResult {
  const pad = insets('everything', vp)
  const bw = Math.max(40, vp.w - pad.l - pad.r)
  const bh = Math.max(40, vp.h - pad.t - pad.b)
  const sized = items.map((n) => ({ n, h: n.h ?? regH(n.count) }))
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
  const zd = Math.min(bestZ, liveBand(vp).lo - 0.01)
  const lp = labelPx(zd) / zd
  const gapY = Math.max(lp + 40, 160)
  const padOf = (it: (typeof sized)[number]): RegionPad =>
    stretch && it.n.id === stretch.id && it.n.h === undefined ? stretch.pad : BOX_PAD
  for (const it of sized) {
    if (padOf(it) !== BOX_PAD && stretch) {
      it.h = Math.max(regH(it.n.count, stretch.pad), stretch.h)
    }
  }
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
    const pad = padOf(it)
    const tileH = it.n.h === undefined ? stretchTileH(it.n.count, it.h, pad) : TH
    const regionSlots: TileSlot[] = []
    for (let j = 0; j < it.n.count; j++) {
      const slot = tileSlot(it.n.id, rect, j, tileH, pad)
      regionSlots.push(slot)
      slots.push(slot)
    }
    regions.push({ id: it.n.id, rect, slots: regionSlots, tileH, pad })
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
  const band = liveBand(vp)
  const capped = mode === 'everything' ? band.lo - 0.01 : 1
  const z = Math.min(capped, bw / rw, bh / rh)
  const safeZ = z > 0 ? z : 0.01
  const bcx = i.l + bw / 2
  const bcy = i.t + bh / 2
  const cx = rect.x + rect.w / 2 - (bcx - vp.w / 2) / safeZ
  // A space too tall to fit at its full width, or above the live band (where
  // it would never show its minis), keeps that zoom and frames from its top
  // edge; the rest is a pan away.
  const topZ = Math.max(band.hi, Math.min(1, bw / rw))
  if (mode === 'space' && safeZ < topZ) {
    return {
      cx: rect.x + rect.w / 2 - (bcx - vp.w / 2) / topZ,
      cy: rect.y - (i.t - vp.h / 2) / topZ,
      z: topZ,
    }
  }
  return {
    cx,
    cy: rect.y + rect.h / 2 - (bcy - vp.h / 2) / safeZ,
    z: safeZ,
  }
}

/** Thread tile: grow to the viewport minus insets, centred on its slot. */
export function focusRect(
  tile: { x: number; y: number; w?: number; h?: number },
  vp: Viewport,
): Rect {
  const i = insets('thread', vp)
  const w = Math.max(300, vp.w - i.l - i.r)
  const h = Math.max(320, vp.h - i.t - i.b)
  return {
    x: tile.x + (tile.w ?? TW) / 2 - w / 2,
    y: tile.y + (tile.h ?? TH) / 2 - h / 2,
    w,
    h,
  }
}

/** Zoom at which one space's width fills the Space inset box. */
export function spaceWidthZoom(vp: Viewport): number {
  const i = insets('space', vp)
  return Math.max(40, vp.w - i.l - i.r) / REG_W
}

/** Zoom `fit` frames a full-width space with in Space. */
export function spaceZoom(vp: Viewport): number {
  return Math.max(Math.min(1, spaceWidthZoom(vp)), liveBand(vp).hi)
}

/**
 * World height a region needs to fill the Space inset box top to bottom at
 * the zoom `fit` frames a full-width space with.
 */
export function spaceFillHeight(vp: Viewport): number {
  const i = insets('space', vp)
  const bh = Math.max(40, vp.h - i.t - i.b)
  return bh / spaceZoom(vp)
}

/** Screen px of the Space band above the cards: the title pills, and the
 *  counts over them when there are any. */
const SPACE_TOP_PX = 42
const SPACE_COUNTS_PX = 26
const SPACE_SIDE_PX = 16

/**
 * Padding of the project you are in. BOX_PAD is sized for the zoomed-out
 * view; here the camera's zoom is known, so the padding is set in screen px
 * and the cards take the rest.
 */
export function spacePad(vp: Viewport, counts: boolean): RegionPad {
  const z = spaceZoom(vp)
  return {
    x: SPACE_SIDE_PX / z,
    top: (SPACE_TOP_PX + (counts ? SPACE_COUNTS_PX : 0)) / z,
    bottom: SPACE_SIDE_PX / z,
  }
}

/**
 * Zoom band where cards crossfade to live minis. It scales with the
 * viewport, a fixed share below a space's width-fit zoom, so Everything
 * (capped just under `lo`) can frame a canvas of one or two spaces nearly
 * as large as Space would. LIVE_LO / LIVE_HI are the floor on small screens.
 */
export function liveBand(vp: Viewport): { lo: number; hi: number } {
  const s = spaceWidthZoom(vp)
  return { lo: Math.max(LIVE_LO, s * 0.9), hi: Math.max(LIVE_HI, s * 0.98) }
}

/** World transform. `live` crossfades cards (0) and minis (1) between the two zooms. */
export function apply(cam: Cam, vp: Viewport): { tx: number; ty: number; z: number; live: number } {
  const z = cam.z
  const tx = vp.w / 2 - cam.cx * z
  const ty = vp.h / 2 - cam.cy * z
  const band = liveBand(vp)
  const live = Math.min(1, Math.max(0, (z - band.lo) / (band.hi - band.lo)))
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

/** Hand zoom never enters thread. Below the live band the canvas is everything. */
export function altitudeFromZoom(z: number, vp: Viewport): 'everything' | 'space' {
  return z < liveBand(vp).lo ? 'everything' : 'space'
}
