import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPreset, HarnessId } from '@rivetos/types'
import {
  FileAgentPresetStore,
  createFallbackPresetStore,
  type AgentPresetInput,
  type AgentPresetStore,
} from '@rivetos/agent-registry'
import { createAgentsRoutes, importAndMaterializeLegacyAgents } from './agents.js'

function legacyRow(): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Reviewer',
    color: '',
    model: 'opus',
    effort: 'medium',
    systemPrompt: '',
    nodeBaseUrl: 'http://127.0.0.1:9',
    createdAt: 10,
    updatedAt: 10,
  }
}

function memoryPrimary(): AgentPresetStore & { rows: AgentPreset[]; checks: number } {
  const rows: AgentPreset[] = []
  let checks = 0
  return {
    rows,
    backend: 'postgres',
    get checks() {
      return checks
    },
    isReady() {
      return Promise.reject(new Error('isReady is injected by the test'))
    },
    list(filter?: { node?: string }) {
      const matched =
        filter?.node === undefined ? rows : rows.filter((row) => row.node === filter.node)
      return Promise.resolve(matched.slice())
    },
    get(id) {
      return Promise.resolve(rows.find((row) => row.id === id))
    },
    findByHandle() {
      return Promise.resolve(undefined)
    },
    create(input: AgentPresetInput & { id?: string; createdAt?: number }) {
      const preset: AgentPreset = {
        id: input.id ?? 'generated',
        name: input.name,
        color: input.color ?? '',
        model: input.model ?? '',
        effort: input.effort ?? 'medium',
        systemPrompt: input.systemPrompt ?? '',
        node: input.node,
        directory: input.directory,
        sharedLink: input.sharedLink ?? true,
        nodeBaseUrl: input.nodeBaseUrl ?? '',
        createdAt: input.createdAt ?? 1,
        updatedAt: 2,
        ...(input.harnessId ? { harnessId: input.harnessId as HarnessId } : {}),
      }
      rows.push(preset)
      return Promise.resolve(preset)
    },
    update() {
      return Promise.resolve(undefined)
    },
    delete() {
      return Promise.resolve(false)
    },
  }
}

describe('agents routes with a fallback store', () => {
  const dirs: string[] = []
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
      ),
    )
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  it('answers from the file store, then the primary, and imports the legacy file once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-agents-fallback-'))
    dirs.push(dir)
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: [legacyRow()] }))
    const directoryRoot = join(dir, 'agents')
    const sharedDir = join(dir, 'shared')
    let ready = false
    let clock = 0
    let probes = 0
    const primary = memoryPrimary()
    primary.isReady = () => {
      probes += 1
      return Promise.resolve(ready)
    }
    const fileStore = new FileAgentPresetStore(file)
    const wrapper = createFallbackPresetStore({
      primary,
      fallback: fileStore,
      recheckMs: 1_000,
      now: () => clock,
    })
    let pending = Promise.resolve()
    wrapper.onPrimaryReady(() => {
      pending = importAndMaterializeLegacyAgents({
        file,
        store: primary,
        nodeName: 'ct115',
        directoryRoot,
        sharedDir,
      }).then(() => undefined)
    })

    const routes = createAgentsRoutes({
      store: wrapper,
      nodeName: 'ct115',
      directoryRoot,
      sharedDir,
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      void routes.handle(req, res, url).then((hit) => {
        if (!hit) {
          res.writeHead(404)
          res.end()
        }
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const first = (await (await fetch(`${base}/api/agents`)).json()) as {
      agents: AgentPreset[]
      backend: string
    }
    expect(first.backend).toBe('file')
    expect(first.agents.map((agent) => agent.name)).toEqual(['Reviewer'])
    expect(existsSync(file)).toBe(true)
    expect(primary.rows).toHaveLength(0)

    ready = true
    const stillFile = (await (await fetch(`${base}/api/agents`)).json()) as { backend: string }
    expect(stillFile.backend).toBe('file')
    expect(probes).toBe(1)

    clock = 1_000
    const switching = (await (await fetch(`${base}/api/agents`)).json()) as { backend: string }
    expect(switching.backend).toBe('postgres')
    await pending
    const importedDir = join(directoryRoot, 'reviewer')
    expect(existsSync(importedDir)).toBe(true)
    expect(lstatSync(join(importedDir, 'rivet-shared')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(importedDir, 'rivet-shared'))).toBe(sharedDir)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).filter((name) => name.includes('.imported-'))).toHaveLength(1)
    expect(primary.rows).toHaveLength(1)
    expect(primary.rows[0]).toMatchObject({
      node: 'ct115',
      directory: importedDir,
      name: 'Reviewer',
    })

    const second = (await (await fetch(`${base}/api/agents`)).json()) as {
      agents: AgentPreset[]
      backend: string
    }
    expect(second.backend).toBe('postgres')
    expect(second.agents).toHaveLength(1)
    expect(second.agents[0]?.directory).toBe(importedDir)

    clock += 5_000
    await fetch(`${base}/api/agents`)
    expect(primary.rows).toHaveLength(1)
    expect(readdirSync(dir).filter((name) => name.includes('.imported-'))).toHaveLength(1)
  })

  it('materializes a pre-existing primary row even when the import inserts nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-agents-preexisting-'))
    dirs.push(dir)
    const directory = join(dir, 'agents', 'already')
    const elsewhere = join(dir, 'agents', 'other-node')
    const sharedDir = join(dir, 'shared')
    mkdirSync(sharedDir)
    const primary = memoryPrimary()
    primary.rows.push(
      {
        id: 'pre-existing',
        name: 'Already',
        color: '',
        model: '',
        effort: 'medium',
        systemPrompt: '',
        node: 'ct115',
        directory,
        sharedLink: true,
        nodeBaseUrl: '',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'other-node',
        name: 'Other',
        color: '',
        model: '',
        effort: 'medium',
        systemPrompt: '',
        node: 'ct114',
        directory: elsewhere,
        sharedLink: true,
        nodeBaseUrl: '',
        createdAt: 2,
        updatedAt: 2,
      },
    )
    const result = await importAndMaterializeLegacyAgents({
      file: join(dir, 'agents.json'),
      store: primary,
      nodeName: 'ct115',
      directoryRoot: join(dir, 'agents'),
      sharedDir,
    })
    expect(result).toEqual({ imported: 0, skipped: 0, renamed: 0 })
    expect(existsSync(directory)).toBe(true)
    expect(readlinkSync(join(directory, 'rivet-shared'))).toBe(sharedDir)
    expect(existsSync(elsewhere)).toBe(false)
  })
})
