import { describe, expect, it } from 'vitest'
import {
  EDGE_TRAVEL_PX,
  EDGE_ZONE_PX,
  EdgeSwipeTracker,
  edgeAt,
  isEdgeOpenSwipe,
} from './edge-swipe.js'

const WIDTH = 412

describe('edgeAt', () => {
  it('recognizes both bezels inside the 24px zone and nothing mid-screen', () => {
    expect(EDGE_ZONE_PX).toBe(24)
    expect(edgeAt(0, WIDTH)).toBe('left')
    expect(edgeAt(EDGE_ZONE_PX, WIDTH)).toBe('left')
    expect(edgeAt(WIDTH, WIDTH)).toBe('right')
    expect(edgeAt(WIDTH - EDGE_ZONE_PX, WIDTH)).toBe('right')
    expect(edgeAt(EDGE_ZONE_PX + 1, WIDTH)).toBe(null)
    expect(edgeAt(WIDTH / 2, WIDTH)).toBe(null)
  })
})

describe('isEdgeOpenSwipe', () => {
  it('fires on 40px inward travel from the matching bezel', () => {
    expect(EDGE_TRAVEL_PX).toBe(40)
    expect(isEdgeOpenSwipe('left', 10, 10 + EDGE_TRAVEL_PX, 100, 100)).toBe(true)
    expect(isEdgeOpenSwipe('right', WIDTH - 10, WIDTH - 10 - EDGE_TRAVEL_PX, 100, 100)).toBe(true)
  })

  it('does not fire below the travel threshold or outward', () => {
    expect(isEdgeOpenSwipe('left', 10, 10 + EDGE_TRAVEL_PX - 1, 100, 100)).toBe(false)
    expect(isEdgeOpenSwipe('left', 10, 0, 100, 100)).toBe(false)
    expect(isEdgeOpenSwipe('right', WIDTH - 10, WIDTH - 1, 100, 100)).toBe(false)
  })

  it('rejects vertical-dominant movement (scrolling from the bezel)', () => {
    expect(isEdgeOpenSwipe('left', 10, 60, 100, 200)).toBe(false)
    expect(isEdgeOpenSwipe('right', WIDTH - 10, WIDTH - 60, 100, 200)).toBe(false)
  })
})

describe('EdgeSwipeTracker', () => {
  it('opens once per gesture, then requires a new pointer down', () => {
    const t = new EdgeSwipeTracker()
    t.down(5, 100, WIDTH)
    expect(t.move(5 + EDGE_TRAVEL_PX, 100)).toBe('left')
    expect(t.move(60, 100)).toBe(null)
    t.up()
    t.down(WIDTH - 5, 100, WIDTH)
    expect(t.move(WIDTH - 5 - EDGE_TRAVEL_PX, 100)).toBe('right')
  })

  it('ignores gestures that start outside the edge zone', () => {
    const t = new EdgeSwipeTracker()
    t.down(100, 100, WIDTH)
    expect(t.move(200, 100)).toBe(null)
  })

  it('resolves nothing after pointer up', () => {
    const t = new EdgeSwipeTracker()
    t.down(5, 100, WIDTH)
    t.up()
    expect(t.move(100, 100)).toBe(null)
  })
})
