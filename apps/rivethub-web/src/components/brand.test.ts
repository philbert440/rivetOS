import { describe, expect, it } from 'vitest'
import { gridRuns, RH_GRID } from './brand.js'

describe('RH_GRID', () => {
  it('is a rectangular 11×7 grid of # and .', () => {
    expect(RH_GRID).toHaveLength(7)
    for (const row of RH_GRID) expect(row).toMatch(/^[#.]{11}$/)
  })

  it('joins R and H with a hyphen on the crossbar row', () => {
    // Column 5 is the gap between the letters; only the crossbar crosses it.
    const gap = RH_GRID.map((row) => row[5])
    expect(gap.filter((c) => c === '#')).toHaveLength(1)
    expect(RH_GRID[3]![5]).toBe('#')
  })
})

describe('gridRuns', () => {
  it('covers exactly the filled cells', () => {
    const filled = RH_GRID.join('')
      .split('')
      .filter((c) => c === '#').length
    const covered = gridRuns(RH_GRID).reduce((n, r) => n + r.w, 0)
    expect(covered).toBe(filled)
  })

  it('merges adjacent cells into one run', () => {
    expect(gridRuns(['.###.#'])).toEqual([
      { x: 1, y: 0, w: 3 },
      { x: 5, y: 0, w: 1 },
    ])
  })
})
