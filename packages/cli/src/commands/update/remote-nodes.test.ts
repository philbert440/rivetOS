import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SSH layer — these tests exercise gitUpdateNodeAsync's control flow,
// not real SSH.
vi.mock('../../lib/ssh.js', () => ({
  resolveSshUser: vi.fn(() => 'rivet'),
  isSafeArg: vi.fn(() => true),
  sshExec: vi.fn(),
  sshExecCapture: vi.fn(),
  sshExecQuiet: vi.fn(),
}))
vi.mock('../../lib/mtls.js', () => ({ buildMeshDispatcher: vi.fn() }))

import { sshExec, sshExecCapture, sshExecQuiet } from '../../lib/ssh.js'
import {
  gitUpdateNodeAsync,
  probeRemoteInstallWritable,
  REMOTE_INSTALL_ROOT,
} from './remote-nodes.js'
import type { UpdateOptions } from './types.js'

const sshExecMock = vi.mocked(sshExec)
const sshExecCaptureMock = vi.mocked(sshExecCapture)
const sshExecQuietMock = vi.mocked(sshExecQuiet)

const OPTS: UpdateOptions = {
  restart: true,
  prebuilt: false,
  mesh: true,
  bareMetal: true,
  sshUser: 'rivet',
  npm: false,
  channel: 'beta',
  ignoreOwnership: false,
}

/**
 * Wire sshExecQuiet for worker list / commit / is-active / ownership probes.
 * Ownership defaults to writable install at /opt/rivetos so existing flow
 * tests keep exercising git→npm→restart without EACCES noise.
 */
function stubQuiet(
  activeStates: Record<string, string>,
  ownership: 'writable' | 'missing' | 'blocked' = 'writable',
) {
  sshExecQuietMock.mockImplementation((_host: string, command: string) => {
    if (command.includes('list-unit-files'))
      return 'rivet-compactor.service\nrivet-embedder.service'
    if (command.includes('rev-parse')) return 'abc1234'
    if (command.includes('is-active')) {
      const unit = Object.keys(activeStates).find((u) => command.includes(u))
      return unit ? activeStates[unit] : 'active'
    }
    // Ownership preflight probes (test -d / test -e / test -w / stat).
    if (command.includes('test -d') && command.includes(REMOTE_INSTALL_ROOT)) {
      return ownership === 'missing' ? 'no' : 'yes'
    }
    if (command.includes('test -e') && command.includes('test -w')) {
      if (ownership === 'blocked') return 'BLOCKED'
      if (ownership === 'missing') return 'SKIP'
      return 'OK'
    }
    if (command.includes('stat -c')) {
      return ownership === 'blocked' ? 'root:root' : 'rivet:rivet'
    }
    return ''
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sshExecCaptureMock.mockResolvedValue({ stdout: '', stderr: '' })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('probeRemoteInstallWritable', () => {
  it('returns ok when install exists and key paths are writable', () => {
    stubQuiet({}, 'writable')
    expect(probeRemoteInstallWritable('192.0.2.110', 'rivet')).toEqual({ ok: true })
  })

  it('returns missing when install root is absent', () => {
    stubQuiet({}, 'missing')
    expect(probeRemoteInstallWritable('192.0.2.110', 'rivet')).toEqual({
      ok: false,
      reason: 'missing',
      root: REMOTE_INSTALL_ROOT,
    })
  })

  it('returns unwritable blockers with owner when paths fail W_OK', () => {
    stubQuiet({}, 'blocked')
    const res = probeRemoteInstallWritable('192.0.2.110', 'rivet')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('unwritable')
    if (res.reason !== 'unwritable') return
    expect(res.blockers.length).toBeGreaterThan(0)
    expect(res.blockers.every((b) => b.owner === 'root:root')).toBe(true)
    // Root label is the absolute install path; nested paths are absolute too.
    expect(res.blockers.some((b) => b.path === REMOTE_INSTALL_ROOT)).toBe(true)
  })

  it('rejects root paths that look like shell injection', () => {
    const res = probeRemoteInstallWritable('192.0.2.110', 'rivet', '/opt/rivetos; rm -rf /')
    expect(res).toEqual({
      ok: false,
      reason: 'missing',
      root: '/opt/rivetos; rm -rf /',
    })
    expect(sshExecQuietMock).not.toHaveBeenCalled()
  })
})

describe('gitUpdateNodeAsync — remote ownership preflight', () => {
  it('fails with failedStep ownership before git pull when tree is unwritable', async () => {
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({}, 'blocked')

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(res.success).toBe(false)
    expect(res.failedStep).toBe('ownership')
    // No git/npm/build should have been attempted.
    expect(sshExecMock).not.toHaveBeenCalled()
  })

  it('fails with failedStep ownership when install root is missing', async () => {
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({}, 'missing')

    const res = await gitUpdateNodeAsync('192.0.2.110', 'ct112', OPTS, true)

    expect(res.success).toBe(false)
    expect(res.failedStep).toBe('ownership')
    expect(sshExecMock).not.toHaveBeenCalled()
  })

  it('proceeds to git pull when the install tree is writable', async () => {
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' }, 'writable')

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(res.success).toBe(true)
    const gitCalls = sshExecMock.mock.calls.map((c) => c[1]).filter((cmd) => cmd.includes('git '))
    expect(gitCalls.length).toBeGreaterThan(0)
  })
})

describe('gitUpdateNodeAsync — datahub worker restart resilience', () => {
  it('restarts all workers and succeeds when every unit ends active', async () => {
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(res.success).toBe(true)
    expect(res.workers).toEqual(['rivet-compactor.service', 'rivet-embedder.service'])
  })

  it('builds the worker services before restarting their units', async () => {
    // The workers are TypeScript under services/ now — without a build the
    // restart puts the units straight back onto the previous dist/.
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    const commands = sshExecMock.mock.calls.map((c) => c[1])
    const buildIdx = commands.findIndex(
      (cmd) => cmd.includes('nx run-many -t build') && cmd.includes('@rivetos/embedding-worker'),
    )
    const firstRestartIdx = commands.findIndex((cmd) => cmd.includes('systemctl restart rivet-'))
    expect(buildIdx).toBeGreaterThanOrEqual(0)
    expect(buildIdx).toBeLessThan(firstRestartIdx)
  })

  it('fails at the build step without restarting anything', async () => {
    sshExecMock.mockImplementation((_host, command: string) =>
      command.includes('nx run-many -t build')
        ? Promise.reject(new Error('tsc exploded'))
        : Promise.resolve(),
    )
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(res.success).toBe(false)
    expect(res.failedStep).toBe('build')
    expect(sshExecMock.mock.calls.map((c) => c[1]).some((c) => c.includes('systemctl restart'))).toBe(
      false,
    )
  })

  it('still restarts the embedder when the compactor restart times out (the bug)', async () => {
    // Compactor restart "times out" (SSH client killed) but the unit is active.
    sshExecMock.mockImplementation((_host, command: string) => {
      if (command.includes('restart rivet-compactor')) {
        return Promise.reject(new Error('restart rivet-compactor.service timed out after 90s'))
      }
      return Promise.resolve()
    })
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    // The embedder restart must have been attempted despite the compactor "failure".
    const restartedUnits = sshExecMock.mock.calls
      .map((c) => c[1])
      .filter((cmd) => cmd.includes('systemctl restart rivet-'))
    expect(restartedUnits.some((c) => c.includes('rivet-embedder'))).toBe(true)
    // And the node succeeds because is-active confirms both came up.
    expect(res.success).toBe(true)
    expect(res.workers).toContain('rivet-embedder.service')
  })

  it('fails and names the units that stay inactive', async () => {
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'failed' })

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(res.success).toBe(false)
    expect(res.failedStep).toBe('worker:rivet-embedder.service')
    expect(res.workers).toEqual(['rivet-compactor.service'])
  })
})

describe('gitUpdateNodeAsync — remote mesh-hosts stderr', () => {
  function passwordRequiredErr(): Error {
    return Object.assign(new Error('[ct112] mesh-hosts exited with code 1'), {
      stderr: 'sudo: a password is required\n',
      stdout: '',
      status: 1,
    })
  }

  it('infra path: skip warning includes captured stderr + sudo hint (not just exit code)', async () => {
    sshExecMock.mockResolvedValue(undefined)
    sshExecCaptureMock.mockRejectedValue(passwordRequiredErr())
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    const res = await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(res.success).toBe(true)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[datahub\].*\/etc\/hosts mesh block update skipped:.*password is required.*passwordless sudo/,
      ),
    )
    expect(sshExecCaptureMock).toHaveBeenCalledOnce()
    expect(sshExecCaptureMock.mock.calls[0]![1]).toContain('setup-mesh-hosts.sh')
  })

  it('agent path: same captured skip warning; deploy still succeeds', async () => {
    sshExecMock.mockResolvedValue(undefined)
    sshExecCaptureMock.mockRejectedValue(passwordRequiredErr())
    stubQuiet({})

    const res = await gitUpdateNodeAsync('192.0.2.110', 'ct112', OPTS, true)

    expect(res.success).toBe(true)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[ct112\].*\/etc\/hosts mesh block update skipped:.*password is required.*passwordless sudo/,
      ),
    )
  })

  it('does not warn when remote hosts heal succeeds', async () => {
    sshExecMock.mockResolvedValue(undefined)
    sshExecCaptureMock.mockResolvedValue({ stdout: '', stderr: '' })
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    await gitUpdateNodeAsync('192.0.2.110', 'datahub', OPTS, false)

    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/etc\/hosts mesh block update skipped/),
    )
  })
})
