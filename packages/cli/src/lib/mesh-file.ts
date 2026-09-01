/**
 * Canonical mesh.json loading (file I/O).
 *
 * Parsing lives in `@rivetos/types` (`parseMeshFile`). This module resolves
 * candidate paths, reads the first readable file, and re-exports the parser
 * for CLI callers that already import from here.
 *
 * The canonical file lives at `$RIVETOS_SHARED_DIR/mesh.json` (default
 * `/rivet-shared/mesh.json`, the NFS mount from the datahub). When `root` is
 * provided (e.g. doctor/cwd), that directory's mesh.json is also tried.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  isMeshFlatArrayError,
  MeshParseError,
  parseMeshFile,
  sharedPath,
  type MeshFile,
} from '@rivetos/types'

export type { MeshFile, MeshNode } from '@rivetos/types'
export {
  assertRecordMeshFile,
  isMeshFlatArrayError,
  MeshParseError,
  parseMeshFile,
} from '@rivetos/types'

/**
 * Load mesh.json, checking the canonical path first and optional root.
 * Returns null if none are readable. Throws on unsupported array format
 * and on per-node validation errors (explicit CLI commands keep
 * `onInvalidNode: 'throw'`); invalid JSON falls through to the next
 * candidate (same as missing / unreadable).
 */
export async function loadMeshFile(root?: string): Promise<MeshFile | null> {
  const paths = [sharedPath('mesh.json')]
  if (root) paths.push(resolve(root, 'mesh.json'))

  for (const p of paths) {
    let raw: string
    try {
      raw = await readFile(p, 'utf-8')
    } catch {
      continue
    }
    try {
      return parseMeshFile(raw, p)
    } catch (err) {
      if (isMeshFlatArrayError(err)) throw err
      if (err instanceof MeshParseError && err.code !== 'MESH_JSON_INVALID') throw err
    }
  }

  return null
}
