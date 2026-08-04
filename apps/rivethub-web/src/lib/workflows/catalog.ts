/**
 * Workflow catalog: fixtures seed + localStorage persistence (browser).
 * Pure parse/serialize helpers are testable without DOM.
 */

import { listWorkflows as listFixtures } from './fixtures.js'
import type { WorkflowDefinition } from './types.js'
import { normalizeWorkflow } from './normalize.js'

export const CATALOG_STORAGE_KEY = 'rivethub.workflows.v1'

export interface WorkflowCatalog {
  version: 1
  workflows: WorkflowDefinition[]
}

export function createEmptyWorkflow(
  overrides?: Partial<Pick<WorkflowDefinition, 'id' | 'name' | 'description'>>,
): WorkflowDefinition {
  const id =
    overrides?.id?.trim() ||
    `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  return {
    id,
    name: overrides?.name?.trim() || 'Untitled workflow',
    description: overrides?.description,
    version: 1,
    nodes: [
      {
        id: 'start',
        kind: 'source',
        label: 'Start',
        position: { x: 48, y: 120 },
        capability: 'read-only',
        inputs: [],
        outputs: [{ id: 'out', name: 'Output', direction: 'out', kind: 'data' }],
      },
      {
        id: 'step',
        kind: 'agent',
        label: 'Agent step',
        position: { x: 300, y: 120 },
        capability: 'read-only',
        inputs: [{ id: 'in', name: 'Input', direction: 'in', kind: 'data', required: true }],
        outputs: [{ id: 'out', name: 'Output', direction: 'out', kind: 'data' }],
      },
    ],
    edges: [
      {
        id: 'e-start-step',
        from: { nodeId: 'start', portId: 'out' },
        to: { nodeId: 'step', portId: 'in' },
      },
    ],
  }
}

/** Seed catalog from built-in fixtures (deep cloned + normalized). */
export function seedCatalog(): WorkflowDefinition[] {
  return listFixtures().map((w) => normalizeWorkflow(structuredClone(w)))
}

export function parseCatalog(raw: string | null | undefined): WorkflowDefinition[] | null {
  if (raw == null || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Partial<WorkflowCatalog>
    if (obj.version !== 1 || !Array.isArray(obj.workflows)) return null
    const out: WorkflowDefinition[] = []
    for (const item of obj.workflows as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const cand = item as Partial<WorkflowDefinition>
      if (typeof cand.id !== 'string' || !Array.isArray(cand.nodes)) continue
      out.push(normalizeWorkflow(cand as WorkflowDefinition))
    }
    return out
  } catch {
    return null
  }
}

export function serializeCatalog(workflows: readonly WorkflowDefinition[]): string {
  const payload: WorkflowCatalog = {
    version: 1,
    workflows: workflows.map((w) => normalizeWorkflow(structuredClone(w))),
  }
  return JSON.stringify(payload)
}

export function upsertWorkflow(
  catalog: readonly WorkflowDefinition[],
  def: WorkflowDefinition,
): WorkflowDefinition[] {
  const normalized = normalizeWorkflow(structuredClone(def))
  const idx = catalog.findIndex((w) => w.id === normalized.id)
  if (idx < 0) return [...catalog, normalized]
  const next = [...catalog]
  next[idx] = normalized
  return next
}

export function deleteWorkflow(
  catalog: readonly WorkflowDefinition[],
  id: string,
): WorkflowDefinition[] {
  return catalog.filter((w) => w.id !== id)
}

export function getFromCatalog(
  catalog: readonly WorkflowDefinition[],
  id: string,
): WorkflowDefinition | undefined {
  return catalog.find((w) => w.id === id)
}

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

/** Load catalog from localStorage, or seed fixtures if empty/missing. */
export function loadCatalog(): WorkflowDefinition[] {
  if (!storageAvailable()) return seedCatalog()
  const parsed = parseCatalog(localStorage.getItem(CATALOG_STORAGE_KEY))
  if (parsed && parsed.length > 0) return parsed
  const seeded = seedCatalog()
  saveCatalog(seeded)
  return seeded
}

export function saveCatalog(workflows: readonly WorkflowDefinition[]): void {
  if (!storageAvailable()) return
  localStorage.setItem(CATALOG_STORAGE_KEY, serializeCatalog(workflows))
}

/** Reset catalog to fixture seeds (overwrites localStorage). */
export function resetCatalogToFixtures(): WorkflowDefinition[] {
  const seeded = seedCatalog()
  saveCatalog(seeded)
  return seeded
}
