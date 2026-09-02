import { afterEach, describe, expect, it } from 'vitest'
import { installRoot, installPath } from './install-root.js'

const ORIGINAL = process.env.RIVETOS_INSTALL_ROOT

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RIVETOS_INSTALL_ROOT
  else process.env.RIVETOS_INSTALL_ROOT = ORIGINAL
})

describe('installRoot', () => {
  it('defaults to /opt/rivetos when the env var is unset', () => {
    delete process.env.RIVETOS_INSTALL_ROOT
    expect(installRoot()).toBe('/opt/rivetos')
  })

  it('returns the trimmed env value when set', () => {
    process.env.RIVETOS_INSTALL_ROOT = '/custom/rivetos'
    expect(installRoot()).toBe('/custom/rivetos')
  })

  it('treats empty string as unset', () => {
    process.env.RIVETOS_INSTALL_ROOT = ''
    expect(installRoot()).toBe('/opt/rivetos')
  })

  it('treats whitespace-only as unset', () => {
    process.env.RIVETOS_INSTALL_ROOT = '   '
    expect(installRoot()).toBe('/opt/rivetos')
  })

  it('trims trailing and leading space', () => {
    process.env.RIVETOS_INSTALL_ROOT = '  /mnt/rivetos  '
    expect(installRoot()).toBe('/mnt/rivetos')
  })

  it('reads the env var at call time, not module load', () => {
    delete process.env.RIVETOS_INSTALL_ROOT
    expect(installRoot()).toBe('/opt/rivetos')
    process.env.RIVETOS_INSTALL_ROOT = '/later'
    expect(installRoot()).toBe('/later')
  })
})

describe('installPath', () => {
  it('joins segments onto the default root', () => {
    delete process.env.RIVETOS_INSTALL_ROOT
    expect(installPath('infra', 'scripts', 'setup-mesh-hosts.sh')).toBe(
      '/opt/rivetos/infra/scripts/setup-mesh-hosts.sh',
    )
    expect(installPath('packages', 'cli')).toBe('/opt/rivetos/packages/cli')
  })

  it('joins segments onto a custom root', () => {
    process.env.RIVETOS_INSTALL_ROOT = '/custom/rivetos'
    expect(installPath('apps', 'rivethub-web', 'dist')).toBe(
      '/custom/rivetos/apps/rivethub-web/dist',
    )
  })

  it('returns the root when given no segments', () => {
    delete process.env.RIVETOS_INSTALL_ROOT
    expect(installPath()).toBe('/opt/rivetos')
  })

  it('collapses a trailing slash on the root via join', () => {
    process.env.RIVETOS_INSTALL_ROOT = '/mnt/rivetos/'
    expect(installRoot()).toBe('/mnt/rivetos/')
    expect(installPath('package.json')).toBe('/mnt/rivetos/package.json')
  })
})
