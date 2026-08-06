/**
 * Control-flow and validation errors for the workflows engine.
 */

import type { Field } from './types.js'

/**
 * Thrown by `step.human` to suspend the orchestration script.
 * Caught by the engine — NOT a failure. Run status becomes `paused_human`.
 *
 * Resume re-executes run.ts from the top; journaled steps return cached
 * results; the gate returns the human's values via gate_resolved.
 */
export class WorkflowSuspension extends Error {
  readonly name = 'WorkflowSuspension'
  readonly stepId: string
  readonly label: string
  readonly seq: number

  constructor(opts: { stepId: string; label: string; seq: number; message?: string }) {
    super(opts.message ?? `Workflow suspended at human gate "${opts.label}" (${opts.stepId})`)
    this.stepId = opts.stepId
    this.label = opts.label
    this.seq = opts.seq
  }
}

/** Thrown when a kill flag is observed between steps. */
export class WorkflowKilled extends Error {
  readonly name = 'WorkflowKilled'
  readonly runId: string

  constructor(runId: string, message?: string) {
    super(message ?? `Run ${runId} was killed`)
    this.runId = runId
  }
}

export interface ContractValidationIssue {
  field: string
  reason: 'missing' | 'type_mismatch' | 'file_missing' | 'invalid'
  message: string
}

/**
 * Structured rejection when start input fails the workflow contract.
 * Lists every missing/invalid field so callers can surface a form error.
 */
export class ContractValidationError extends Error {
  readonly name = 'ContractValidationError'
  readonly issues: ContractValidationIssue[]

  constructor(issues: ContractValidationIssue[]) {
    const summary = issues.map((i) => `${i.field}: ${i.message}`).join('; ')
    super(`Contract validation failed: ${summary}`)
    this.issues = issues
  }

  static missingFields(fields: Field[]): ContractValidationError {
    return new ContractValidationError(
      fields.map((f) => ({
        field: f.name,
        reason: 'missing' as const,
        message: `required ${f.type} field "${f.name}" is missing`,
      })),
    )
  }
}

export class UnknownCallNamespaceError extends Error {
  readonly name = 'UnknownCallNamespaceError'
  readonly ref: string
  readonly namespace: string
  readonly knownNamespaces: string[]

  constructor(ref: string, namespace: string, knownNamespaces: string[]) {
    super(
      `Unknown call namespace "${namespace}" in ref "${ref}". ` +
        `Known namespaces: ${knownNamespaces.length ? knownNamespaces.join(', ') : '(none)'}`,
    )
    this.ref = ref
    this.namespace = namespace
    this.knownNamespaces = knownNamespaces
  }
}

export class WorkflowNotFoundError extends Error {
  readonly name = 'WorkflowNotFoundError'
  readonly ref: string

  constructor(ref: string, detail?: string) {
    super(detail ?? `Workflow not found: ${ref}`)
    this.ref = ref
  }
}

export class RunNotFoundError extends Error {
  readonly name = 'RunNotFoundError'
  readonly runId: string

  constructor(runId: string) {
    super(`Run not found: ${runId}`)
    this.runId = runId
  }
}

export class StepTimeoutError extends Error {
  readonly name = 'StepTimeoutError'
  readonly stepId: string
  readonly timeoutMs: number

  constructor(stepId: string, timeoutMs: number) {
    super(`Step ${stepId} timed out after ${timeoutMs}ms`)
    this.stepId = stepId
    this.timeoutMs = timeoutMs
  }
}

export class RunTimeoutError extends Error {
  readonly name = 'RunTimeoutError'
  readonly runId: string
  readonly timeoutMs: number

  constructor(runId: string, timeoutMs: number) {
    super(`Run ${runId} exceeded max runtime of ${timeoutMs}ms`)
    this.runId = runId
    this.timeoutMs = timeoutMs
  }
}

/** True if err is a control-flow suspension (not a failure). */
export function isWorkflowSuspension(err: unknown): err is WorkflowSuspension {
  return err instanceof WorkflowSuspension || (err as Error)?.name === 'WorkflowSuspension'
}

export function isWorkflowKilled(err: unknown): err is WorkflowKilled {
  return err instanceof WorkflowKilled || (err as Error)?.name === 'WorkflowKilled'
}
