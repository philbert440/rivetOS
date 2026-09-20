import type { HarnessCapabilities, HarnessId, UserTurn } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'

/** Per-turn overrides only; never used to choose a launch command or flags. */
export interface ConversationTurnPick {
  harnessId: HarnessId
  model?: string
  effort?: string
}

type Sheet = Pick<HarnessCapabilities, 'turnOptions' | 'models' | 'efforts'>

/** Query readiness comes from the caller, never from absent row fields. */
export function conversationProtocolOwnership({
  summaryReady,
  registryReady,
  bound,
  transport,
}: {
  summaryReady: boolean
  registryReady: boolean
  bound: boolean
  transport?: string
}): boolean | undefined {
  if (!summaryReady || !registryReady) return undefined
  return bound && transport === 'protocol'
}

/** Resolve only the conversation's harness, never an agent catalog default. */
export function conversationModelOptions(
  harnessId: HarnessId | undefined,
  registry: readonly { harnessId: HarnessId; capabilities: Sheet }[] | undefined,
  pick: ConversationTurnPick | undefined,
  protocolOwned: boolean | undefined,
  currentModel?: string,
): {
  models: SelectOption[]
  efforts: SelectOption[]
  effective: Pick<UserTurn, 'model' | 'effort'>
  clearPick: boolean
  retainedPick: ConversationTurnPick | undefined
  defaultModelLabel: string
} {
  const sheet = registry?.find((row) => row.harnessId === harnessId)?.capabilities
  const models = protocolOwned && sheet?.turnOptions ? (sheet.models ?? []) : []
  const stale =
    !!pick &&
    (pick.harnessId !== harnessId ||
      !models.length ||
      (!!pick.model && !models.some((model) => model.id === pick.model)))
  const model = !stale && pick?.model ? pick.model : undefined
  const defaultModel = currentModel
    ? models.find((row) => row.id === currentModel)
    : (models.find((row) => row.default) ?? models[0])
  const selected = models.find((row) => row.id === model) ?? defaultModel
  const efforts = models.length && selected ? (selected.efforts ?? sheet?.efforts ?? []) : []
  const effort = !stale && efforts.some((row) => row.id === pick?.effort) ? pick?.effort : undefined
  const effective = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  return {
    defaultModelLabel: currentModel
      ? `Session default (${defaultModel?.label ?? currentModel})`
      : 'Harness default',
    retainedPick: harnessId && (model || effort) ? { harnessId, ...effective } : undefined,
    models: models.map((row) => ({ value: row.id, label: row.label })),
    efforts: efforts.map((row) => ({ value: row.id, label: row.label })),
    effective,
    // A harness change clears immediately; otherwise unknown ownership preserves the pick.
    clearPick:
      pick && harnessId !== undefined && pick.harnessId !== harnessId
        ? true
        : protocolOwned === false
          ? !!pick
          : protocolOwned === true &&
            harnessId !== undefined &&
            registry !== undefined &&
            (stale || (!!pick?.effort && !effort)),
  }
}
