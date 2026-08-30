/**
 * `rivetos user …` — tenancy registry. One command to add a human rather than
 * a fleet env-map deploy.
 *
 *   rivetos user list
 *   rivetos user add <id> --device <deviceId> [--persona <name>] [--url <pg>] [--file <path>]
 *
 * Identity is written to the registry file (no fleet restart). `--url` stores
 * the user's Postgres URL on that record so den can route without
 * RIVETOS_USER_DBS. CREATE DATABASE / role / migrate is printed when
 * RIVETOS_TEAM_PG_ADMIN_URL is unset.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseUsersRegistry, sharedPath, type UsersRegistry } from '@rivetos/types'

function defaultFile(): string {
  return process.env.RIVETOS_USERS_FILE?.trim() || sharedPath('rivetos', 'users.json')
}

function load(file: string): UsersRegistry {
  if (!existsSync(file)) {
    return {
      ownerUserId: 'phil',
      unmappedIsOwner: false,
      users: { phil: { id: 'phil', devices: [] } },
    }
  }
  const parsed = parseUsersRegistry(readFileSync(file, 'utf8'))
  if (!parsed) {
    console.error(`[user] ${file} is not a valid registry`)
    process.exit(1)
  }
  return parsed
}

function save(file: string, registry: UsersRegistry): void {
  mkdirSync(dirname(file), { recursive: true })
  const body = {
    ownerUserId: registry.ownerUserId,
    unmappedIsOwner: registry.unmappedIsOwner,
    users: Object.fromEntries(
      Object.values(registry.users).map((u) => [
        u.id,
        {
          devices: u.devices,
          ...(u.persona ? { persona: u.persona } : {}),
          ...(u.db?.pgUrl ? { pgUrl: u.db.pgUrl } : {}),
          ...(u.db?.envFile ? { envFile: u.db.envFile } : {}),
        },
      ]),
    ),
  }
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  return args[i + 1]
}

function list(file: string): void {
  // load() already supplies the missing-file default — same one add() uses,
  // so list and add can't disagree on unmappedIsOwner.
  const registry = load(file)
  console.log(`[user] file ${file}`)
  console.log(`[user] owner ${registry.ownerUserId}  unmappedIsOwner=${registry.unmappedIsOwner}`)
  const ids = Object.keys(registry.users)
  if (ids.length === 0) {
    console.log('[user] (empty)')
    return
  }
  for (const id of ids) {
    const u = registry.users[id]
    console.log(
      `  ${id}  devices=${u.devices.join(',') || '-'}  db=${u.db?.pgUrl ? 'yes' : 'no'}  persona=${u.persona ?? '-'}`,
    )
  }
}

function add(id: string, args: string[]): void {
  if (!id) {
    console.error(
      'usage: rivetos user add <id> --device <deviceId> [--persona name] [--url postgres://…] [--file path]',
    )
    process.exit(1)
  }
  const device = argValue(args, '--device')
  if (!device) {
    console.error('[user add] --device is required')
    process.exit(1)
  }
  const file = argValue(args, '--file') || defaultFile()
  const persona = argValue(args, '--persona')
  const url = argValue(args, '--url')
  const envFile = argValue(args, '--env-file')
  const registry = load(file)
  const existing = registry.users[id] ?? { id, devices: [] }
  const bare = device.startsWith('device:') ? device.slice('device:'.length) : device
  if (!existing.devices.includes(bare)) existing.devices.push(bare)
  if (persona) existing.persona = persona
  if (url) existing.db = { pgUrl: url, envFile: envFile ?? existing.db?.envFile }
  else if (envFile && existing.db) existing.db = { ...existing.db, envFile }
  registry.users[id] = existing
  save(file, registry)
  console.log(`[user] wrote ${id} device=${bare} → ${file}`)
  if (!url && !existing.db) {
    console.log(
      `[user] no --url given. After CREATE DATABASE, re-run with --url or set RIVETOS_USER_DBS.`,
    )
  }
  if (!process.env.RIVETOS_TEAM_PG_ADMIN_URL) {
    console.log(`[user] provisioning SQL (run as a superuser on datahub):`)
    console.log(`  CREATE USER rivet_${id} WITH PASSWORD '...';`)
    console.log(`  CREATE DATABASE ${id}_memory OWNER rivet_${id};`)
    console.log(
      `  ALTER TABLE ros_messages OWNER TO rivet_${id};  -- after rivetos db migrate --url …`,
    )
  }
}

export default async function userCommand(args: string[]): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  const fileFlag = argValue(rest, '--file') || defaultFile()
  switch (sub) {
    case 'list':
      list(fileFlag)
      break
    case 'add':
      await Promise.resolve(add(rest[0] ?? '', rest.slice(1)))
      break
    default:
      console.error('usage: rivetos user list | rivetos user add <id> --device <deviceId>')
      process.exit(1)
  }
}
