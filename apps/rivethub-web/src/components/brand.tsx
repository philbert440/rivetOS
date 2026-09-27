import type { JSX } from 'react'
import { cn } from '../lib/utils.js'

/**
 * RivetHub brand — type, not a mascot. The expanded rail shows the
 * `rivethub` wordmark; the collapsed rail, the narrow top bar and the empty
 * states show the R-H monogram. Both take their color from the active theme
 * (accent `em`, dim `ink-dim`), so an Omarchy theme switch restyles them.
 */
export function Wordmark(props: { className?: string }): JSX.Element {
  return (
    <span
      className={cn('font-mono font-extrabold tracking-tight select-none', props.className)}
      aria-label="RivetHub"
    >
      <span className="text-em" aria-hidden>
        rivet
      </span>
      <span className="text-ink-dim" aria-hidden>
        hub
      </span>
    </span>
  )
}

/**
 * The R-H monogram on an 11×7 pixel grid, in Omarchy's block style: square
 * cells, stepped corners, and H's crossbar running out as the hyphen that
 * joins the two letters. Exported for the tests that pin its shape.
 */
export const RH_GRID = [
  '####..#...#',
  '#...#.#...#',
  '#...#.#...#',
  '####.######',
  '#.#...#...#',
  '#..#..#...#',
  '#...#.#...#',
] as const

/** Horizontal runs of filled cells, one rect each (fewer nodes than per-cell). */
export function gridRuns(grid: readonly string[]): { x: number; y: number; w: number }[] {
  const runs: { x: number; y: number; w: number }[] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== '#') {
        x++
        continue
      }
      const start = x
      while (x < row.length && row[x] === '#') x++
      runs.push({ x: start, y, w: x - start })
    }
  })
  return runs
}

const RH_RUNS = gridRuns(RH_GRID)
const RH_W = RH_GRID[0].length
const RH_H = RH_GRID.length

/**
 * R-H monogram. Sized by width (`className`); height follows the 11:7 grid.
 * Keep the width a multiple of 11px (22, 33, 44, 66…) so every cell lands on
 * whole pixels — fractional cells smear the stepped corners. Fill is
 * `currentColor`, the accent by default via `text-em`.
 */
export function RhMark(props: { className?: string; title?: string }): JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${String(RH_W)} ${String(RH_H)}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      className={cn('h-auto shrink-0 text-em', props.className)}
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      {RH_RUNS.map((r) => (
        <rect key={`${String(r.x)}-${String(r.y)}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  )
}
