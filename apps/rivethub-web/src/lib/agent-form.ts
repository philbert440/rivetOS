import type {
  AgentCreateRequest,
  AgentPreset,
  AgentUpdateRequest,
  CatalogAgent,
  HarnessId,
} from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'

/** Fields the agent editor submits. `nodeBaseUrl` chooses the den; it is not a wire field. */
export type AgentWrite = {
  name?: string
  color?: string
  harnessId?: HarnessId | null
  model?: string
  effort?: string
  systemPrompt?: string
  directory?: string
  sharedLink?: boolean
  nodeBaseUrl?: string
}

/**
 * Create body for a current den. `node` is omitted (the den stamps it) and
 * `nodeBaseUrl` is omitted. An empty directory is omitted so the den applies
 * its default. `sharedLink` defaults on.
 */
export function agentCreateBody(agent: AgentWrite): AgentCreateRequest {
  const directory = agent.directory?.trim()
  return {
    name: agent.name ?? '',
    ...(agent.color !== undefined ? { color: agent.color } : {}),
    ...(agent.harnessId ? { harnessId: agent.harnessId } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
    ...(directory ? { directory } : {}),
    sharedLink: agent.sharedLink !== false,
  }
}

/** One retry for a pre-registry den that still 400s with `nodeBaseUrl is required`. */
export function agentCreateBodyLegacy(agent: AgentWrite, nodeBaseUrl: string): AgentCreateRequest {
  return { ...agentCreateBody(agent), nodeBaseUrl }
}

/**
 * POST the current-den body. A pre-registry den answers 400
 * `nodeBaseUrl is required`; retry that once with the legacy field.
 * A second failure, or any other error, surfaces to the caller.
 */
export async function createWithLegacyRetry<T>(
  post: (body: AgentCreateRequest) => Promise<T>,
  agent: AgentWrite,
  baseUrl: string,
): Promise<T> {
  try {
    return await post(agentCreateBody(agent))
  } catch (err) {
    if (!isLegacyNodeBaseUrlRequired(err)) throw err
    return await post(agentCreateBodyLegacy(agent, baseUrl))
  }
}

/**
 * Catalog-clash warning: the name equals a local config-agent id, which
 * wins over a preset name for delegate_task. Remote rows and `kind: 'preset'`
 * rows do not. The id compare is case-sensitive, matching the catalog.
 */
export function catalogNameClashes(
  name: string,
  agents: readonly CatalogAgent[],
  editingId?: string,
): boolean {
  const trimmed = name.trim()
  if (trimmed === '') return false
  return agents.some((row) => {
    if (row.id !== trimmed || row.id === editingId) return false
    if (!row.local) return false
    return !('kind' in row)
  })
}

export function isLegacyNodeBaseUrlRequired(err: unknown): boolean {
  return (
    err instanceof GatewayError &&
    err.status === 400 &&
    err.message.includes('nodeBaseUrl is required')
  )
}

/**
 * PATCH body. Directory and sharedLink are sent only when they differ from
 * the stored preset. `node` and `nodeBaseUrl` are never sent.
 */
export function agentUpdateBody(
  previous: Pick<AgentPreset, 'directory' | 'sharedLink'>,
  agent: AgentWrite,
): AgentUpdateRequest {
  const body: AgentUpdateRequest = {
    name: agent.name,
    color: agent.color,
    harnessId: agent.harnessId,
    model: agent.model,
    effort: agent.effort,
    systemPrompt: agent.systemPrompt,
  }
  if (agent.directory !== undefined) {
    const next = agent.directory.trim()
    const prev = previous.directory?.trim() ?? ''
    if (next !== prev) body.directory = next
  }
  if (agent.sharedLink !== undefined) {
    const next = agent.sharedLink
    const prev = previous.sharedLink !== false
    if (next !== prev) body.sharedLink = next
  }
  return body
}
