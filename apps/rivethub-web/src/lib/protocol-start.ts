import type { HarnessCapabilities, HarnessId } from '@rivetos/types'

/**
 * Which harness a new conversation's first send should start through the
 * control plane instead of spawning its TUI, or `undefined` to spawn as
 * before.
 *
 * ACP drivers (`protocolStart`) give a session to whichever side holds it: a
 * live TUI pane takes its turns. Spawning the TUI for the first send would
 * make a chat conversation terminal-owned from the start.
 *
 * Only a draft with a known harness and no PTY yet qualifies. An agent preset
 * keeps the spawn path: its directory and model are applied by the spawn
 * route, which the control-plane start does not know about.
 */
export function protocolStartHarness(input: {
  isDraft: boolean
  hasPty: boolean
  harnessId: HarnessId | undefined
  agentId: string | undefined
  registry:
    | readonly { harnessId: HarnessId; capabilities: Pick<HarnessCapabilities, 'protocolStart'> }[]
    | undefined
}): HarnessId | undefined {
  if (!input.isDraft || input.hasPty || input.agentId || !input.harnessId) return undefined
  const row = input.registry?.find((h) => h.harnessId === input.harnessId)
  return row?.capabilities.protocolStart === true ? input.harnessId : undefined
}
