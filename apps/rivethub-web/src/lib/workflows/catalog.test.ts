import { describe, it, expect } from 'vitest'
import {
  createEmptyWorkflow,
  deleteWorkflow,
  parseCatalog,
  resolveCatalog,
  seedCatalog,
  serializeCatalog,
  upsertWorkflow,
} from './catalog.js'
import { isValidWorkflow } from './validate.js'

describe('catalog', () => {
  it('seeds fixture workflows', () => {
    const seeded = seedCatalog()
    expect(seeded.length).toBeGreaterThanOrEqual(2)
    expect(seeded.every((w) => w.id && w.nodes.length > 0)).toBe(true)
  })

  it('round-trips serialize/parse', () => {
    const seeded = seedCatalog()
    const raw = serializeCatalog(seeded)
    const parsed = parseCatalog(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.map((w) => w.id)).toEqual(seeded.map((w) => w.id))
  })

  it('returns null for junk JSON', () => {
    expect(parseCatalog('not-json')).toBeNull()
    expect(parseCatalog('{"version":2,"workflows":[]}')).toBeNull()
    expect(parseCatalog(null)).toBeNull()
  })

  it('upsert and delete', () => {
    let cat = seedCatalog()
    const empty = createEmptyWorkflow({ id: 'custom-1', name: 'Custom' })
    cat = upsertWorkflow(cat, empty)
    expect(cat.some((w) => w.id === 'custom-1')).toBe(true)
    cat = upsertWorkflow(cat, { ...empty, name: 'Custom 2' })
    expect(cat.filter((w) => w.id === 'custom-1')).toHaveLength(1)
    expect(cat.find((w) => w.id === 'custom-1')!.name).toBe('Custom 2')
    cat = deleteWorkflow(cat, 'custom-1')
    expect(cat.some((w) => w.id === 'custom-1')).toBe(false)
  })

  it('empty workflow is structurally connected enough to validate without errors', () => {
    const w = createEmptyWorkflow({ id: 'e1' })
    expect(isValidWorkflow(w)).toBe(true)
  })

  it('resolveCatalog: missing → seed + shouldPersist; empty array kept; corrupt not persisted', () => {
    const missing = resolveCatalog(null)
    expect(missing.status).toBe('missing')
    expect(missing.shouldPersist).toBe(true)
    expect(missing.workflows.length).toBeGreaterThan(0)

    const emptyRaw = serializeCatalog([])
    const empty = resolveCatalog(emptyRaw)
    expect(empty.status).toBe('ok')
    expect(empty.shouldPersist).toBe(false)
    expect(empty.workflows).toEqual([])

    const corrupt = resolveCatalog('{not json')
    expect(corrupt.status).toBe('corrupt')
    expect(corrupt.shouldPersist).toBe(false)
    expect(corrupt.workflows.length).toBeGreaterThan(0)

    // Valid catalog with one entry does not reseed
    const one = serializeCatalog([createEmptyWorkflow({ id: 'only' })])
    const loaded = resolveCatalog(one)
    expect(loaded.status).toBe('ok')
    expect(loaded.workflows.map((w) => w.id)).toEqual(['only'])
  })
})
