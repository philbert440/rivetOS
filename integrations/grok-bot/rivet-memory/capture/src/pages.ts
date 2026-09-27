import { normalizeRecords } from './normalize.js'
import type { NormalizeOptions, NormalizeResult, ParsedInput } from './types.js'

export interface MergedPages {
  records: unknown[]
  positions: number[]
}

/**
 * Merge ReadTranscript / on-disk pages for one agent into a single
 * position-ordered record list. First write at a position wins so overlapping
 * or out-of-order pages are stable.
 */
export function mergeParsedInputs(inputs: ParsedInput[]): MergedPages {
  const byPos = new Map<number, unknown>()
  for (const input of inputs) {
    const start = input.header?.a ?? 0
    input.records.forEach((rec, i) => {
      const pos = start + i
      if (!byPos.has(pos)) byPos.set(pos, rec)
    })
  }
  const positions = [...byPos.keys()].sort((a, b) => a - b)
  return { records: positions.map((p) => byPos.get(p) as unknown), positions }
}

export function normalizePages(inputs: ParsedInput[], opts: NormalizeOptions): NormalizeResult {
  const merged = mergeParsedInputs(inputs)
  const headerId = inputs.find((p) => p.header?.id)?.header?.id
  return normalizeRecords(merged.records, {
    ...opts,
    format: opts.format ?? inputs.find((p) => p.format)?.format,
    startPosition: merged.positions[0] ?? opts.startPosition ?? 0,
    positions: merged.positions,
    agentId: opts.agentId ?? headerId,
  })
}
