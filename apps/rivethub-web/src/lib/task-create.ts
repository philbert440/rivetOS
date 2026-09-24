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

function isPreset(agent: CatalogAgent): agent is Extract<CatalogAgent, { kind: 'preset' }> {
  return 'kind' in agent && agent.kind === 'preset'
}

/**
 * Agent picker for tasks — local config agents, mesh agents, then RivetHub
 * presets (tasks are how mesh work is routed; chat deliberately excludes
 * remote agents and presets).
 */
export function taskAgentOptions(agents: readonly CatalogAgent[]): SelectOption[] {
  const opts: SelectOption[] = []
  const seen = new Set<string>()
  // Locals first for a short default list. Presets carry `local` too, but
  // they are a third variant — narrowing on `local` alone would mis-label them.
  for (const a of agents) {
    if (isPreset(a) || !a.local || seen.has(a.id)) continue
    seen.add(a.id)
    const model = 'model' in a && a.model ? ` (${a.model})` : ''
    opts.push({
      value: a.id,
      label: `${HARNESS_LABEL[a.id] ?? a.id}${model} · this node`,
    })
  }
  for (const a of agents) {
    if (isPreset(a) || a.local || seen.has(a.id)) continue
    seen.add(a.id)
    opts.push({
      value: a.id,
      label: `${HARNESS_LABEL[a.id] ?? a.id} @ ${a.node}`,
    })
  }
  for (const a of agents) {
    if (!isPreset(a) || seen.has(a.id)) continue
    seen.add(a.id)
    const harness = a.harnessId ?? 'no harness'
    const unimplemented = a.implemented === false
    opts.push({
      value: a.id,
      label: `${a.name} (agent · ${harness} @ ${a.node})`,
      disabled: unimplemented,
      title: unimplemented ? (a.gap ?? 'no headless executor') : undefined,
    })
  }
  return opts
}

/**
 * Options handed to the task-form Select. `disabled` and `title` must survive
 * — the form used to rebuild `{value, label}` and let unimplemented presets
 * be selected.
 */
export function toTaskSelectOptions(opts: readonly SelectOption[]): SelectOption[] {
  return opts.map((opt) => ({
    value: opt.value,
    label: opt.label,
    disabled: opt.disabled,
    title: opt.title,
  }))
}
