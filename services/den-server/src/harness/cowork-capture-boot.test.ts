import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { findCoworkCaptureBundle, startCoworkCaptureCatchUp } from './cowork-capture-boot.js'

describe('cowork capture catch-up', () => {
  it('skips quietly when the bundle is absent', () => {
    const spawnImpl = vi.fn()
    startCoworkCaptureCatchUp({
      bundle: join(tmpdir(), 'missing-cowork-cli.js'),
      spawnImpl,
    })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('spawns one backfill when the bundle exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cowork-boot-'))
    const bundle = join(root, 'integrations', 'cowork', 'rivet-memory', 'capture', 'dist', 'cli.js')
    mkdirSync(join(root, 'integrations', 'cowork', 'rivet-memory', 'capture', 'dist'), {
      recursive: true,
    })
    writeFileSync(bundle, '// bundle\n')
    expect(findCoworkCaptureBundle(join(root, 'services', 'den-server', 'src'))).toBe(bundle)
    const child = { unref: vi.fn(), on: vi.fn() }
    const spawnImpl = vi.fn(() => child)
    startCoworkCaptureCatchUp({ bundle, spawnImpl, env: { HOME: root } })
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(spawnImpl.mock.calls[0]?.[1]).toEqual([bundle, '--backfill'])
    expect(child.unref).toHaveBeenCalled()
  })
})
