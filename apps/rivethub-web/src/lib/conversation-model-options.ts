import type { HarnessCapabilities, HarnessId, UserTurn } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'

/** Per-turn overrides only; never used to choose a launch command or flags. */
export interface ConversationTurnPick {
  harnessId: HarnessId
  model?: string
  effort?: string
}

type Sheet = Pick<HarnessCapabilities, 'turnOptions' | 'models' | 'efforts'>

/** Resolve only the conversation's harness, never an agent catalog default. */
export function conversationModelOptions(
  harnessId: HarnessId | undefined,
  registry: readonly { harnessId: HarnessId; capabilities: Sheet }[] | undefined,
  pick: ConversationTurnPick | undefined,
): {
  models: SelectOption[]
  efforts: SelectOption[]
  effective: Pick<UserTurn, 'model' | 'effort'>
  clearPick: boolean
} {
  const sheet = registry?.find((row) => row.harnessId === harnessId)?.capabilities
  const models = sheet?.turnOptions ? (sheet.models ?? []) : []
  const stale =
    !!pick &&
    (pick.harnessId !== harnessId ||
      !models.length ||
      (!!pick.model && !models.some((model) => model.id === pick.model)))
  const model = !stale && pick?.model ? pick.model : undefined
  const selected =
    models.find((row) => row.id === model) ?? models.find((row) => row.default) ?? models[0]
  const efforts = models.length ? (selected.efforts ?? sheet?.efforts ?? []) : []
  const effort = !stale && efforts.some((row) => row.id === pick?.effort) ? pick?.effort : undefined
  return {
    models: models.map((row) => ({ value: row.id, label: row.label })),
    efforts: efforts.map((row) => ({ value: row.id, label: row.label })),
    effective: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    // Pending session/registry queries must not erase a persisted choice.
    clearPick:
      harnessId !== undefined && registry !== undefined && (stale || (!!pick?.effort && !effort)),
  }
}
