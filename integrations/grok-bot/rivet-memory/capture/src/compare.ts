import type { CaptureMessage } from '@rivetos/capture-core'
import { legacyNormalizeRecords, type LegacyRow } from './legacy.js'
import { normalizeRecords } from './normalize.js'
import { parseInput } from './parse.js'
import { addNoise, countNoise } from './wrappers.js'
import {
  EMPTY_NOISE,
  type NoiseCounts,
  type NormalizeOptions,
  type NormalizeStats,
} from './types.js'

export interface RoleAverages {
  user: number
  assistant: number
  tool: number
  system: number
  all: number
}

export interface CompareResult {
  before: {
    rows: number
    noise: NoiseCounts
    avgChars: RoleAverages
    toolResultsEmpty: number
    truncatedMarker: number
  }
  after: {
    rows: number
    noise: NoiseCounts
    avgChars: RoleAverages
    stats: NormalizeStats
  }
  dropped: number
  systemEvents: number
}

export function compareInput(text: string, opts: NormalizeOptions): CompareResult {
  const parsed = parseInput(text)
  const beforeRows = legacyNormalizeRecords(parsed.records, { page: parsed.format === 'page' })
  const after = normalizeRecords(parsed.records, {
    ...opts,
    format: parsed.format,
    startPosition: parsed.header?.a ?? opts.startPosition ?? 0,
    agentId: parsed.header?.id ?? opts.agentId,
  })
  return {
    before: summarizeLegacy(beforeRows),
    after: {
      rows: after.messages.length,
      noise: noiseFromMessages(after.messages),
      avgChars: averagesFromMessages(after.messages),
      stats: after.stats,
    },
    dropped: after.stats.dropped,
    systemEvents: after.stats.systemEvents,
  }
}

export function formatCompareTable(rows: Array<{ name: string; result: CompareResult }>): string {
  const lines = [
    '| sample | before rows | after rows | dropped | system events | before avg chars | after avg chars | before noise markers | after noise markers |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const { name, result } of rows) {
    lines.push(
      `| ${name} | ${String(result.before.rows)} | ${String(result.after.rows)} | ${String(result.dropped)} | ${String(result.systemEvents)} | ${result.before.avgChars.all.toFixed(1)} | ${result.after.avgChars.all.toFixed(1)} | ${String(sumNoise(result.before.noise))} | ${String(sumNoise(result.after.noise))} |`,
    )
  }
  return lines.join('\n')
}

export function formatNoiseBreakdown(result: CompareResult): string {
  const keys = Object.keys(EMPTY_NOISE) as (keyof NoiseCounts)[]
  const lines = [
    '| marker | before | after |',
    '|---|---:|---:|',
    ...keys.map(
      (k) => `| ${k} | ${String(result.before.noise[k])} | ${String(result.after.noise[k])} |`,
    ),
  ]
  return lines.join('\n')
}

function summarizeLegacy(rows: LegacyRow[]) {
  let noise = { ...EMPTY_NOISE }
  let emptyTool = 0
  let truncatedMarker = 0
  for (const r of rows) {
    noise = addNoise(noise, countNoise(r.content))
    if (
      r.content.includes('[tool_result') &&
      /\[tool_result[^\]]*\]\s*$/.test(r.content.split('\n\n').pop() ?? '')
    ) {
      emptyTool += 1
    }
    if (r.content.includes('…[truncated')) truncatedMarker += 1
  }
  return {
    rows: rows.length,
    noise,
    avgChars: averages(rows.map((r) => ({ role: r.role, content: r.content }))),
    toolResultsEmpty: emptyTool,
    truncatedMarker,
  }
}

function noiseFromMessages(messages: CaptureMessage[]): NoiseCounts {
  let noise = { ...EMPTY_NOISE }
  for (const m of messages) {
    noise = addNoise(noise, countNoise(m.content))
    if (m.tool_result) noise = addNoise(noise, countNoise(m.tool_result))
  }
  return noise
}

function averagesFromMessages(messages: CaptureMessage[]): RoleAverages {
  return averages(
    messages.map((m) => ({
      role: m.role,
      content: m.role === 'tool' ? (m.tool_result ?? m.content) : m.content,
    })),
  )
}

function averages(rows: Array<{ role: string; content: string }>): RoleAverages {
  const acc: Record<string, { n: number; chars: number }> = {
    user: { n: 0, chars: 0 },
    assistant: { n: 0, chars: 0 },
    tool: { n: 0, chars: 0 },
    system: { n: 0, chars: 0 },
    all: { n: 0, chars: 0 },
  }
  for (const r of rows) {
    const len = r.content.length
    acc.all.n += 1
    acc.all.chars += len
    if (Object.hasOwn(acc, r.role) && r.role !== 'all') {
      acc[r.role].n += 1
      acc[r.role].chars += len
    }
  }
  const avg = (b: { n: number; chars: number }) => (b.n === 0 ? 0 : b.chars / b.n)
  return {
    user: avg(acc.user),
    assistant: avg(acc.assistant),
    tool: avg(acc.tool),
    system: avg(acc.system),
    all: avg(acc.all),
  }
}

function sumNoise(n: NoiseCounts): number {
  return (Object.keys(EMPTY_NOISE) as (keyof NoiseCounts)[]).reduce((s, k) => s + n[k], 0)
}
