import type { TermSpawnRequest } from '@rivetos/types'

export type PresetSpawnFields = { model?: string; effort?: string }

/**
 * `POST /term` body. When `agentId` is set, model and effort that merely
 * repeat the preset are omitted so the den fills them — an explicit
 * per-thread pick (a value that differs from the preset) is still sent.
 * Without a loaded preset the stored flags are sent as-is.
 */
export function termSpawnBody(input: {
  sessionId: string
  command?: string
  resumeSessionId?: string
  agentId?: string
  model?: string
  effort?: string
  preset?: PresetSpawnFields
}): TermSpawnRequest {
  const agentId = input.agentId?.trim() || undefined
  let model = input.model?.trim() || undefined
  let effort = input.effort?.trim() || undefined
  if (agentId && input.preset) {
    if ((model ?? '') === (input.preset.model?.trim() ?? '')) model = undefined
    if ((effort ?? '') === (input.preset.effort?.trim() ?? '')) effort = undefined
  }
  return {
    session: input.sessionId,
    ...(input.command ? { command: input.command } : {}),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** 404 fallback keeps the session and, when present, the preset id. */
export function termSpawnFallbackBody(sessionId: string, agentId?: string): TermSpawnRequest {
  const id = agentId?.trim()
  return { session: sessionId, ...(id ? { agentId: id } : {}) }
}

/** Preset model/effort for one id, from the agents-list cache (first hit). */
export function presetSpawnFields(
  agentId: string | undefined,
  lists: ReadonlyArray<ReadonlyArray<{ id: string; model?: string; effort?: string }> | undefined>,
): PresetSpawnFields | undefined {
  const id = agentId?.trim()
  if (!id) return undefined
  for (const list of lists) {
    const hit = list?.find((agent) => agent.id === id)
    if (hit) return { model: hit.model ?? '', effort: hit.effort ?? '' }
  }
  return undefined
}
