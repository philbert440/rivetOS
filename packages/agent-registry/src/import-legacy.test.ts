import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentPreset } from '@rivetos/types'
import { createFallbackPresetStore } from './fallback-store.js'
import { FileAgentPresetStore } from './file-store.js'
import { importLegacyAgentsJson } from './import-legacy.js'
import { PresetConflictError, type AgentPresetInput, type AgentPresetStore } from './store.js'

function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  }
}

describe('importLegacyAgentsJson', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-registry-import-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports rows with a default directory and renames the file', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: [legacyRow()] }))
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    const result = await importLegacyAgentsJson({
      file,
      store: target,
      node: 'ct115',
      directoryRoot: '/home/agents',
    })
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.renamedTo).toMatch(/agents\.json\.imported-\d+$/)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(result.renamedTo ?? '')).toBe(true)
    const row = await target.get('11111111-1111-4111-8111-111111111111')
    expect(row).toMatchObject({
      node: 'ct115',
      directory: '/home/agents/reviewer',
      createdAt: 10,
      name: 'Reviewer',
    })
    expect(row?.updatedAt).not.toBe(10)
    expect(result.rows).toHaveLength(1)
    expect(result.rows?.[0]?.directory).toBe('/home/agents/reviewer')
  })

  it('skips a conflicting id and still renames the file', async () => {
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    await target.create({
      id: 'taken',
      name: 'Existing',
      node: 'n',
      directory: '/x',
      createdAt: 1,
    })
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          legacyRow({ id: 'taken', name: 'Other' }),
          legacyRow({ id: 'fresh', name: 'Newcomer' }),
        ],
      }),
    )
    const logs: string[] = []
    const result = await importLegacyAgentsJson({
      file,
      store: target,
      node: 'ct115',
      directoryRoot: '/home/agents',
      log: (message) => {
        logs.push(message)
      },
    })
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(logs.join('\n')).toMatch(/taken/)
    expect(logs.join('\n')).toMatch(/Other/)
    expect(result.renamedTo).toBeTruthy()
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(result.renamedTo ?? '', 'utf8')).toMatch(/taken/)
    expect((await target.get('taken'))?.name).toBe('Existing')
    expect((await target.get('fresh'))?.directory).toBe('/home/agents/newcomer')
  })

  it('imports a conflicting name as "<name> (<node>)" and then "<name> (<node> 2)"', async () => {
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    await target.create({ id: 'keep', name: 'Reviewer', node: 'n', directory: '/x', createdAt: 1 })
    await target.create({ id: 'keep2', name: 'Other', node: 'n', directory: '/y', createdAt: 1 })
    await target.create({
      id: 'keep3',
      name: 'Other (ct115)',
      node: 'n',
      directory: '/z',
      createdAt: 1,
    })
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          legacyRow({ id: 'other', name: ' reviewer ' }),
          legacyRow({ id: 'second', name: 'Other' }),
        ],
      }),
    )
    const logs: string[] = []
    const result = await importLegacyAgentsJson({
      file,
      store: target,
      node: 'ct115',
      directoryRoot: '/home/agents',
      log: (message) => {
        logs.push(message)
      },
    })
    expect(result).toMatchObject({ imported: 2, skipped: 0 })
    const logged = logs.join('\n')
    expect(logged).toMatch(/other/)
    expect(logged).toMatch(/name conflict/)
    expect(logged).toMatch(/reviewer \(ct115\)/)
    expect(logged).toMatch(/Other \(ct115 2\)/)
    const names = (await target.list()).map((row) => row.name).sort()
    expect(names).toEqual([
      'Other',
      // Space sorts before ')'.
      'Other (ct115 2)',
      'Other (ct115)',
      'Reviewer',
      'reviewer (ct115)',
    ])
    expect((await target.get('other'))?.name).toBe('reviewer (ct115)')
    expect((await target.get('second'))?.name).toBe('Other (ct115 2)')
    expect(result.renamedTo).toBeTruthy()
  })

  it('skips only an id conflict when postgres reports pkey vs the name index', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          legacyRow({ id: 'id-clash', name: 'Kept' }),
          legacyRow({ id: 'name-clash', name: 'Same' }),
        ],
      }),
    )
    const created: AgentPreset[] = []
    const logs: string[] = []
    const store: AgentPresetStore = {
      backend: 'postgres',
      isReady: () => Promise.resolve(true),
      list: () => Promise.resolve(created.slice()),
      get: (id) => Promise.resolve(created.find((row) => row.id === id)),
      findByHandle: () => Promise.resolve(undefined),
      create: (input: AgentPresetInput & { id?: string; createdAt?: number }) => {
        if (input.id === 'id-clash') {
          return Promise.reject(
            new PresetConflictError(
              'agent preset conflicts with an existing id or name (ros_agent_presets_pkey)',
            ),
          )
        }
        if (input.name === 'Same') {
          return Promise.reject(
            new PresetConflictError(
              'agent preset conflicts with an existing id or name (idx_ros_agent_presets_name)',
            ),
          )
        }
        const preset = {
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
        } as AgentPreset
        created.push(preset)
        return Promise.resolve(preset)
      },
      update: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(false),
    }
    const result = await importLegacyAgentsJson({
      file,
      store,
      node: 'ct115',
      directoryRoot: '/home/agents',
      log: (message) => {
        logs.push(message)
      },
    })
    expect(result).toMatchObject({ imported: 1, skipped: 1 })
    expect(created.map((row) => row.name)).toEqual(['Same (ct115)'])
    expect(created[0]?.id).toBe('name-clash')
    const logged = logs.join('\n')
    expect(logged).toMatch(/id-clash/)
    expect(logged).toMatch(/pkey/)
    expect(logged).toMatch(/idx_ros_agent_presets_name/)
    expect(logged).toMatch(/Same \(ct115\)/)
  })

  it('keeps a valid directory and falls back when one is missing or invalid', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          legacyRow({ id: 'abs', name: 'Abs', directory: '/srv/agents//abs/' }),
          legacyRow({ id: 'rel', name: 'Rel', directory: 'relative/path' }),
          legacyRow({ id: 'bad', name: 'Bad', directory: 12 }),
        ],
      }),
    )
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    const logs: string[] = []
    const result = await importLegacyAgentsJson({
      file,
      store: target,
      node: 'ct115',
      directoryRoot: '/home/agents',
      log: (message) => {
        logs.push(message)
      },
    })
    expect(result.imported).toBe(3)
    expect(result.skipped).toBe(0)
    expect((await target.get('abs'))?.directory).toBe('/srv/agents/abs')
    expect((await target.get('rel'))?.directory).toBe('/home/agents/rel')
    expect((await target.get('bad'))?.directory).toBe('/home/agents/bad')
    const logged = logs.join('\n')
    expect(logged).toMatch(/rel/i)
    expect(logged).toMatch(/bad/i)
    expect(logged).not.toMatch(/\bAbs\b/)
    expect(logged).toMatch(/missing or invalid/)
  })

  it('does not rename the source when the store file resolves to it', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: [legacyRow()] }))
    const store = new FileAgentPresetStore(`${dir}/./agents.json`)
    expect(store.file).not.toBe(file)
    expect(resolve(store.file)).toBe(resolve(file))
    const result = await importLegacyAgentsJson({
      file,
      store,
      node: 'ct115',
      directoryRoot: '/home/agents',
    })
    expect(result).toEqual({ imported: 0, skipped: 0, reason: 'store is the source file' })
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(dir).some((name) => name.includes('.imported-'))).toBe(false)
    expect(readFileSync(file, 'utf8')).toMatch(/Reviewer/)
    expect(await store.list()).toHaveLength(1)
  })

  it('returns without renamedTo when the source was quarantined', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, '{not json')
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    const result = await importLegacyAgentsJson({
      file,
      store: target,
      node: 'n',
      directoryRoot: '/home/agents',
    })
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.renamedTo).toBeUndefined()
    expect(result.reason).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect(await target.list()).toEqual([])
  })

  it('refuses a file-mode fallback wrapper whose file is the source', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: [legacyRow()] }))
    const fallback = new FileAgentPresetStore(`${dir}/./agents.json`)
    const primary: AgentPresetStore = {
      backend: 'postgres',
      isReady: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      findByHandle: () => Promise.resolve(undefined),
      create: () => Promise.reject(new Error('primary should not be written')),
      update: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(false),
    }
    const wrapper = createFallbackPresetStore({ primary, fallback, now: () => 0 })
    await wrapper.list()
    expect(wrapper.backend).toBe('file')
    expect(resolve(wrapper.file ?? '')).toBe(resolve(file))
    const result = await importLegacyAgentsJson({
      file,
      store: wrapper,
      node: 'ct115',
      directoryRoot: '/home/agents',
    })
    expect(result).toEqual({ imported: 0, skipped: 0, reason: 'store is the source file' })
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(dir).some((name) => name.includes('.imported-'))).toBe(false)
    expect(readFileSync(file, 'utf8')).toMatch(/Reviewer/)
  })

  it('imports through a wrapper once the primary file is a different path', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: [legacyRow()] }))
    const fallback = new FileAgentPresetStore(file)
    const primary = new FileAgentPresetStore(join(dir, 'target.json'))
    const wrapper = createFallbackPresetStore({ primary, fallback, now: () => 0 })
    await wrapper.list()
    expect(wrapper.backend).toBe('file')
    expect(resolve(wrapper.file ?? '')).toBe(resolve(primary.file))
    const result = await importLegacyAgentsJson({
      file,
      store: wrapper,
      node: 'ct115',
      directoryRoot: '/home/agents',
    })
    expect(result.imported).toBe(1)
    expect(result.renamedTo).toMatch(/imported-/)
    expect(existsSync(file)).toBe(false)
    expect((await primary.get('11111111-1111-4111-8111-111111111111'))?.node).toBe('ct115')
  })

  it('returns zeros when the file is absent', async () => {
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    const result = await importLegacyAgentsJson({
      file: join(dir, 'missing.json'),
      store: target,
      node: 'n',
      directoryRoot: '/home/agents',
    })
    expect(result).toEqual({ imported: 0, skipped: 0 })
    expect(await target.list()).toEqual([])
  })
})
