/**
 * Probe the persona's bound Rivet node (den) — not OpenMausBot Box.
 */
import { getGateway } from '../../lib/gateway.js'
import { useTeam } from '../../stores/team.js'

export function nodeIdForBot(botId: string): string {
  const userId = useTeam.getState().userId
  return getGateway().listPersonas(userId).find((p) => p.id === botId)?.nodeId ?? 'local-node'
}

export interface NodeComputerStatus {
  nodeId: string
  baseUrl: string
  reachable: boolean
  term?: { enabled: boolean; active: number; maxPtys: number; commands: { id: string; label: string }[] }
  error?: string
}

export async function probeNodeComputer(botId: string): Promise<NodeComputerStatus> {
  const nodeId = nodeIdForBot(botId)
  const baseUrl = getGateway().config.baseUrl.replace(/\/$/, '')
  const out: NodeComputerStatus = { nodeId, baseUrl, reachable: false }
  try {
    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2500) })
    out.reachable = health.ok
    if (!health.ok) {
      out.error = `node ${nodeId} healthz ${health.status}`
      return out
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
    return out
  }
  try {
    const res = await fetch(`${baseUrl}/api/terminal/config`, { signal: AbortSignal.timeout(2500) })
    if (res.ok) {
      const body = (await res.json()) as {
        enabled?: boolean
        active?: number
        maxPtys?: number
        commands?: { id: string; label: string }[]
      }
      out.term = {
        enabled: Boolean(body.enabled),
        active: body.active ?? 0,
        maxPtys: body.maxPtys ?? 0,
        commands: body.commands ?? [],
      }
    }
  } catch {
    /* terminal surface optional */
  }
  return out
}

export async function spawnNodeShell(session: string): Promise<{ id: string } | { error: string }> {
  const baseUrl = getGateway().config.baseUrl.replace(/\/$/, '')
  try {
    const res = await fetch(`${baseUrl}/api/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
    if (!res.ok || !body.id) return { error: body.error ?? `spawn ${res.status}` }
    return { id: body.id }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
