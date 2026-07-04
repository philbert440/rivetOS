// Pure math for the window grid: best-fit cols×rows packing for N uniform
// den frames, and the fixed-position CSS rect for DOM elements anchored into
// a window's frame-local coordinate space (DomAnchor). No Pixi, no DOM —
// unit-tested in grid.test.ts; windows.ts is the consumer.

export interface GridSpec {
  cols: number
  rows: number
  /** Uniform scale applied to every frameW × frameH cell. */
  s: number
}

/** Pick the column count in 1..n that maximizes the per-window scale for n
 *  frames of frameW×frameH inside availW×availH with `gap` px between cells.
 *  n=1 degenerates to the plain letterbox fit: s = min(availW/frameW,
 *  availH/frameH) — exactly the pre-grid single-window layout. */
export function computeGrid(
  n: number,
  availW: number,
  availH: number,
  frameW: number,
  frameH: number,
  gap: number,
): GridSpec {
  let best: GridSpec | null = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const s = Math.min(
      (availW - (cols - 1) * gap) / (cols * frameW),
      (availH - (rows - 1) * gap) / (rows * frameH),
    )
    if (!best || s > best.s) best = { cols, rows, s }
  }
  return best! // n ≥ 1 always runs the cols=1 pass
}

/** Top-left corner of window #i (row-major, first-seen order). The grid
 *  block is centered in the avail box at origin (ox, oy); a partial last
 *  row is centered on its own width. */
export function cellPos(
  i: number,
  n: number,
  g: GridSpec,
  ox: number,
  oy: number,
  availW: number,
  availH: number,
  frameW: number,
  frameH: number,
  gap: number,
): { x: number; y: number } {
  const cellW = frameW * g.s
  const cellH = frameH * g.s
  const gridH = g.rows * cellH + (g.rows - 1) * gap
  const row = Math.floor(i / g.cols)
  const col = i % g.cols
  const inRow = row === g.rows - 1 ? n - (g.rows - 1) * g.cols : g.cols
  const rowW = inRow * cellW + (inRow - 1) * gap
  return {
    x: ox + (availW - rowW) / 2 + col * (cellW + gap),
    y: oy + (availH - gridH) / 2 + row * (cellH + gap),
  }
}

export interface AnchorRect {
  left: number
  top: number
  width?: number
  height?: number
}

/** Fixed-position CSS rect for a DOM element anchored at frame-local (x, y)
 *  inside a window whose root sits at (rootX, rootY) with uniform scale s. */
export function anchorCss(
  rootX: number,
  rootY: number,
  s: number,
  a: { x: number; y: number; w?: number; h?: number },
): AnchorRect {
  return {
    left: rootX + a.x * s,
    top: rootY + a.y * s,
    width: a.w === undefined ? undefined : a.w * s,
    height: a.h === undefined ? undefined : a.h * s,
  }
}
