/**
 * Seed a single-owner users.json into the resolved shared dir.
 *
 * Shape matches `packages/types/src/users-registry.ts` (file registry:
 * `unmappedIsOwner: false`). Idempotent — an existing file is left alone.
 */

import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sharedPath } from '@rivetos/types'

export function usersJsonPath(): string {
  return sharedPath('rivetos', 'users.json')
}

/** On-disk registry shape (parseUsersRegistry reconstructs `id` from the key). */
export function buildOwnerRegistry(ownerId: string): {
  ownerUserId: string
  unmappedIsOwner: false
  users: Record<string, { devices: string[] }>
} {
  const id = ownerId.trim()
  return {
    ownerUserId: id,
    unmappedIsOwner: false,
    users: { [id]: { devices: [] } },
  }
}

export async function seedUsersJson(ownerId: string): Promise<{ path: string; written: boolean }> {
  const path = usersJsonPath()
  try {
    await access(path)
    return { path, written: false }
  } catch {
    // missing — seed
  }
  await mkdir(dirname(path), { recursive: true })
  const body = `${JSON.stringify(buildOwnerRegistry(ownerId), null, 2)}\n`
  await writeFile(path, body, { mode: 0o600 })
  return { path, written: true }
}
