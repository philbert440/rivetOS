import { migrateAgentPreset, type AgentPreset, type HarnessId } from '@rivetos/types'

export type AgentRegistryBackend = 'postgres' | 'file'

export interface AgentPresetInput {
  name: string
  color?: string
  harnessId?: HarnessId
  model?: string
  effort?: string
  systemPrompt?: string
  /** Mesh node NAME hosting the agent (`mesh.node_name`). */
  node: string
  /** Absolute working directory for the agent's harness. */
  directory: string
  sharedLink?: boolean
  /** @deprecated den base URL of the hosting node, kept for pre-registry clients. */
  nodeBaseUrl?: string
}

export interface AgentPresetPatch {
  name?: string
  color?: string
  /** null unsets */
  harnessId?: HarnessId | null
  model?: string
  effort?: string
  systemPrompt?: string
  directory?: string
  sharedLink?: boolean
}

export interface AgentPresetStore {
  readonly backend: AgentRegistryBackend
  /** true when the backing store can serve requests (table exists / dir writable). */
  isReady(): Promise<boolean>
  list(filter?: { node?: string }): Promise<AgentPreset[]>
  get(id: string): Promise<AgentPreset | undefined>
  /** exact id → exact name → case-insensitive trimmed name; undefined when nothing matches. */
  findByHandle(handle: string): Promise<AgentPreset | undefined>
  create(input: AgentPresetInput & { id?: string; createdAt?: number }): Promise<AgentPreset>
  update(id: string, patch: AgentPresetPatch): Promise<AgentPreset | undefined>
  delete(id: string): Promise<boolean>
}

export class PresetConflictError extends Error {
  readonly code = 'preset_conflict'
  constructor(message: string) {
    super(message)
    this.name = 'PresetConflictError'
  }
}

/**
 * Case-insensitive trimmed name, the uniqueness key both stores share.
 *
 * The Postgres unique index uses `lower(name)` (0017). `String#toLowerCase`
 * and PG `lower()` agree under a UTF-8 ctype and can diverge for non-ASCII
 * names on a C ctype. The DataHub is expected to be UTF-8, so the two keys match.
 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Blank names collapse to one unique-index key. Both stores reject them. */
export function requireAgentName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('agent name is required')
  return trimmed
}

export function sortPresets(presets: readonly AgentPreset[]): AgentPreset[] {
  return presets.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
}

/** exact id → exact name → case-insensitive trimmed name. */
export function findPresetByHandle(
  presets: readonly AgentPreset[],
  handle: string,
): AgentPreset | undefined {
  const trimmed = handle.trim()
  return (
    presets.find((preset) => preset.id === trimmed) ??
    presets.find((preset) => preset.name === trimmed) ??
    presets.find((preset) => nameKey(preset.name) === nameKey(trimmed))
  )
}

export function presetFromCreate(
  input: AgentPresetInput & { id?: string; createdAt?: number },
  opts: { id: string; now: number },
): AgentPreset {
  const draft: AgentPreset = {
    id: input.id ?? opts.id,
    name: requireAgentName(input.name),
    color: input.color ?? '',
    model: input.model ?? '',
    effort: input.effort ?? 'medium',
    systemPrompt: input.systemPrompt ?? '',
    // Still persisted for pre-registry clients; the field is deprecated on the type.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    nodeBaseUrl: input.nodeBaseUrl ?? '',
    createdAt: input.createdAt ?? opts.now,
    updatedAt: opts.now,
    sharedLink: input.sharedLink ?? true,
    node: input.node,
    directory: input.directory,
  }
  if (input.harnessId) draft.harnessId = input.harnessId
  return migrateAgentPreset(draft)
}

/**
 * Merge a patch onto `current`. Does not change `id`, `node`, or `createdAt`.
 * `harnessId: null` clears the field before `migrateAgentPreset` runs, so a
 * catalog id still sitting in `model` can move back onto `harnessId`.
 */
export function presetFromPatch(
  current: AgentPreset,
  patch: AgentPresetPatch,
  now: number,
): AgentPreset {
  const next: AgentPreset = { ...current, updatedAt: now }
  if (patch.name !== undefined) next.name = requireAgentName(patch.name)
  if (patch.color !== undefined) next.color = patch.color
  if (patch.model !== undefined) next.model = patch.model
  if (patch.effort !== undefined) next.effort = patch.effort
  if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt
  if (patch.directory !== undefined) next.directory = patch.directory
  if (patch.sharedLink !== undefined) next.sharedLink = patch.sharedLink
  if (patch.harnessId === null) delete next.harnessId
  else if (patch.harnessId !== undefined) next.harnessId = patch.harnessId
  return migrateAgentPreset(next)
}
