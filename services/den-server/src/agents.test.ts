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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileAgentPresetStore,
  PresetConflictError,
  type AgentPresetInput,
  type AgentPresetStore,
} from '@rivetos/agent-registry'
import { createAgentsRoutes, type AgentRouteLog } from './agents.js'
import type { AgentPreset } from '@rivetos/types'

const NODE = 'https://192.0.2.10:5174'

let dir: string | undefined
let server: Server | undefined
let base: string
let now = 1_700_000_000_000

async function start(opts?: {
  homeDir?: () => string
  directoryRoot?: (dir: string) => string
  store?: (dir: string) => AgentPresetStore
  log?: AgentRouteLog
}): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'den-agents-'))
  mkdirSync(join(dir, 'shared'))
  now = 1_700_000_000_000
  const routes = createAgentsRoutes({
    store:
      opts?.store?.(dir) ?? new FileAgentPresetStore(join(dir, 'agents.json'), { now: () => now }),
    nodeName: 'ct115',
    directoryRoot: opts?.directoryRoot?.(dir) ?? join(dir, 'agents'),
    sharedDir: join(dir, 'shared'),
    now: () => now,
    ...(opts?.homeDir ? { homeDir: opts.homeDir } : {}),
    ...(opts?.log ? { log: opts.log } : {}),
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

function storeOver(
  root: string,
  create: (real: FileAgentPresetStore, input: AgentPresetInput) => Promise<AgentPreset>,
): AgentPresetStore {
  const real = new FileAgentPresetStore(join(root, 'agents.json'), { now: () => now })
  return {
    backend: 'file',
    file: real.file,
    isReady: () => real.isReady(),
    list: (filter) => real.list(filter),
    get: (id) => real.get(id),
    findByHandle: (handle) => real.findByHandle(handle),
    create: (input) => create(real, input),
    update: (id, patch) => real.update(id, patch),
    delete: (id) => real.delete(id),
  }
}

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

  it('PATCH sortOrder orders the list; null clears it; bad values are 400', async () => {
    await start()
    const first = (await createAgent({ name: 'First' })).json.agent!
    const second = (await createAgent({ name: 'Second' })).json.agent!
    const patch = (id: string, body: unknown) =>
      fetch(`${base}/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    const names = async () =>
      ((await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentPreset[] }).agents.map(
        (a) => a.name,
      )

    const ordered = await patch(second.id, { sortOrder: 0 })
    expect(ordered.status).toBe(200)
    expect(((await ordered.json()) as { agent: AgentPreset }).agent.sortOrder).toBe(0)
    expect(await names()).toEqual(['Second', 'First'])
    expect((await patch(first.id, { sortOrder: 0 })).status).toBe(200)
    expect((await patch(second.id, { sortOrder: 1 })).status).toBe(200)
    expect(await names()).toEqual(['First', 'Second'])

    for (const bad of [-1, 1.5, 1_000_001, '2', true]) {
      const res = await patch(first.id, { sortOrder: bad })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(
        'sortOrder must be an integer 0-1000000 or null',
      )
    }

    const cleared = await patch(first.id, { sortOrder: null })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { agent: AgentPreset }).agent.sortOrder).toBeUndefined()
    // An unordered preset sorts after every ordered one.
    expect(await names()).toEqual(['Second', 'First'])
  })

  it('POST nodeBaseUrl is stored, not required', async () => {
    await start()
    const sent = `  https://192.0.2.99:5174/${'x'.repeat(500)}  `
    const res = await createAgent({
      name: 'Stored',
      nodeBaseUrl: sent,
    })
    expect(res.status).toBe(201)
    const stored = sent.trim().slice(0, 512)
    expect(stored.length).toBe(512)
    expect(res.json.agent).toMatchObject({ node: 'ct115', nodeBaseUrl: stored })

    const omitted = await createAgent({ name: 'Omitted' })
    expect(omitted.status).toBe(201)
    expect(omitted.json.agent?.nodeBaseUrl).toBe('')
  })

  it('PATCH ignores nodeBaseUrl and does not fill an empty URL', async () => {
    await start()
    const created = await createAgent({ name: 'Alpha' })
    expect(created.json.agent?.nodeBaseUrl).toBe('')
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: 'https://192.0.2.99:5174', name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agent: AgentPreset }).agent).toMatchObject({
      name: 'Renamed',
      nodeBaseUrl: '',
    })
  })

  it('PATCH of nodeBaseUrl is a no-op, not 400', async () => {
    await start()
    const created = await createAgent({ name: 'Alpha' })
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: NODE, name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const agent = ((await res.json()) as { agent: AgentPreset }).agent
    expect(agent.name).toBe('Renamed')
    expect(agent.nodeBaseUrl).toBe('')
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

  it('lists and gets a legacy file row with its nodeBaseUrl, and PATCH does not change it', async () => {
    await start()
    writeFileSync(
      join(dir!, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'legacy-url-1',
            name: 'LegacyUrl',
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: NODE,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )
    const listed = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentPreset[] }
    expect(listed.agents).toHaveLength(1)
    expect(listed.agents[0]?.nodeBaseUrl).toBe(NODE)
    const got = (await (await fetch(`${base}/api/agents/legacy-url-1`)).json()) as {
      agent: AgentPreset
    }
    expect(got.agent.nodeBaseUrl).toBe(NODE)

    const cleared = await fetch(`${base}/api/agents/legacy-url-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: '' }),
    })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { agent: AgentPreset }).agent.nodeBaseUrl).toBe(NODE)

    const replaced = await fetch(`${base}/api/agents/legacy-url-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: 'https://192.0.2.99:5174', name: 'StillLegacy' }),
    })
    expect(replaced.status).toBe(200)
    expect(((await replaced.json()) as { agent: AgentPreset }).agent).toMatchObject({
      name: 'StillLegacy',
      nodeBaseUrl: NODE,
    })
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

  it('logs directory creation at info, not error', async () => {
    const logs: string[] = []
    await start({
      log: (msg, level) => {
        logs.push(`${level ?? 'error'}:${msg}`)
      },
    })
    expect((await createAgent({ name: 'Alpha' })).status).toBe(201)
    expect(
      logs.some((line) => line.startsWith('info:') && line.includes('created agent directory')),
    ).toBe(true)
    expect(logs.some((line) => line.startsWith('info:') && line.includes('linked'))).toBe(true)
    expect(logs.some((line) => line.startsWith('error:'))).toBe(false)
  })

  it('store failure → 503 with the cause logged, not leaked', async () => {
    const logs: string[] = []
    await start({
      log: (msg, level) => {
        logs.push(`${level ?? 'error'}:${msg}`)
      },
      store: () => ({
        backend: 'file',
        isReady: () => Promise.resolve(true),
        list: () => Promise.reject(new Error('secret-cause')),
        get: () => Promise.reject(new Error('secret-cause')),
        findByHandle: () => Promise.reject(new Error('secret-cause')),
        create: () => Promise.reject(new Error('secret-cause')),
        update: () => Promise.reject(new Error('secret-cause')),
        delete: () => Promise.reject(new Error('secret-cause')),
      }),
    })
    const listed = await fetch(`${base}/api/agents`)
    const body = (await listed.json()) as { error?: string }
    expect(listed.status).toBe(503)
    expect(body.error).toBe('agent registry unavailable')
    expect(JSON.stringify(body)).not.toMatch(/secret-cause/)
    expect(logs.some((line) => line.startsWith('error:') && line.includes('secret-cause'))).toBe(
      true,
    )
  })

  it('ensureAgentDirectory failure → 500 and nothing stored', async () => {
    await start({
      directoryRoot: (root) => {
        const file = join(root, 'not-a-dir')
        writeFileSync(file, 'x')
        return file
      },
    })
    const res = await createAgent({ name: 'Alpha' })
    expect(res.status).toBe(500)
    expect(res.json.error).toMatch(/could not create agent directory/)
    const listed = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentPreset[] }
    expect(listed.agents).toEqual([])
    expect(existsSync(join(dir!, 'agents.json'))).toBe(false)
  })

  it('rejected duplicate POST leaves the existing agent link', async () => {
    await start()
    const created = await createAgent({ name: 'Alpha' })
    const link = join(created.json.agent!.directory!, 'rivet-shared')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const again = await createAgent({ name: 'alpha', sharedLink: false })
    expect(again.status).toBe(409)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))
  })

  it('PATCH rename → 409 leaves the link and the row', async () => {
    await start()
    const alpha = await createAgent({ name: 'Alpha' })
    expect((await createAgent({ name: 'Beta' })).status).toBe(201)
    const link = join(alpha.json.agent!.directory!, 'rivet-shared')
    const res = await fetch(`${base}/api/agents/${alpha.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', sharedLink: false }),
    })
    expect(res.status).toBe(409)
    const got = (await (await fetch(`${base}/api/agents/${alpha.json.agent!.id}`)).json()) as {
      agent: AgentPreset
    }
    expect(got.agent.name).toBe('Alpha')
    expect(got.agent.sharedLink).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))
  })

  it('two concurrent placement PATCHes both land and disk matches the stored row', async () => {
    await start()
    const created = await createAgent({ name: 'Alpha' })
    const id = created.json.agent!.id
    const next = join(dir!, 'moved')
    const [off, moved] = await Promise.all([
      fetch(`${base}/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharedLink: false }),
      }),
      fetch(`${base}/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: next }),
      }),
    ])
    expect(off.status).toBe(200)
    expect(moved.status).toBe(200)
    const agent = (
      (await (await fetch(`${base}/api/agents/${id}`)).json()) as { agent: AgentPreset }
    ).agent
    expect(agent.sharedLink).toBe(false)
    expect(agent.directory).toBe(next)
    expect(existsSync(next)).toBe(true)
    expect(existsSync(join(next, 'rivet-shared'))).toBe(false)
  })

  it('POST {directory:"~/", sharedLink:false} never unlinks', async () => {
    await start({
      homeDir: () => {
        const home = join(dir!, 'home')
        if (!existsSync(home)) {
          mkdirSync(home)
          symlinkSync(join(dir!, 'shared'), join(home, 'rivet-shared'))
        }
        return home
      },
    })
    const res = await createAgent({ name: 'Home', directory: '~/', sharedLink: false })
    expect(res.status).toBe(201)
    const link = join(dir!, 'home', 'rivet-shared')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))
  })

  it('absolute path with .. and ~/../x → 400', async () => {
    await start({ homeDir: () => join(dir!, 'home') })
    const abs = await createAgent({
      name: 'Dot',
      directory: `${dir!}/agents/../escaped`,
    })
    expect(abs.status).toBe(400)
    expect(abs.json.error).toBe('directory must be an absolute path')
    expect(existsSync(join(dir!, 'escaped'))).toBe(false)
    const tilde = await createAgent({ name: 'Tilde', directory: '~/../x' })
    expect(tilde.status).toBe(400)
    expect(tilde.json.error).toBe('directory must be an absolute path')
    expect(existsSync(join(dir!, 'x'))).toBe(false)
  })

  it('PATCH nodeBaseUrl does not fill an empty stored URL', async () => {
    await start()
    const created = await createAgent({ name: 'Bare' })
    expect(created.json.agent?.nodeBaseUrl).toBe('')
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBaseUrl: 'https://192.0.2.20:5174' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agent: AgentPreset }).agent.nodeBaseUrl).toBe('')
  })

  it('GET ?node= filters', async () => {
    await start()
    writeFileSync(
      join(dir!, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'local-1',
            name: 'Local',
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: '',
            node: 'ct115',
            directory: join(dir!, 'agents', 'local'),
            sharedLink: true,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'remote-1',
            name: 'Remote',
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: '',
            node: 'ct114',
            directory: join(dir!, 'agents', 'remote'),
            sharedLink: true,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      }),
    )
    const filtered = (await (await fetch(`${base}/api/agents?node=ct114`)).json()) as {
      agents: AgentPreset[]
    }
    expect(filtered.agents.map((agent) => agent.name)).toEqual(['Remote'])
    const local = (await (await fetch(`${base}/api/agents?node=ct115`)).json()) as {
      agents: AgentPreset[]
    }
    expect(local.agents.map((agent) => agent.name)).toEqual(['Local'])
  })

  it('refuses directory and sharedLink edits for a foreign preset and still edits other fields', async () => {
    let expanded = false
    await start({
      homeDir: () => {
        expanded = true
        return join(dir!, 'home')
      },
    })
    const remoteDir = join(dir!, 'remote-dir')
    mkdirSync(remoteDir)
    symlinkSync(join(dir!, 'shared'), join(remoteDir, 'rivet-shared'))
    writeFileSync(
      join(dir!, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'foreign-1',
            name: 'Remote',
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: '',
            node: 'ct114',
            directory: remoteDir,
            sharedLink: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )
    const denied = await fetch(`${base}/api/agents/foreign-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '~/stolen', sharedLink: false, name: 'Nope' }),
    })
    expect(denied.status).toBe(409)
    expect(((await denied.json()) as { error: string }).error).toBe(
      'agent "Remote" is hosted on ct114',
    )
    expect(expanded).toBe(false)
    expect(readlinkSync(join(remoteDir, 'rivet-shared'))).toBe(join(dir!, 'shared'))
    expect(existsSync(join(dir!, 'home', 'stolen'))).toBe(false)

    const renamed = await fetch(`${base}/api/agents/foreign-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', model: 'opus' }),
    })
    expect(renamed.status).toBe(200)
    const agent = ((await renamed.json()) as { agent: AgentPreset }).agent
    expect(agent).toMatchObject({
      name: 'Renamed',
      model: 'opus',
      directory: remoteDir,
      node: 'ct114',
    })
    expect(readlinkSync(join(remoteDir, 'rivet-shared'))).toBe(join(dir!, 'shared'))
  })

  it('PATCH sharedLink:false on a legacy row defaults and persists the directory', async () => {
    await start()
    writeFileSync(
      join(dir!, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'legacy-1',
            name: 'Legacy',
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: NODE,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )
    const sameNode = await fetch(`${base}/api/agents/legacy-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: 'ct115' }),
    })
    expect(sameNode.status).toBe(200)

    const res = await fetch(`${base}/api/agents/legacy-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLink: false }),
    })
    expect(res.status).toBe(200)
    const directory = join(dir!, 'agents', 'legacy')
    const agent = ((await res.json()) as { agent: AgentPreset }).agent
    expect(agent.directory).toBe(directory)
    expect(agent.sharedLink).toBe(false)
    expect(existsSync(directory)).toBe(true)
    expect(existsSync(join(directory, 'rivet-shared'))).toBe(false)
  })

  it('a duplicate POST blocked in create does not undo a link PATCH enables', async () => {
    let releaseGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let markEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let blockDuplicate = false
    await start({
      store: (root) =>
        storeOver(root, (real, input) => {
          if (blockDuplicate) {
            markEntered()
            return gate.then(() =>
              Promise.reject(new PresetConflictError('agent name already exists')),
            )
          }
          return real.create(input)
        }),
    })
    const created = await createAgent({ name: 'Alpha', sharedLink: false })
    expect(created.status).toBe(201)
    const id = created.json.agent!.id
    const directory = created.json.agent!.directory!
    const link = join(directory, 'rivet-shared')
    expect(existsSync(link)).toBe(false)
    blockDuplicate = true
    const pendingPost = createAgent({ name: 'Alpha', sharedLink: true })
    await entered
    const pendingPatch = fetch(`${base}/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLink: true }),
    })
    releaseGate()
    const again = await pendingPost
    const patched = await pendingPatch
    expect(again.status).toBe(409)
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { agent: AgentPreset }).agent.sharedLink).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))
    const got = (await (await fetch(`${base}/api/agents/${id}`)).json()) as { agent: AgentPreset }
    expect(got.agent.sharedLink).toBe(true)
  })

  it('PATCH {directory:"~/"} on a no-link preset never unlinks the home link', async () => {
    await start({
      homeDir: () => {
        const home = join(dir!, 'home')
        if (!existsSync(home)) {
          mkdirSync(home)
          symlinkSync(join(dir!, 'shared'), join(home, 'rivet-shared'))
        }
        return home
      },
    })
    const created = await createAgent({ name: 'Nolink', sharedLink: false })
    expect(created.status).toBe(201)
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '~/' }),
    })
    expect(res.status).toBe(200)
    const agent = ((await res.json()) as { agent: AgentPreset }).agent
    expect(agent.directory).toBe(join(dir!, 'home'))
    expect(agent.sharedLink).toBe(false)
    const link = join(dir!, 'home', 'rivet-shared')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(dir!, 'shared'))
  })

  it('does not unlink a relative rivet-shared when the parent directory is a symlink', async () => {
    await start()
    const otherAgent = join(dir!, 'other', 'agent')
    mkdirSync(otherAgent, { recursive: true })
    mkdirSync(join(dir!, 'other', 'shared'))
    const alias = join(dir!, 'alias')
    symlinkSync(otherAgent, alias)
    // Lexical resolve(alias, '../shared') is the configured shared dir.
    // The real target is other/shared, so the link must stay.
    symlinkSync('../shared', join(alias, 'rivet-shared'))
    const created = await createAgent({ name: 'Alias', directory: alias, sharedLink: true })
    expect(created.status).toBe(201)
    const link = join(alias, 'rivet-shared')
    expect(readlinkSync(link)).toBe('../shared')
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLink: false }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { agent: AgentPreset }).agent.sharedLink).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe('../shared')
  })

  it('unlinks a symlinked-parent link whose real target is sharedDir', async () => {
    await start()
    const otherAgent = join(dir!, 'other', 'agent')
    mkdirSync(otherAgent, { recursive: true })
    const alias = join(dir!, 'alias')
    symlinkSync(otherAgent, alias)
    symlinkSync('../../shared', join(alias, 'rivet-shared'))
    const created = await createAgent({ name: 'Alias', directory: alias, sharedLink: true })
    expect(created.status).toBe(201)
    const link = join(alias, 'rivet-shared')
    const res = await fetch(`${base}/api/agents/${created.json.agent!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedLink: false }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(link)).toBe(false)
  })

  it('round-trips an unchanged directory and sharedLink on a foreign preset', async () => {
    let expanded = false
    await start({
      homeDir: () => {
        expanded = true
        return join(dir!, 'home')
      },
    })
    const remoteDir = join(dir!, 'remote-dir')
    mkdirSync(remoteDir)
    symlinkSync(join(dir!, 'shared'), join(remoteDir, 'rivet-shared'))
    writeFileSync(
      join(dir!, 'agents.json'),
      JSON.stringify({
        agents: [
          {
            id: 'foreign-2',
            name: 'Remote',
            color: '',
            model: '',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: '',
            node: 'ct114',
            directory: remoteDir,
            sharedLink: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )
    const res = await fetch(`${base}/api/agents/foreign-2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: remoteDir,
        sharedLink: true,
        name: 'Renamed',
        model: 'opus',
      }),
    })
    expect(res.status).toBe(200)
    expect(expanded).toBe(false)
    const agent = ((await res.json()) as { agent: AgentPreset }).agent
    expect(agent).toMatchObject({
      name: 'Renamed',
      model: 'opus',
      directory: remoteDir,
      sharedLink: true,
      node: 'ct114',
    })
    expect(readlinkSync(join(remoteDir, 'rivet-shared'))).toBe(join(dir!, 'shared'))
  })

  it('a rejected POST does not remove a directory another preset now owns', async () => {
    await start({
      store: (root) =>
        storeOver(root, async (real, input) => {
          if (input.name === 'Loser') {
            await real.create({
              name: 'Keeper',
              node: 'ct115',
              directory: input.directory,
              sharedLink: false,
              createdAt: 1,
            })
            throw new Error('injected')
          }
          return real.create(input)
        }),
    })
    const directory = join(dir!, 'custom')
    const res = await createAgent({ name: 'Loser', directory, sharedLink: false })
    expect(res.status).toBe(503)
    expect(existsSync(directory)).toBe(true)
    const listed = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentPreset[] }
    expect(listed.agents.map((agent) => agent.name)).toEqual(['Keeper'])
    expect(listed.agents[0]?.directory).toBe(directory)
  })

  it('two POSTs with different names and one directory keep the accepted preset', async () => {
    await start({
      store: (root) =>
        storeOver(root, (real, input) => {
          if (input.name === 'Loser') return Promise.reject(new Error('injected'))
          return real.create(input)
        }),
    })
    const directory = join(dir!, 'custom')
    const [keeper, loser] = await Promise.all([
      createAgent({ name: 'Keeper', directory, sharedLink: true }),
      createAgent({ name: 'Loser', directory, sharedLink: true }),
    ])
    expect([keeper.status, loser.status].sort()).toEqual([201, 503])
    expect(existsSync(directory)).toBe(true)
    expect(readlinkSync(join(directory, 'rivet-shared'))).toBe(join(dir!, 'shared'))
    const listed = (await (await fetch(`${base}/api/agents`)).json()) as { agents: AgentPreset[] }
    expect(listed.agents.map((agent) => agent.name)).toEqual(['Keeper'])
  })
})
