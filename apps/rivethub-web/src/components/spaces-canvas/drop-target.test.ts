import { describe, expect, it } from 'vitest'
import { clientToWorld, dropTarget, resolveDrop } from './drop-target.js'

const regions = [
  { id: 'a', rect: { x: 0, y: 0, w: 100, h: 80 } },
  { id: 'b', rect: { x: 200, y: 0, w: 100, h: 80 } },
]
const panel = { x: 0, y: 200, w: 50, h: 40 }

describe('dropTarget', () => {
  it('hits the region under the point', () => {
    expect(dropTarget({ x: 10, y: 10 }, regions, panel)).toEqual({ kind: 'region', id: 'a' })
    expect(dropTarget({ x: 250, y: 40 }, regions, panel)).toEqual({ kind: 'region', id: 'b' })
    expect(dropTarget({ x: 100, y: 80 }, regions, null)).toEqual({ kind: 'region', id: 'a' })
  })

  it('hits History when the point is inside the panel', () => {
    expect(dropTarget({ x: 10, y: 210 }, regions, panel)).toEqual({ kind: 'history' })
  })

  it('is none outside every region and the panel', () => {
    expect(dropTarget({ x: 150, y: 10 }, regions, panel)).toEqual({ kind: 'none' })
    expect(dropTarget({ x: 10, y: 210 }, regions, null)).toEqual({ kind: 'none' })
  })

  it('lets the panel win when it overlaps a region', () => {
    expect(dropTarget({ x: 10, y: 10 }, regions, { x: 0, y: 0, w: 20, h: 20 })).toEqual({
      kind: 'history',
    })
  })
})

describe('resolveDrop', () => {
  it('places a history row or a tile onto a different region', () => {
    expect(
      resolveDrop({ source: 'history', originSpace: undefined, hit: { kind: 'region', id: 'a' } }),
    ).toBe('place')
    expect(
      resolveDrop({ source: 'tile', originSpace: 'a', hit: { kind: 'region', id: 'b' } }),
    ).toBe('place')
  })

  it('snaps a tile back onto its own region or onto empty space', () => {
    expect(
      resolveDrop({ source: 'tile', originSpace: 'a', hit: { kind: 'region', id: 'a' } }),
    ).toBe('snap')
    expect(resolveDrop({ source: 'tile', originSpace: 'a', hit: { kind: 'none' } })).toBe('snap')
    expect(resolveDrop({ source: 'history', originSpace: undefined, hit: { kind: 'none' } })).toBe(
      'snap',
    )
  })

  it('unplaces only when a tile is dropped on History', () => {
    expect(resolveDrop({ source: 'tile', originSpace: 'a', hit: { kind: 'history' } })).toBe(
      'unplace',
    )
    expect(
      resolveDrop({ source: 'history', originSpace: undefined, hit: { kind: 'history' } }),
    ).toBe('snap')
  })
})

describe('clientToWorld', () => {
  it('maps a client point through the stage origin and the camera translate', () => {
    expect(
      clientToWorld({ x: 100, y: 80 }, { left: 10, top: 20 }, { tx: 30, ty: 40, z: 2 }),
    ).toEqual({
      x: 30,
      y: 10,
    })
  })
})
