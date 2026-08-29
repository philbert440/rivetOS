import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cascadePoint,
  clampToDisplays,
  DEFAULT_WINDOW_STATE,
  loadWindowState,
  parseWindowState,
  saveWindowState,
} from './window-state.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const DISPLAY = [{ x: 0, y: 0, width: 2560, height: 1400 }]

describe('parseWindowState', () => {
  it('accepts a sane saved state and floors fractional values', () => {
    expect(
      parseWindowState('{"x":10.7,"y":20,"width":1600.2,"height":900,"maximized":true}'),
    ).toEqual({
      x: 10,
      y: 20,
      width: 1600,
      height: 900,
      maximized: true,
    })
  })

  it('falls back to default on garbage, undersized, and absurd dimensions', () => {
    for (const raw of [
      'not json',
      '[]',
      'null',
      '{"width":100,"height":900}', // below the BrowserWindow minimum
      '{"width":1e6,"height":900}', // nothing is a million px wide
      '{"width":"1280","height":820}',
    ]) {
      expect(parseWindowState(raw)).toEqual(DEFAULT_WINDOW_STATE)
    }
  })

  it('keeps size but drops a half-specified position', () => {
    expect(parseWindowState('{"x":50,"width":1280,"height":820}')).toEqual({
      width: 1280,
      height: 820,
    })
  })
})

describe('clampToDisplays', () => {
  it('keeps a position that is visible on some display', () => {
    const s = { x: 100, y: 100, width: 1280, height: 820 }
    expect(clampToDisplays(s, DISPLAY)).toEqual(s)
  })

  it('drops the position of a window stranded on an unplugged monitor', () => {
    expect(clampToDisplays({ x: -5000, y: 100, width: 1280, height: 820 }, DISPLAY)).toEqual({
      width: 1280,
      height: 820,
    })
  })

  it('a sliver of overlap is not enough — needs the visibility minimum', () => {
    // 40px visible on the x axis: still effectively off-screen
    expect(clampToDisplays({ x: -1240, y: 100, width: 1280, height: 820 }, DISPLAY)).toEqual({
      width: 1280,
      height: 820,
    })
  })

  it('shrinks a rect saved on a bigger monitor to the hosting display', () => {
    // 4K-era size restored onto a laptop: without the shrink the far edges
    // are unreachable and the window cannot be resized back
    expect(clampToDisplays({ x: 0, y: 0, width: 3840, height: 2100 }, DISPLAY)).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1400,
    })
    // centered (position-less) states clamp against the largest display
    expect(
      clampToDisplays({ width: 9000, height: 9000 }, [
        { x: 0, y: 0, width: 1920, height: 1080 },
        ...DISPLAY,
      ]),
    ).toEqual({ width: 2560, height: 1400 })
  })

  it('pulls the origin back on-screen after shrinking', () => {
    // saved hanging off the right edge of a bigger monitor: overlap test
    // keeps the position, then the shrink alone would leave 120px visible
    expect(
      clampToDisplays({ x: 1800, y: 0, width: 3840, height: 2100 }, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('no displays reported: state passes through untouched', () => {
    const s = { x: 10, y: 10, width: 1280, height: 820 }
    expect(clampToDisplays(s, [])).toEqual(s)
  })
})

describe('load/save round trip', () => {
  it('round-trips through disk and defaults when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winstate-'))
    dirs.push(dir)
    const file = join(dir, 'nested', 'window-state.json')
    expect(loadWindowState(file, DISPLAY)).toEqual(DEFAULT_WINDOW_STATE)
    saveWindowState(file, { x: 12, y: 34, width: 1600, height: 900 })
    expect(loadWindowState(file, DISPLAY)).toEqual({ x: 12, y: 34, width: 1600, height: 900 })
  })

  it('clamps a saved off-screen position at load time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winstate-'))
    dirs.push(dir)
    const file = join(dir, 'window-state.json')
    writeFileSync(file, JSON.stringify({ x: 99_999, y: 0, width: 1280, height: 820 }))
    expect(loadWindowState(file, DISPLAY)).toEqual({ width: 1280, height: 820 })
  })
})

describe('cascadePoint', () => {
  const WORK = { x: 0, y: 0, width: 2560, height: 1400 }

  it('offsets down-right from the base window', () => {
    expect(cascadePoint({ x: 100, y: 200 }, WORK)).toEqual({ x: 132, y: 232 })
  })

  it('wraps an axis back to the work-area origin at the edge', () => {
    expect(cascadePoint({ x: 2540, y: 200 }, WORK)).toEqual({ x: 0, y: 232 })
    expect(cascadePoint({ x: 100, y: 1390 }, WORK)).toEqual({ x: 132, y: 0 })
  })

  it('respects a work area that does not start at the origin', () => {
    const work = { x: 2560, y: 0, width: 1920, height: 1080 }
    expect(cascadePoint({ x: 4470, y: 100 }, work)).toEqual({ x: 2560, y: 132 })
  })

  it('clamps a base left of / above the work area to its origin', () => {
    expect(cascadePoint({ x: -500, y: -300 }, WORK)).toEqual({ x: 0, y: 0 })
    const work = { x: 200, y: 100, width: 1920, height: 1080 }
    expect(cascadePoint({ x: 0, y: 0 }, work)).toEqual({ x: 200, y: 100 })
  })

  it('wraps when base+offset is inside work but MIN_VISIBLE would hang off', () => {
    // x=2440+32=2472 is inside width 2560, but 2472+100 > 2560 -> wrap
    expect(cascadePoint({ x: 2440, y: 200 }, WORK)).toEqual({ x: 0, y: 232 })
    expect(cascadePoint({ x: 100, y: 1290 }, WORK)).toEqual({ x: 132, y: 0 })
  })
})
