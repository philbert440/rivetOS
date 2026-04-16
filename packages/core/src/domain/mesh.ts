/**
 * Mesh Registry — manages the local view of all known nodes in the mesh.
 *
 * The registry persists to a single authoritative `mesh.json` at `/rivet-shared/mesh.json`
 * (NFS export from the datahub). All nodes read/write this exact file.
 * and reads others' entries. This is a shared-file based registry — no
 * separate coordination service needed.
 *
 * Lifecycle:
 * 1. On startup, node reads mesh.json and registers/updates itself
 * 2. A heartbeat interval updates the node's lastSeen timestamp
 * 3. Stale nodes (no heartbeat within threshold) are pruned
 * 4. On shutdown, node marks itself offline
 *
 * For seed-based discovery, the joining node contacts the seed's
 * agent channel /api/mesh endpoint to get the current registry,
 * then writes itself into it.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type {
  MeshNode,
  MeshNodeRole,
  MeshRegistry,
  MeshConfig,
  MeshNodeEvent,
} from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('Mesh')

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_STALE_THRESHOLD_MS = 90_000
const MESH_FILE = 'mesh.json'
const CANONICAL_SHARED_PATH = '/rivet-shared'

// ---------------------------------------------------------------------------
// File-based Mesh Registry
// ---------------------------------------------------------------------------

export interface MeshRegistryConfig {
  /** Directory to store mesh.json (e.g., /shared/ or workspace dir) */
  storageDir: string

  /** Mesh configuration from rivet.config.yaml */
  mesh: MeshConfig

  /** This node's info (populated on register) */
  localNode?: Partial<MeshNode>

  /** Event handler for mesh events */
  onEvent?: (event: MeshNodeEvent) => void
}

interface MeshFile {
  version: 1
  nodes: Record<string, MeshNode | undefined>
  updatedAt: number
}

export class FileMeshRegistry implements MeshRegistry {
  private config: MeshRegistryConfig
  private filePath: string
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private localNodeId?: string

  constructor(config: MeshRegistryConfig) {
    this.config = config

    // Force use of canonical /rivet-shared (the NFS mount from datahub)
    // so **all** nodes read/write the exact same authoritative mesh.json.
    const canonicalPath = join(CANONICAL_SHARED_PATH, MESH_FILE)
    this.filePath = canonicalPath
  }

  // -----------------------------------------------------------------------
  // MeshRegistry interface
  // -----------------------------------------------------------------------

  async register(node: MeshNode): Promise<void> {
    const data = await this.load()
    const existing = data.nodes[node.id]

    data.nodes[node.id] = node
    data.updatedAt = Date.now()
    await this.save(data)

    if (!existing) {
      this.emit({ type: 'node:joined', node, timestamp: Date.now() })
      log.info(`Node registered: ${node.name} (${node.id}) at ${node.host}:${String(node.port)}`)
    } else {
      this.emit({ type: 'node:updated', node, timestamp: Date.now() })
      log.info(`Node updated: ${node.name} (${node.id})`)
    }
  }

  async deregister(nodeId: string): Promise<void> {
    const data = await this.load()
    const node = data.nodes[nodeId]
    if (!node) return

    node.status = 'offline'
    data.nodes[nodeId] = node
    data.updatedAt = Date.now()
    await this.save(data)

    this.emit({ type: 'node:left', node, timestamp: Date.now() })
    log.info(`Node deregistered: ${node.name} (${nodeId})`)
  }

  async heartbeat(nodeId: string, status?: MeshNode['status']): Promise<void> {
    const data = await this.load()
    const node = data.nodes[nodeId]
    if (!node) return

    node.lastSeen = Date.now()
    if (status) node.status = status
    data.nodes[nodeId] = node
    data.updatedAt = Date.now()
    await this.save(data)
  }

  async getNodes(): Promise<MeshNode[]> {
    const data = await this.load()
    return Object.values(data.nodes).filter((n): n is MeshNode => n !== undefined)
  }

  async getNode(nodeId: string): Promise<MeshNode | undefined> {
    const data = await this.load()
    return data.nodes[nodeId]
  }

  async findByAgent(agentId: string): Promise<MeshNode[]> {
    const nodes = await this.getNodes()
    return nodes.filter((n) => n.agents.includes(agentId) && n.status === 'online')
  }

  async findByCapability(capability: string): Promise<MeshNode[]> {
    const nodes = await this.getNodes()
    return nodes.filter((n) => n.capabilities.includes(capability) && n.status === 'online')
  }

  async findByProvider(providerId: string): Promise<MeshNode[]> {
    const nodes = await this.getNodes()
    return nodes.filter((n) => n.providers.includes(providerId) && n.status === 'online')
  }

  async sync(): Promise<void> {
    const { discovery } = this.config.mesh

    if (!discovery) return

    if (discovery.mode === 'seed' && discovery.seedHost) {
      await this.syncFromSeed(discovery.seedHost, discovery.seedPort ?? 3100)
    }
    // mDNS and static don't need sync — they discover via other means
  }

  async prune(staleThresholdMs?: number): Promise<MeshNode[]> {
    const threshold =
      staleThresholdMs ?? this.config.mesh.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS
    const now = Date.now()
    const data = await this.load()
    const pruned: MeshNode[] = []

    for (const [id, node] of Object.entries(data.nodes)) {
      // Don't prune ourselves or missing entries
      if (id === this.localNodeId || !node) continue

      // Don't prune infrastructure nodes — they don't heartbeat
      if (node.role && node.role !== 'agent') continue

      if (now - node.lastSeen > threshold && node.status !== 'offline') {
        node.status = 'offline'
        data.nodes[id] = node
        pruned.push(node)
        this.emit({ type: 'node:stale', node, timestamp: now })
        log.warn(
          `Node stale: ${node.name} (${id}) — last seen ${Math.round((now - node.lastSeen) / 1000)}s ago`,
        )
      }
    }

    if (pruned.length > 0) {
      data.updatedAt = now
      await this.save(data)
    }

    return pruned
  }

  // -----------------------------------------------------------------------
  // Lifecycle — start/stop heartbeat timer
  // -----------------------------------------------------------------------

  /**
   * Start the mesh — register this node and begin heartbeating.
   */
  async start(localNode: MeshNode): Promise<void> {
    this.localNodeId = localNode.id
    await this.register(localNode)

    const interval = this.config.mesh.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat(localNode.id, 'online')
        .then(() => this.prune())
        .catch((err: unknown) => {
          log.error(`Mesh heartbeat failed: ${(err as Error).message}`)
        })
    }, interval)

    // Initial sync if seed-based
    if (this.config.mesh.discovery?.mode === 'seed') {
      await this.sync().catch((err: unknown) => {
        log.warn(`Initial mesh sync failed: ${(err as Error).message}`)
      })
    }

    log.info(`Mesh started — heartbeat every ${String(interval)}ms`)
  }

  /**
   * Stop the mesh — mark this node offline, stop heartbeating.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    if (this.localNodeId) {
      await this.deregister(this.localNodeId).catch((err: unknown) => {
        log.warn(`Failed to deregister on shutdown: ${(err as Error).message}`)
      })
    }

    log.info('Mesh stopped')
  }

  // -----------------------------------------------------------------------
  // Seed sync — pull registry from a seed node's agent channel
  // -----------------------------------------------------------------------

  private async syncFromSeed(seedHost: string, seedPort: number): Promise<void> {
    const url = `http://${seedHost}:${String(seedPort)}/api/mesh`
    const secret = this.config.mesh.secret ?? ''

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      })

      if (!res.ok) {
        throw new Error(`Seed responded ${String(res.status)}: ${await res.text()}`)
      }

      const remoteNodes = (await res.json()) as MeshNode[]
      const localData = await this.load()

      let merged = 0
      for (const remote of remoteNodes) {
        const local = localData.nodes[remote.id]
        // Merge if remote is newer or doesn't exist locally
        if (!local || remote.lastSeen > local.lastSeen) {
          localData.nodes[remote.id] = remote
          merged++
        }
      }

      if (merged > 0) {
        localData.updatedAt = Date.now()
        await this.save(localData)
        log.info(`Synced ${String(merged)} nodes from seed ${seedHost}:${String(seedPort)}`)
      }
    } catch (err: unknown) {
      log.warn(`Seed sync failed (${seedHost}:${String(seedPort)}): ${(err as Error).message}`)
    }
  }

  // -----------------------------------------------------------------------
  // File I/O
  // -----------------------------------------------------------------------

  private async load(): Promise<MeshFile> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      return JSON.parse(raw) as MeshFile
    } catch {
      // File doesn't exist yet — return empty registry
      return { version: 1, nodes: {}, updatedAt: Date.now() }
    }
  }

  private async save(data: MeshFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  private emit(event: MeshNodeEvent): void {
    this.config.onEvent?.(event)
  }
}

// ---------------------------------------------------------------------------
// Helper — build a MeshNode for the local instance
// ---------------------------------------------------------------------------

export interface BuildLocalNodeArgs {
  /** Node ID (reads from mesh.json if exists, otherwise generates) */
  existingId?: string
  /** Node name (default: hostname) */
  name?: string
  /** Node role — 'agent' (default) or infrastructure role like 'datahub' */
  role?: MeshNodeRole
  /** Agent IDs running on this instance */
  agents: string[]
  /** Host address */
  host: string
  /** Agent channel port */
  port: number
  /** Provider IDs */
  providers: string[]
  /** Model names */
  models: string[]
  /** Capabilities */
  capabilities?: string[]
  /** RivetOS version */
  version: string
}

export function buildLocalNode(args: BuildLocalNodeArgs): MeshNode {
  return {
    id: args.existingId ?? randomUUID(),
    name: args.name ?? hostname(),
    ...(args.role ? { role: args.role } : {}),
    agents: args.agents,
    host: args.host,
    port: args.port,
    providers: args.providers,
    models: args.models,
    capabilities: args.capabilities ?? [],
    status: 'online',
    lastSeen: Date.now(),
    registeredAt: Date.now(),
    version: args.version,
  }
}
