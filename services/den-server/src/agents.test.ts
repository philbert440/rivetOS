import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAgentPresetStore } from '@rivetos/agent-registry'
import { createAgentsRoutes } from './agents.js'
import type { AgentPreset } from '@rivetos/types'

const NODE = 'https://192.0.2.10:5174'

let dir: string | undefined
let server: Server | undefined
let base: string
let now = 1_700_000_000_000

async function start(opts?: { homeDir?: () => string }): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'den-agents-'))
  mkdirSync(join(dir, 'shared'))
  now = 1_700_000_000_000
  const routes = createAgentsRoutes({
    store: new FileAgentPresetStore(join(dir, 'agents.json'), { now: () => now }),
    nodeName: 'ct115',
    directoryRoot: join(dir, 'agents'),
    sharedDir: join(dir, 'shared'),
    now: () => now,
    ...(opts?.homeDir ? { homeDir: opts.homeDir } : {}),
  })
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
    const directory = join(dir!, 'agents', 'alpha')
    expect(agent).toMatchObject({
      name: 'Alpha',
      color: '#3b82f6',
      harnessId: 'claude-code',
      model: 'fable',
      effort: 'high',
      systemPrompt: 'be terse',
      nodeBaseUrl: NODE,
      node: 'ct115',
      directory,
      sharedLink: true,
    })
    expect(agent?.id).toBeTruthy()
    expect(existsSync(directory)).toBe(true)
    const link = join(directory, 'rivet-shared')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))

    const listed = await fetch(`${base}/api/agents`)
    expect(listed.status).toBe(200)
    const listBody = (await listed.json()) as {
      agents: AgentPreset[]
      node: string
      directoryRoot: string
      sharedDir: string
      backend: string
    }
    expect(listBody.agents).toHaveLength(1)
    expect(listBody.agents[0].id).toBe(agent!.id)
    expect(listBody.node).toBe('ct115')
    expect(listBody.directoryRoot).toBe(join(dir!, 'agents'))
    expect(listBody.sharedDir).toBe(join(dir!, 'shared'))
    expect(listBody.backend).toBe('file')

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

  it('POST without nodeBaseUrl succeeds and stamps node', async () => {
    await start()
    const res = await createAgent({ name: 'Bare' })
    expect(res.status).toBe(201)
    expect(res.json.agent).toMatchObject({ node: 'ct115', nodeBaseUrl: '' })
  })

  it('POST with a foreign node → 400', async () => {
    await start()
    const res = await createAgent({ name: 'x', node: 'ct114' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('agent must be created on its hosting node (ct115)')
    expect(existsSync(join(dir!, 'agents', 'x'))).toBe(false)
  })

  it('PATCH node → 400 immutable', async () => {
    await start()
    const created = await createAgent()
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: 'ct114' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'node is immutable; recreate the agent',
    )
    const got = await fetch(`${base}/api/agents/${created.json.agent!.id}`)
    expect(((await got.json()) as { agent: AgentPreset }).agent.node).toBe('ct115')
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

  it('rejects a non-hex color', async () => {
    await start()
    const res = await createAgent({ name: 'x', nodeBaseUrl: NODE, color: 'blue' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('color must be a hex value')
  })

  it('PATCH directory materializes the new directory (old stays)', async () => {
    await start()
    const created = await createAgent({ name: 'Alpha', nodeBaseUrl: NODE })
    const oldDir = created.json.agent!.directory!
    const next = join(dir!, 'elsewhere')
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: next }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agent: AgentPreset }).agent.directory).toBe(next)
    expect(existsSync(oldDir)).toBe(true)
    expect(lstatSync(join(oldDir, 'rivet-shared')).isSymbolicLink()).toBe(true)
    expect(existsSync(next)).toBe(true)
    expect(readlinkSync(join(next, 'rivet-shared'))).toBe(join(dir!, 'shared'))
  })

  it('PATCH sharedLink:false then true re-links', async () => {
    await start()
    const created = await createAgent({ name: 'Alpha', nodeBaseUrl: NODE })
    const directory = created.json.agent!.directory!
    const link = join(directory, 'rivet-shared')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const off = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLink: false }),
    })
    expect(off.status).toBe(200)
    expect(((await off.json()) as { agent: AgentPreset }).agent.sharedLink).toBe(false)
    expect(existsSync(link)).toBe(false)
    const on = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLink: true }),
    })
    expect(on.status).toBe(200)
    expect(((await on.json()) as { agent: AgentPreset }).agent.sharedLink).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))
  })

  it('duplicate name → 409', async () => {
    await start()
    expect((await createAgent({ name: 'Alpha', nodeBaseUrl: NODE })).status).toBe(201)
    const again = await createAgent({ name: 'Alpha', nodeBaseUrl: NODE })
    expect(again.status).toBe(409)
    expect(again.json.error).toBe('an agent named "Alpha" already exists')
  })

  it('directory with `..` → 400', async () => {
    await start()
    const res = await createAgent({ name: 'Dot', nodeBaseUrl: NODE, directory: '../nope' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('directory must be an absolute path')
  })

  it('`~/x` expands to homeDir()', async () => {
    let home = ''
    await start({ homeDir: () => home })
    home = join(dir!, 'home')
    const res = await createAgent({ name: 'Tilde', nodeBaseUrl: NODE, directory: '~/x' })
    expect(res.status).toBe(201)
    expect(res.json.agent?.directory).toBe(join(home, 'x'))
    expect(existsSync(join(home, 'x'))).toBe(true)
  })

  it('PATCH empty nodeBaseUrl is ignored', async () => {
    await start()
    const created = await createAgent()
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: '' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agent: AgentPreset }).agent.nodeBaseUrl).toBe(NODE)
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

  it('accepts a slash model id on create and PATCH', async () => {
    await start()
    const created = await createAgent({
      name: 'Kimi',
      nodeBaseUrl: NODE,
      harnessId: 'kimi-code',
      model: 'moonshotai/kimi-k3',
    })
    expect(created.status).toBe(201)
    expect(created.json.agent).toMatchObject({
      harnessId: 'kimi-code',
      model: 'moonshotai/kimi-k3',
    })
    const patched = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'moonshotai/kimi-k2-0905-preview' }),
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { agent: AgentPreset }).agent.model).toBe(
      'moonshotai/kimi-k2-0905-preview',
    )
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
