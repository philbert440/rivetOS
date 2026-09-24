import type { AgentPreset, HarnessId } from '@rivetos/types'
import { agentDirectoryPlaceholder } from './agent-directory.js'
import {
  defaultEffort,
  defaultModel,
  effortOptionsFor,
  modelOptionsFor,
  type HarnessSheet,
} from './harness-options.js'

export type AgentDraft = Pick<
  AgentPreset,
  'name' | 'color' | 'model' | 'effort' | 'systemPrompt'
> & {
  harnessId: string
  /** Carried onto the copy when the editor has one. Empty means the den default. */
  directory?: string
  sharedLink?: boolean
}
export type CopySource = Pick<AgentPreset, 'nodeBaseUrl'> & {
  sourceNodeBaseUrl: string
  /** Preset name the stored directory was slugged from, when known. */
  name?: string
  /** Hosting den's directory root. With `name`, a default `<root>/<slug>` is not copied. */
  directoryRoot?: string
}
export type CopyTarget = {
  nodeBaseUrl: string
  harnesses: { harnessId: HarnessId; capabilities: HarnessSheet }[]
}

export function copyName(name: string): string {
  return `${name.replace(/(?: \(copy\))+$/, '')} (copy)`
}

/** A failed capability request alone does not imply that a preset exists. */
export function canOfferAgentCopy(
  source: CopySource | undefined,
  queriedNode: string,
  isError: boolean,
): boolean {
  return Boolean(source && isError && queriedNode === source.sourceNodeBaseUrl)
}

/** Only caller-supplied target capabilities may authorize copied selections. */
export function agentCopySeed(draft: AgentDraft, source: CopySource, target: CopyTarget) {
  if (
    !target.nodeBaseUrl ||
    target.nodeBaseUrl === source.sourceNodeBaseUrl ||
    target.nodeBaseUrl === source.nodeBaseUrl
  ) {
    throw new Error('Choose another reachable node for the copy.')
  }
  const harness =
    target.harnesses.find((h) => h.harnessId === draft.harnessId) ?? target.harnesses.at(0)
  const harnessId = harness?.harnessId
  const sheet = harness?.capabilities
  const sameHarness = harnessId === draft.harnessId
  const model =
    sameHarness && modelOptionsFor(sheet).some((o) => o.value === draft.model)
      ? draft.model
      : defaultModel(sheet)
  const effort =
    sameHarness && effortOptionsFor(sheet, model).some((o) => o.value === draft.effort)
      ? draft.effort
      : defaultEffort(sheet, model)
  const notes: string[] = []
  for (const [label, before, after] of [
    ['Harness', draft.harnessId, harnessId],
    ['Model', draft.model, model],
    ['Effort', draft.effort, effort],
  ]) {
    if (before !== (after ?? '')) {
      notes.push(
        `${label} “${before || 'default'}” was replaced with ${after ? `“${after}”` : 'an empty selection'} for this target. Review the available options.`,
      )
    }
  }
  const directory = copiedDirectory(draft.directory, source)
  return {
    seed: {
      name: copyName(draft.name),
      color: draft.color,
      systemPrompt: draft.systemPrompt,
      harnessId,
      model,
      effort,
      nodeBaseUrl: target.nodeBaseUrl,
      ...(directory !== undefined ? { directory } : {}),
      ...(draft.sharedLink !== undefined ? { sharedLink: draft.sharedLink } : {}),
    },
    notes,
  }
}

/**
 * Drop a directory that is only the source den's default `<root>/<slug>`.
 * The target den then applies its own default instead of inheriting the
 * source path. Anything else, including an unknown root, is kept.
 */
function copiedDirectory(directory: string | undefined, source: CopySource): string | undefined {
  if (directory === undefined) return undefined
  const root = source.directoryRoot
  const name = source.name
  if (!root || !name) return directory
  const stored = directory.trim().replace(/\/+$/, '')
  const presetDefault = agentDirectoryPlaceholder(root, name).replace(/\/+$/, '')
  if (stored === presetDefault) return undefined
  return directory
}
