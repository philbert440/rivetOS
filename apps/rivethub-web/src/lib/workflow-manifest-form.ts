/**
 * Structured overlay for workflow.yaml — parse known form fields from a
 * parsed YAML object and merge edits back while preserving unknown keys.
 *
 * The raw file remains SoT: open → parse → edit form → serialize → save.
 * Never store form state separately from the file bytes across view switches.
 */

import type { WorkflowField, WorkflowFieldType } from '@rivetos/types'

const FIELD_TYPES: WorkflowFieldType[] = ['string', 'number', 'boolean', 'json', 'file']

export interface ManifestBudgetsForm {
  maxTokens?: number
  maxCost?: number
  maxConcurrentRuns?: number
}

/** Editable slice of workflow.yaml for the form overlay. */
export interface ManifestFormState {
  id: string
  version: string
  name: string
  description: string
  input: WorkflowField[]
  output: WorkflowField[]
  budgets: ManifestBudgetsForm
  /**
   * Full root object after parse, used so serialize can preserve unknown
   * top-level keys (outline, custom flags, etc.).
   */
  _raw: Record<string, unknown>
}

/** Build form state from a yaml.parse result (or plain object). */
export function manifestFormFromRaw(raw: unknown): ManifestFormState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('workflow.yaml: root must be an object')
  }
  const o = { ...(raw as Record<string, unknown>) }
  return {
    id: typeof o.id === 'string' ? o.id : '',
    version: typeof o.version === 'string' ? o.version : '',
    name: typeof o.name === 'string' ? o.name : '',
    description: typeof o.description === 'string' ? o.description : '',
    input: parseFieldArray(o.input),
    output: parseFieldArray(o.output),
    budgets: parseBudgets(o.budgets),
    _raw: o,
  }
}

/** Merge form edits into the preserved raw object for YAML dump. */
export function rawFromManifestForm(state: ManifestFormState): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state._raw }
  out.id = state.id
  out.version = state.version
  out.name = state.name
  if (state.description.trim()) out.description = state.description
  else delete out.description
  out.input = state.input.map(fieldToObj)
  out.output = state.output.map(fieldToObj)
  const b = budgetsToObj(state.budgets)
  if (b) out.budgets = b
  else delete out.budgets
  return out
}

function parseFieldArray(raw: unknown): WorkflowField[] {
  if (!Array.isArray(raw)) return []
  const out: WorkflowField[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    if (typeof f.name !== 'string' || !f.name) continue
    const type =
      typeof f.type === 'string' && FIELD_TYPES.includes(f.type as WorkflowFieldType)
        ? (f.type as WorkflowFieldType)
        : 'string'
    out.push({
      name: f.name,
      type,
      required: typeof f.required === 'boolean' ? f.required : undefined,
      description: typeof f.description === 'string' ? f.description : undefined,
    })
  }
  return out
}

function parseBudgets(raw: unknown): ManifestBudgetsForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const b = raw as Record<string, unknown>
  return {
    maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
    maxCost: typeof b.maxCost === 'number' ? b.maxCost : undefined,
    maxConcurrentRuns: typeof b.maxConcurrentRuns === 'number' ? b.maxConcurrentRuns : undefined,
  }
}

function fieldToObj(f: WorkflowField): Record<string, unknown> {
  const o: Record<string, unknown> = { name: f.name, type: f.type }
  if (f.required !== undefined) o.required = f.required
  if (f.description) o.description = f.description
  return o
}

function budgetsToObj(b: ManifestBudgetsForm): Record<string, unknown> | undefined {
  const o: Record<string, unknown> = {}
  if (typeof b.maxTokens === 'number' && Number.isFinite(b.maxTokens)) o.maxTokens = b.maxTokens
  if (typeof b.maxCost === 'number' && Number.isFinite(b.maxCost)) o.maxCost = b.maxCost
  if (typeof b.maxConcurrentRuns === 'number' && Number.isFinite(b.maxConcurrentRuns)) {
    o.maxConcurrentRuns = b.maxConcurrentRuns
  }
  return Object.keys(o).length > 0 ? o : undefined
}

/** Empty form for a brand-new / unparseable file. */
export function emptyManifestForm(): ManifestFormState {
  return {
    id: '',
    version: '1.0.0',
    name: '',
    description: '',
    input: [],
    output: [],
    budgets: {},
    _raw: {},
  }
}
