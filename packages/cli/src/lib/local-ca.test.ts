import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  desktopClientId,
  ensureLocalCa,
  issueClientDevice,
  listBannerLanIpv4,
  listLanIpv4,
  localCaPaths,
  localNodeSans,
  planLocalCa,
  writeBothChains,
} from './local-ca.js'

function ipv4(
  address: string,
  internal = false,
): NonNullable<ReturnType<typeof networkInterfaces>[string]>[number] {
  return {
    address,
    family: 'IPv4',
    internal,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: `${address}/24`,
  }
}

describe('listLanIpv4 / listBannerLanIpv4', () => {
  const nics: ReturnType<typeof networkInterfaces> = {
    eth0: [ipv4('192.0.2.10')],
    wlan0: [ipv4('198.51.100.4')],
    docker0: [ipv4('203.0.113.10')],
    'br-abc123': [ipv4('203.0.113.11')],
    veth0: [ipv4('203.0.113.12')],
    tailscale0: [ipv4('203.0.113.13')],
    tun0: [ipv4('203.0.113.14')],
    wg0: [ipv4('203.0.113.15')],
    virbr0: [ipv4('203.0.113.16')],
    lo: [ipv4('127.0.0.1', true)],
    'eth0:linklocal': [ipv4('169.254.1.1')],
  }

  it('keeps virtual ifaces in SANs and drops them from the banner list', () => {
    expect(listLanIpv4(nics)).toEqual([
      '192.0.2.10',
      '198.51.100.4',
      '203.0.113.10',
      '203.0.113.11',
      '203.0.113.12',
      '203.0.113.13',
      '203.0.113.14',
      '203.0.113.15',
      '203.0.113.16',
    ])
    expect(listBannerLanIpv4(nics)).toEqual(['192.0.2.10', '198.51.100.4'])
  })
})

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
      join(paths.rootDir, 'ca.crt'),
      join(paths.sharedDir, 'intermediate', 'int.key'),
      join(paths.sharedDir, 'intermediate', 'int.crt'),
      join(paths.sharedDir, 'issued', `device-${desktopClientId('testhost')}.crt`),
      join(paths.sharedDir, 'issued', `device-${desktopClientId('testhost')}.key`),
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
    expect(plan.steps[2].argv).toEqual(['issue-node', 'testhost', ...sans])
    expect(plan.nodeCert).toBe(join(paths.sharedDir, 'issued', 'testhost.crt'))
    expect(plan.nodeKey).toBe(join(paths.sharedDir, 'issued', 'testhost.key'))
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

  it('throws on incomplete root (key without cert)', () => {
    const existing = new Set([join(paths.rootDir, 'ca.key')])
    expect(() =>
      planLocalCa({
        home,
        hostname: 'testhost',
        sans,
        scriptPath: script,
        exists: (p) => existing.has(p),
      }),
    ).toThrow(/incomplete root CA/)
  })
})

describe('writeBothChains + issueClientDevice skip', () => {
  const script = '/opt/rivetos/scripts/rivet-ca.sh'
  const sans = localNodeSans({ hostname: 'testhost', lanAddrs: ['192.0.2.10'] })

  it('copies chain.pem onto ca-chain.pem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-ca-chain-'))
    try {
      const plan = planLocalCa({
        home: dir,
        hostname: 'testhost',
        sans,
        scriptPath: script,
        exists: () => false,
      })
      mkdirSync(join(plan.sharedDir, 'intermediate'), { recursive: true })
      writeFileSync(plan.chainPem, 'CHAIN')
      writeBothChains(plan)
      expect(readFileSync(plan.caChainPem, 'utf-8')).toBe('CHAIN')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('issueClientDevice skips when cert and key already exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-ca-client-'))
    try {
      const issued = join(dir, '.rivetos', 'shared', 'rivet-ca', 'issued')
      mkdirSync(issued, { recursive: true })
      writeFileSync(join(issued, 'device-phone.crt'), 'c')
      writeFileSync(join(issued, 'device-phone.key'), 'k')
      const result = await issueClientDevice({
        home: dir,
        name: 'phone',
        scriptPath: script,
      })
      expect(result.id).toBe('phone')
      expect(result.cert).toContain('device-phone.crt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats spawn error (code null) as a CA issuance failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-ca-null-'))
    try {
      const exec = async () => ({
        stdout: '',
        stderr: 'spawn bash ENOENT',
        code: null,
        timedOut: false,
      })
      await expect(
        ensureLocalCa({
          home: dir,
          hostname: 'testhost',
          lanAddrs: ['192.0.2.10'],
          exec,
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
          exists: () => false,
        }),
      ).rejects.toThrow(/rivet-ca.sh init failed/)
      await expect(
        issueClientDevice({
          home: dir,
          name: 'phone',
          exec,
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
        }),
      ).rejects.toThrow(/issue-client phone failed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
