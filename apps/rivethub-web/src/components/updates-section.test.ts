import { describe, expect, it } from 'vitest'
import { PACKAGE_MANAGED_NOTICE, stateAfterInstallResult } from './updates-state.js'

describe('stateAfterInstallResult', () => {
  const available = { version: '0.5.22', sizeBytes: 120_000_000 }

  it('skip (false) leaves installing and restores available with a package-manager notice', () => {
    const next = stateAfterInstallResult(false, available)
    expect(next.kind).not.toBe('installing')
    expect(next).toEqual({
      kind: 'available',
      version: '0.5.22',
      sizeBytes: 120_000_000,
      notice: PACKAGE_MANAGED_NOTICE,
    })
    expect(PACKAGE_MANAGED_NOTICE).toContain('package manager')
  })

  it('success (true) stays installing so the quit path is unchanged', () => {
    expect(stateAfterInstallResult(true, available)).toEqual({ kind: 'installing' })
  })

  it('void from an older shell is not treated as a skip', () => {
    expect(stateAfterInstallResult(undefined, available)).toEqual({ kind: 'installing' })
  })
})
