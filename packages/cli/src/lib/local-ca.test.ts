import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { desktopClientId, localCaPaths, localNodeSans, planLocalCa } from './local-ca.js'

describe('localNodeSans', () => {
  it('always includes loopback IP + localhost DNS + hostname.local', () => {
    expect(localNodeSans({ hostname: 'testhost', lanAddrs: [] })).toEqual([
      'IP:127.0.0.1',
      'DNS:localhost',
      'DNS:testhost.local',
    ])
  })

  it('prefixes LAN addresses as IP: (TEST-NET, not a real host)', () => {
    expect(
      localNodeSans({ hostname: 'testhost', lanAddrs: ['192.0.2.10', '198.51.100.4'] }),
    ).toEqual([
      'IP:127.0.0.1',
      'DNS:localhost',
      'IP:192.0.2.10',
      'IP:198.51.100.4',
      'DNS:testhost.local',
    ])
  })
})

describe('planLocalCa', () => {
  const home = '/tmp/rivetos-local-ca-home'
  const script = '/opt/rivetos/scripts/rivet-ca.sh'
  const sans = localNodeSans({ hostname: 'testhost', lanAddrs: ['192.0.2.10'] })
  const paths = localCaPaths(home)

  it('skips init / intermediate / desktop client when outputs exist; always re-issues the node', () => {
    const existing = new Set([
      join(paths.rootDir, 'ca.key'),
      join(paths.sharedDir, 'intermediate', 'int.key'),
      join(paths.sharedDir, 'issued', `device-${desktopClientId('testhost')}.crt`),
    ])
    const plan = planLocalCa({
      home,
      hostname: 'testhost',
      sans,
      scriptPath: script,
      exists: (p) => existing.has(p),
    })
    expect(plan.script).toBe(script)
    expect(plan.rootDir).toBe(paths.rootDir)
    expect(plan.sharedDir).toBe(paths.sharedDir)
    expect(plan.steps.map((s) => s.argv[0])).toEqual([
      'init',
      'issue-intermediate',
      'issue-node',
      'issue-client',
    ])
    expect(plan.steps[0].skip).toBe(true)
    expect(plan.steps[1].skip).toBe(true)
    expect(plan.steps[2].skip).toBe(false)
    expect(plan.steps[2].argv).toEqual(['issue-node', 'local', ...sans])
    expect(plan.steps[3].skip).toBe(true)
    expect(plan.steps[3].argv).toEqual(['issue-client', 'desktop-testhost'])
    expect(plan.chainPem).toBe(join(paths.sharedDir, 'intermediate', 'chain.pem'))
    expect(plan.caChainPem).toBe(join(paths.sharedDir, 'intermediate', 'ca-chain.pem'))
  })

  it('runs every step on a greenfield home', () => {
    const plan = planLocalCa({
      home,
      hostname: 'testhost',
      sans,
      scriptPath: script,
      exists: () => false,
    })
    expect(plan.steps.every((s) => !s.skip)).toBe(true)
  })
})
