import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SSH layer — these tests exercise the den deploy stage's control
// flow, not real SSH (mirrors remote-nodes.test.ts).
vi.mock('../../lib/ssh.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/ssh.js')>()
  return {
    ...real,
    sshExec: vi.fn(),
    sshExecQuiet: vi.fn(),
  }
})

import { sshExec, sshExecQuiet } from '../../lib/ssh.js'
import {
  parseDenSettings,
  denProbeHost,
  retireDenUnitRemote,
  verifyGatewayRemote,
} from './den-deploy.js'

const sshExecMock = vi.mocked(sshExec)
const sshExecQuietMock = vi.mocked(sshExecQuiet)

const ROOT = '/opt/rivetos'

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
  static_dir: /srv/den/dist
`

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

// ---------------------------------------------------------------------------
// parseDenSettings
// ---------------------------------------------------------------------------

describe('parseDenSettings', () => {
  it('is disabled with sensible defaults when there is no config at all', () => {
    const s = parseDenSettings(null, ROOT)
    expect(s.enabled).toBe(false)
    expect(s.host).toBe('127.0.0.1')
    expect(s.port).toBe(5174)
    expect(s.token).toBe('')
    expect(s.termEnabled).toBe(false)
  })

  it('is disabled when the config has no den section', () => {
    const s = parseDenSettings('runtime:\n  workspace: /tmp\n', ROOT)
    expect(s.enabled).toBe(false)
  })

  it('is disabled on unparseable YAML (deploy stage must never throw)', () => {
    const s = parseDenSettings('runtime: [unclosed', ROOT)
    expect(s.enabled).toBe(false)
  })

  it('derives static/packs dirs from the install root by default', () => {
    const s = parseDenSettings('den:\n  enabled: true\n', ROOT)
    expect(s.staticDir).toBe('/opt/rivetos/apps/den/dist')
    expect(s.packsDir).toBe('/opt/rivetos/packages/den-packs/packs')
  })

  it('reads the full den section, honoring overrides', () => {
    const s = parseDenSettings(DEN_YAML, ROOT)
    expect(s).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 5175,
      token: 'den-secret',
      termEnabled: true,
      termOpen: false,
      staticDir: '/srv/den/dist',
      packsDir: '/opt/rivetos/packages/den-packs/packs',
    })
  })

  it('falls back to the default port on out-of-range values', () => {
    const s = parseDenSettings('den:\n  enabled: true\n  port: 99999\n', ROOT)
    expect(s.port).toBe(5174)
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

// ---------------------------------------------------------------------------
// retire/verify — control flow over mocked SSH
// ---------------------------------------------------------------------------

/** Wire sshExecQuiet to answer by command shape. */
function stubQuiet(opts: {
  configYaml: string
  unitActive?: string
  unitEnabled?: string
  healthz?: string
}) {
  sshExecQuietMock.mockImplementation((_host: string, command: string) => {
    if (command.includes('config.yaml')) return opts.configYaml
    if (command.includes('is-active')) return opts.unitActive ?? 'inactive'
    if (command.includes('is-enabled')) return opts.unitEnabled ?? 'disabled'
    if (command.includes('/healthz')) return opts.healthz ?? '{"ok":true}'
    return ''
  })
}

/** Minimal den section for control-flow tests (distinct name from full DEN_YAML fixture above). */
const DEN_YAML_MINIMAL = 'den:\n  enabled: true\n  host: 0.0.0.0\n  port: 5174\n'

describe('retireDenUnitRemote', () => {
  it('no-ops when the unit is neither active nor enabled', async () => {
    stubQuiet({ configYaml: DEN_YAML_MINIMAL })
    await retireDenUnitRemote('192.0.2.10', 'node-a', 'rivet')
    expect(sshExecMock).not.toHaveBeenCalled()
  })

  it('disables an active unit before the rivetos restart', async () => {
    stubQuiet({ configYaml: DEN_YAML_MINIMAL, unitActive: 'active' })
    await retireDenUnitRemote('192.0.2.10', 'node-a', 'rivet')
    expect(sshExecMock).toHaveBeenCalledWith(
      '192.0.2.10',
      expect.stringContaining('systemctl disable --now rivet-den'),
      expect.any(String),
      expect.any(Number),
      'rivet',
    )
  })
})

describe('verifyGatewayRemote', () => {
  it('skips when den is disabled', async () => {
    stubQuiet({ configYaml: 'runtime:\n  workspace: /tmp\n' })
    expect(await verifyGatewayRemote('192.0.2.10', 'node-a', 'rivet')).toBe('skipped')
  })

  it('reports deployed on a healthy embedded gateway', async () => {
    stubQuiet({ configYaml: DEN_YAML_MINIMAL, unitActive: 'inactive' })
    expect(await verifyGatewayRemote('192.0.2.10', 'node-a', 'rivet')).toBe('deployed')
  })

  it('FAILS when /healthz answers but the retired unit is still active (false-green guard)', async () => {
    stubQuiet({ configYaml: DEN_YAML_MINIMAL, unitActive: 'active' })
    expect(await verifyGatewayRemote('192.0.2.10', 'node-a', 'rivet')).toBe('failed')
  })
})
