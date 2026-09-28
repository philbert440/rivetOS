import { normalizeRecords } from './normalize.js'
import type { NormalizeOptions, NormalizeResult, ParsedInput } from './types.js'

export interface MergedPages {
  records: unknown[]
  positions: number[]
  /** Positions where a later page disagreed with the first write. */
  conflicts: number[]
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
  const conflictSet = new Set<number>()
  for (const input of inputs) {
    const start = input.header?.a ?? 0
    input.records.forEach((rec, i) => {
      const pos = start + i
      const held = byPos.get(pos)
      if (held === undefined) {
        byPos.set(pos, rec)
        return
      }
      if (recordJson(held) !== recordJson(rec)) conflictSet.add(pos)
    })
  }
  const positions = [...byPos.keys()].sort((a, b) => a - b)
  const records: unknown[] = []
  for (const p of positions) {
    const rec = byPos.get(p)
    if (rec !== undefined) records.push(rec)
  }
  return { records, positions, conflicts: [...conflictSet].sort((a, b) => a - b) }
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
  const result = normalizeRecords(merged.records, {
    ...opts,
    format: opts.format ?? inputs[0]?.format,
    startPosition: merged.positions[0] ?? 0,
    positions: merged.positions,
    agentId: opts.agentId ?? headerId,
  })
  return { ...result, conflicts: merged.conflicts }
}
