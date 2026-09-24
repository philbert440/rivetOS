import type { QueryClient } from '@tanstack/react-query'
import { GatewayError } from '@rivetos/gateway-client'
import type { TermSpawnRequest } from '@rivetos/types'
import { presetsFromAgentsQueryData } from './agent-roster.js'

/** Shown once a missing preset is dropped and the thread spawns without it. */
export const DELETED_PRESET_NOTICE = 'Preset not found on this node; opened without it'

/**
 * Chat wiring for `termSpawnBody`'s `presetHasHarness`. A preset id with no
 * harness is `false` (omit `agentId`). No preset id leaves the flag unset.
 */
export function presetHasHarnessFlag(
  settings: { agentId?: string; harnessId?: string } | undefined,
): boolean | undefined {
  if (!settings?.agentId) return undefined
  return Boolean(settings.harnessId)
}

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

/** Den 404 whose wire message is exactly `agent not found` (missing preset). */
export function isDeletedAgentError(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 404 && err.message === 'agent not found'
}

function agentIdIsListed(agentId: string, listedAgentIds: readonly string[]): boolean {
  const trimmed = agentId.trim()
  return listedAgentIds.some((id) => id.trim() === trimmed)
}

/**
 * Ids on active `agents-all-nodes` queries. `getQueriesData` prefix-matches
 * inactive entries from an older roster key or transport epoch; those still
 * list a deleted id until gcTime and must not block recovery.
 */
export function listedAgentIds(queryClient: QueryClient): string[] {
  return queryClient
    .getQueriesData({ queryKey: ['agents-all-nodes'], type: 'active' })
    .flatMap(([, data]) => presetsFromAgentsQueryData(data).map((preset) => preset.id))
}

/**
 * Spawn once. On `agent not found`, call `onDeleted` (clear the thread's
 * preset id) and retry a single time without `agentId`. Skip that recovery
 * when `listedAgentIds` still contains the id: the preset is listed, so the
 * 404 is the thread error. The second failure propagates. Any other error
 * is not retried. Omit `listedAgentIds` only when the caller has no cache.
 */
export async function recoverDeletedAgentSpawn<T>(
  spawn: (body: TermSpawnRequest) => Promise<T>,
  body: TermSpawnRequest,
  onDeleted?: () => void,
  listedAgentIds?: readonly string[],
): Promise<{ result: T; droppedAgentId: boolean }> {
  try {
    return { result: await spawn(body), droppedAgentId: false }
  } catch (err) {
    if (!isDeletedAgentError(err) || !body.agentId) throw err
    if (listedAgentIds && agentIdIsListed(body.agentId, listedAgentIds)) throw err
    onDeleted?.()
    return {
      result: await spawn(termSpawnBodyWithoutAgent(body)),
      droppedAgentId: true,
    }
  }
}

/**
 * Chat's recovery entry. The oracle is {@link listedAgentIds} (active queries
 * only). When the id is still listed, the 404 stays the thread error and the
 * agents queries are invalidated so the next attempt reads a fresh list.
 */
export async function recoverDeletedAgentSpawnUsingCache<T>(
  queryClient: QueryClient,
  spawn: (body: TermSpawnRequest) => Promise<T>,
  body: TermSpawnRequest,
  onDeleted?: () => void,
): Promise<{ result: T; droppedAgentId: boolean }> {
  const ids = listedAgentIds(queryClient)
  try {
    return await recoverDeletedAgentSpawn(spawn, body, onDeleted, ids)
  } catch (err) {
    if (isDeletedAgentError(err) && body.agentId && agentIdIsListed(body.agentId, ids)) {
      void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
    }
    throw err
  }
}

/**
 * Command-404 fallback. Always sends `session` — main never sent `{}`, and a
 * blank session is still a session. Keeps the preset id, model, and effort
 * when set. Drops command and resume. Other empty fields are omitted.
 */
export function termSpawnFallbackBody(req: TermSpawnRequest): TermSpawnRequest {
  const agentId = req.agentId?.trim()
  const model = req.model?.trim()
  const effort = req.effort?.trim()
  return {
    session: req.session?.trim() ?? '',
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/**
 * `spawnOnce`: a command that 404s, when that 404 is not `agent not found`
 * and the thread has no harness, retries once as the node default. Any
 * other error, including a missing-preset 404, propagates.
 */
export async function spawnOnceWithCommandFallback<T>(
  termSpawn: (body: TermSpawnRequest) => Promise<T>,
  req: TermSpawnRequest,
  ctx: { command?: string; harnessId?: string },
): Promise<T> {
  if (!ctx.command) return termSpawn(req)
  try {
    return await termSpawn(req)
  } catch (error: unknown) {
    if (
      error instanceof GatewayError &&
      error.status === 404 &&
      !isDeletedAgentError(error) &&
      !ctx.harnessId
    ) {
      return termSpawn(termSpawnFallbackBody(req))
    }
    throw error
  }
}
