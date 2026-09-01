/**
 * Mesh types — multi-agent mesh networking.
 *
 * The mesh is a self-organizing network of RivetOS instances. Each node
 * registers itself and periodically heartbeats. The mesh registry maintains
 * a local view of all known nodes, synced via the datahub (shared storage
 * or direct peer exchange).
 *
 * Discovery modes:
 * - Seed node: `rivetos init --join <host>` registers with an existing node
 * - mDNS: automatic discovery on the local network
 * - Static: manually configured peers in rivet.config.yaml
 *
 * On-disk `mesh.json` is owned here: {@link MeshFile} + {@link parseMeshFile}.
 * Callers that need I/O (CLI path candidates, den-server probe/roster, core
 * registry RMW) parse through this module and keep their own file/network logic.
 */

import { RivetError } from './errors.js'
import { sharedPath } from './shared-dir.js'

// ---------------------------------------------------------------------------
// Mesh Node — a single agent instance in the mesh
// ---------------------------------------------------------------------------

/** Known mesh node roles. Add new infrastructure roles here as needed. */
export type MeshNodeRole = 'agent' | 'datahub'

export interface MeshNode {
  /** Unique node ID (generated on first registration) */
  id: string

  /** Human-readable name (e.g., "rivet-opus") */
  name: string

  /** Node role — 'agent' (default) runs the full runtime; infrastructure roles like 'datahub' are sync-only */
  role?: MeshNodeRole

  /** Agent IDs running on this node */
  agents: string[]

  /** Host address (IP or hostname) */
  host: string

  /** Agent channel port (default: 3100) */
  port: number

  /** Provider IDs available on this node */
  providers: string[]

  /** Model names available on this node */
  models: string[]

  /** Agent capabilities — what this node is good at */
  capabilities: string[]

  /** Node status */
  status: 'online' | 'offline' | 'degraded' | 'updating'

  /** When this node last heartbeated (epoch ms) */
  lastSeen: number

  /** When this node first registered (epoch ms) */
  registeredAt: number

  /** RivetOS version running on this node */
  version: string

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>

  /**
   * SSH login for update/deploy tooling when it isn't `rivet`
   * (e.g. phildesk → `philip`). Consumed by CLI `update` / `mesh` / `keys`.
   */
  sshUser?: string

  /**
   * Source-tree path when it isn't `$RIVETOS_INSTALL_ROOT` (default
   * `/opt/rivetos`). Consumed by CLI `update` remote-node deploy.
   */
  installRoot?: string

  /**
   * Host platform. Default 'linux'. Non-linux nodes (e.g. rivet-phone →
   * 'android') are full mesh members but have no automated update path yet:
   * `update --mesh` probes and reports them without attempting git/systemd.
   */
  platform?: string
}

// ---------------------------------------------------------------------------
// Mesh file — on-disk mesh.json (Record-format only)
// ---------------------------------------------------------------------------

/**
 * Canonical on-disk mesh.json document. Pre-capabilities `nodes: []` is rejected.
 * Extra top-level keys (and extra keys on each node) are preserved so a
 * load→mutate→save cycle does not strip fields a newer writer added.
 */
export interface MeshFile {
  version: number
  nodes: Record<string, MeshNode>
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Mesh Registry — tracks all known nodes
// ---------------------------------------------------------------------------

export interface MeshRegistry {
  /** Register this node in the mesh */
  register(node: MeshNode): Promise<void>

  /** Remove a node from the mesh */
  deregister(nodeId: string): Promise<void>

  /** Update a node's heartbeat timestamp and status */
  heartbeat(nodeId: string, status?: MeshNode['status']): Promise<void>

  /** Get all known nodes */
  getNodes(): Promise<MeshNode[]>

  /** Get a specific node by ID */
  getNode(nodeId: string): Promise<MeshNode | undefined>

  /** Find nodes that have a specific agent */
  findByAgent(agentId: string): Promise<MeshNode[]>

  /** Find nodes that have a specific capability */
  findByCapability(capability: string): Promise<MeshNode[]>

  /** Find nodes that have a specific provider */
  findByProvider(providerId: string): Promise<MeshNode[]>

  /** Sync local registry with remote (pull from seed/peers) */
  sync(): Promise<void>

  /** Prune stale nodes that haven't heartbeated within the threshold */
  prune(staleThresholdMs: number): Promise<MeshNode[]>
}

// ---------------------------------------------------------------------------
// Mesh Config — user-facing configuration in rivet.config.yaml
// ---------------------------------------------------------------------------

export interface MeshConfig {
  /** Enable mesh networking (default: false) */
  enabled?: boolean

  /** This node's name (default: hostname) */
  nodeName?: string

  /** Discovery mode */
  discovery?: MeshDiscoveryConfig

  /** Heartbeat interval in ms (default: 30000 = 30s) */
  heartbeatIntervalMs?: number

  /** How long before a node is considered stale (default: 90000 = 90s = 3 missed heartbeats) */
  staleThresholdMs?: number

  /**
   * TLS configuration for mesh agent-channel.
   * - `true`  → use default cert paths derived from nodeName
   * - object  → override individual paths
   * - absent / false → mesh will refuse to start (no plaintext fallback)
   *
   * Mutual TLS is the sole agent-channel authentication mechanism; the old
   * shared-secret bearer auth is gone.
   */
  tls?: boolean | MeshTlsConfig

  /** Static peer list (used when discovery is 'static') */
  peers?: MeshPeerConfig[]
}

export interface MeshDiscoveryConfig {
  /** Discovery method */
  mode: 'seed' | 'mdns' | 'static'

  /** Seed node address (for 'seed' mode) — the node to contact first */
  seedHost?: string

  /** Seed node port (for 'seed' mode, default: 3100) */
  seedPort?: number

  /** mDNS service name (for 'mdns' mode, default: "_rivetos._tcp") */
  mdnsService?: string
}

export interface MeshPeerConfig {
  /** Peer name */
  name: string

  /** Peer host address */
  host: string

  /** Peer port (default: 3100) */
  port?: number
}

export interface MeshTlsConfig {
  /** Path to CA chain PEM for verifying peers (default: /rivet-shared/rivet-ca/intermediate/ca-chain.pem) */
  caPath?: string
  /** Path to this node's certificate (default: /rivet-shared/rivet-ca/issued/<nodeName>.crt) */
  certPath?: string
  /** Path to this node's private key (default: /rivet-shared/rivet-ca/issued/<nodeName>.key) */
  keyPath?: string
}

// ---------------------------------------------------------------------------
// Mesh Events — for hooks and logging
// ---------------------------------------------------------------------------

export interface MeshNodeEvent {
  type: 'node:joined' | 'node:left' | 'node:stale' | 'node:updated' | 'node:degraded'
  node: MeshNode
  timestamp: number
}

// ---------------------------------------------------------------------------
// Mesh Delegation — extending delegation for cross-mesh routing
// ---------------------------------------------------------------------------

export interface MeshDelegationRoute {
  /** The agent to delegate to */
  agentId: string

  /** The node that hosts this agent */
  node: MeshNode

  /** Whether this is a local (same-process) or remote (HTTP) delegation */
  type: 'local' | 'remote'
}

// ---------------------------------------------------------------------------
// mesh.json parser — zero third-party deps, no I/O
// ---------------------------------------------------------------------------

export type MeshParseErrorCode =
  | 'MESH_JSON_INVALID'
  | 'MESH_FLAT_ARRAY'
  | 'MESH_INVALID_SHAPE'
  | 'MESH_NODE_INVALID'

export class MeshParseError extends RivetError {
  readonly path: string

  constructor(
    code: MeshParseErrorCode,
    message: string,
    options?: { path?: string; cause?: Error; context?: Record<string, unknown> },
  ) {
    super({
      code,
      message,
      severity: 'fatal',
      retryable: false,
      cause: options?.cause,
      context: {
        ...options?.context,
        ...(options?.path ? { path: options.path } : {}),
      },
    })
    this.name = 'MeshParseError'
    this.path = options?.path ?? 'mesh.json'
  }
}

/** True when `err` is the pre-capabilities flat-array rejection. */
export function isMeshFlatArrayError(err: unknown): boolean {
  if (err instanceof MeshParseError) return err.code === 'MESH_FLAT_ARRAY'
  return err instanceof Error && err.message.includes('pre-capabilities flat-array')
}

function flatArrayMessage(path: string): string {
  return (
    `mesh.json at ${path} uses the pre-capabilities flat-array format, ` +
    'which is no longer supported. Rewrite the file as Record-format ' +
    `{ version, nodes: { [id]: node }, updatedAt } ` +
    `(see live ${sharedPath('mesh.json')}; override with RIVETOS_SHARED_DIR).`
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function nodeFieldError(path: string, key: string, field: string, detail: string): MeshParseError {
  return new MeshParseError(
    'MESH_NODE_INVALID',
    `mesh.json at ${path}: node "${key}" has invalid ${field} (${detail})`,
    { path, context: { nodeId: key, field } },
  )
}

const KNOWN_NODE_KEYS = new Set([
  'id',
  'name',
  'host',
  'port',
  'role',
  'status',
  'version',
  'sshUser',
  'installRoot',
  'platform',
  'lastSeen',
  'registeredAt',
  'agents',
  'providers',
  'models',
  'capabilities',
  'metadata',
])

function parseMeshNode(key: string, raw: unknown, path: string): MeshNode {
  if (!isPlainObject(raw)) {
    throw new MeshParseError(
      'MESH_NODE_INVALID',
      `mesh.json at ${path}: node "${key}" is not an object`,
      { path, context: { nodeId: key } },
    )
  }

  if ('id' in raw && typeof raw.id !== 'string') {
    throw nodeFieldError(path, key, 'id', 'must be a string')
  }
  if ('name' in raw && typeof raw.name !== 'string') {
    throw nodeFieldError(path, key, 'name', 'must be a string')
  }
  if ('host' in raw && typeof raw.host !== 'string') {
    throw nodeFieldError(path, key, 'host', 'must be a string')
  }
  if ('port' in raw && (typeof raw.port !== 'number' || !Number.isFinite(raw.port))) {
    throw nodeFieldError(path, key, 'port', 'must be a finite number')
  }
  if ('role' in raw && typeof raw.role !== 'string') {
    throw nodeFieldError(path, key, 'role', 'must be a string')
  }
  if ('status' in raw && typeof raw.status !== 'string') {
    throw nodeFieldError(path, key, 'status', 'must be a string')
  }
  if ('version' in raw && typeof raw.version !== 'string') {
    throw nodeFieldError(path, key, 'version', 'must be a string')
  }
  if ('sshUser' in raw && typeof raw.sshUser !== 'string') {
    throw nodeFieldError(path, key, 'sshUser', 'must be a string')
  }
  if ('installRoot' in raw && typeof raw.installRoot !== 'string') {
    throw nodeFieldError(path, key, 'installRoot', 'must be a string')
  }
  if ('platform' in raw && typeof raw.platform !== 'string') {
    throw nodeFieldError(path, key, 'platform', 'must be a string')
  }
  if ('lastSeen' in raw && (typeof raw.lastSeen !== 'number' || !Number.isFinite(raw.lastSeen))) {
    throw nodeFieldError(path, key, 'lastSeen', 'must be a finite number')
  }
  if (
    'registeredAt' in raw &&
    (typeof raw.registeredAt !== 'number' || !Number.isFinite(raw.registeredAt))
  ) {
    throw nodeFieldError(path, key, 'registeredAt', 'must be a finite number')
  }
  if ('agents' in raw && !isStringArray(raw.agents)) {
    throw nodeFieldError(path, key, 'agents', 'must be a string array')
  }
  if ('providers' in raw && !isStringArray(raw.providers)) {
    throw nodeFieldError(path, key, 'providers', 'must be a string array')
  }
  if ('models' in raw && !isStringArray(raw.models)) {
    throw nodeFieldError(path, key, 'models', 'must be a string array')
  }
  if ('capabilities' in raw && !isStringArray(raw.capabilities)) {
    throw nodeFieldError(path, key, 'capabilities', 'must be a string array')
  }
  if ('metadata' in raw && !isPlainObject(raw.metadata)) {
    throw nodeFieldError(path, key, 'metadata', 'must be an object')
  }

  const id = typeof raw.id === 'string' && raw.id ? raw.id : key
  const name = typeof raw.name === 'string' && raw.name ? raw.name : id
  const status = (
    typeof raw.status === 'string' ? raw.status : 'offline'
  ) as MeshNode['status']

  const node: MeshNode = {
    id,
    name,
    host: typeof raw.host === 'string' ? raw.host : '',
    port: typeof raw.port === 'number' ? raw.port : 0,
    agents: isStringArray(raw.agents) ? raw.agents : [],
    providers: isStringArray(raw.providers) ? raw.providers : [],
    models: isStringArray(raw.models) ? raw.models : [],
    capabilities: isStringArray(raw.capabilities) ? raw.capabilities : [],
    status,
    lastSeen: typeof raw.lastSeen === 'number' ? raw.lastSeen : 0,
    registeredAt: typeof raw.registeredAt === 'number' ? raw.registeredAt : 0,
    version: typeof raw.version === 'string' ? raw.version : '',
  }
  if (typeof raw.role === 'string') node.role = raw.role as MeshNodeRole
  if (isPlainObject(raw.metadata)) node.metadata = raw.metadata
  if (typeof raw.sshUser === 'string') node.sshUser = raw.sshUser
  if (typeof raw.installRoot === 'string') node.installRoot = raw.installRoot
  if (typeof raw.platform === 'string') node.platform = raw.platform

  // Unknown keys are copied verbatim after known fields are validated, so a
  // future RivetOS field (or a hand-added notes/tags key) survives RMW.
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_NODE_KEYS.has(k)) (node as unknown as Record<string, unknown>)[k] = v
  }
  return node
}

/**
 * Per-node failure policy for {@link parseMeshFile} / {@link assertRecordMeshFile}.
 * `'throw'` (default) fails the whole document; `'skip'` omits the bad entry
 * and continues. Flat-array and root-shape errors always throw.
 */
export interface MeshParseOptions {
  onInvalidNode?: 'throw' | 'skip'
}

/**
 * Assert a parsed JSON value is Record-format mesh.json.
 * Throws {@link MeshParseError} on the pre-capabilities flat-array shape and
 * (unless `onInvalidNode: 'skip'`) on per-node field errors. Unknown extra
 * keys on the root and on each node are preserved verbatim.
 */
export function assertRecordMeshFile(
  parsed: unknown,
  path = 'mesh.json',
  options?: MeshParseOptions,
): MeshFile {
  if (!isPlainObject(parsed)) {
    throw new MeshParseError(
      'MESH_INVALID_SHAPE',
      `mesh.json at ${path} is not a JSON object`,
      { path },
    )
  }
  if (Array.isArray(parsed.nodes)) {
    throw new MeshParseError('MESH_FLAT_ARRAY', flatArrayMessage(path), { path })
  }
  if ('nodes' in parsed && parsed.nodes !== undefined && !isPlainObject(parsed.nodes)) {
    throw new MeshParseError(
      'MESH_INVALID_SHAPE',
      `mesh.json at ${path}: nodes must be an object keyed by node id`,
      { path },
    )
  }

  const nodesIn = isPlainObject(parsed.nodes) ? parsed.nodes : {}
  const nodes: Record<string, MeshNode> = {}
  const skipInvalid = options?.onInvalidNode === 'skip'
  for (const [key, value] of Object.entries(nodesIn)) {
    if (value === null || value === undefined) continue
    try {
      nodes[key] = parseMeshNode(key, value, path)
    } catch (err) {
      if (
        skipInvalid &&
        err instanceof MeshParseError &&
        err.code === 'MESH_NODE_INVALID'
      ) {
        console.warn(`mesh.json at ${path}: skipping invalid node "${key}"`)
        continue
      }
      throw err
    }
  }

  const version =
    typeof parsed.version === 'number' && Number.isFinite(parsed.version) ? parsed.version : 1
  const updatedAt =
    typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
      ? parsed.updatedAt
      : 0
  const file: MeshFile = { version, nodes, updatedAt }
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'version' || k === 'nodes' || k === 'updatedAt') continue
    ;(file as unknown as Record<string, unknown>)[k] = v
  }
  return file
}

/**
 * Parse a mesh.json document from its raw string.
 * Zero I/O, zero third-party deps. `path` is only interpolated into errors.
 * Unknown extra keys on the root and on each node are preserved so a
 * load→mutate→save cycle is lossless for future/unknown fields.
 *
 * @throws {@link MeshParseError}
 */
export function parseMeshFile(
  raw: string,
  path = 'mesh.json',
  options?: MeshParseOptions,
): MeshFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new MeshParseError('MESH_JSON_INVALID', `mesh.json at ${path} is not valid JSON`, {
      path,
      cause: cause instanceof Error ? cause : undefined,
    })
  }
  return assertRecordMeshFile(parsed, path, options)
}
