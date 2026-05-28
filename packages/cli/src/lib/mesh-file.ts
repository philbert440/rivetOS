/**
 * Canonical mesh.json loading + legacy-format normalization.
 *
 * The canonical file lives at `/rivet-shared/mesh.json` (the NFS mount from the
 * datahub). We also accept a couple of legacy locations and the old flat-array
 * format so a half-migrated mesh still updates cleanly.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface MeshNode {
  id: string
  name: string
  role?: string // 'agent' (default), 'datahub', etc. Non-agent nodes are sync-only.
  agents?: string[]
  host: string
  port: number
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

/** Legacy mesh.json format — flat array with `ip` instead of `host`. */
interface LegacyMeshFile {
  nodes: Array<{ name: string; ip?: string; host?: string; role?: string }>
  updatedAt?: number
}

/** Normalize a legacy array-based mesh.json to the Record-based format. */
export function normalizeMeshFile(parsed: MeshFile | LegacyMeshFile): MeshFile {
  if (!Array.isArray(parsed.nodes)) {
    return parsed as MeshFile
  }

  const nodes: MeshFile['nodes'] = {}
  for (const entry of parsed.nodes) {
    const host = entry.ip ?? entry.host ?? ''
    const id = entry.name
    nodes[id] = {
      id,
      name: entry.name,
      host,
      port: 3100,
      status: 'offline',
      role: entry.role === 'primary' ? 'agent' : entry.role,
    }
  }

  return {
    version: 1,
    nodes,
    updatedAt: parsed.updatedAt ?? Date.now(),
  }
}

/**
 * Load and normalize mesh.json, checking the canonical path first and a couple
 * of legacy fallbacks. Returns null if none are readable.
 */
export async function loadMeshFile(root?: string): Promise<MeshFile | null> {
  const paths = ['/rivet-shared/mesh.json']
  if (root) paths.push(resolve(root, 'mesh.json'))
  paths.push(resolve(process.env.HOME ?? '~', '.rivetos', 'mesh.json'))

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8')
      const parsed = JSON.parse(raw) as MeshFile | LegacyMeshFile
      return normalizeMeshFile(parsed)
    } catch {
      // try next
    }
  }

  return null
}
