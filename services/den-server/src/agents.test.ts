import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentsRoutes } from './agents.js'
import type { AgentPreset } from '@rivetos/types'

const NODE = 'https://192.0.2.10:5174'

let dir: string | undefined
let server: Server | undefined
let base: string
let now = 1_700_000_000_000

async function start(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'den-agents-'))
  now = 1_700_000_000_000
  const routes = createAgentsRoutes({ stateDir: dir, now: () => now })
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void routes.handle(req, res, url).then((hit) => {
      if (!hit) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

async function createAgent(
  body: Record<string, unknown> = { name: 'Alpha', nodeBaseUrl: NODE },
): Promise<{ status: number; json: { agent?: AgentPreset; error?: string } }> {
  const res = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as { agent?: AgentPreset; error?: string } }
}

describe('agents routes', () => {
  it('creates, lists, patches, and deletes', async () => {
    await start()
    const created = await createAgent({
      name: '  Alpha  ',
      color: '#3b82f6',
      harnessId: 'claude-code',
      model: 'fable',
      effort: 'high',
      systemPrompt: '  be terse  ',
      nodeBaseUrl: NODE,
    })
    expect(created.status).toBe(201)
    const agent = created.json.agent
    expect(agent).toMatchObject({
      name: 'Alpha',
      color: '#3b82f6',
      harnessId: 'claude-code',
      model: 'fable',
      effort: 'high',
      systemPrompt: 'be terse',
      nodeBaseUrl: NODE,
    })
    expect(agent?.id).toBeTruthy()

    const listed = await fetch(`${base}/api/agents`)
    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as { agents: AgentPreset[] }
    expect(listBody.agents).toHaveLength(1)
    expect(listBody.agents[0].id).toBe(agent!.id)

    const one = await fetch(`${base}/api/agents/${agent!.id}`)
    expect(one.status).toBe(200)

    const patched = await fetch(`${base}/api/agents/${agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', effort: 'low' }),
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { agent: AgentPreset }).agent).toMatchObject({
      name: 'Beta',
      effort: 'low',
      color: '#3b82f6',
    })

    const del = await fetch(`${base}/api/agents/${agent!.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    const empty = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentPreset[] }
    expect(empty.agents).toHaveLength(0)
  })

  it('POST 400s empty nodeBaseUrl', async () => {
    await start()
    const res = await createAgent({ name: 'x', nodeBaseUrl: '' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('nodeBaseUrl is required')
  })

  it('PATCH 400s empty nodeBaseUrl', async () => {
    await start()
    const created = await createAgent()
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: '' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('nodeBaseUrl is required')
  })

  it('PATCH 400s nodeBaseUrl changes as immutable', async () => {
    await start()
    const created = await createAgent()
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: 'https://192.0.2.99:5174' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'node is immutable; recreate the agent',
    )
    const got = await fetch(`${base}/api/agents/${created.json.agent!.id}`)
    expect(((await got.json()) as { agent: AgentPreset }).agent.nodeBaseUrl).toBe(NODE)
  })

  it('PATCH of the same nodeBaseUrl is a no-op, not 400', async () => {
    await start()
    const created = await createAgent()
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: NODE, name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agent: AgentPreset }).agent.name).toBe('Renamed')
  })

  it('quarantines a corrupt agents.json and allows writes after', async () => {
    await start()
    writeFileSync(join(dir!, 'agents.json'), '{not json')
    const listed = await fetch(`${base}/api/agents`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ agents: [] })
    const leftovers = readdirSync(dir!).filter((n) => n.startsWith('agents.json.corrupt-'))
    expect(leftovers).toHaveLength(1)
    expect(existsSync(join(dir!, 'agents.json'))).toBe(false)
    expect(readFileSync(join(dir!, leftovers[0]), 'utf8')).toBe('{not json')

    const created = await createAgent({ name: 'Recovered', nodeBaseUrl: NODE })
    expect(created.status).toBe(201)
    expect(existsSync(join(dir!, 'agents.json'))).toBe(true)
    expect(readFileSync(join(dir!, leftovers[0]), 'utf8')).toBe('{not json')
  })

  it('quarantines a valid JSON file whose agents field is not an array', async () => {
    await start()
    writeFileSync(join(dir!, 'agents.json'), JSON.stringify({ agents: { nope: true } }))
    const listed = await fetch(`${base}/api/agents`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ agents: [] })
    expect(readdirSync(dir!).some((n) => n.startsWith('agents.json.corrupt-'))).toBe(true)
  })

  it('serializes concurrent patches so both field writes land', async () => {
    await start()
    const created = await createAgent({ name: 'Orig', color: '#111111', nodeBaseUrl: NODE })
    const id = created.json.agent!.id
    const [a, b] = await Promise.all([
      fetch(`${base}/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'FromA' }),
      }),
      fetch(`${base}/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: '#abcdef' }),
      }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const got = await fetch(`${base}/api/agents/${id}`)
    const agent = ((await got.json()) as { agent: AgentPreset }).agent
    expect(agent.name).toBe('FromA')
    expect(agent.color).toBe('#abcdef')
  })

  it('rejects a non-http nodeBaseUrl and a non-hex color', async () => {
    await start()
    expect((await createAgent({ name: 'x', nodeBaseUrl: 'ftp://nope' })).status).toBe(400)
    expect((await createAgent({ name: 'x', nodeBaseUrl: NODE, color: 'blue' })).status).toBe(400)
  })

  it('migrates a stored catalog-agent model onto harnessId', async () => {
    await start()
    writeFileSync(
      join(dir!, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Legacy',
            color: '',
            model: 'claude',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: NODE,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )
    const listed = await fetch(`${base}/api/agents`)
    const body = (await listed.json()) as { agents: AgentPreset[] }
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]).toMatchObject({
      name: 'Legacy',
      harnessId: 'claude-code',
      model: '',
      effort: 'medium',
    })
  })

  it('migrates model=claude-code on create to harnessId and empty model', async () => {
    await start()
    const created = await createAgent({ name: 'OldClient', nodeBaseUrl: NODE, model: 'claude' })
    expect(created.status).toBe(201)
    expect(created.json.agent).toMatchObject({ harnessId: 'claude-code', model: '' })
  })

  it('PATCH harnessId null unsets, then migrateAgentPreset runs on the result', async () => {
    await start()
    const created = await createAgent({
      name: 'Pinned',
      nodeBaseUrl: NODE,
      harnessId: 'claude-code',
      model: 'fable',
    })
    const id = created.json.agent!.id
    const cleared = await fetch(`${base}/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harnessId: null }),
    })
    expect(cleared.status).toBe(200)
    const clearedAgent = ((await cleared.json()) as { agent: AgentPreset }).agent
    expect(clearedAgent.harnessId).toBeUndefined()
    expect(clearedAgent.model).toBe('fable')

    const recatalog = await fetch(`${base}/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harnessId: null, model: 'claude' }),
    })
    expect(recatalog.status).toBe(200)
    const remigrated = ((await recatalog.json()) as { agent: AgentPreset }).agent
    expect(remigrated).toMatchObject({ harnessId: 'claude-code', model: '' })
  })
})
