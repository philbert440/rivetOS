import type { HarnessCapabilities, HarnessId } from '@rivetos/types'

/**
 * How a new conversation's first send should start its session through the
 * control plane instead of spawning its TUI, or `undefined` to spawn as
 * before.
 *
 * ACP drivers (`protocolStart`) give a session to whichever side holds it: a
 * live TUI pane takes its turns. Spawning the TUI for the first send would
 * make a chat conversation terminal-owned from the start.
 *
 * The harness is the conversation's own choice (picked, or its preset's), and
 * otherwise the node's default roster command. A preset goes along as
 * `agentId`; the node resolves its directory, model and effort exactly as a
 * spawn would. A preset with no harness keeps the spawn path, which is where
 * a command can stand in for one.
 */
export function protocolStartPlan(input: {
  isDraft: boolean
  hasPty: boolean
  harnessId: HarnessId | undefined
  agentId: string | undefined
  /** `presetHasHarnessFlag(settings)` — false for a preset with no harness. */
  presetHasHarness: boolean | undefined
  defaultHarnessId: HarnessId | undefined
  registry:
    | readonly { harnessId: HarnessId; capabilities: Pick<HarnessCapabilities, 'protocolStart'> }[]
    | undefined
}): { harnessId: HarnessId; agentId?: string } | undefined {
  if (!input.isDraft || input.hasPty) return undefined
  if (input.agentId && input.presetHasHarness === false) return undefined
  const harnessId = input.agentId ? input.harnessId : (input.harnessId ?? input.defaultHarnessId)
  if (!harnessId) return undefined
  const row = input.registry?.find((h) => h.harnessId === harnessId)
  if (row?.capabilities.protocolStart !== true) return undefined
  return { harnessId, ...(input.agentId ? { agentId: input.agentId } : {}) }
}
