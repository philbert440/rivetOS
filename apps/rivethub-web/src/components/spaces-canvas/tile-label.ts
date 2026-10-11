/**
 * The name a canvas tile leads with. The model says more than the harness
 * (several agents share `opencode`), so a tile reads as the agent preset that
 * runs that model ("GLM 5.3"), else the model id's last segment
 * ("glm-5.3"), and only then the harness command.
 */

import type { ChatItem } from '../../lib/harness-chat.js'

/** Model id → the roster agent name that runs it. */
export type ModelNames = ReadonlyMap<string, string>

/** Build the lookup from roster agents. The first agent wins a shared model. */
export function modelNamesFrom(agents: readonly { name?: string; model?: string }[]): ModelNames {
  const names = new Map<string, string>()
  for (const a of agents) {
    const model = a.model?.trim()
    const name = a.name?.trim()
    if (model && name && !names.has(model)) names.set(model, name)
  }
  return names
}

/** A provider prefix may be on either side ("openrouter/z-ai/glm-5.3" vs
 *  "z-ai/glm-5.3"), so a whole trailing path also matches. */
function rosterName(model: string, names: ModelNames): string | undefined {
  const exact = names.get(model)
  if (exact) return exact
  for (const [m, name] of names) {
    if (model.endsWith(`/${m}`) || m.endsWith(`/${model}`)) return name
  }
  return undefined
}

/** Readable model label, or undefined when the row has no usable model. */
export function modelLabel(model: string | undefined, names: ModelNames): string | undefined {
  const m = model?.trim()
  if (!m || m === 'default') return undefined
  return rosterName(m, names) ?? m.split('/').filter(Boolean).pop() ?? m
}

export function tileChip(
  item: Pick<ChatItem, 'agentName' | 'model' | 'command' | 'harnessId'>,
  names: ModelNames,
): string {
  return (
    item.agentName?.trim() ||
    modelLabel(item.model, names) ||
    item.command ||
    item.harnessId ||
    'session'
  )
}
