import type { HarnessCapabilities, HarnessId, UserTurn } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'
import { harnessForRosterCommand } from './harness-chat.js'
import { spawnModelEffort } from './harness-options.js'

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

type LaunchRegistryRow = {
  harnessId: HarnessId
  capabilities: Pick<HarnessCapabilities, 'launchModel' | 'models'>
}

/**
 * Models on the conversation's settled `launchModel` sheet.
 * `undefined` when the registry has not settled, the row is missing, or the
 * sheet does not declare `launchModel` — there is nothing to vet against.
 * This is the only sheet lookup; callers pass the ids through rather than
 * resolving a second way.
 */
function resolvedLaunchModels(
  harnessId: HarnessId | undefined,
  registry: readonly LaunchRegistryRow[] | undefined,
): readonly { id: string; label: string; default?: boolean }[] | undefined {
  if (harnessId === undefined || registry === undefined) return undefined
  const sheet = registry.find((row) => row.harnessId === harnessId)?.capabilities
  if (sheet?.launchModel !== true) return undefined
  return sheet.models ?? []
}

/**
 * Whether the pre-spawn model picker is open.
 * True only when this conversation has never spawned, nothing is in flight,
 * and no PTY is attached. A successful launch stays shut after the pty id is
 * cleared (inject 409), and a bound row stays shut.
 */
export function isPreBind(input: {
  bound: boolean
  hasPty: boolean
  launched: boolean
  spawnInFlight: boolean
}): boolean {
  return !input.bound && !input.hasPty && !input.launched && !input.spawnInFlight
}

/**
 * A never-launched thread with a stored model and no preset harness must not
 * spawn until that node's registry has settled — an unsettled sheet would
 * drop the pick. Threads with no model, or with a harnessId, do not wait.
 */
export function needsRegistryBeforeSpawn(input: {
  model?: string
  harnessId?: string
  registrySettled: boolean
}): boolean {
  if (input.registrySettled || input.harnessId) return false
  return !!input.model?.trim()
}

/**
 * Latch only when the conversation's agent and harness are still the ones
 * captured at the start of this spawn, and the latch is not already set.
 * Missing agent matches the store default `''`.
 */
export function shouldPersistLaunchLatch(
  captured: { agent?: string; harnessId?: string },
  current: { agent?: string; harnessId?: string; launched?: boolean } | undefined,
): boolean {
  if (current?.launched === true) return false
  return (
    (current?.agent ?? '') === (captured.agent ?? '') && current?.harnessId === captured.harnessId
  )
}

/**
 * Spawn-time model selection (#814) — the pre-bind twin of
 * `conversationModelOptions` (which covers per-turn picks after launch).
 *
 * Offered only while `preBind` (see `isPreBind`), and only when the
 * conversation's own resolved harness sheet declares `launchModel`. The
 * options come from that sheet alone — never a catalog default, never
 * another harness's models. `vettedModelIds` is that sheet's ids (unset when
 * the registry has not settled); `POST /term` may carry `model` only when the
 * stored id is one of them. A conversation that has already spawned keeps its
 * stored launch model — cleanup does not erase it, and the picker stays shut.
 * Live switching stays the separate `turnOptions` path.
 *
 * Unknown registry (pending/errored) or an unregistered harness preserves a
 * stored model and returns no vetted ids.
 */
export function launchModelOptions({
  preBind,
  harnessId,
  registry,
  model,
}: {
  preBind: boolean
  harnessId?: HarnessId
  registry?: readonly LaunchRegistryRow[]
  model?: string
}): {
  models: SelectOption[]
  value: string
  clearModel: boolean
  /** `#821` wording: `Harness default (<label>)`, or `Harness default` when none is known. */
  defaultModelLabel: string
  /** Settled sheet ids. Undefined → do not send a model (fail closed). */
  vettedModelIds: readonly string[] | undefined
} {
  const sheetModels = resolvedLaunchModels(harnessId, registry)
  // The picker only lists the sheet while the conversation has not launched.
  const listed = preBind && sheetModels ? sheetModels : []
  const stored = model?.trim() || undefined
  // Drop a stored id only before launch, and only once a `launchModel` sheet
  // has settled and does not offer it. Pending/missing leaves it alone; a
  // launched conversation keeps the model it spawned with.
  const stale =
    preBind &&
    sheetModels !== undefined &&
    !!stored &&
    !sheetModels.some((row) => row.id === stored)
  const def = sheetModels?.find((row) => row.default) ?? sheetModels?.[0]
  return {
    models: listed.map((row) => ({ value: row.id, label: row.label })),
    value: stored && !stale ? stored : '',
    clearModel: stale,
    defaultModelLabel: def ? `Harness default (${def.label})` : 'Harness default',
    vettedModelIds: sheetModels?.map((row) => row.id),
  }
}

/**
 * What `chat.tsx` derives for one conversation: resolved launch harness,
 * picker state, and the `POST /term` model/effort body. One sheet resolution
 * feeds both the picker and the vetted spawn model.
 */
export function conversationLaunch(input: {
  itemHarnessId?: HarnessId
  settings?: {
    agent?: string
    harnessId?: HarnessId
    model?: string
    effort?: string
    harnessEffort?: string
  }
  registry?: readonly LaunchRegistryRow[]
  preBind: boolean
}): {
  harnessId: HarnessId | undefined
  options: ReturnType<typeof launchModelOptions>
  spawn: ReturnType<typeof spawnModelEffort>
} {
  const harnessId =
    input.itemHarnessId ??
    input.settings?.harnessId ??
    harnessForRosterCommand(input.settings?.agent)
  const options = launchModelOptions({
    preBind: input.preBind,
    harnessId,
    registry: input.registry,
    model: input.settings?.model,
  })
  return {
    harnessId,
    options,
    spawn: spawnModelEffort(input.settings, options.vettedModelIds),
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
