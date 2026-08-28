/**
 * Main-window bounds persistence — every launch used to reset a carefully
 * tiled window to the centered 1280×820 default (four-agent desktop review,
 * consolidated punch list #7).
 *
 * Pure load/clamp/save over a tiny JSON file so the policy is testable
 * without Electron: the caller feeds display work areas in and applies the
 * result to BrowserWindow itself.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 820 }

/** Matches the BrowserWindow minimums; anything smaller is a corrupt file. */
const MIN_WIDTH = 720
const MIN_HEIGHT = 480
/** Sanity ceiling — a state file claiming a 100k-px window is garbage. */
const MAX_DIM = 16_384
/** How much of the window must remain on SOME display for the saved
 *  position to be reused (a monitor that was unplugged must not strand the
 *  window off-screen). */
const MIN_VISIBLE = 100

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Parse + validate a saved state; anything suspect falls back to default. */
export function parseWindowState(raw: string): WindowState {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_WINDOW_STATE }
  }
  if (typeof j !== 'object' || j === null) return { ...DEFAULT_WINDOW_STATE }
  const o = j as Record<string, unknown>
  const width = isFiniteInt(o.width) ? Math.floor(o.width) : NaN
  const height = isFiniteInt(o.height) ? Math.floor(o.height) : NaN
  if (!(width >= MIN_WIDTH && width <= MAX_DIM) || !(height >= MIN_HEIGHT && height <= MAX_DIM)) {
    return { ...DEFAULT_WINDOW_STATE }
  }
  const out: WindowState = { width, height }
  if (isFiniteInt(o.x) && isFiniteInt(o.y)) {
    out.x = Math.floor(o.x)
    out.y = Math.floor(o.y)
  }
  if (o.maximized === true) out.maximized = true
  return out
}

function overlap(x: number, y: number, w: number, h: number, d: DisplayRect): number {
  const ow = Math.min(x + w, d.x + d.width) - Math.max(x, d.x)
  const oh = Math.min(y + h, d.y + d.height) - Math.max(y, d.y)
  return ow >= MIN_VISIBLE && oh >= MIN_VISIBLE ? ow * oh : 0
}

/**
 * Fit the saved state onto the CURRENT displays: the position is dropped
 * unless at least MIN_VISIBLE px of the window in both axes lands on some
 * display (a position-less state centers, which is always safe), and the
 * size is shrunk to the hosting display's work area — a rect saved on a 4K
 * monitor must not come back mostly off a laptop screen with no reachable
 * resize edge. Sized against the largest display when centering.
 */
export function clampToDisplays(state: WindowState, displays: DisplayRect[]): WindowState {
  if (displays.length === 0) return state
  let out = { ...state }
  let host: DisplayRect | undefined
  if (out.x !== undefined && out.y !== undefined) {
    host = displays.reduce(
      (best: DisplayRect | undefined, d) =>
        overlap(out.x as number, out.y as number, out.width, out.height, d) >
        (best ? overlap(out.x as number, out.y as number, out.width, out.height, best) : 0)
          ? d
          : best,
      undefined,
    )
    if (!host) {
      const { x: _x, y: _y, ...rest } = out
      out = rest
    }
  }
  host ??= displays.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
  out.width = Math.max(MIN_WIDTH, Math.min(out.width, host.width))
  out.height = Math.max(MIN_HEIGHT, Math.min(out.height, host.height))
  return out
}

/** State files are a few hundred bytes; refuse to slurp anything bigger
 *  into the main process at startup. */
const MAX_FILE_BYTES = 64 * 1024

export function loadWindowState(file: string, displays: DisplayRect[]): WindowState {
  let raw: string
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return { ...DEFAULT_WINDOW_STATE }
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { ...DEFAULT_WINDOW_STATE }
  }
  return clampToDisplays(parseWindowState(raw), displays)
}

/** Best-effort — a full disk or unwritable dir must never break quitting.
 *  Temp-then-rename so a crash mid-write leaves the previous state, not a
 *  torn file (parseWindowState survives garbage, but defaulting away a good
 *  position is still a loss). */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, file)
  } catch {
    /* losing a window position is not worth an error surface */
  }
}
