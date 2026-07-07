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
  // remote agents show where they run; local models show their model id
  if (!agent.local) return `${base} @ ${agent.node}`
  return 'model' in agent && agent.model ? `${base} (${agent.model})` : base
}

/**
 * Build the model dropdown options from the catalog. Local agents first
 * (this node's harnesses / models), then remote agents grouped by node.
 * Increment-2 will expand the local provider into its live-served models;
 * for now each configured agent is one option.
 */
export function modelOptions(agents: CatalogAgent[]): SelectOption[] {
  const opts: SelectOption[] = [{ value: '', label: 'default agent', group: 'This node' }]
  for (const a of agents) {
    if (a.local) opts.push({ value: a.id, label: label(a), group: 'This node' })
  }
  const remote = agents.filter((a) => !a.local)
  for (const a of remote) {
    opts.push({ value: a.id, label: label(a), group: 'On the mesh' })
  }
  // de-dupe by value (mesh can list an id on several nodes; keep the first)
  const seen = new Set<string>()
  return opts.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)))
}
