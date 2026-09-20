import type { AgentPreset, HarnessId } from '@rivetos/types'
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
}
export type CopySource = Pick<AgentPreset, 'nodeBaseUrl'> & { sourceNodeBaseUrl: string }
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
  return {
    seed: {
      name: copyName(draft.name),
      color: draft.color,
      systemPrompt: draft.systemPrompt,
      harnessId,
      model,
      effort,
      nodeBaseUrl: target.nodeBaseUrl,
    },
    notes,
  }
}
