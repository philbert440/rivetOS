import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SSH layer — these tests exercise gitUpdateNodeAsync's control flow,
// not real SSH.
vi.mock('../../lib/ssh.js', () => ({
  resolveSshUser: vi.fn(() => 'rivet'),
  isSafeArg: vi.fn(() => true),
  sshExec: vi.fn(),
  sshExecQuiet: vi.fn(),
}))
vi.mock('../../lib/mtls.js', () => ({ buildMeshDispatcher: vi.fn() }))

import { sshExec, sshExecQuiet } from '../../lib/ssh.js'
import { gitUpdateNodeAsync } from './remote-nodes.js'
import type { UpdateOptions } from './types.js'

const sshExecMock = vi.mocked(sshExec)
const sshExecQuietMock = vi.mocked(sshExecQuiet)

const OPTS: UpdateOptions = {
  restart: true,
  prebuilt: false,
  mesh: true,
  bareMetal: true,
  sshUser: 'rivet',
  npm: false,
  channel: 'beta',
}

/** Wire sshExecQuiet to answer by command: worker list, commit SHA, is-active. */
function stubQuiet(activeStates: Record<string, string>) {
  sshExecQuietMock.mockImplementation((_host: string, command: string) => {
    if (command.includes('list-unit-files'))
      return 'rivet-compactor.service\nrivet-embedder.service'
    if (command.includes('rev-parse')) return 'abc1234'
    if (command.includes('is-active')) {
      const unit = Object.keys(activeStates).find((u) => command.includes(u))
      return unit ? activeStates[unit] : 'active'
    }
    return ''
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('gitUpdateNodeAsync — datahub worker restart resilience', () => {
  it('restarts all workers and succeeds when every unit ends active', async () => {
    sshExecMock.mockResolvedValue(undefined)
    stubQuiet({ 'rivet-compactor.service': 'active', 'rivet-embedder.service': 'active' })

    const res = await gitUpdateNodeAsync('10.4.20.110', 'datahub', OPTS, false)

    expect(res.success).toBe(true)
    expect(res.workers).toEqual(['rivet-compactor.service', 'rivet-embedder.service'])
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

    const res = await gitUpdateNodeAsync('10.4.20.110', 'datahub', OPTS, false)

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

    const res = await gitUpdateNodeAsync('10.4.20.110', 'datahub', OPTS, false)

    expect(res.success).toBe(false)
    expect(res.failedStep).toBe('worker:rivet-embedder.service')
    expect(res.workers).toEqual(['rivet-compactor.service'])
  })
})
