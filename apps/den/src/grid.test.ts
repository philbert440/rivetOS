import { describe, expect, it } from 'vitest'
import { anchorCss, cellPos, computeGrid } from './grid.js'

// the real numbers for the default pack on a 1400×900 viewport (ui≈1.184):
// FRAME 1300×932, avail 1376×791 after pad/top/bottom reserves
const FW = 1300
const FH = 932
const AW = 1376
const AH = 791
const GAP = 14

describe('computeGrid', () => {
  it('n=1 is the plain letterbox fit (pre-grid layout preserved)', () => {
    const g = computeGrid(1, AW, AH, FW, FH, GAP)
    expect(g).toEqual({ cols: 1, rows: 1, s: Math.min(AW / FW, AH / FH) })
  })

  it('2 windows on a wide screen go side by side', () => {
    const g = computeGrid(2, AW, AH, FW, FH, GAP)
    expect([g.cols, g.rows]).toEqual([2, 1])
  })

  it('3 windows pick 2+1 when that maximizes scale', () => {
    const g = computeGrid(3, AW, AH, FW, FH, GAP)
    expect([g.cols, g.rows]).toEqual([2, 2])
  })

  it('5 windows on a wide screen pick 3×2', () => {
    const g = computeGrid(5, AW, AH, FW, FH, GAP)
    expect([g.cols, g.rows]).toEqual([3, 2])
  })

  it('a tall/narrow avail box stacks vertically instead', () => {
    const g = computeGrid(2, 500, 1600, FW, FH, GAP)
    expect([g.cols, g.rows]).toEqual([1, 2])
  })
})

describe('cellPos', () => {
  it('centers the grid block and centers a partial last row', () => {
    const g = { cols: 2, rows: 2, s: 0.25 }
    const cellW = FW * g.s // 325
    const cellH = FH * g.s // 233
    const gap = 10
    const p0 = cellPos(0, 3, g, 0, 0, 1000, 800, FW, FH, gap)
    const p1 = cellPos(1, 3, g, 0, 0, 1000, 800, FW, FH, gap)
    const p2 = cellPos(2, 3, g, 0, 0, 1000, 800, FW, FH, gap)
    // full first row (2 cells + gap = 660) centered → x0 = 170
    expect(p0.x).toBeCloseTo(170)
    expect(p1.x).toBeCloseTo(170 + cellW + gap)
    expect(p1.y).toBe(p0.y)
    // partial last row (1 cell) centered on its own width
    expect(p2.x).toBeCloseTo((1000 - cellW) / 2)
    expect(p2.y).toBeCloseTo(p0.y + cellH + gap)
    // grid block itself is vertically centered
    expect(p0.y).toBeCloseTo((800 - (2 * cellH + gap)) / 2)
  })

  it('n=1 reproduces the centered letterbox position', () => {
    const g = computeGrid(1, AW, AH, FW, FH, GAP)
    const p = cellPos(0, 1, g, 14.2, 11.8, AW, AH, FW, FH, GAP)
    expect(p.x).toBeCloseTo(14.2 + (AW - FW * g.s) / 2)
    expect(p.y).toBeCloseTo(11.8 + (AH - FH * g.s) / 2)
  })
})

describe('anchorCss (DomAnchor math)', () => {
  it('maps frame-local coords through the root transform', () => {
    expect(anchorCss(100, 50, 0.5, { x: 40, y: 20, w: 200 })).toEqual({
      left: 120,
      top: 60,
      width: 100,
      height: undefined,
    })
  })

  it('scales height when given', () => {
    expect(anchorCss(0, 0, 2, { x: 1, y: 2, h: 30 }).height).toBe(60)
  })
})
