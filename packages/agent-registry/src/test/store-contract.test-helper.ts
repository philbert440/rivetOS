/**
 * Shared preset-store cases. Not a test file itself: both store suites call
 * `describePresetStoreContract`. It stays in this tsconfig so lint can typecheck
 * it; it is not exported from the package entry.
 */

import { describe, expect, it } from 'vitest'
import type { AgentPresetStore } from '../store.js'

export interface RawPresetSeed {
  id: string
  name: string
  model: string
  harnessId: string | null
  node: string
  directory: string
  sharedLink?: boolean
  color?: string
  effort?: string
  systemPrompt?: string
  nodeBaseUrl?: string
  createdAt?: number
  updatedAt?: number
}

export interface StoredPreset {
  name: string
  model: string
  harnessId: string | null
  sharedLink: boolean
}

export interface PresetStoreContract {
  newStore: () => AgentPresetStore
  /** Insert a row that has not been through `migrateAgentPreset`. */
  seedRaw: (row: RawPresetSeed) => Promise<void>
  /** What is actually persisted, not the migrated read view. */
  readStored: (id: string) => Promise<StoredPreset | undefined>
}

function legacySeed(overrides: Partial<RawPresetSeed> & Pick<RawPresetSeed, 'id'>): RawPresetSeed {
  return {
    name: 'Legacy',
    model: 'claude',
    harnessId: null,
    node: 'ct115',
    directory: '/tmp/agents/legacy',
    sharedLink: true,
    ...overrides,
  }
}

export function describePresetStoreContract(contract: PresetStoreContract): void {
  describe('shared preset-store contract', () => {
    it('create with a catalog model migrates onto harnessId', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Catalog',
        node: 'ct115',
        directory: '/tmp/agents/catalog',
        model: 'claude',
      })
      expect(created).toMatchObject({ harnessId: 'claude-code', model: '' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'claude-code',
        model: '',
      })
    })

    it('reads a legacy catalog row without rewriting it', async () => {
      const id = 'legacy-read'
      await contract.seedRaw(legacySeed({ id }))
      expect(await contract.readStored(id)).toMatchObject({
        model: 'claude',
        harnessId: null,
      })
      const store = contract.newStore()
      const row = await store.get(id)
      expect(row).toMatchObject({ harnessId: 'claude-code', model: '' })
      expect(await contract.readStored(id)).toMatchObject({
        model: 'claude',
        harnessId: null,
      })
    })

    it('model-only patch on a legacy catalog row keeps the migrated harness', async () => {
      const id = 'legacy-patch'
      await contract.seedRaw(legacySeed({ id, name: 'LegacyPatch' }))
      const updated = await contract.newStore().update(id, { model: 'opus' })
      expect(updated).toMatchObject({ harnessId: 'claude-code', model: 'opus' })
      expect(await contract.readStored(id)).toMatchObject({
        harnessId: 'claude-code',
        model: 'opus',
      })
    })

    it('model patch to a catalog id on a harness-less row migrates the new model', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Plain',
        node: 'ct115',
        directory: '/tmp/agents/plain',
        model: 'gpt-4',
      })
      expect(created.harnessId).toBeUndefined()
      const updated = await store.update(created.id, { model: 'claude' })
      expect(updated).toMatchObject({ harnessId: 'claude-code', model: '' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'claude-code',
        model: '',
      })
    })

    it('model patch to a canonical harness id on a harness-less row migrates', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Canonical',
        node: 'ct115',
        directory: '/tmp/agents/canonical',
        model: 'gpt-4',
      })
      const updated = await store.update(created.id, { model: 'codex' })
      expect(updated).toMatchObject({ harnessId: 'codex', model: '' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'codex',
        model: '',
      })
    })

    it('model patch on a row with a harness keeps the harness and the model verbatim', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Kept',
        node: 'ct115',
        directory: '/tmp/agents/kept',
        harnessId: 'codex',
        model: 'opus',
      })
      const updated = await store.update(created.id, { model: 'claude' })
      expect(updated).toMatchObject({ harnessId: 'codex', model: 'claude' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'codex',
        model: 'claude',
      })
    })

    it('harnessId null with a catalog model already in model migrates that model', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'ClearCatalog',
        node: 'ct115',
        directory: '/tmp/agents/clear-catalog',
        harnessId: 'codex',
        model: 'claude',
      })
      expect(created).toMatchObject({ harnessId: 'codex', model: 'claude' })
      const updated = await store.update(created.id, { harnessId: null })
      expect(updated).toMatchObject({ harnessId: 'claude-code', model: '' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'claude-code',
        model: '',
      })
    })

    it("harnessId null together with model 'kimi' migrates the patch", async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Swap',
        node: 'ct115',
        directory: '/tmp/agents/swap',
        harnessId: 'codex',
        model: 'opus',
      })
      const updated = await store.update(created.id, { harnessId: null, model: 'kimi' })
      expect(updated).toMatchObject({ harnessId: 'kimi-code', model: '' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'kimi-code',
        model: '',
      })
    })

    it('harnessId codex together with a catalog model does not migrate', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Explicit',
        node: 'ct115',
        directory: '/tmp/agents/explicit',
        harnessId: 'grok-build',
        model: 'real-model',
      })
      const updated = await store.update(created.id, { harnessId: 'codex', model: 'claude' })
      expect(updated).toMatchObject({ harnessId: 'codex', model: 'claude' })
      expect(await contract.readStored(created.id)).toMatchObject({
        harnessId: 'codex',
        model: 'claude',
      })
    })

    it('persists sharedLink false', async () => {
      const store = contract.newStore()
      const created = await store.create({
        name: 'Solo',
        node: 'ct115',
        directory: '/tmp/agents/solo',
        sharedLink: false,
      })
      expect(created.sharedLink).toBe(false)
      expect((await store.get(created.id))?.sharedLink).toBe(false)
      expect(await contract.readStored(created.id)).toMatchObject({ sharedLink: false })
    })

    it('rejects an empty or whitespace name', async () => {
      const store = contract.newStore()
      const base = { node: 'ct115', directory: '/tmp/agents/named' }
      await expect(store.create({ ...base, name: '' })).rejects.toThrow('agent name is required')
      await expect(store.create({ ...base, name: '   ' })).rejects.toThrow('agent name is required')
      await expect(store.create({ ...base, name: '\t' })).rejects.toThrow('agent name is required')
      const created = await store.create({ ...base, name: 'Named' })
      await expect(store.update(created.id, { name: '' })).rejects.toThrow('agent name is required')
      await expect(store.update(created.id, { name: ' \n ' })).rejects.toThrow(
        'agent name is required',
      )
      expect((await store.get(created.id))?.name).toBe('Named')
      expect(await contract.readStored(created.id)).toMatchObject({ name: 'Named' })
    })
  })
}
