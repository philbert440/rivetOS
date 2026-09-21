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

/**
 * Spawn-time model selection (#814) — the pre-bind twin of
 * `conversationModelOptions` (which covers per-turn picks after launch).
 *
 * Offered only while the conversation is NOT yet bound to a harness session
 * (draft, not spawned), and only when the conversation's own resolved harness
 * sheet declares `launchModel`. The options come from that sheet alone —
 * never a catalog default, never another harness's models. The pick rides
 * `POST /term { model }`, which the den validates against the sheet; once the
 * conversation is bound the launch model is fixed for its life (live switching
 * stays the separate `turnOptions` path; a harness may declare both).
 *
 * Unknown registry (pending/errored) or an unregistered harness preserves a
 * stored model — the den still validates the spawn against its own sheet.
 */
export function launchModelOptions({
  preBind,
  harnessId,
  registry,
  model,
}: {
  preBind: boolean
  harnessId?: HarnessId
  registry?: readonly {
    harnessId: HarnessId
    capabilities: Pick<HarnessCapabilities, 'launchModel' | 'models'>
  }[]
  model?: string
}): {
  models: SelectOption[]
  value: string
  clearModel: boolean
} {
  const sheet = registry?.find((row) => row.harnessId === harnessId)?.capabilities
  const sheetModels = sheet?.models ?? []
  // The picker only offers the sheet's models while NOT bound and only when
  // the sheet declares `launchModel`; a bound conversation keeps the launch
  // model it spawned with (live switching is the separate `turnOptions` path).
  const listed = preBind && sheet?.launchModel ? sheetModels : []
  const stored = model?.trim() || undefined
  // A stored model a SETTLED `launchModel` sheet no longer offers is ignored
  // and cleared (checked against the sheet's full list, independent of the
  // pre-bind gate, so a bound conversation's launch model is invalidated too);
  // a missing row or an unloaded registry leaves the stored model alone.
  const stale =
    registry !== undefined &&
    sheet?.launchModel === true &&
    !!stored &&
    !sheetModels.some((row) => row.id === stored)
  return {
    models: listed.map((row) => ({ value: row.id, label: row.label })),
    value: stored && !stale ? stored : '',
    clearModel: stale,
  }
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
