import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDenServer, type DenServer } from './server.js'
import { createMeshView, loadMeshFile, meshFilePaths, type MeshOverview } from './mesh.js'
import { loadConfig, type DenConfig } from './config.js'

const servers: DenServer[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'den-mesh-'))
  dirs.push(dir)
  return dir
}

async function start(overrides: Partial<DenConfig> = {}): Promise<{ den: DenServer; base: string }> {
  const stateDir = tmp()
  const config: DenConfig = {
    port: 0,
    host: '127.0.0.1',
    token: '',
    tls: { certPath: '', keyPath: '', caPath: '', requireClientCert: true },
    stateDir,
    staticDir: '',
    packsDir: '',
    evictTtlMs: 60_000,
    meshFile: '',
    meshCacheMs: 10_000,
    term: {
      enabled: false,
      open: false,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
    },
    audio: {
      enabled: false,
      open: false,
      dir: '',
      deviceName: 'RivetHub Mic',
      sampleRate: 16_000,
    },
    ...overrides,
  }
  const den = createDenServer(config)
  servers.push(den)
  await new Promise<void>((r) => den.server.listen(0, '127.0.0.1', r))
  const port = (den.server.address() as AddressInfo).port
  return { den, base: `http://127.0.0.1:${port}` }
}

const EV = { v: 1, session: 's1', name: 'alpha', ts: 100, type: 'session.start', title: 'hello' }

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

// mesh.json roster entry — 192.0.2.x (TEST-NET) hosts, agent-channel port 3000
// (the den must never probe that port)
const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  host: '192.0.2.10',
  port: 3000,
  agents: [],
  providers: [],
  capabilities: [],
  status: 'online',
  lastSeen: 0,
  ...extra,
})

const writeMesh = (file: string, nodes: Record<string, unknown>, updatedAt = 1234): void =>
  writeFileSync(file, JSON.stringify({ version: 1, updatedAt, nodes }))

describe('mesh view', () => {
  it('projects den-enabled nodes and probes each den /healthz', async () => {
    const { base: peerBase } = await start() // real peer for the online case
    await post(peerBase, '/event', EV)

    const file = join(tmp(), 'mesh.json')
    writeMesh(file, {
      plain: node('plain'), // no den tag → excluded
      peer: node('peer', { metadata: { denUrl: peerBase } }),
      dark: node('dark', { host: '192.0.2.1', capabilities: ['den'] }), // unreachable
    })
    const view = createMeshView({ meshFile: file, cacheMs: 10_000, probeTimeoutMs: 300 })
    const overview = (await view.overview()) as MeshOverview
    expect(overview.updatedAt).toBe(1234)
    const byId = Object.fromEntries(overview.nodes.map((n) => [n.id, n]))
    expect(Object.keys(byId).sort()).toEqual(['dark', 'peer'])
    expect(byId.peer).toMatchObject({ online: true, sessions: 1, denUrl: peerBase })
    // capabilities-only node: default den port 5174, NOT the agent port
    expect(byId.dark).toMatchObject({
      online: false,
      sessions: null,
      denUrl: 'http://192.0.2.1:5174',
    })
  })

  it('attaches latest only to the local node', async () => {
    const file = join(tmp(), 'mesh.json')
    writeMesh(file, {
      me: node('me', { metadata: { denPort: 5999 } }),
      other: node('other', { metadata: { denPort: 5998 } }),
    })
    const view = createMeshView({
      meshFile: file,
      cacheMs: 10_000,
      probeTimeoutMs: 100,
      localNodeId: 'me',
      getLocalLatest: () => ({ activity: 'coding', title: 'hello' }),
    })
    const overview = (await view.overview()) as MeshOverview
    const me = overview.nodes.find((n) => n.id === 'me')!
    const other = overview.nodes.find((n) => n.id === 'other')!
    expect(me.latest).toEqual({ activity: 'coding', title: 'hello' })
    expect('latest' in other).toBe(false)
    expect(me.denUrl).toBe('http://192.0.2.10:5999') // metadata.denPort drives the URL
  })

  it('caches the overview for cacheMs, then refreshes', async () => {
    const { base: peerBase } = await start() // instant probes keep timing crisp
    const file = join(tmp(), 'mesh.json')
    writeMesh(file, { a: node('a', { metadata: { denUrl: peerBase } }) }, 1)
    const view = createMeshView({ meshFile: file, cacheMs: 150, probeTimeoutMs: 300 })
    expect(((await view.overview()) as MeshOverview).updatedAt).toBe(1)
    writeMesh(file, { a: node('a', { metadata: { denUrl: peerBase } }) }, 2)
    expect(((await view.overview()) as MeshOverview).updatedAt).toBe(1) // inside TTL — cached
    await new Promise((r) => setTimeout(r, 200))
    expect(((await view.overview()) as MeshOverview).updatedAt).toBe(2) // TTL expired — re-read
  })

  it('reads mesh.json candidates in order, first readable wins', async () => {
    const dir = tmp()
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writeMesh(b, {}, 22)
    expect((await loadMeshFile([a, b]))?.updatedAt).toBe(22) // a missing → falls back to b
    writeMesh(a, {}, 11)
    expect((await loadMeshFile([a, b]))?.updatedAt).toBe(11) // a wins once present
    expect(await loadMeshFile([join(dir, 'nope.json')])).toBeNull()
  })

  it('ignores metadata.denUrl entries that are not http(s)', async () => {
    const file = join(tmp(), 'mesh.json')
    writeMesh(file, {
      evil: node('evil', { metadata: { denUrl: 'ftp://192.0.2.9/pub' } }),
      junk: node('junk', { metadata: { denUrl: 'not a url' } }),
    })
    const view = createMeshView({ meshFile: file, cacheMs: 10_000, probeTimeoutMs: 100 })
    expect(((await view.overview()) as MeshOverview).nodes).toEqual([])
  })

  it('serves GET /mesh.json behind the auth gate', async () => {
    const { base: peerBase } = await start()
    await post(peerBase, '/event', EV)
    const file = join(tmp(), 'mesh.json')
    writeMesh(file, { peer: node('peer', { metadata: { denUrl: peerBase } }) })

    const { base } = await start({ meshFile: file })
    // loopback — mTLS not required; API serves the mesh file
    const res = await fetch(`${base}/mesh.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeshOverview
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({ id: 'peer', online: true, sessions: 1 })

    const noMesh = await start({ meshFile: join(tmp(), 'missing.json') })
    expect((await fetch(`${noMesh.base}/mesh.json`)).status).toBe(404)
  })

  it('preflights DELETE for cross-origin session removal', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/session?session=x`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE')
  })

  it('throws on pre-capabilities flat-array mesh.json', async () => {
    const file = join(tmp(), 'mesh.json')
    writeFileSync(
      file,
      JSON.stringify({
        nodes: [{ name: 'legacy-node', ip: '192.0.2.1' }],
        updatedAt: 99,
      }),
    )
    await expect(loadMeshFile([file])).rejects.toThrow(/pre-capabilities flat-array/)
  })

  it('skips a malformed node and still returns the rest of the roster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const file = join(tmp(), 'mesh.json')
      writeMesh(file, {
        good: node('good'),
        bad: { host: 'h', port: '3100' },
      })
      const mesh = await loadMeshFile([file])
      expect(mesh).not.toBeNull()
      expect(Object.keys(mesh!.nodes)).toEqual(['good'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/"bad"/)
    } finally {
      warn.mockRestore()
    }
  })

  it('GET /mesh.json 500 names mesh.json on a root-level parse failure', async () => {
    const file = join(tmp(), 'mesh.json')
    writeFileSync(
      file,
      JSON.stringify({
        nodes: [{ name: 'legacy-node', ip: '192.0.2.1' }],
        updatedAt: 99,
      }),
    )
    const { base } = await start({ meshFile: file })
    const res = await fetch(`${base}/mesh.json`)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: string; code?: string }
    expect(body.error).toMatch(/mesh\.json/)
    expect(body.code).toBe('MESH_FLAT_ARRAY')
  })

  it('GET /mesh.json still serves when one node is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const file = join(tmp(), 'mesh.json')
      writeMesh(file, {
        good: node('good'),
        bad: { host: 'h', port: '3100' },
      })
      const { base } = await start({ meshFile: file })
      const res = await fetch(`${base}/mesh.json`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as MeshOverview
      expect(body.updatedAt).toBe(1234)
      expect(body.nodes).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

describe('meshFilePaths', () => {
  const ORIGINAL = process.env.RIVETOS_SHARED_DIR
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RIVETOS_SHARED_DIR
    else process.env.RIVETOS_SHARED_DIR = ORIGINAL
  })

  it('pins the literal default under a cleared env', () => {
    delete process.env.RIVETOS_SHARED_DIR
    expect(meshFilePaths('')).toEqual([
      '/rivet-shared/mesh.json',
      join(homedir(), '.rivetos', 'mesh.json'),
    ])
    expect(meshFilePaths('/x/mesh.json')).toEqual(['/x/mesh.json'])
  })

  it('honors loadConfig passed env, not process.env', () => {
    process.env.RIVETOS_SHARED_DIR = '/process/shared'
    const cfg = loadConfig({ RIVETOS_SHARED_DIR: '/gateway/shared' } as NodeJS.ProcessEnv)
    expect(meshFilePaths(cfg.meshFile, cfg.sharedRoot)).toEqual([
      '/gateway/shared/mesh.json',
      join(homedir(), '.rivetos', 'mesh.json'),
    ])
    const overridden = loadConfig({
      RIVETOS_SHARED_DIR: '/gateway/shared',
      RIVETOS_DEN_MESH_FILE: '/x/mesh.json',
    } as NodeJS.ProcessEnv)
    expect(meshFilePaths(overridden.meshFile, overridden.sharedRoot)).toEqual(['/x/mesh.json'])
  })
})
