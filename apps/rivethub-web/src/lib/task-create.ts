/**
 * Helpers for the Tasks create form (POST /api/tasks).
 */

import type { AcceptanceCriterion, CatalogAgent } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'

const HARNESS_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  grok: 'grok Build',
  'grok-fast': 'grok Build (fast)',
  hermes: 'Hermes',
  local: 'local',
}

/**
 * One criterion per non-empty line. Ids are stable c1..cN for the create
 * payload; kind is manual (evaluator can still run when policy requires).
 */
export function criteriaFromLines(text: string): AcceptanceCriterion[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.map((description, i) => ({
    id: `c${String(i + 1)}`,
    description,
    kind: 'manual' as const,
  }))
}

/**
 * Agent picker for tasks — local AND mesh agents (tasks are how mesh work
 * is routed; chat deliberately excludes remote).
 */
export function taskAgentOptions(agents: readonly CatalogAgent[]): SelectOption[] {
  const opts: SelectOption[] = []
  const seen = new Set<string>()
  // Locals first for a short default list
  for (const a of agents) {
    if (!a.local || seen.has(a.id)) continue
    seen.add(a.id)
    const model = 'model' in a && a.model ? ` (${a.model})` : ''
    opts.push({
      value: a.id,
      label: `${HARNESS_LABEL[a.id] ?? a.id}${model} · this node`,
    })
  }
  for (const a of agents) {
    if (a.local || seen.has(a.id)) continue
    seen.add(a.id)
    opts.push({
      value: a.id,
      label: `${HARNESS_LABEL[a.id] ?? a.id} @ ${a.node}`,
    })
  }
  return opts
}
