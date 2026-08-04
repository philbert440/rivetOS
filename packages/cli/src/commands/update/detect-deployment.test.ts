import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import {
  detectDeployment,
  findOwnershipBlockers,
  findRootOwnedBlockers,
} from './detect-deployment.js'

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

describe('findOwnershipBlockers', () => {
  const scratchDirs: string[] = []

  afterEach(() => {
    for (const d of scratchDirs.splice(0)) {
      try {
        // Restore write bits so cleanup can remove even if we chmod'd 0555.
        chmodSync(d, 0o755)
        rmSync(d, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  })

  function scratch(): string {
    const dir = join(
      tmpdir(),
      `rivetos-own-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
    )
    mkdirSync(dir, { recursive: true })
    scratchDirs.push(dir)
    return dir
  }

  it('returns empty for a missing tree', () => {
    const blockers = findOwnershipBlockers('/tmp/rivetos-does-not-exist-xyz')
    expect(Array.isArray(blockers)).toBe(true)
    expect(blockers).toEqual([])
  })

  it('returns empty when the install tree is writable by us', () => {
    const root = scratch()
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'packages'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    expect(findOwnershipBlockers(root)).toEqual([])
  })

  it('flags unwritable install root (not just root-uid)', () => {
    // Skip when running as root — the preflight intentionally no-ops for uid 0.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return
    }
    const root = scratch()
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    // Drop all write bits for owner/group/other — simulates foreign-owned tree
    // without needing another uid (CI runners can't chown to root freely).
    chmodSync(root, 0o555)
    const blockers = findOwnershipBlockers(root)
    expect(blockers).toContain('(install root)')
  })

  it('flags an unwritable node_modules while root stays writable', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return
    }
    const root = scratch()
    const nm = join(root, 'node_modules')
    mkdirSync(nm, { recursive: true })
    chmodSync(nm, 0o555)
    const blockers = findOwnershipBlockers(root)
    expect(blockers).toContain('node_modules')
    expect(blockers).not.toContain('(install root)')
  })

  it('findRootOwnedBlockers aliases findOwnershipBlockers', () => {
    const root = scratch()
    expect(findRootOwnedBlockers(root)).toEqual(findOwnershipBlockers(root))
  })
})
