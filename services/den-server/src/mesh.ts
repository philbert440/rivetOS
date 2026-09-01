// Mesh overview for the den viewer: read the mesh roster (mesh.json), project
// the den-enabled nodes, probe each one's den /healthz in parallel, and cache
// the assembled result for a short TTL.
//
// mesh.json parsing lives in @rivetos/types (`parseMeshFile`). den-server
// rule: no third-party runtime deps; workspace types/pure-lib imports allowed.
//
// A roster entry's top-level `port` is the agent-channel port, NOT the den
// port; the den address always comes from metadata.denUrl / metadata.denPort
// (default 5174).

import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  isMeshFlatArrayError,
  MeshParseError,
  parseMeshFile,
  sharedDir,
  type MeshDenNode,
  type MeshFile,
  type MeshNode,
  type MeshOverview,
} from '@rivetos/types'

export type { MeshDenNode, MeshOverview } from '@rivetos/types'

export interface MeshViewOptions {
  /** Explicit mesh.json path; '' = the meshFilePaths() default chain. */
  meshFile: string
  /**
   * Shared-storage root for the empty-meshFile fallback. Pass the value
   * loadConfig resolved from the same env (not process.env) so an embedded
   * gateway's synthetic RIVETOS_SHARED_DIR wins.
   */
  sharedRoot?: string
  /** How long one assembled overview (roster + probes) is served from cache. */
  cacheMs: number
  /** Per-peer /healthz probe budget (ms). */
  probeTimeoutMs?: number
  /** PEM bundle for verifying https peers (the Rivet CA chain). '' / missing
   *  file = system trust only, so private-CA peers show offline. */
  caPath?: string
  /** Which roster entry is this process — default $RIVETOS_DEN_NODE_ID, else
   *  os.hostname(). No id matching = no `latest` anywhere, which is fine. */
  localNodeId?: string
  /** Latest {activity,title} among the sessions this process serves. */
  getLocalLatest?: () => { activity: string; title: string } | null
}

export interface MeshView {
  /** Assembled overview, or null when no mesh.json is readable. */
  overview(): Promise<MeshOverview | null>
  /** This node's ssh target from the roster. Never throws: a missing or
   *  unparseable mesh.json falls back to os.hostname() + sshUser `rivet`,
   *  and a rejected load is not cached for the TTL. */
  localIdentity(): Promise<{ host: string; sshUser: string }>
}

/**
 * Candidate mesh.json paths. A non-empty `meshFile` is the only candidate
 * (`RIVETOS_DEN_MESH_FILE`). Empty uses `<sharedRoot>/mesh.json` then
 * `~/.rivetos/mesh.json`. `sharedRoot` must come from loadConfig's passed env;
 * omitting it falls back to {@link sharedDir} (process.env) for direct callers.
 */
export const meshFilePaths = (meshFile: string, sharedRoot?: string): string[] =>
  meshFile
    ? [meshFile]
    : [join(sharedRoot ?? sharedDir(), 'mesh.json'), join(homedir(), '.rivetos', 'mesh.json')]

/** This node's ssh target, derived from the mesh roster. Falls back to
 *  `fallbackHost` (typically `os.hostname()`) and sshUser `rivet` when the
 *  roster is missing or has no matching node. Lookup is by map key or
 *  `node.id` against `RIVETOS_DEN_NODE_ID`. */
export function localMeshIdentity(
  file:
    | {
        nodes: Record<string, { id?: string; host?: string; sshUser?: string } | undefined>
      }
    | null
    | undefined,
  nodeId: string,
  fallbackHost: string,
): { host: string; sshUser: string } {
  if (!file) return { host: fallbackHost, sshUser: 'rivet' }
  const byKey = file.nodes[nodeId]
  let byId: { id?: string; host?: string; sshUser?: string } | undefined
  for (const n of Object.values(file.nodes)) {
    if (n && n.id === nodeId) {
      byId = n
      break
    }
  }
  const node = byKey ?? byId
  if (!node) return { host: fallbackHost, sshUser: 'rivet' }
  const host = (node.host ?? '').trim() || fallbackHost
  const sshUser = node.sshUser?.trim() || 'rivet'
  return { host, sshUser }
}

/** First readable + parseable candidate wins; null when none is.
 *  Pre-capabilities flat-array and root-shape errors throw (same as CLI).
 *  A single invalid node is skipped with a warning. Invalid JSON /
 *  unreadable files fall through to the next candidate. */
export async function loadMeshFile(paths: string[]): Promise<MeshFile | null> {
  for (const p of paths) {
    let raw: string
    try {
      raw = await readFile(p, 'utf8')
    } catch {
      continue
    }
    try {
      return parseMeshFile(raw, p, { onInvalidNode: 'skip' })
    } catch (err) {
      if (isMeshFlatArrayError(err)) throw err
      if (err instanceof MeshParseError && err.code !== 'MESH_JSON_INVALID') throw err
      // invalid JSON — try the next candidate
    }
  }
  return null
}

/** null = not den-enabled, or a denUrl we refuse to touch → excluded. */
function denUrlFor(id: string, node: MeshNode): string | null {
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

/**
 * GET a peer's /healthz body. http URLs go through fetch; https URLs use
 * node:https directly so the private Rivet CA (opts.caPath) can be trusted
 * without process-wide NODE_EXTRA_CA_CERTS. Client certs are not needed:
 * /healthz is never auth-gated.
 */
async function getHealthz(denUrl: string, timeoutMs: number, ca: string | null): Promise<string> {
  const url = new URL(`${denUrl}/healthz`)
  if (url.protocol !== 'https:') {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`status ${String(res.status)}`)
    return res.text()
  }
  const { request } = await import('node:https')
  return new Promise<string>((resolve, reject) => {
    const req = request(url, { ...(ca ? { ca } : {}), timeout: timeoutMs }, (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        res.resume()
        reject(new Error(`status ${String(res.statusCode)}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

async function probe(
  denUrl: string,
  timeoutMs: number,
  ca: string | null,
): Promise<{ online: boolean; sessions: number | null }> {
  try {
    const body = JSON.parse(await getHealthz(denUrl, timeoutMs, ca)) as {
      ok?: boolean
      sessions?: number
    }
    if (body.ok !== true) return { online: false, sessions: null }
    return { online: true, sessions: typeof body.sessions === 'number' ? body.sessions : null }
  } catch {
    // refused, timed out, bad cert, or not JSON — all the same to the viewer
    return { online: false, sessions: null }
  }
}

export function createMeshView(opts: MeshViewOptions): MeshView {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500
  const localNodeId = opts.localNodeId ?? process.env.RIVETOS_DEN_NODE_ID ?? hostname()
  const paths = meshFilePaths(opts.meshFile, opts.sharedRoot)
  // CA is read once per process — cert rotation on /rivet-shared is picked up
  // by the service restart that a rotation already requires. Only a SUCCESSFUL
  // read is memoized: a transient NFS hiccup must not pin every https peer
  // offline until restart.
  let caCache: string | null = null
  const loadCa = async (): Promise<string | null> => {
    if (caCache !== null || !opts.caPath) return caCache
    caCache = await readFile(opts.caPath, 'utf8').catch(() => null)
    return caCache
  }

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
    const ca = await loadCa()
    const nodes = await Promise.all(
      enabled.map(async ({ id, name, denUrl }): Promise<MeshDenNode> => {
        const { online, sessions } = await probe(denUrl, probeTimeoutMs, ca)
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
  let identityCached: { at: number; result: Promise<{ host: string; sshUser: string }> } | null =
    null
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
    localIdentity() {
      if (identityCached && Date.now() - identityCached.at < opts.cacheMs) {
        return identityCached.result
      }
      const loaded = loadMeshFile(paths).then((file) =>
        localMeshIdentity(file, localNodeId, hostname()),
      )
      const result = loaded.catch(() => ({ host: hostname(), sshUser: 'rivet' }))
      identityCached = { at: Date.now(), result }
      void loaded.then(
        () => undefined,
        () => {
          if (identityCached?.result === result) identityCached = null
        },
      )
      return result
    },
  }
}
