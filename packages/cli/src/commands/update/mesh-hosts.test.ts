import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
import {
  buildLocalMeshHostsCommand,
  buildRemoteMeshHostsCommand,
  formatExecFailure,
  formatMeshHostsSkipDetail,
  healLocalMeshHosts,
  isProcessRoot,
} from './mesh-hosts.js'

const execSyncMock = vi.mocked(execSync)

const ORIGINAL_INSTALL_ROOT = process.env.RIVETOS_INSTALL_ROOT
const ORIGINAL_SHARED_DIR = process.env.RIVETOS_SHARED_DIR

beforeEach(() => {
  delete process.env.RIVETOS_INSTALL_ROOT
  delete process.env.RIVETOS_SHARED_DIR
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  if (ORIGINAL_INSTALL_ROOT === undefined) delete process.env.RIVETOS_INSTALL_ROOT
  else process.env.RIVETOS_INSTALL_ROOT = ORIGINAL_INSTALL_ROOT
  if (ORIGINAL_SHARED_DIR === undefined) delete process.env.RIVETOS_SHARED_DIR
  else process.env.RIVETOS_SHARED_DIR = ORIGINAL_SHARED_DIR
  vi.restoreAllMocks()
})

describe('formatExecFailure', () => {
  it('prefers stderr over message', () => {
    expect(
      formatExecFailure({
        message: 'Command failed: sudo …',
        stderr: Buffer.from('[setup-mesh-hosts] ERROR: mesh file not readable\n'),
      }),
    ).toBe('[setup-mesh-hosts] ERROR: mesh file not readable')
  })

  it('keeps the last few stderr lines when noisy', () => {
    expect(
      formatExecFailure({
        stderr: 'line1\nline2\nline3\nline4\n',
      }),
    ).toBe('line2 | line3 | line4')
  })

  it('falls back to message, then status', () => {
    expect(formatExecFailure({ message: 'boom' })).toBe('boom')
    expect(formatExecFailure({ status: 1 })).toBe('exited with code 1')
  })
})

describe('formatMeshHostsSkipDetail', () => {
  it('adds a passwordless-sudo hint for sudo password errors', () => {
    expect(
      formatMeshHostsSkipDetail({
        stderr: 'sudo: a password is required\n',
        message: 'mesh-hosts exited with code 1',
        status: 1,
      }),
    ).toMatch(/password is required.*passwordless sudo/)
  })

  it('adds the same hint for no-TTY sudo failures', () => {
    expect(formatMeshHostsSkipDetail({ stderr: 'sudo: a terminal is required to read the password' })).toMatch(
      /terminal is required.*passwordless sudo/,
    )
  })

  it('passes through script stderr without a sudo hint', () => {
    expect(
      formatMeshHostsSkipDetail({
        stderr: '[setup-mesh-hosts] ERROR: mesh file not readable\n',
        message: 'mesh-hosts exited with code 1',
      }),
    ).toBe('[setup-mesh-hosts] ERROR: mesh file not readable')
  })

  it('falls back to exit-code message when no stdio was captured', () => {
    expect(formatMeshHostsSkipDetail({ message: 'mesh-hosts exited with code 1', status: 1 })).toBe(
      'mesh-hosts exited with code 1',
    )
  })
})

describe('buildRemoteMeshHostsCommand', () => {
  it('omits sudo for root and pins the default install root', () => {
    expect(buildRemoteMeshHostsCommand('root')).toBe(
      "'/opt/rivetos/infra/scripts/setup-mesh-hosts.sh' /rivet-shared/mesh.json --quiet",
    )
  })

  it('uses non-interactive sudo for non-root', () => {
    expect(buildRemoteMeshHostsCommand('rivet')).toBe(
      "sudo -n '/opt/rivetos/infra/scripts/setup-mesh-hosts.sh' /rivet-shared/mesh.json --quiet",
    )
  })

  it('per-node root wins over RIVETOS_INSTALL_ROOT', () => {
    process.env.RIVETOS_INSTALL_ROOT = '/env/rivetos'
    expect(buildRemoteMeshHostsCommand('root', '/node/rivetos')).toBe(
      "'/node/rivetos/infra/scripts/setup-mesh-hosts.sh' /rivet-shared/mesh.json --quiet",
    )
  })
})

describe('buildLocalMeshHostsCommand', () => {
  it('matches root vs non-root prefix to isProcessRoot()', () => {
    const script = '/opt/rivetos/infra/scripts/setup-mesh-hosts.sh'
    const cmd = buildLocalMeshHostsCommand(script)
    if (isProcessRoot()) {
      expect(cmd).toBe(`${script} /rivet-shared/mesh.json --quiet`)
    } else {
      expect(cmd).toBe(`sudo -n ${script} /rivet-shared/mesh.json --quiet`)
    }
  })
})

describe('healLocalMeshHosts', () => {
  it('returns ok when execSync succeeds and does not warn', () => {
    execSyncMock.mockReturnValue('')
    const result = healLocalMeshHosts({
      scriptPath: '/tmp/setup-mesh-hosts.sh',
      tag: '    ',
    })
    expect(result).toEqual({ ok: true })
    expect(console.log).not.toHaveBeenCalled()
    expect(execSyncMock).toHaveBeenCalledOnce()
    const [cmd] = execSyncMock.mock.calls[0]!
    expect(String(cmd)).toContain('/tmp/setup-mesh-hosts.sh')
    expect(String(cmd)).toContain('/rivet-shared/mesh.json')
    expect(String(cmd)).toContain('--quiet')
  })

  it('warns with stderr detail and does not throw on failure', () => {
    execSyncMock.mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stderr: Buffer }
      err.stderr = Buffer.from(
        'sudo: a password is required\n',
      )
      throw err
    })

    const result = healLocalMeshHosts({
      scriptPath: '/tmp/setup-mesh-hosts.sh',
      tag: '    [local] ',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.detail).toMatch(/password is required/)
    expect(result.detail).toMatch(/passwordless sudo/)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[local\].*\/etc\/hosts mesh block update skipped:.*password is required/,
      ),
    )
  })

  it('uses custom mesh file when provided', () => {
    execSyncMock.mockReturnValue('')
    healLocalMeshHosts({
      scriptPath: '/tmp/setup-mesh-hosts.sh',
      meshFile: '/tmp/mesh.json',
    })
    const [cmd] = execSyncMock.mock.calls[0]!
    expect(String(cmd)).toContain('/tmp/mesh.json')
  })
})
