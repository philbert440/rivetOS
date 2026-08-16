import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  TeamMeResponse,
  TeamNotesSearchResponse,
  TeamPairRedeemResponse,
  TeamPairStartResponse,
  TeamPersonaResponse,
  TeamPersonasResponse,
  TeamUserResponse,
  TeamUsersListResponse,
} from '@rivetos/types'
import {
  createTeamUsersRoutes,
  normalizeHandle,
  teamRoleName,
  teamSchemaName,
  userSchemaSql,
} from './team-users.js'

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-team-'))
}

async function listen(routes: ReturnType<typeof createTeamUsersRoutes>): Promise<{
  base: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/team/pair/redeem') {
        if (await routes.handleRedeem(req, res, url)) return
      }
      if (await routes.handle(req, res, url)) return
      res.writeHead(404)
      res.end()
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return {
    base,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

async function json<T>(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; den?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.den) headers.authorization = `Bearer ${opts.den}`
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, body: (await res.json()) as T }
}

describe('team identifier allowlist', () => {
  it('accepts a short handle and rejects junk and reserved names', () => {
    expect(normalizeHandle('Phil')).toBe('phil')
    expect(teamSchemaName('phil')).toBe('team_u_phil')
    expect(teamRoleName('phil')).toBe('rivet_team_phil')
    expect(() => normalizeHandle('')).toThrow(/invalid/)
    expect(() => normalizeHandle('1bad')).toThrow(/invalid/)
    expect(() => normalizeHandle('drop table')).toThrow(/invalid/)
    expect(() => normalizeHandle('ros_messages')).toThrow(/reserved|invalid/)
    expect(() => normalizeHandle('public')).toThrow(/reserved|invalid/)
  })

  it('schema SQL never mentions ros_* tables', () => {
    const sql = userSchemaSql('team_u_phil', 'rivet_team_phil')
    expect(sql).toContain('team_u_phil')
    expect(sql).toContain('rivet_team_phil')
    expect(sql).not.toMatch(/ros_messages|ros_conversations|ros_summaries/)
    expect(sql).toMatch(/ROW LEVEL SECURITY/)
  })
})

describe('team users isolation', () => {
  let base: string
  let close: () => Promise<void>

  beforeAll(async () => {
    const routes = createTeamUsersRoutes({ stateDir: tmpState(), denToken: '' })
    const srv = await listen(routes)
    base = srv.base
    close = srv.close
  })
  afterAll(async () => {
    await close()
  })

  it('two users cannot read each others notes or personas', async () => {
    const a = await json<TeamUserResponse>(base, 'POST', '/api/team/users', {
      body: { handle: 'phil', displayName: 'Phil' },
    })
    const b = await json<TeamUserResponse>(base, 'POST', '/api/team/users', {
      body: { handle: 'alex', displayName: 'Alex' },
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.body.user.schemaName).toBe('team_u_phil')
    expect(b.body.user.schemaName).toBe('team_u_alex')
    expect(a.body.user.roleName).not.toBe(b.body.user.roleName)

    const pairA = await json<TeamPairStartResponse>(
      base,
      'POST',
      `/api/team/users/${a.body.user.id}/pair`,
    )
    const pairB = await json<TeamPairStartResponse>(
      base,
      'POST',
      `/api/team/users/${b.body.user.id}/pair`,
    )
    const redA = await json<TeamPairRedeemResponse>(base, 'POST', '/api/team/pair/redeem', {
      body: { code: pairA.body.code, label: 'phil-phone' },
    })
    const redB = await json<TeamPairRedeemResponse>(base, 'POST', '/api/team/pair/redeem', {
      body: { code: pairB.body.code, label: 'alex-phone' },
    })
    expect(redA.status).toBe(200)
    expect(redB.status).toBe(200)

    const personasA = await json<TeamPersonasResponse>(base, 'GET', '/api/team/personas', {
      token: redA.body.deviceToken,
    })
    const personasB = await json<TeamPersonasResponse>(base, 'GET', '/api/team/personas', {
      token: redB.body.deviceToken,
    })
    expect(personasA.body.personas).toHaveLength(3)
    expect(personasB.body.personas).toHaveLength(3)
    expect(personasA.body.personas.every((p) => p.userId === a.body.user.id)).toBe(true)
    expect(personasB.body.personas.every((p) => p.userId === b.body.user.id)).toBe(true)
    const aIds = new Set(personasA.body.personas.map((p) => p.id))
    expect(personasB.body.personas.some((p) => aIds.has(p.id))).toBe(false)

    const note = await json(base, 'POST', '/api/team/notes', {
      token: redA.body.deviceToken,
      body: {
        personaId: personasA.body.personas[0].id,
        role: 'user',
        content: 'secret from phil',
      },
    })
    expect(note.status).toBe(201)

    const searchB = await json<TeamNotesSearchResponse>(
      base,
      'GET',
      '/api/team/notes/search?q=secret',
      { token: redB.body.deviceToken },
    )
    expect(searchB.status).toBe(200)
    expect(searchB.body.notes).toEqual([])

    const searchA = await json<TeamNotesSearchResponse>(
      base,
      'GET',
      '/api/team/notes/search?q=secret',
      { token: redA.body.deviceToken },
    )
    expect(searchA.body.notes).toHaveLength(1)
    expect(searchA.body.notes[0].content).toBe('secret from phil')

    const steal = await json(base, 'POST', '/api/team/notes', {
      token: redB.body.deviceToken,
      body: {
        personaId: personasA.body.personas[0].id,
        role: 'user',
        content: 'inject',
      },
    })
    expect(steal.status).toBe(404)
  })

  it('rejects a second user with the same handle', async () => {
    const second = await json(base, 'POST', '/api/team/users', {
      body: { handle: 'PHIL', displayName: 'Also Phil' },
    })
    expect(second.status).toBe(409)
  })

  it('lists users for the operator without leaking notes', async () => {
    const list = await json<TeamUsersListResponse>(base, 'GET', '/api/team/users')
    expect(list.status).toBe(200)
    expect(list.body.users.length).toBeGreaterThan(0)
    expect(JSON.stringify(list.body)).not.toMatch(/secret from phil/)
  })

  it('creates a persona only on the calling user', async () => {
    const list = await json<TeamUsersListResponse>(base, 'GET', '/api/team/users')
    const phil = list.body.users.find((u) => u.handle === 'phil')
    expect(phil).toBeTruthy()
    const pair = await json<TeamPairStartResponse>(
      base,
      'POST',
      `/api/team/users/${phil!.id}/pair`,
    )
    const red = await json<TeamPairRedeemResponse>(base, 'POST', '/api/team/pair/redeem', {
      body: { code: pair.body.code },
    })
    const created = await json<TeamPersonaResponse>(base, 'POST', '/api/team/personas', {
      token: red.body.deviceToken,
      body: { name: 'Kitchen', systemPrompt: 'Help with dinner.' },
    })
    expect(created.status).toBe(201)
    expect(created.body.persona.userId).toBe(phil!.id)
    expect(created.body.persona.name).toBe('Kitchen')
  })
})

describe('team pairing vs den bearer', () => {
  it('pair redeem does not require the den bearer', async () => {
    const routes = createTeamUsersRoutes({ stateDir: tmpState(), denToken: 'mesh-secret' })
    const srv = await listen(routes)
    try {
      const created = await json<TeamUserResponse>(srv.base, 'POST', '/api/team/users', {
        body: { handle: 'alex', displayName: 'Alex' },
        den: 'mesh-secret',
      })
      expect(created.status).toBe(201)

      const denied = await json(srv.base, 'POST', '/api/team/users', {
        body: { handle: 'other', displayName: 'Other' },
      })
      expect(denied.status).toBe(401)

      const pair = await json<TeamPairStartResponse>(
        srv.base,
        'POST',
        `/api/team/users/${created.body.user.id}/pair`,
        { den: 'mesh-secret' },
      )
      const redeem = await json<TeamPairRedeemResponse>(srv.base, 'POST', '/api/team/pair/redeem', {
        body: { code: pair.body.code },
      })
      expect(redeem.status).toBe(200)
      expect(redeem.body.deviceToken).toBeTruthy()

      const me = await json<TeamMeResponse>(srv.base, 'GET', '/api/team/me', {
        token: redeem.body.deviceToken,
      })
      expect(me.status).toBe(200)
      expect(me.body.user.handle).toBe('alex')
    } finally {
      await srv.close()
    }
  })
})

describe('team schema mint', () => {
  it('does not remint when the handle is already taken', async () => {
    let mintCalls = 0
    const schemaAdmin = {
      async ensureUserSchema(handle: string) {
        mintCalls += 1
        return {
          schema: teamSchemaName(handle),
          role: teamRoleName(handle),
          url: `postgres://rivet_team_${handle}:x@127.0.0.1/rivetos`,
        }
      },
      async dropUserSchema() {},
    }
    const routes = createTeamUsersRoutes({
      stateDir: tmpState(),
      denToken: '',
      schemaAdmin,
    })
    const srv = await listen(routes)
    try {
      const first = await json<TeamUserResponse>(srv.base, 'POST', '/api/team/users', {
        body: { handle: 'phil', displayName: 'Phil' },
      })
      expect(first.status).toBe(201)
      expect(mintCalls).toBe(1)
      const second = await json(srv.base, 'POST', '/api/team/users', {
        body: { handle: 'PHIL', displayName: 'Also Phil' },
      })
      expect(second.status).toBe(409)
      expect(mintCalls).toBe(1)
    } finally {
      await srv.close()
    }
  })
})

describe('team store file', () => {
  it('writes team-users.json owner-only', async () => {
    const dir = tmpState()
    const routes = createTeamUsersRoutes({ stateDir: dir, denToken: '' })
    const srv = await listen(routes)
    try {
      const created = await json<TeamUserResponse>(srv.base, 'POST', '/api/team/users', {
        body: { handle: 'phil', displayName: 'Phil' },
      })
      expect(created.status).toBe(201)
      const mode = statSync(join(dir, 'team-users.json')).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      await srv.close()
    }
  })
})
