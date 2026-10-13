import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLOW_VIEW,
  FLOW_ZOOM_MAX,
  FLOW_ZOOM_MIN,
  fitView,
  screenToWorld,
  wheelView,
  zoomAt,
} from './flow-view.js'
import { FLOW_NODE_SIZE } from './flow-layout.js'

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const v = { x: 30, y: -10, k: 1 }
    const before = screenToWorld(v, 200, 150)
    const z = zoomAt(v, 200, 150, 1.5)
    expect(z.k).toBeCloseTo(1.5)
    const after = screenToWorld(z, 200, 150)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps to the zoom range', () => {
    expect(zoomAt(DEFAULT_FLOW_VIEW, 0, 0, 100).k).toBe(FLOW_ZOOM_MAX)
    expect(zoomAt(DEFAULT_FLOW_VIEW, 0, 0, 0.001).k).toBe(FLOW_ZOOM_MIN)
    const atMax = { x: 0, y: 0, k: FLOW_ZOOM_MAX }
    expect(zoomAt(atMax, 10, 10, 2)).toBe(atMax)
  })
})

describe('fitView', () => {
  it('centers small graphs at 1:1', () => {
    const v = fitView([{ x: 0, y: 0 }], 1000, 600)
    expect(v.k).toBe(1)
    expect(v.x).toBeCloseTo((1000 - FLOW_NODE_SIZE) / 2)
    expect(v.y).toBeCloseTo((600 - FLOW_NODE_SIZE) / 2)
  })

  it('zooms out so wide graphs fit with padding', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
    ]
    const v = fitView(nodes, 1000, 600, 50)
    const right = (2000 + FLOW_NODE_SIZE) * v.k + v.x
    expect(v.k).toBeLessThan(1)
    expect(v.x).toBeGreaterThanOrEqual(49.9)
    expect(right).toBeLessThanOrEqual(1000 - 49.9)
  })

  it('falls back to the default view without nodes or size', () => {
    expect(fitView([], 800, 600)).toBe(DEFAULT_FLOW_VIEW)
    expect(fitView([{ x: 0, y: 0 }], 0, 600)).toBe(DEFAULT_FLOW_VIEW)
  })
})

describe('wheelView', () => {
  const v = { x: 0, y: 0, k: 1 }
  it('pans on plain scroll and zooms on pinch / modifier', () => {
    expect(wheelView(v, { deltaX: 10, deltaY: 20, ctrlKey: false, metaKey: false }, 0, 0)).toEqual({
      x: -10,
      y: -20,
      k: 1,
    })
    expect(
      wheelView(v, { deltaX: 0, deltaY: -50, ctrlKey: true, metaKey: false }, 0, 0).k,
    ).toBeGreaterThan(1)
    expect(
      wheelView(v, { deltaX: 0, deltaY: 50, ctrlKey: false, metaKey: true }, 0, 0).k,
    ).toBeLessThan(1)
  })

  it('caps zoom per wheel event so one mouse notch is a step, not a jump', () => {
    const notch = wheelView(v, { deltaX: 0, deltaY: -100, ctrlKey: true, metaKey: false }, 0, 0)
    expect(notch.k).toBeGreaterThan(1.2)
    expect(notch.k).toBeLessThan(1.5)
  })

  it('normalizes line-mode deltas', () => {
    expect(
      wheelView(v, { deltaX: 0, deltaY: 3, ctrlKey: false, metaKey: false, deltaMode: 1 }, 0, 0).y,
    ).toBe(-48)
  })
})
