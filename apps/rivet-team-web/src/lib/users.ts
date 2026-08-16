/**
 * Household user session for rivet-team.
 *
 * Tries the live /api/team surface (PR #512). If the node does not have
 * it yet, falls back to a per-browser localStorage roster that still
 * isolates personas and notes by userId.
 */

import { uuidv4 } from './uuid.js'

export interface TeamUser {
  id: string
  handle: string
  displayName: string
  schemaName: string
  roleName: string
  createdAt: number
}

export interface TeamSession {
  user: TeamUser
  deviceToken?: string
  source: 'live' | 'local'
}

const USER_KEY = 'rivet-team.users'
const SESSION_KEY = 'rivet-team.session'
const memoryUsers: TeamUser[] = []
let hydrated = false

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

function loadUsers(): TeamUser[] {
  if (!hydrated) {
    hydrated = true
    const raw = storage()?.getItem(USER_KEY)
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          memoryUsers.length = 0
          memoryUsers.push(...(parsed as TeamUser[]))
        }
      } catch {
        /* ignore */
      }
    }
  }
  return memoryUsers
}

function saveUsers(users: TeamUser[]): void {
  if (users !== memoryUsers) {
    memoryUsers.length = 0
    memoryUsers.push(...users)
  }
  try {
    storage()?.setItem(USER_KEY, JSON.stringify(memoryUsers))
  } catch {
    /* quota / missing */
  }
}

export function loadSession(): TeamSession | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as TeamSession) : null
  } catch {
    return null
  }
}

export function saveSession(session: TeamSession | null): void {
  if (typeof localStorage === 'undefined') return
  // deviceToken is a long-lived household bearer. Fine on a trusted LAN
  // browser profile; do not sync this origin to a shared machine.
  if (!session) localStorage.removeItem(SESSION_KEY)
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function resetLocalUsers(): void {
  memoryUsers.length = 0
  hydrated = true
  try {
    storage()?.removeItem(USER_KEY)
  } catch {
    /* missing */
  }
}

export function listLocalUsers(): TeamUser[] {
  return loadUsers()
}

export function createLocalUser(handle: string, displayName: string): TeamUser {
  const h = handle.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(h) || h === 'public' || /^(ros_|pg_)/.test(h)) {
    throw new Error('invalid handle')
  }
  const users = loadUsers()
  if (users.some((u) => u.handle === h)) throw new Error('handle taken')
  const user: TeamUser = {
    id: uuidv4(),
    handle: h,
    displayName: displayName.trim() || h,
    schemaName: `team_u_${h}`,
    roleName: `rivet_team_${h}`,
    createdAt: Date.now(),
  }
  users.push(user)
  saveUsers(users)
  return user
}

export class LiveTeamError extends Error {
  status?: number
  kind: 'http' | 'network'
  constructor(message: string, opts: { status?: number; kind: 'http' | 'network' }) {
    super(message)
    this.status = opts.status
    this.kind = opts.kind
  }
}

function isOffline(err: unknown): boolean {
  if (!(err instanceof LiveTeamError)) return true
  if (err.kind === 'network') return true
  const status = err.status ?? 0
  return status === 404 || status >= 500
}

async function liveJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    throw new LiveTeamError((err as Error).message || 'network error', { kind: 'network' })
  }
  let body: T & { error?: string }
  try {
    body = (await res.json()) as T & { error?: string }
  } catch {
    throw new LiveTeamError(`team api ${res.status}`, { status: res.status, kind: 'http' })
  }
  if (!res.ok) {
    throw new LiveTeamError(body.error || `team api ${res.status}`, {
      status: res.status,
      kind: 'http',
    })
  }
  return body
}

export async function tryCreateLiveUser(
  handle: string,
  displayName: string,
): Promise<TeamSession | null> {
  let created: { user: TeamUser }
  try {
    created = await liveJson<{ user: TeamUser }>('/api/team/users', {
      method: 'POST',
      body: JSON.stringify({ handle, displayName }),
    })
  } catch (err) {
    if (isOffline(err)) return null
    throw err
  }
  // User exists on the server now — do not invent a local twin if pair fails.
  const pair = await liveJson<{ code: string }>(`/api/team/users/${created.user.id}/pair`, {
    method: 'POST',
  })
  const redeemed = await liveJson<{ user: TeamUser; deviceToken: string }>(
    '/api/team/pair/redeem',
    { method: 'POST', body: JSON.stringify({ code: pair.code, label: 'rivet-team-web' }) },
  )
  return { user: redeemed.user, deviceToken: redeemed.deviceToken, source: 'live' }
}

export async function tryRedeemLive(code: string): Promise<TeamSession | null> {
  try {
    const redeemed = await liveJson<{ user: TeamUser; deviceToken: string }>(
      '/api/team/pair/redeem',
      { method: 'POST', body: JSON.stringify({ code, label: 'rivet-team-web' }) },
    )
    return { user: redeemed.user, deviceToken: redeemed.deviceToken, source: 'live' }
  } catch (err) {
    if (isOffline(err)) return null
    throw err
  }
}

export function signInLocal(user: TeamUser): TeamSession {
  return { user, source: 'local' }
}
