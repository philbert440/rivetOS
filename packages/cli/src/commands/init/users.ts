/**
 * Seed a single-owner users.json into the resolved shared dir.
 *
 * Shape matches `packages/types/src/users-registry.ts` (file registry:
 * `unmappedIsOwner: false`). Idempotent — an existing file is left alone.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
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

function bareDeviceId(raw: string): string {
  const t = raw.trim()
  return t.startsWith('device:') ? t.slice('device:'.length) : t
}

/**
 * Append device ids to the owner's `devices` array. Enrolled den clients
 * fail closed if they are missing from this list. Idempotent on id.
 */
export async function appendOwnerDevices(
  deviceIds: string[],
  ownerId = 'owner',
): Promise<{ path: string; added: string[] }> {
  const seeded = await seedUsersJson(ownerId)
  const path = seeded.path
  let parsed: {
    ownerUserId?: string
    unmappedIsOwner?: boolean
    users?: Record<string, { devices?: string[] }>
  }
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8')) as typeof parsed
  } catch {
    parsed = buildOwnerRegistry(ownerId)
  }
  const owner = (parsed.ownerUserId ?? ownerId).trim() || ownerId
  if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {}
  if (!parsed.users[owner]) parsed.users[owner] = { devices: [] }
  const devices = Array.isArray(parsed.users[owner].devices) ? parsed.users[owner].devices : []
  const have = new Set(devices.map(bareDeviceId))
  const added: string[] = []
  for (const raw of deviceIds) {
    const id = bareDeviceId(raw)
    if (!id || have.has(id)) continue
    have.add(id)
    devices.push(id)
    added.push(id)
  }
  parsed.users[owner].devices = devices
  parsed.ownerUserId = owner
  if (parsed.unmappedIsOwner === undefined) parsed.unmappedIsOwner = false
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
  return { path, added }
}
