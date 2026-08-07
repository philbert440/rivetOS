/**
 * Client-side helpers for workflow validate diagnostics (shape + display).
 */

import type { WorkflowDiagnostic, WorkflowDiagnosticSeverity } from '@rivetos/types'

/** Normalize a possibly-partial diagnostic from the wire. */
export function shapeDiagnostic(raw: unknown): WorkflowDiagnostic | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.file !== 'string' || typeof o.message !== 'string') return null
  const severity: WorkflowDiagnosticSeverity =
    o.severity === 'warning' || o.severity === 'info' || o.severity === 'error'
      ? o.severity
      : 'error'
  const line =
    typeof o.line === 'number' && Number.isFinite(o.line) && o.line > 0
      ? Math.floor(o.line)
      : undefined
  return {
    file: o.file,
    message: o.message,
    severity,
    ...(line !== undefined ? { line } : {}),
  }
}

export function shapeDiagnostics(raw: unknown): WorkflowDiagnostic[] {
  if (!Array.isArray(raw)) return []
  return raw.map(shapeDiagnostic).filter((d): d is WorkflowDiagnostic => d !== null)
}

/** Join def-relative file path onto the files-root-relative editPath. */
export function diagnosticAbsolutePath(editPath: string, file: string): string {
  const base = editPath.replace(/\/+$/, '')
  const rel = file.replace(/^\/+/, '')
  if (!base) return rel
  return `${base}/${rel}`
}

export function severityRank(s: WorkflowDiagnosticSeverity): number {
  if (s === 'error') return 0
  if (s === 'warning') return 1
  return 2
}
