import { afterEach, describe, expect, it } from 'vitest'
import { sharedDir, sharedPath } from './shared-dir.js'

const ORIGINAL = process.env.RIVETOS_SHARED_DIR

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL
})

describe('sharedDir', () => {
  it('defaults to /rivet-shared when the env var is unset', () => {
    delete process.env.RIVETOS_SHARED_DIR
    expect(sharedDir()).toBe('/rivet-shared')
  })

  it('returns the trimmed env value when set', () => {
    process.env.RIVETOS_SHARED_DIR = '/custom/shared'
    expect(sharedDir()).toBe('/custom/shared')
  })

  it('treats empty string as unset', () => {
    process.env.RIVETOS_SHARED_DIR = ''
    expect(sharedDir()).toBe('/rivet-shared')
  })

  it('treats whitespace-only as unset', () => {
    process.env.RIVETOS_SHARED_DIR = '   '
    expect(sharedDir()).toBe('/rivet-shared')
  })

  it('trims trailing and leading space', () => {
    process.env.RIVETOS_SHARED_DIR = '  /mnt/shared  '
    expect(sharedDir()).toBe('/mnt/shared')
  })

  it('reads the env var at call time, not module load', () => {
    delete process.env.RIVETOS_SHARED_DIR
    expect(sharedDir()).toBe('/rivet-shared')
    process.env.RIVETOS_SHARED_DIR = '/later'
    expect(sharedDir()).toBe('/later')
  })
})

describe('sharedPath', () => {
  it('joins segments onto the default root', () => {
    delete process.env.RIVETOS_SHARED_DIR
    expect(sharedPath('mesh.json')).toBe('/rivet-shared/mesh.json')
    expect(sharedPath('workflows', 'runs')).toBe('/rivet-shared/workflows/runs')
  })

  it('joins segments onto a custom root', () => {
    process.env.RIVETOS_SHARED_DIR = '/custom/shared'
    expect(sharedPath('rivetos', 'users.json')).toBe('/custom/shared/rivetos/users.json')
  })

  it('returns the root when given no segments', () => {
    delete process.env.RIVETOS_SHARED_DIR
    expect(sharedPath()).toBe('/rivet-shared')
  })

  it('collapses a trailing slash on the root via join', () => {
    process.env.RIVETOS_SHARED_DIR = '/mnt/shared/'
    expect(sharedDir()).toBe('/mnt/shared/')
    expect(sharedPath('mesh.json')).toBe('/mnt/shared/mesh.json')
  })
})
