import { describe, expect, it } from 'vitest'
import {
  CGAP,
  GAP,
  LIVE_HI,
  LIVE_LO,
  PAD,
  REG_W,
  TH,
  TW,
  type Altitude,
  type Cam,
  type Rect,
  type Viewport,
  apply,
  fit,
  flyStep,
  focusRect,
  insets,
  layout,
  neighbor,
  regH,
  zoomAround,
} from './camera.js'

function project(cam: Cam, vp: Viewport, rect: Rect): Rect {
  const { tx, ty, z } = apply(cam, vp)
  return { x: tx + rect.x * z, y: ty + rect.y * z, w: rect.w * z, h: rect.h * z }
}

describe('regH', () => {
  it('reserves a phantom slot so two threads are two rows', () => {
    expect(regH(0)).toBe(PAD * 2 + TH)
    expect(regH(2)).toBe(PAD * 2 + 2 * TH + GAP)
  })
})

describe('fit', () => {
  const modes: Altitude[] = ['everything', 'space', 'thread']

  it('lands the rect inside the inset box at every altitude', () => {
    const vp = { w: 1100, h: 700 }
    // Small enough that the everything cap still contains it.
    const rect = { x: 40, y: 20, w: 200, h: 120 }
    for (const mode of modes) {
      const cam = fit(rect, mode, vp)
      const box = insets(mode, vp)
      const p = project(cam, vp, rect)
      expect(p.x).toBeGreaterThanOrEqual(box.l - 0.5)
      expect(p.y).toBeGreaterThanOrEqual(box.t - 0.5)
      expect(p.x + p.w).toBeLessThanOrEqual(vp.w - box.r + 0.5)
      expect(p.y + p.h).toBeLessThanOrEqual(vp.h - box.b + 0.5)
    }
  })

  it('caps everything below LIVE_LO even when the rect is tiny', () => {
    const cam = fit({ x: 0, y: 0, w: 10, h: 10 }, 'everything', { w: 1100, h: 700 })
    expect(cam.z).toBeLessThan(LIVE_LO)
    expect(cam.z).toBeCloseTo(LIVE_LO - 0.01)
  })

  it('fits a 2-tile region above LIVE_HI at 1100×700 in space', () => {
    const rect = { x: 0, y: 0, w: REG_W, h: regH(2) }
    const cam = fit(rect, 'space', { w: 1100, h: 700 })
    expect(cam.z).toBeGreaterThan(LIVE_HI)
  })
})

describe('focusRect', () => {
  it('fills the viewport minus thread insets and stays centred on the slot', () => {
    const vp = { w: 1100, h: 700 }
    const tile = { x: 100, y: 220 }
    const rect = focusRect(tile, vp)
    const box = insets('thread', vp)
    expect(rect.w).toBe(vp.w - box.l - box.r)
    expect(rect.h).toBe(vp.h - box.t - box.b)
    expect(rect.x + rect.w / 2).toBe(tile.x + TW / 2)
    expect(rect.y + rect.h / 2).toBe(tile.y + TH / 2)
  })
})

describe('neighbor', () => {
  const tiles = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: TW + GAP, y: 0 },
    { id: 'c', x: 0, y: TH + GAP },
    { id: 'd', x: TW + GAP, y: TH + GAP },
  ]

  it('picks the adjacent tile in a 2×2', () => {
    expect(neighbor('a', tiles, 'right')?.id).toBe('b')
    expect(neighbor('a', tiles, 'down')?.id).toBe('c')
    expect(neighbor('b', tiles, 'left')?.id).toBe('a')
    expect(neighbor('b', tiles, 'down')?.id).toBe('d')
    expect(neighbor('c', tiles, 'up')?.id).toBe('a')
    expect(neighbor('d', tiles, 'left')?.id).toBe('c')
    expect(neighbor('a', tiles, 'left')).toBeNull()
  })
})

describe('layout', () => {
  const regions = [0, 1, 2, 3].map((i) => ({
    id: `r${i}`,
    name: 'Space',
    count: 1,
  }))

  it('picks more columns when the viewport is wider than it is tall', () => {
    const narrow = layout(regions, { w: 900, h: 1600 })
    const wide = layout(regions, { w: 4000, h: 900 })
    expect(narrow.cols).toBe(1)
    expect(wide.cols).toBeGreaterThan(narrow.cols)
    expect(wide.regions[1]?.rect.x).toBeGreaterThan(wide.regions[0]?.rect.x ?? 0)
    expect(narrow.regions[1]?.rect.x).toBe(0)
  })

  it('places one slot per thread inside the region padding', () => {
    const laid = layout([{ id: 'unplaced', name: 'Unplaced', count: 2 }], { w: 1400, h: 900 })
    expect(laid.slots).toHaveLength(2)
    expect(laid.slots[0]).toMatchObject({ x: PAD, y: PAD, w: TW, h: TH })
    expect(laid.slots[1]?.x).toBe(PAD + TW + GAP)
    expect(laid.regions[0]?.rect.w).toBe(REG_W)
    expect(CGAP).toBe(300)
  })
})

describe('flyStep', () => {
  it('eases out cubically and log-interpolates zoom', () => {
    const from = { cx: 0, cy: 0, z: 0.25 }
    const to = { cx: 100, cy: 40, z: 1 }
    expect(flyStep(from, to, 0)).toEqual(from)
    expect(flyStep(from, to, 1)).toEqual(to)
    const mid = flyStep(from, to, 0.5)
    // cubic ease-out at t=0.5 is 0.875, past the linear halfway.
    expect(mid.cx).toBeCloseTo(87.5)
    expect(mid.z).toBeCloseTo(Math.exp(Math.log(0.25) + (Math.log(1) - Math.log(0.25)) * 0.875))
  })
})

describe('zoomAround', () => {
  it('keeps the world point under the pointer fixed', () => {
    const vp = { w: 800, h: 600 }
    const cam = { cx: 100, cy: 80, z: 0.5 }
    const p = { x: 200, y: 150 }
    const before = apply(cam, vp)
    const worldX = (p.x - before.tx) / cam.z
    const worldY = (p.y - before.ty) / cam.z
    const next = zoomAround(cam, p, 1.4, vp)
    const after = apply(next, vp)
    expect(after.tx + worldX * next.z).toBeCloseTo(p.x)
    expect(after.ty + worldY * next.z).toBeCloseTo(p.y)
    expect(next.z).toBeCloseTo(0.7)
  })
})
