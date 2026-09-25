import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileAgentPresetStore } from './file-store.js'
import { PresetConflictError, type AgentPresetInput } from './store.js'
import {
  describePresetStoreContract,
  type RawPresetSeed,
  type StoredPreset,
} from './test/store-contract.test-helper.js'
import { isRecord } from './validate.js'

function legacyAgent(row: RawPresetSeed): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    color: row.color ?? '',
    model: row.model,
    effort: row.effort ?? 'medium',
    systemPrompt: row.systemPrompt ?? '',
    nodeBaseUrl: row.nodeBaseUrl ?? '',
    createdAt: row.createdAt ?? 1,
    updatedAt: row.updatedAt ?? 1,
    node: row.node,
    directory: row.directory,
    sharedLink: row.sharedLink ?? true,
  }
  if (row.harnessId !== null) agent.harnessId = row.harnessId
  return agent
}

function readContractRow(file: string, id: string): StoredPreset | undefined {
  if (!existsSync(file)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) return undefined
  const row = parsed.agents.find((agent) => isRecord(agent) && agent.id === id)
  if (!isRecord(row) || typeof row.name !== 'string' || typeof row.model !== 'string') {
    return undefined
  }
  return {
    name: row.name,
    model: row.model,
    harnessId: typeof row.harnessId === 'string' ? row.harnessId : null,
    sharedLink: typeof row.sharedLink === 'boolean' ? row.sharedLink : true,
  }
}

function input(overrides: Partial<AgentPresetInput> = {}): AgentPresetInput {
  return {
    name: 'Reviewer',
    node: 'ct115',
    directory: '/tmp/agents/reviewer',
    ...overrides,
  }
}

describe('FileAgentPresetStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-registry-file-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function store(now?: () => number): FileAgentPresetStore {
    return new FileAgentPresetStore(join(dir, 'agents.json'), now ? { now } : undefined)
  }

  it('quarantines a file that is not JSON and still accepts writes', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, '{not json')
    const registry = new FileAgentPresetStore(file)
    expect(await registry.list()).toEqual([])
    const leftovers = readdirSync(dir).filter((name) => name.startsWith('agents.json.corrupt-'))
    expect(leftovers).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(join(dir, leftovers[0] ?? ''), 'utf8')).toBe('{not json')

    const created = await registry.create(input({ name: 'Recovered' }))
    expect(created.name).toBe('Recovered')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(join(dir, leftovers[0] ?? ''), 'utf8')).toBe('{not json')
  })

  it('quarantines a JSON file whose agents field is not an array', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: { nope: true } }))
    const registry = new FileAgentPresetStore(file)
    expect(await registry.list()).toEqual([])
    expect(readdirSync(dir).some((name) => name.startsWith('agents.json.corrupt-'))).toBe(true)
  })

  it('serializes concurrent updates so both field writes land', async () => {
    const registry = store()
    const created = await registry.create(input({ name: 'Orig', color: '#111111' }))
    const [a, b] = await Promise.all([
      registry.update(created.id, { name: 'FromA' }),
      registry.update(created.id, { color: '#abcdef' }),
    ])
    expect(a?.id).toBe(created.id)
    expect(b?.id).toBe(created.id)
    const got = await registry.get(created.id)
    expect(got?.name).toBe('FromA')
    expect(got?.color).toBe('#abcdef')
  })

  it('fills create defaults and trims the name', async () => {
    const registry = store(() => 5_000)
    const created = await registry.create(input({ name: '  Reviewer  ' }))
    expect(created).toMatchObject({
      name: 'Reviewer',
      color: '',
      model: '',
      effort: 'medium',
      systemPrompt: '',
      sharedLink: true,
      nodeBaseUrl: '',
      node: 'ct115',
      directory: '/tmp/agents/reviewer',
      createdAt: 5_000,
      updatedAt: 5_000,
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(created.harnessId).toBeUndefined()
    const unlinked = await registry.create(
      input({ name: 'Solo', sharedLink: false, directory: '/tmp/agents/solo' }),
    )
    expect(unlinked.sharedLink).toBe(false)
  })

  it('resolves findByHandle as id, then exact name, then case-insensitive name', async () => {
    const registry = store()
    await registry.create(input({ id: 'beta', name: 'Alpha', directory: '/a' }))
    await registry.create(input({ id: 'id-b', name: 'beta', directory: '/b' }))
    await registry.create(input({ id: 'id-c', name: 'Gamma', directory: '/c' }))
    expect((await registry.findByHandle('beta'))?.id).toBe('beta')
    expect((await registry.findByHandle('Alpha'))?.id).toBe('beta')
    expect((await registry.findByHandle('gamma'))?.id).toBe('id-c')
    expect((await registry.findByHandle('  gamma  '))?.id).toBe('id-c')
    expect(await registry.findByHandle('missing')).toBeUndefined()
  })

  it('rejects a duplicate name on create and on rename', async () => {
    const registry = store()
    await registry.create(input({ name: 'Reviewer' }))
    await expect(registry.create(input({ name: ' reviewer ' }))).rejects.toBeInstanceOf(
      PresetConflictError,
    )
    const other = await registry.create(input({ name: 'Other', directory: '/tmp/agents/other' }))
    await expect(registry.update(other.id, { name: 'REVIEWER' })).rejects.toBeInstanceOf(
      PresetConflictError,
    )
    expect((await registry.get(other.id))?.name).toBe('Other')
  })

  it('rejects a duplicate id', async () => {
    const registry = store()
    await registry.create(input({ id: 'same', name: 'One' }))
    await expect(
      registry.create(input({ id: 'same', name: 'Two', directory: '/tmp/agents/two' })),
    ).rejects.toBeInstanceOf(PresetConflictError)
  })

  it('unsets harnessId without changing id, node, or createdAt', async () => {
    let now = 1_000
    const registry = store(() => now)
    const created = await registry.create(
      input({ harnessId: 'codex', model: 'opus', node: 'ct115' }),
    )
    now = 2_000
    const updated = await registry.update(created.id, { harnessId: null })
    expect(updated?.harnessId).toBeUndefined()
    expect(updated?.model).toBe('opus')
    expect(updated?.id).toBe(created.id)
    expect(updated?.node).toBe('ct115')
    expect(updated?.createdAt).toBe(1_000)
    expect(updated?.updatedAt).toBe(2_000)
  })

  it('drops a non-integer sortOrder and keeps the preset across the next write', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          {
            id: 'keep-me',
            name: 'Alpha',
            color: '',
            model: 'fable',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: '',
            node: 'ct115',
            directory: '/tmp/agents/alpha',
            sharedLink: true,
            createdAt: 1,
            updatedAt: 1,
            sortOrder: '1',
          },
        ],
      }),
    )
    const registry = new FileAgentPresetStore(file, { now: () => 2 })
    const loaded = await registry.list()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('keep-me')
    expect(loaded[0]?.sortOrder).toBeUndefined()
    const updated = await registry.update('keep-me', { color: '#fff' })
    expect(updated?.name).toBe('Alpha')
    expect(updated?.sortOrder).toBeUndefined()
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(isRecord(parsed) && Array.isArray(parsed.agents)).toBe(true)
    const saved = isRecord(parsed) && Array.isArray(parsed.agents) ? parsed.agents : []
    expect(saved).toHaveLength(1)
    expect(isRecord(saved[0]) && saved[0].id).toBe('keep-me')
    expect(isRecord(saved[0]) && saved[0].sortOrder).toBeUndefined()
  })

  it('loads a legacy row with no node or directory and migrates a catalog model', async () => {
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Legacy',
            color: '',
            model: 'claude',
            effort: 'medium',
            systemPrompt: '',
            nodeBaseUrl: 'http://127.0.0.1:9',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )
    const registry = new FileAgentPresetStore(file)
    const row = await registry.get('11111111-1111-4111-8111-111111111111')
    expect(row?.harnessId).toBe('claude-code')
    expect(row?.model).toBe('')
    expect(row?.node).toBeUndefined()
    expect(row?.directory).toBeUndefined()
    expect(row?.nodeBaseUrl).toBe('http://127.0.0.1:9')
  })

  it('lists by createdAt then id, filters by node, and deletes', async () => {
    const registry = store()
    await registry.create(input({ id: 'b', name: 'B', createdAt: 2, directory: '/b' }))
    await registry.create(
      input({ id: 'c', name: 'C', createdAt: 1, directory: '/c', node: 'other' }),
    )
    await registry.create(input({ id: 'a', name: 'A', createdAt: 1, directory: '/a' }))
    expect((await registry.list()).map((preset) => preset.id)).toEqual(['a', 'c', 'b'])
    expect((await registry.list({ node: 'ct115' })).map((preset) => preset.id)).toEqual(['a', 'b'])
    expect(await registry.delete('a')).toBe(true)
    expect(await registry.delete('a')).toBe(false)
    expect(await registry.get('a')).toBeUndefined()
  })

  describePresetStoreContract({
    newStore: () => new FileAgentPresetStore(join(dir, 'contract.json'), { now: () => 5_000 }),
    seedRaw: (row) => {
      writeFileSync(join(dir, 'contract.json'), JSON.stringify({ agents: [legacyAgent(row)] }))
      return Promise.resolve()
    },
    readStored: (id) => Promise.resolve(readContractRow(join(dir, 'contract.json'), id)),
  })
})
