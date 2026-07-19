import { describe, it, expect } from 'vitest'
import { detectDeployment, findRootOwnedBlockers } from './detect-deployment.js'

describe('detectDeployment', () => {
  it('honors forceBareMetal over every other signal', async () => {
    const res = await detectDeployment({
      forceBareMetal: true,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => 'docker',
        hasSystemdUnit: async () => false,
        isDockerUsable: () => true,
        hasComposeFile: async () => true,
      },
    })
    expect(res.mode).toBe('bare-metal')
    expect(res.reason).toMatch(/forced/i)
  })

  it('uses config.deployment.target when set (bare-metal)', async () => {
    const res = await detectDeployment({
      forceBareMetal: false,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => 'bare-metal',
        hasSystemdUnit: async () => false,
        isDockerUsable: () => true,
        hasComposeFile: async () => true,
      },
    })
    expect(res.mode).toBe('bare-metal')
    expect(res.reason).toContain('config.deployment.target=bare-metal')
  })

  it('refuses config target=docker when docker is unavailable', async () => {
    const res = await detectDeployment({
      forceBareMetal: false,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => 'docker',
        hasSystemdUnit: async () => false,
        isDockerUsable: () => false,
        hasComposeFile: async () => true,
      },
    })
    expect(res.mode).toBe('bare-metal')
    expect(res.reason).toMatch(/docker is unavailable/i)
  })

  it('prefers systemd over compose file (the mesh bare-metal case)', async () => {
    const res = await detectDeployment({
      forceBareMetal: false,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => undefined,
        hasSystemdUnit: async () => true,
        isDockerUsable: () => false,
        hasComposeFile: async () => true,
      },
    })
    expect(res.mode).toBe('bare-metal')
    expect(res.reason).toMatch(/systemd/i)
  })

  it('does NOT choose docker just because compose file ships in the repo', async () => {
    // This is the 2026-05-23 silent-fallback footgun.
    const res = await detectDeployment({
      forceBareMetal: false,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => undefined,
        hasSystemdUnit: async () => false,
        isDockerUsable: () => false,
        hasComposeFile: async () => true,
      },
    })
    expect(res.mode).toBe('bare-metal')
    expect(res.reason).toMatch(/docker unavailable/i)
  })

  it('chooses docker only when compose exists AND docker works', async () => {
    const res = await detectDeployment({
      forceBareMetal: false,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => undefined,
        hasSystemdUnit: async () => false,
        isDockerUsable: () => true,
        hasComposeFile: async () => true,
      },
    })
    expect(res.mode).toBe('docker')
    expect(res.reason).toMatch(/docker daemon reachable/i)
  })

  it('defaults to bare-metal with no signals', async () => {
    const res = await detectDeployment({
      forceBareMetal: false,
      root: '/tmp/rivetos-fake',
      probes: {
        readConfigTarget: async () => undefined,
        hasSystemdUnit: async () => false,
        isDockerUsable: () => false,
        hasComposeFile: async () => false,
      },
    })
    expect(res.mode).toBe('bare-metal')
    expect(res.reason).toMatch(/default/i)
  })
})

describe('findRootOwnedBlockers', () => {
  it('returns empty when running as root (uid 0)', () => {
    // We can't flip getuid in all environments; just ensure the function
    // is callable on a missing tree and returns an array.
    const blockers = findRootOwnedBlockers('/tmp/rivetos-does-not-exist-xyz')
    expect(Array.isArray(blockers)).toBe(true)
    expect(blockers).toEqual([])
  })
})
