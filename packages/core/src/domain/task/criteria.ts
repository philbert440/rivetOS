/**
 * Acceptance-criteria normalization (phase 2b) — the ONE place criteria are
 * validated, derived, or required. Every task creator (gateway task-api,
 * subagent spawn, mesh delegation, heartbeat) routes its criteria through
 * here so policy lives in config, not scattered one-offs.
 *
 * Skeptical-but-proportionate by design: gateway tasks carry explicit
 * criteria (and can be REQUIRED to); internal creators get a single derived
 * goal criterion so simple things get a sanity check, not a tribunal;
 * skip-listed origins (heartbeats) stay unevaluated.
 */

import type { AcceptanceCriterion } from '@rivetos/types'

export interface CriteriaPolicy {
  /** Mirror of tasks.eval.enabled — policy is a no-op when false. */
  enabled: boolean
  /** Gateway creates must carry at least one criterion (origin 'api' only). */
  requireCriteria: boolean
  /** Derive a goal criterion for internal creators with none. */
  deriveInternal: boolean
  /** Origins that never get evaluated — normalize returns [] for these. */
  skipOrigins: string[]
}

export const CRITERIA_POLICY_OFF: CriteriaPolicy = {
  enabled: false,
  requireCriteria: false,
  deriveInternal: false,
  skipOrigins: [],
}

/** Build the policy from the (already-validated) tasks.eval config section. */
export function criteriaPolicyFromConfig(evalSection?: {
  enabled?: boolean
  require_criteria?: boolean
  derive_internal?: boolean
  skip_origins?: string[]
}): CriteriaPolicy {
  if (!evalSection?.enabled) return CRITERIA_POLICY_OFF
  return {
    enabled: true,
    requireCriteria: evalSection.require_criteria !== false,
    deriveInternal: evalSection.derive_internal !== false,
    skipOrigins: evalSection.skip_origins ?? ['heartbeat'],
  }
}

/** Thrown when policy requires criteria and none were provided (→ 400). */
export class CriteriaRequiredError extends Error {
  constructor() {
    super(
      'acceptanceCriteria is required: provide at least one criterion (tasks.eval.require_criteria)',
    )
    this.name = 'CriteriaRequiredError'
  }
}

/** Thrown on malformed criterion objects (→ 400). */
export class CriteriaShapeError extends Error {
  constructor(detail: string) {
    super(`invalid acceptanceCriteria: ${detail}`)
    this.name = 'CriteriaShapeError'
  }
}

const DERIVED_GOAL_ID = 'goal'

export interface NormalizeCriteriaInput {
  goal: string
  origin: string
  acceptanceCriteria?: unknown
}

/**
 * Validate + apply policy. Returns the criteria to persist.
 *
 * - Explicit criteria: shape-checked (id/description non-empty strings,
 *   kind manual|automated, unique ids) regardless of policy — bad input is
 *   bad input even with eval off.
 * - Empty + skip-listed origin: [] (unevaluated by design).
 * - Empty + internal origin + deriveInternal: one goal criterion.
 * - Empty + origin 'api' + requireCriteria: CriteriaRequiredError.
 */
export function normalizeCriteria(
  input: NormalizeCriteriaInput,
  policy: CriteriaPolicy,
): AcceptanceCriterion[] {
  const explicit = validateShape(input.acceptanceCriteria)
  if (explicit.length > 0) return explicit

  // Verifier child tasks are STRUCTURALLY exempt (not config-dependent):
  // deriving a goal criterion for a verifier would make the verifier itself
  // evaluable — an eval-loop hazard no skip_origins override may reintroduce.
  if (input.origin === 'eval') return []

  if (!policy.enabled || policy.skipOrigins.includes(input.origin)) return []

  if (input.origin === 'api') {
    if (policy.requireCriteria) throw new CriteriaRequiredError()
    return []
  }

  if (!policy.deriveInternal) return []
  return [
    {
      id: DERIVED_GOAL_ID,
      description: `The stated goal was accomplished: ${input.goal}`,
      kind: 'manual',
    },
  ]
}

function validateShape(raw: unknown): AcceptanceCriterion[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new CriteriaShapeError('must be an array')
  const seen = new Set<string>()
  return raw.map((c, i) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c))
      throw new CriteriaShapeError(`criterion[${i}] must be an object`)
    const { id, description, kind, check } = c as Record<string, unknown>
    if (typeof id !== 'string' || id.trim() === '')
      throw new CriteriaShapeError(`criterion[${i}].id must be a non-empty string`)
    if (seen.has(id)) throw new CriteriaShapeError(`duplicate criterion id "${id}"`)
    seen.add(id)
    if (typeof description !== 'string' || description.trim() === '')
      throw new CriteriaShapeError(`criterion[${i}].description must be a non-empty string`)
    const k = kind ?? 'manual'
    if (k !== 'manual' && k !== 'automated')
      throw new CriteriaShapeError(`criterion[${i}].kind must be 'manual' or 'automated'`)
    if (check !== undefined && typeof check !== 'string')
      throw new CriteriaShapeError(`criterion[${i}].check must be a string`)
    return { id, description, kind: k, ...(check !== undefined ? { check: check } : {}) }
  })
}
