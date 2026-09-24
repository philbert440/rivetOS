import { GatewayError } from '@rivetos/gateway-client'
import type { TermSpawnRequest } from '@rivetos/types'

export type PresetSpawnFields = { model?: string; effort?: string }

/** Shown once a deleted preset is dropped and the thread spawns without it. */
export const DELETED_PRESET_NOTICE = 'Preset no longer exists — opened this thread without it.'

/**
 * `POST /term` body. The thread's model and effort always ride along when
 * set — a pre-registry den ignores `agentId` and would otherwise spawn the
 * harness default. `presetHasHarness: false` omits `agentId`: the den 400s
 * `agent has no harness and no command was given` for a harness-less preset.
 */
export function termSpawnBody(input: {
  sessionId: string
  command?: string
  resumeSessionId?: string
  agentId?: string
  model?: string
  effort?: string
  /** False when the preset has no harnessId. Omitted means "send agentId if set". */
  presetHasHarness?: boolean
}): TermSpawnRequest {
  const agentId = input.presetHasHarness === false ? undefined : input.agentId?.trim() || undefined
  const model = input.model?.trim() || undefined
  const effort = input.effort?.trim() || undefined
  return {
    session: input.sessionId,
    ...(input.command ? { command: input.command } : {}),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** Same body with `agentId` removed. Model, effort, command, and resume stay. */
export function termSpawnBodyWithoutAgent(body: TermSpawnRequest): TermSpawnRequest {
  if (!body.agentId) return body
  const { agentId: _agentId, ...rest } = body
  return rest
}

/** Den 404 whose wire message is exactly `agent not found` (deleted preset). */
export function isDeletedAgentError(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 404 && err.message === 'agent not found'
}

/**
 * Spawn once. On `agent not found`, call `onDeleted` (clear the thread's
 * preset id) and retry a single time without `agentId`. The second failure
 * propagates — it is the thread error. Any other error is not retried.
 */
export async function recoverDeletedAgentSpawn<T>(
  spawn: (body: TermSpawnRequest) => Promise<T>,
  body: TermSpawnRequest,
  onDeleted?: () => void,
): Promise<{ result: T; droppedAgentId: boolean }> {
  try {
    return { result: await spawn(body), droppedAgentId: false }
  } catch (err) {
    if (!isDeletedAgentError(err) || !body.agentId) throw err
    onDeleted?.()
    return {
      result: await spawn(termSpawnBodyWithoutAgent(body)),
      droppedAgentId: true,
    }
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
