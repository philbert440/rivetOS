/**
 * workflow.yaml parse + input contract validation.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ContractValidationError, type ContractValidationIssue } from './errors.js'
import type { Field, FieldType, WorkflowBudgets, WorkflowManifest, OutlineStep } from './types.js'

const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean', 'json', 'file']

export function parseManifest(raw: unknown): WorkflowManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('workflow.yaml: root must be an object')
  }
  const o = raw as Record<string, unknown>

  const id = requireString(o, 'id')
  const version = requireString(o, 'version')
  const name = requireString(o, 'name')
  const description = optionalString(o, 'description')
  const input = parseFields(o.input, 'input')
  const output = parseFields(o.output ?? [], 'output')
  const outline = parseOutline(o.outline)
  const budgets = parseBudgets(o.budgets)

  return { id, version, name, description, input, output, outline, budgets }
}

export async function loadManifestFile(workflowDir: string): Promise<WorkflowManifest> {
  const path = join(workflowDir, 'workflow.yaml')
  if (!existsSync(path)) {
    throw new Error(`workflow.yaml not found in ${workflowDir}`)
  }
  const text = await readFile(path, 'utf-8')
  const raw: unknown = parseYaml(text)
  return parseManifest(raw)
}

/**
 * Validate start input against the workflow input contract.
 * - required fields must be present (and non-undefined)
 * - type:'file' means the path relative to caseDir must exist (checked when caseDir known)
 * - type checks are best-effort for string/number/boolean
 *
 * Rejects with ContractValidationError listing every issue.
 */
export function validateInputContract(
  fields: Field[],
  input: Record<string, unknown>,
  opts?: { caseDir?: string; checkFiles?: boolean },
): void {
  const issues: ContractValidationIssue[] = []

  for (const field of fields) {
    // Fields default to required; authors opt out with `required: false`.
    const isRequired = field.required !== false
    const value = input[field.name]

    if (value === undefined || value === null) {
      if (isRequired) {
        issues.push({
          field: field.name,
          reason: 'missing',
          message: `required ${field.type} field "${field.name}" is missing`,
        })
      }
      continue
    }

    const typeIssue = checkType(field, value)
    if (typeIssue) issues.push(typeIssue)

    if (
      field.type === 'file' &&
      opts?.checkFiles !== false &&
      opts?.caseDir &&
      typeof value === 'string'
    ) {
      const rel = value
      const abs = join(opts.caseDir, rel)
      if (!existsSync(abs)) {
        issues.push({
          field: field.name,
          reason: 'file_missing',
          message: `file field "${field.name}" path "${rel}" does not exist under caseDir`,
        })
      }
    }
  }

  if (issues.length > 0) {
    throw new ContractValidationError(issues)
  }
}

/**
 * For start-time validation before caseDir exists, check fields only (not file existence).
 * File fields are re-checked after caseDir is created if files were staged there.
 * At start, file-type inputs are paths that must be present in the *input* as strings;
 * the engine stages them or expects them relative to caseDir after seed.
 *
 * Decision (NOTES): at startRun, we validate presence of required fields first.
 * File existence is checked relative to caseDir only when the file was already
 * copied into the run dir; for start, a required file field must be a non-empty string
 * (path). Optional second pass after seeding can use checkFiles:true.
 */
export function validateStartInput(fields: Field[], input: Record<string, unknown>): void {
  // Treat required:undefined as required (strict contracts at start).
  // If author sets required: false, field is optional.
  const issues: ContractValidationIssue[] = []

  for (const field of fields) {
    const isRequired = field.required !== false
    const value = input[field.name]

    if (value === undefined || value === null || value === '') {
      if (isRequired) {
        issues.push({
          field: field.name,
          reason: 'missing',
          message: `required ${field.type} field "${field.name}" is missing`,
        })
      }
      continue
    }

    const typeIssue = checkType(field, value)
    if (typeIssue) issues.push(typeIssue)
  }

  if (issues.length > 0) {
    throw new ContractValidationError(issues)
  }
}

function checkType(field: Field, value: unknown): ContractValidationIssue | null {
  switch (field.type) {
    case 'string':
    case 'file':
      if (typeof value !== 'string') {
        return {
          field: field.name,
          reason: 'type_mismatch',
          message: `field "${field.name}" expected string, got ${typeof value}`,
        }
      }
      return null
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return {
          field: field.name,
          reason: 'type_mismatch',
          message: `field "${field.name}" expected number, got ${typeof value}`,
        }
      }
      return null
    case 'boolean':
      if (typeof value !== 'boolean') {
        return {
          field: field.name,
          reason: 'type_mismatch',
          message: `field "${field.name}" expected boolean, got ${typeof value}`,
        }
      }
      return null
    case 'json':
      // any JSON value is fine
      return null
    default:
      return {
        field: field.name,
        reason: 'invalid',
        message: `unknown field type "${field.type}"`,
      }
  }
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`workflow.yaml: "${key}" must be a non-empty string`)
  }
  return v
}

function optionalString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`workflow.yaml: "${key}" must be a string`)
  return v
}

function parseFields(raw: unknown, path: string): Field[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new Error(`workflow.yaml: "${path}" must be an array`)
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`workflow.yaml: ${path}[${i}] must be an object`)
    }
    const f = item as Record<string, unknown>
    const name = f.name
    const type = f.type
    if (typeof name !== 'string' || !name) {
      throw new Error(`workflow.yaml: ${path}[${i}].name must be a non-empty string`)
    }
    if (typeof type !== 'string' || !FIELD_TYPES.includes(type as FieldType)) {
      throw new Error(`workflow.yaml: ${path}[${i}].type must be one of ${FIELD_TYPES.join('|')}`)
    }
    return {
      name,
      type: type as FieldType,
      required: typeof f.required === 'boolean' ? f.required : undefined,
      description: typeof f.description === 'string' ? f.description : undefined,
    }
  })
}

function parseOutline(raw: unknown): OutlineStep[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('workflow.yaml: outline must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`workflow.yaml: outline[${i}] must be an object`)
    }
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string') {
      throw new Error(`workflow.yaml: outline[${i}].id must be a string`)
    }
    return {
      id: o.id,
      label: typeof o.label === 'string' ? o.label : undefined,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
    }
  })
}

function parseBudgets(raw: unknown): WorkflowBudgets | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') throw new Error('workflow.yaml: budgets must be an object')
  const b = raw as Record<string, unknown>
  return {
    maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
    maxCost: typeof b.maxCost === 'number' ? b.maxCost : undefined,
    maxConcurrentRuns: typeof b.maxConcurrentRuns === 'number' ? b.maxConcurrentRuns : undefined,
  }
}
