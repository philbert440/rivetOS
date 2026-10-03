import { normalizeRecords } from './normalize.js'
import type { NormalizeOptions, NormalizeResult, ParsedInput } from './types.js'

export interface MergedPages {
  records: unknown[]
  positions: number[]
  /** Positions where a later page disagreed with the first write. */
  conflicts: number[]
  /** Winning page path per record (undefined when the input had none). */
  sourcePaths: Array<string | undefined>
  /** Winning source line per record. */
  sourceLines: Array<number | undefined>
}

function recordJson(rec: unknown): string {
  try {
    return JSON.stringify(rec)
  } catch {
    return String(rec)
  }
}

/**
 * Merge ReadTranscript / on-disk pages for one agent into a single
 * position-ordered record list. First write at a position wins so overlapping
 * or out-of-order pages are stable. When a later page has different JSON at
 * the same position, that position is listed in `conflicts` (pull-bridge add
 * refuses `--write` the same way).
 */
export function mergeParsedInputs(inputs: ParsedInput[]): MergedPages {
  const byPos = new Map<number, unknown>()
  const pathByPos = new Map<number, string>()
  const lineByPos = new Map<number, number>()
  const conflictSet = new Set<number>()
  for (const input of inputs) {
    const start = input.header?.a ?? 0
    input.records.forEach((rec, i) => {
      const pos = start + i
      const held = byPos.get(pos)
      if (held === undefined) {
        byPos.set(pos, rec)
        if (input.sourcePath) pathByPos.set(pos, input.sourcePath)
        const line = input.sourceLines?.[i]
        if (typeof line === 'number') lineByPos.set(pos, line)
        return
      }
      if (recordJson(held) !== recordJson(rec)) conflictSet.add(pos)
    })
  }
  const positions = [...byPos.keys()].sort((a, b) => a - b)
  const records: unknown[] = []
  const sourcePaths: Array<string | undefined> = []
  const sourceLines: Array<number | undefined> = []
  for (const p of positions) {
    const rec = byPos.get(p)
    if (rec !== undefined) {
      records.push(rec)
      sourcePaths.push(pathByPos.get(p))
      sourceLines.push(lineByPos.get(p))
    }
  }
  return {
    records,
    positions,
    conflicts: [...conflictSet].sort((a, b) => a - b),
    sourcePaths,
    sourceLines,
  }
}

export function formatMergeConflicts(conflicts: number[]): string {
  if (conflicts.length === 0) return ''
  const shown = conflicts.slice(0, 5).join(', ')
  const more = conflicts.length > 5 ? '...' : ''
  return (
    `CONFLICT positions ${shown}${more} differ from stored content ` +
    `(conversation reset/rewritten?). Nothing written. Investigate, then ` +
    `rotate GROKBOT_SESSION_SUFFIX or re-run after fixing the source.`
  )
}

export function normalizePages(inputs: ParsedInput[], opts: NormalizeOptions): NormalizeResult {
  const merged = mergeParsedInputs(inputs)
  const headerId = inputs.find((p) => p.header?.id)?.header?.id
  const hasPaths = merged.sourcePaths.some((p) => typeof p === 'string' && p.length > 0)
  const hasLines = merged.sourceLines.some((n) => typeof n === 'number')
  const result = normalizeRecords(merged.records, {
    ...opts,
    format: opts.format ?? inputs[0]?.format,
    startPosition: merged.positions[0] ?? 0,
    positions: merged.positions,
    agentId: opts.agentId ?? headerId,
    sourcePaths: hasPaths ? merged.sourcePaths.map((p) => p ?? '') : opts.sourcePaths,
    sourceLines: hasLines
      ? merged.sourceLines.map((n, i) => (typeof n === 'number' ? n : (merged.positions[i] ?? 0)))
      : opts.sourceLines,
  })
  return { ...result, conflicts: merged.conflicts }
}
