import type { CatalogAgent } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'

/** Friendly harness labels — match what the TUI offers (grok Build / Claude
 *  Code); other agents fall back to their id. */
const HARNESS_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  grok: 'grok Build',
  'grok-fast': 'grok Build (fast)',
}

function label(agent: CatalogAgent): string {
  const base = HARNESS_LABEL[agent.id] ?? agent.id
  // local agents show their model when configured (increment 2 expands the
  // local provider into its live-served models)
  return 'model' in agent && agent.model ? `${base} (${agent.model})` : base
}

/**
 * Model dropdown options from the catalog — LOCAL agents only. A chat turn
 * runs on this node; a remote/mesh agent isn't routable for chat (it needs a
 * task), so mesh entries are excluded to avoid a dead selection (#310 review).
 * De-duped by id.
 */
export function modelOptions(agents: CatalogAgent[]): SelectOption[] {
  const opts: SelectOption[] = [{ value: '', label: 'default agent' }]
  const seen = new Set<string>([''])
  for (const a of agents) {
    if (!a.local || seen.has(a.id)) continue
    seen.add(a.id)
    opts.push({ value: a.id, label: label(a) })
  }
  return opts
}
