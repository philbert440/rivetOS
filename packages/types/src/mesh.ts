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
 */

// ---------------------------------------------------------------------------
// Mesh Node — a single agent instance in the mesh
// ---------------------------------------------------------------------------

export interface MeshNode {
  /** Unique node ID (generated on first registration) */
  id: string

  /** Human-readable name (e.g., "rivet-opus") */
  name: string

  /** Node role — 'agent' (default) runs the full runtime; infrastructure roles like 'datahub' are sync-only */
  role?: 'agent' | 'datahub' | string

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

  /** Shared secret for mesh authentication */
  secret?: string

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
