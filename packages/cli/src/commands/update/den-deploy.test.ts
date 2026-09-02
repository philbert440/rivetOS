import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the SSH layer — these tests exercise the gateway verify stage's
// control flow, not real SSH (mirrors remote-nodes.test.ts).
vi.mock('../../lib/ssh.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/ssh.js')>()
  return {
    ...real,
    sshExec: vi.fn(),
    sshExecQuiet: vi.fn(),
  }
})

import { sshExecQuiet } from '../../lib/ssh.js'
import { parseDenSettings, denProbeHost, denProbeCmd, verifyGatewayRemote } from './den-deploy.js'

const sshExecQuietMock = vi.mocked(sshExecQuiet)

const ORIGINAL_SHARED_DIR = process.env.RIVETOS_SHARED_DIR

const DEN_YAML = `
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
den:
  enabled: true
  host: 0.0.0.0
  port: 5175
  token: den-secret
  terminal:
    enabled: true
  static_dir: /srv/hub/dist
`

beforeEach(() => {
  delete process.env.RIVETOS_SHARED_DIR
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  if (ORIGINAL_SHARED_DIR === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL_SHARED_DIR
})

// ---------------------------------------------------------------------------
// parseDenSettings
// ---------------------------------------------------------------------------

describe('parseDenSettings', () => {
  it('is disabled with sensible defaults when there is no config at all', () => {
    const s = parseDenSettings(null)
    expect(s.enabled).toBe(false)
    expect(s.host).toBe('127.0.0.1')
    expect(s.port).toBe(5174)
    expect(s.token).toBe('')
    expect(s.termEnabled).toBe(false)
  })

  it('is disabled when the config has no den section', () => {
    const s = parseDenSettings('runtime:\n  workspace: /tmp\n')
    expect(s.enabled).toBe(false)
  })

  it('is disabled on unparseable YAML (deploy stage must never throw)', () => {
    const s = parseDenSettings('runtime: [unclosed')
    expect(s.enabled).toBe(false)
  })

  it('reads the den section used for the health probe', () => {
    const s = parseDenSettings(DEN_YAML)
    expect(s).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 5175,
      token: 'den-secret',
      termEnabled: true,
      termOpen: false,
      tlsCert: '',
      tlsCa: '/rivet-shared/rivet-ca/intermediate/chain.pem',
    })
  })

  it('falls back to the default port on out-of-range values', () => {
    const s = parseDenSettings('den:\n  enabled: true\n  port: 99999\n')
    expect(s.port).toBe(5174)
  })

  it('reads explicit den.tls_* paths', () => {
    const s = parseDenSettings(
      'den:\n  enabled: true\n  tls_cert: /x/n.crt\n  tls_key: /x/n.key\n  tls_ca: /x/chain.pem\n',
    )
    expect(s.tlsCert).toBe('/x/n.crt')
    expect(s.tlsCa).toBe('/x/chain.pem')
  })

  it('stays plain-http when the cert resolves but the key does not (probe must track the gateway)', () => {
    const s = parseDenSettings('den:\n  enabled: true\n  tls_cert: /x/n.crt\n')
    expect(s.tlsCert).toBe('')
  })

  it('stays plain-http when mesh.node_name has no issued cert on disk', () => {
    const s = parseDenSettings('mesh:\n  node_name: no-such-node-xyz\nden:\n  enabled: true\n')
    expect(s.tlsCert).toBe('')
  })
})

describe('denProbeHost', () => {
  it('probes loopback for wildcard binds, the bind host otherwise', () => {
    expect(denProbeHost('0.0.0.0')).toBe('127.0.0.1')
    expect(denProbeHost('::')).toBe('127.0.0.1')
    expect(denProbeHost('127.0.0.1')).toBe('127.0.0.1')
    expect(denProbeHost('192.0.2.10')).toBe('192.0.2.10')
  })
})

describe('denProbeCmd', () => {
  it('probes plain http when the den has no TLS material', () => {
    const s = parseDenSettings('den:\n  enabled: true\n  host: 0.0.0.0\n')
    expect(denProbeCmd(s)).toBe('curl -fsS -m 3 http://127.0.0.1:5174/healthz')
  })

  it('probes https with the CA bundle when TLS is configured (#491)', () => {
    const s = parseDenSettings(
      'den:\n  enabled: true\n  host: 0.0.0.0\n  tls_cert: /x/n.crt\n  tls_key: /x/n.key\n',
    )
    expect(denProbeCmd(s)).toBe(
      'curl -fsS -m 3 --cacert /rivet-shared/rivet-ca/intermediate/chain.pem https://127.0.0.1:5174/healthz',
    )
  })
})

// ---------------------------------------------------------------------------
// verify — control flow over mocked SSH
// ---------------------------------------------------------------------------

/** Wire sshExecQuiet to answer by command shape. */
function stubQuiet(opts: { configYaml: string; healthz?: string }) {
  sshExecQuietMock.mockImplementation((_host: string, command: string) => {
    if (command.includes('config.yaml')) return opts.configYaml
    if (command.includes('/healthz')) return opts.healthz ?? '{"ok":true}'
    return ''
  })
}

/** Minimal den section for control-flow tests (distinct name from full DEN_YAML fixture above). */
const DEN_YAML_MINIMAL = 'den:\n  enabled: true\n  host: 0.0.0.0\n  port: 5174\n'

describe('verifyGatewayRemote', () => {
  it('skips when den is disabled', async () => {
    stubQuiet({ configYaml: 'runtime:\n  workspace: /tmp\n' })
    expect(await verifyGatewayRemote('192.0.2.10', 'node-a', 'rivet')).toBe('skipped')
  })

  it('reports deployed on a healthy embedded gateway', async () => {
    stubQuiet({ configYaml: DEN_YAML_MINIMAL })
    expect(await verifyGatewayRemote('192.0.2.10', 'node-a', 'rivet')).toBe('deployed')
  })
})
