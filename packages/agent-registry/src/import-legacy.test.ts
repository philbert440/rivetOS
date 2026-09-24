import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileAgentPresetStore } from './file-store.js'
import { importLegacyAgentsJson } from './import-legacy.js'

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

  it('skips a conflicting name', async () => {
    const target = new FileAgentPresetStore(join(dir, 'target.json'))
    await target.create({ id: 'keep', name: 'Reviewer', node: 'n', directory: '/x', createdAt: 1 })
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({ agents: [legacyRow({ id: 'other', name: ' reviewer ' })] }),
    )
    const logs: string[] = []
    const result = await importLegacyAgentsJson({
      file,
      store: target,
      node: 'n',
      directoryRoot: '/home/agents',
      log: (message) => {
        logs.push(message)
      },
    })
    expect(result).toMatchObject({ imported: 0, skipped: 1 })
    expect(logs.join('\n')).toMatch(/other/)
    expect(logs.join('\n')).toMatch(/reviewer/i)
    expect(await target.list()).toHaveLength(1)
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
