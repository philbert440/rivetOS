/**
 * Contract-driven form helpers for workflow trigger + gate resume.
 * Plain functions so they unit-test without a React/component setup.
 */

import type { WorkflowField, WorkflowContractErrorResponse } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'

/** One field's raw string value in the form (booleans use "true"/"false"). */
export type FieldFormValues = Record<string, string>

/** Per-field validation / 422 issue messages. */
export type FieldIssues = Record<string, string>

/** Build empty form state from a contract. */
export function emptyFormValues(fields: readonly WorkflowField[]): FieldFormValues {
  const out: FieldFormValues = {}
  for (const f of fields) {
    out[f.name] = f.type === 'boolean' ? 'false' : ''
  }
  return out
}

/**
 * Gate open fields are name-only (string[]). Treat common boolean-ish names as
 * checkboxes; everything else is a free-text string.
 */
export function gateFieldsAsContract(names: readonly string[]): WorkflowField[] {
  return names.map((name) => ({
    name,
    type: isBooleanishName(name) ? 'boolean' : 'string',
    required: true,
  }))
}

export function isBooleanishName(name: string): boolean {
  const n = name.toLowerCase()
  return (
    n === 'approved' ||
    n === 'ok' ||
    n === 'confirm' ||
    n === 'confirmed' ||
    n === 'yes' ||
    n === 'accept' ||
    n === 'accepted' ||
    n.startsWith('is_') ||
    n.startsWith('has_')
  )
}

/**
 * Parse form string values into typed input for the gateway.
 * Returns `{ ok: true, value }` or `{ ok: false, issues }` for client-side
 * parse errors (required empty, bad number/json).
 */
export function parseFormValues(
  fields: readonly WorkflowField[],
  values: FieldFormValues,
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: FieldIssues } {
  const issues: FieldIssues = {}
  const out: Record<string, unknown> = {}

  for (const f of fields) {
    const raw = values[f.name] ?? ''
    const trimmed = raw.trim()
    // Engine semantics: fields are required unless explicitly `required: false`.
    const required = f.required !== false

    if (f.type === 'boolean') {
      out[f.name] = raw === 'true' || raw === '1' || raw === 'on'
      continue
    }

    if (trimmed === '') {
      if (required) {
        issues[f.name] = 'required'
      }
      // omit optional empty fields
      continue
    }

    switch (f.type) {
      case 'number': {
        const n = Number(trimmed)
        if (!Number.isFinite(n)) {
          issues[f.name] = 'must be a number'
        } else {
          out[f.name] = n
        }
        break
      }
      case 'json': {
        try {
          out[f.name] = JSON.parse(trimmed) as unknown
        } catch {
          issues[f.name] = 'invalid JSON'
        }
        break
      }
      case 'file':
      case 'string':
      default:
        out[f.name] = trimmed
        break
    }
  }

  if (Object.keys(issues).length > 0) return { ok: false, issues }
  return { ok: true, value: out }
}

/** Pull per-field issues from a 422 GatewayError body. */
export function issuesFromGatewayError(err: unknown): FieldIssues {
  if (!(err instanceof GatewayError) || err.status !== 422) return {}
  const body = err.body
  if (typeof body !== 'object' || body === null) return {}
  const issues = (body as WorkflowContractErrorResponse).issues
  if (!Array.isArray(issues)) return {}
  const out: FieldIssues = {}
  for (const i of issues as Array<
    WorkflowContractErrorResponse['issues'][number] | null | undefined
  >) {
    if (typeof i?.field === 'string' && i.field) {
      out[i.field] = typeof i.message === 'string' && i.message ? i.message : i.reason || 'invalid'
    }
  }
  return out
}

/** True when the error is a contract 422 (so the UI can show inline issues). */
export function isContractError(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 422
}
