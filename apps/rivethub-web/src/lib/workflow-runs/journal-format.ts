/**
 * Human-readable journal timeline lines for run detail.
 * Newest-last ordering is applied by the caller (engine appends chronologically).
 */

import type { WorkflowJournalEntry } from '@rivetos/types'
import { str } from './graph-project.js'

export interface JournalLine {
  /** Stable key for React lists (type + ts + stepId/label). */
  key: string
  /** ISO timestamp from the entry (or empty). */
  ts: string
  /** Short type badge (step, gate, run, warn). */
  kind: 'run' | 'step' | 'gate' | 'warn' | 'other'
  /** One-line human summary. */
  summary: string
  /** Optional detail (error text, result preview, prompt). */
  detail?: string
  /** Severity for failed / warn styling. */
  severity: 'normal' | 'em' | 'warn' | 'error'
}

function preview(value: unknown, max = 120): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value)
    if (s.length <= max) return s
    return s.slice(0, max - 1) + '…'
  } catch {
    return undefined
  }
}

function keyOf(entry: WorkflowJournalEntry, index: number): string {
  const stepId = str(entry.stepId) ?? str(entry.label) ?? ''
  const seq = typeof entry.seq === 'number' ? String(entry.seq) : ''
  return `${entry.type}:${entry.ts}:${stepId}:${seq}:${String(index)}`
}

/**
 * Format a single journal entry into a timeline line.
 * Unknown types fall back to a JSON preview of the entry.
 */
export function formatJournalEntry(entry: WorkflowJournalEntry, index = 0): JournalLine {
  const ts = str(entry.ts) ?? ''
  const type = entry.type
  const label = str(entry.label)
  const stepId = str(entry.stepId)
  const kind = str(entry.kind)
  const base = { key: keyOf(entry, index), ts }

  switch (type) {
    case 'run_started': {
      const workflowId = str(entry.workflowId) ?? '?'
      const version = str(entry.version)
      return {
        ...base,
        kind: 'run',
        summary: `Run started · ${workflowId}${version ? ` v${version}` : ''}`,
        detail: preview(entry.input),
        severity: 'em',
      }
    }
    case 'run_finished': {
      const status = str(entry.status) ?? 'finished'
      const error = str(entry.error)
      return {
        ...base,
        kind: 'run',
        summary: `Run ${status}`,
        detail: error ?? preview(entry.output),
        severity: status === 'done' ? 'em' : 'error',
      }
    }
    case 'step_started': {
      return {
        ...base,
        kind: 'step',
        summary: `Started ${label ?? stepId ?? 'step'}${kind ? ` (${kind})` : ''}`,
        severity: 'normal',
      }
    }
    case 'step_finished': {
      return {
        ...base,
        kind: 'step',
        summary: `Finished ${label ?? stepId ?? 'step'}${kind ? ` (${kind})` : ''}`,
        detail: preview(entry.result),
        severity: 'normal',
      }
    }
    case 'step_failed': {
      return {
        ...base,
        kind: 'step',
        summary: `Failed ${label ?? stepId ?? 'step'}${kind ? ` (${kind})` : ''}`,
        detail: str(entry.error) ?? preview(entry.error),
        severity: 'error',
      }
    }
    case 'gate_opened': {
      const fields = Array.isArray(entry.fields)
        ? (entry.fields as unknown[]).map(String).join(', ')
        : undefined
      const prompt = str(entry.prompt)
      return {
        ...base,
        kind: 'gate',
        summary: `Gate opened · ${label ?? stepId ?? 'gate'}`,
        detail: [prompt, fields ? `fields: ${fields}` : undefined].filter(Boolean).join(' · '),
        severity: 'em',
      }
    }
    case 'gate_resolved': {
      return {
        ...base,
        kind: 'gate',
        summary: `Gate resolved · ${label ?? stepId ?? 'gate'}`,
        detail: preview(entry.values),
        severity: 'em',
      }
    }
    case 'manifest_warn': {
      const undeclared = Array.isArray(entry.undeclared)
        ? (entry.undeclared as unknown[]).map(String).join(', ')
        : undefined
      return {
        ...base,
        kind: 'warn',
        summary: str(entry.message) ?? `Manifest warning · ${label ?? stepId ?? ''}`,
        detail: undeclared ? `undeclared: ${undeclared}` : undefined,
        severity: 'warn',
      }
    }
    default:
      return {
        ...base,
        kind: 'other',
        summary: type || 'event',
        detail: preview(entry),
        severity: 'normal',
      }
  }
}

/** Format a full journal (chronological — engine order is oldest-first). */
export function formatJournal(entries: readonly WorkflowJournalEntry[]): JournalLine[] {
  return entries.map((e, i) => formatJournalEntry(e, i))
}
