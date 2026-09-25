/**
 * Shared preset-store cases. Not a suite of its own: both store test files call
 * `describePresetStoreContract`. It lives under `src/test` so this package's
 * tsconfig compiles it (lint and typecheck see it) and vitest does not load it
 * as its own file. It is not exported from the package entry.
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

function canonicalSeed(
  overrides: Partial<RawPresetSeed> & Pick<RawPresetSeed, 'id'>,
): RawPresetSeed {
  return {
    name: 'Canonical',
    model: 'claude',
    harnessId: 'codex',
    node: 'ct115',
    directory: '/tmp/agents/canonical-row',
    sharedLink: true,
    ...overrides,
  }
}

function expectStored(contract: PresetStoreContract, id: string, row: StoredPreset): Promise<void> {
  return contract.readStored(id).then((stored) => {
    expect(stored).toEqual(row)
  })
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

    it('harnessId null on a raw legacy catalog row clears harness and model', async () => {
      const id = 'legacy-clear-harness'
      await contract.seedRaw(legacySeed({ id, name: 'LegacyClear' }))
      const updated = await contract.newStore().update(id, { harnessId: null })
      expect(updated?.harnessId).toBeUndefined()
      expect(updated?.model).toBe('')
      await expectStored(contract, id, {
        name: 'LegacyClear',
        model: '',
        harnessId: null,
        sharedLink: true,
      })
    })

    it('harness-only patch on a raw legacy catalog row stores an empty model', async () => {
      const id = 'legacy-set-harness'
      await contract.seedRaw(legacySeed({ id, name: 'LegacyHarness' }))
      const updated = await contract.newStore().update(id, { harnessId: 'codex' })
      expect(updated).toMatchObject({ harnessId: 'codex', model: '' })
      await expectStored(contract, id, {
        name: 'LegacyHarness',
        model: '',
        harnessId: 'codex',
        sharedLink: true,
      })
    })

    it('harnessId null on a raw canonical row migrates the stored model', async () => {
      const id = 'canonical-clear-harness'
      await contract.seedRaw(canonicalSeed({ id, name: 'CanonicalClear' }))
      const updated = await contract.newStore().update(id, { harnessId: null })
      expect(updated).toMatchObject({ harnessId: 'claude-code', model: '' })
      await expectStored(contract, id, {
        name: 'CanonicalClear',
        model: '',
        harnessId: 'claude-code',
        sharedLink: true,
      })
    })

    it('harness-only codex patch on a raw canonical row keeps the stored model', async () => {
      const id = 'canonical-set-harness'
      await contract.seedRaw(canonicalSeed({ id, name: 'CanonicalHarness' }))
      const updated = await contract.newStore().update(id, { harnessId: 'codex' })
      expect(updated).toMatchObject({ harnessId: 'codex', model: 'claude' })
      await expectStored(contract, id, {
        name: 'CanonicalHarness',
        model: 'claude',
        harnessId: 'codex',
        sharedLink: true,
      })
    })

    it('model-only patch on a raw canonical row keeps the harness', async () => {
      const id = 'canonical-model'
      await contract.seedRaw(canonicalSeed({ id, name: 'CanonicalModel' }))
      const updated = await contract.newStore().update(id, { model: 'opus' })
      expect(updated).toMatchObject({ harnessId: 'codex', model: 'opus' })
      await expectStored(contract, id, {
        name: 'CanonicalModel',
        model: 'opus',
        harnessId: 'codex',
        sharedLink: true,
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

    it('lists by sortOrder, unordered presets after ordered ones by creation time', async () => {
      const store = contract.newStore()
      const base = { node: 'ct115', directory: '/tmp/agents/order' }
      const a = await store.create({ ...base, name: 'A', createdAt: 1_000 })
      const b = await store.create({ ...base, name: 'B', createdAt: 2_000 })
      const c = await store.create({ ...base, name: 'C', createdAt: 3_000 })
      const d = await store.create({ ...base, name: 'D', createdAt: 4_000 })
      expect((await store.list()).map((p) => p.name)).toEqual(['A', 'B', 'C', 'D'])

      await store.update(c.id, { sortOrder: 0 })
      await store.update(a.id, { sortOrder: 1 })
      expect((await store.list()).map((p) => p.name)).toEqual(['C', 'A', 'B', 'D'])
      expect((await store.get(c.id))?.sortOrder).toBe(0)

      await store.update(d.id, { sortOrder: 0 })
      await store.update(c.id, { sortOrder: 2 })
      expect((await store.list()).map((p) => p.name)).toEqual(['D', 'A', 'C', 'B'])
      expect((await store.list({ node: 'ct115' })).map((p) => p.name)).toEqual(['D', 'A', 'C', 'B'])
      expect((await store.get(b.id))?.sortOrder).toBeUndefined()
    })

    it('clears sortOrder with null and keeps it across unrelated patches', async () => {
      const store = contract.newStore()
      const base = { node: 'ct115', directory: '/tmp/agents/order-clear' }
      const first = await store.create({ ...base, name: 'First', createdAt: 1_000 })
      const second = await store.create({ ...base, name: 'Second', createdAt: 2_000 })
      await store.update(second.id, { sortOrder: 5 })
      await store.update(second.id, { color: '#3b82f6' })
      expect((await store.get(second.id))?.sortOrder).toBe(5)
      expect((await store.list()).map((p) => p.name)).toEqual(['Second', 'First'])

      const cleared = await store.update(second.id, { sortOrder: null })
      expect(cleared?.sortOrder).toBeUndefined()
      expect((await store.get(second.id))?.sortOrder).toBeUndefined()
      expect((await store.list()).map((p) => p.name)).toEqual(['First', 'Second'])
      expect((await store.get(first.id))?.sortOrder).toBeUndefined()
    })
  })
}
