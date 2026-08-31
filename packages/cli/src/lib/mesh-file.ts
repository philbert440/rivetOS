/**
 * Canonical mesh.json loading.
 *
 * The canonical file lives at `$RIVETOS_SHARED_DIR/mesh.json` (default
 * `/rivet-shared/mesh.json`, the NFS mount from the datahub). When `root` is
 * provided (e.g. doctor/cwd), that directory's mesh.json is also tried. The
 * pre-capabilities flat-array format is rejected with a clear error —
 * Record-format only.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sharedPath } from '@rivetos/types'

export interface MeshNode {
  id: string
  name: string
  role?: string // 'agent' (default), 'datahub', etc. Non-agent nodes are sync-only.
  agents?: string[]
  host: string
  port: number
  /** SSH login for update/deploy tooling when it isn't `rivet` (e.g. phildesk → `philip`). */
  sshUser?: string
  /** Source-tree path when it isn't `$RIVETOS_INSTALL_ROOT` (default `/opt/rivetos`). */
  installRoot?: string
  /** Host platform. Default 'linux'. Non-linux nodes (e.g. rivet-phone →
   *  'android') are full mesh members but have no automated update path yet:
   *  `update --mesh` probes and reports them without attempting git/systemd. */
  platform?: string
  /** Arbitrary per-node metadata (e.g. deployable:false as an explicit
   *  update opt-out regardless of platform). */
  metadata?: Record<string, unknown>
  providers?: string[]
  models?: string[]
  capabilities?: string[]
  /** 'online' | 'offline' | 'degraded' | 'updating' — datahub may emit others. */
  status: string
  lastSeen?: number
  registeredAt?: number
  version?: string
}

export interface MeshFile {
  version: number
  nodes: Record<string, MeshNode>
  updatedAt: number
}

/**
 * Assert mesh.json is Record-format. Throws if `nodes` is a flat array
 * (pre-capabilities format no longer supported).
 */
export function assertRecordMeshFile(parsed: unknown, path: string): MeshFile {
  const data = parsed as { nodes?: unknown; version?: unknown; updatedAt?: unknown }
  if (Array.isArray(data.nodes)) {
    throw new Error(
      `mesh.json at ${path} uses the pre-capabilities flat-array format, ` +
        'which is no longer supported. Rewrite the file as Record-format ' +
        `{ version, nodes: { [id]: node }, updatedAt } (see live ${sharedPath('mesh.json')}; override with RIVETOS_SHARED_DIR).`,
    )
  }
  return parsed as MeshFile
}

/**
 * Load mesh.json, checking the canonical path first and optional root.
 * Returns null if none are readable. Throws on unsupported array format.
 */
export async function loadMeshFile(root?: string): Promise<MeshFile | null> {
  const paths = [sharedPath('mesh.json')]
  if (root) paths.push(resolve(root, 'mesh.json'))

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      return assertRecordMeshFile(parsed, p)
    } catch (err) {
      // Fail loud on unsupported array format — do not try the next candidate.
      if (err instanceof Error && err.message.includes('pre-capabilities flat-array')) {
        throw err
      }
      // try next (missing / unreadable / invalid JSON)
    }
  }

  return null
}
