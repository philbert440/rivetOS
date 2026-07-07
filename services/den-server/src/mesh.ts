// Mesh overview for the den viewer: read the mesh roster (mesh.json), project
// the den-enabled nodes, probe each one's den /healthz in parallel, and cache
// the assembled result for a short TTL.
//
// The loader deliberately mirrors packages/cli/src/lib/mesh-file.ts instead of
// importing it — den-server stays dependency-free (node:http + ws only).
//
// A roster entry's top-level `port` is the agent-channel port, NOT the den
// port; the den address always comes from metadata.denUrl / metadata.denPort
// (default 5174).

import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

// Only the roster fields the den reads — everything else is ignored, and all
// of these may be missing or malformed (mesh.json is shared and hand-edited).
interface MeshFileNode {
  id?: string
  name?: string
  host?: string
  capabilities?: string[]
  metadata?: Record<string, unknown>
}

interface MeshFileData {
  updatedAt: number
  nodes: Record<string, MeshFileNode | undefined>
}

// These two are the /api/mesh (/mesh.json) wire shapes. Their canonical
// client-facing mirror is MeshDenNode/MeshOverview in @rivetos/types
// gateway-api.ts; den-server stays dependency-free at runtime, so the two
// definitions are locked against each other by a compile-time assertion in
// mesh.test.ts (types is a devDependency only).
export interface MeshDenNode {
  id: string
  name: string
  denUrl: string
  online: boolean
  /** From the peer's /healthz; null when the probe failed. */
  sessions: number | null
  /** Most recent room served by THIS process — present only on the entry
   *  matching localNodeId (see docs/DEN.md). */
  latest?: { activity: string; title: string } | null
}

export interface MeshOverview {
  updatedAt: number
  nodes: MeshDenNode[]
}

export interface MeshViewOptions {
  /** Explicit mesh.json path; '' = the meshFilePaths() default chain. */
  meshFile: string
  /** How long one assembled overview (roster + probes) is served from cache. */
  cacheMs: number
  /** Per-peer /healthz probe budget (ms). */
  probeTimeoutMs?: number
  /** Which roster entry is this process — default $RIVETOS_DEN_NODE_ID, else
   *  os.hostname(). No id matching = no `latest` anywhere, which is fine. */
  localNodeId?: string
  /** Latest {activity,title} among the sessions this process serves. */
  getLocalLatest?: () => { activity: string; title: string } | null
}

export interface MeshView {
  /** Assembled overview, or null when no mesh.json is readable. */
  overview(): Promise<MeshOverview | null>
}

export const meshFilePaths = (meshFile: string): string[] =>
  meshFile ? [meshFile] : ['/rivet-shared/mesh.json', join(homedir(), '.rivetos', 'mesh.json')]

/** First readable + parseable candidate wins; null when none is. The legacy
 *  flat-array format predates capabilities/metadata, so nothing in one can be
 *  den-enabled — it parses to an empty roster rather than an error. */
export async function loadMeshFile(paths: string[]): Promise<MeshFileData | null> {
  for (const p of paths) {
    try {
      const parsed = JSON.parse(await readFile(p, 'utf8')) as {
        updatedAt?: unknown
        nodes?: unknown
      }
      const nodes =
        parsed.nodes && typeof parsed.nodes === 'object' && !Array.isArray(parsed.nodes)
          ? (parsed.nodes as MeshFileData['nodes'])
          : {}
      return { updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0, nodes }
    } catch {
      // unreadable or invalid JSON — try the next candidate
    }
  }
  return null
}

/** null = not den-enabled, or a denUrl we refuse to touch → excluded. */
function denUrlFor(id: string, node: MeshFileNode): string | null {
  const meta = node.metadata ?? {}
  const rawUrl = meta.denUrl
  if (typeof rawUrl === 'string' && rawUrl) {
    let scheme = ''
    try {
      scheme = new URL(rawUrl).protocol
    } catch {
      // not parseable as a URL at all — same treatment as a bad scheme
    }
    if (scheme !== 'http:' && scheme !== 'https:') {
      // the roster is shared and hand-editable — never let an entry point the
      // probe (or the viewer) at file:/ftp:/anything but plain web
      console.warn(`[den-server] mesh: ignoring node ${id} — denUrl "${rawUrl}" is not http(s)`)
      return null
    }
    // paths are always server-constructed (`${denUrl}/healthz` etc.)
    return rawUrl.replace(/\/+$/, '')
  }
  if (!node.host) return null
  const rawPort = meta.denPort
  const port = typeof rawPort === 'number' || typeof rawPort === 'string' ? Number(rawPort) : NaN
  if (Number.isInteger(port) && port > 0 && port < 65536) return `http://${node.host}:${port}`
  if (node.capabilities?.includes('den')) return `http://${node.host}:5174`
  return null
}

async function probe(
  denUrl: string,
  timeoutMs: number,
): Promise<{ online: boolean; sessions: number | null }> {
  try {
    const res = await fetch(`${denUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { online: false, sessions: null }
    const body = (await res.json()) as { ok?: boolean; sessions?: number }
    if (body.ok !== true) return { online: false, sessions: null }
    return { online: true, sessions: typeof body.sessions === 'number' ? body.sessions : null }
  } catch {
    // refused, timed out, or not JSON — all the same to the viewer
    return { online: false, sessions: null }
  }
}

export function createMeshView(opts: MeshViewOptions): MeshView {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500
  const localNodeId = opts.localNodeId ?? process.env.RIVETOS_DEN_NODE_ID ?? hostname()
  const paths = meshFilePaths(opts.meshFile)

  const build = async (): Promise<MeshOverview | null> => {
    const file = await loadMeshFile(paths)
    if (!file) return null
    const enabled: { id: string; name: string; denUrl: string }[] = []
    for (const [key, node] of Object.entries(file.nodes)) {
      if (!node) continue
      const id = node.id ?? key
      const denUrl = denUrlFor(id, node)
      if (denUrl) enabled.push({ id, name: node.name ?? id, denUrl })
    }
    const nodes = await Promise.all(
      enabled.map(async ({ id, name, denUrl }): Promise<MeshDenNode> => {
        const { online, sessions } = await probe(denUrl, probeTimeoutMs)
        const out: MeshDenNode = { id, name, denUrl, online, sessions }
        // `latest` comes straight from this process's reducer state — the
        // only node we can answer for without another round-trip
        if (id === localNodeId && opts.getLocalLatest) out.latest = opts.getLocalLatest()
        return out
      }),
    )
    return { updatedAt: file.updatedAt, nodes }
  }

  // the promise is cached (not the value) so concurrent requests inside the
  // TTL share one probe sweep instead of stampeding the peers
  let cached: { at: number; result: Promise<MeshOverview | null> } | null = null
  return {
    overview() {
      if (cached && Date.now() - cached.at < opts.cacheMs) return cached.result
      const result = build()
      cached = { at: Date.now(), result }
      // a missing mesh.json shouldn't stick for a whole TTL — retry next call
      void result.then(
        (v) => {
          if (v === null && cached?.result === result) cached = null
        },
        () => {
          if (cached?.result === result) cached = null
        },
      )
      return result
    },
  }
}
