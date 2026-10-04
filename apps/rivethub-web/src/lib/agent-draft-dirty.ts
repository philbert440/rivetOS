/**
 * Draft-dirty comparison for the agent form. Pure: the component captures a
 * baseline snapshot and compares live fields against it.
 */

export interface AgentDraftFields {
  name: string
  color: string
  rawHarnessId: string
  rawModel: string
  rawEffort: string
  systemPrompt: string
  draftDirectory: string
  sharedLink: boolean
  /** The node the agent is created on (or copied to). Submitted with the form, so it counts. */
  nodeBaseUrl: string
}

export function captureAgentDraft(fields: AgentDraftFields): AgentDraftFields {
  return { ...fields }
}

const FIELDS: (keyof AgentDraftFields)[] = [
  'name',
  'color',
  'rawHarnessId',
  'rawModel',
  'rawEffort',
  'systemPrompt',
  'draftDirectory',
  'sharedLink',
  'nodeBaseUrl',
]

/** True when any live field diverges from the captured baseline. */
export function agentDraftDirty(baseline: AgentDraftFields, live: AgentDraftFields): boolean {
  return FIELDS.some((k) => live[k] !== baseline[k])
}
