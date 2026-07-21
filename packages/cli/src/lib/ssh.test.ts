import { describe, it, expect, vi, afterEach } from 'vitest'
import { isSafeArg, assertSafeArg, discoverLocalRivetWorkers } from './ssh.js'
import { execSync } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execSync: vi.fn(real.execSync),
  }
})

const execSyncMock = vi.mocked(execSync)

describe('isSafeArg', () => {
  it('accepts real version tags, channels, users and unit names', () => {
    for (const ok of [
      'main',
      'v0.4.0-beta.6',
      '0.4.0-beta.2',
      'latest',
      'beta',
      'rivet',
      'root',
      'rivet-embedder.service',
      'feat/some-branch',
      'user@host',
      'host:22',
    ]) {
      expect(isSafeArg(ok), ok).toBe(true)
    }
  })

  it('rejects shell metacharacters and empty input', () => {
    for (const bad of [
      '',
      'main; rm -rf /',
      'main && reboot',
      '$(whoami)',
      '`id`',
      'a|b',
      'a b',
      'a>b',
      "a'b",
      'a"b',
      'a\nb',
    ]) {
      expect(isSafeArg(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('assertSafeArg', () => {
  it('returns the value when safe', () => {
    expect(assertSafeArg('v1.2.3', '--version')).toBe('v1.2.3')
  })

  it('throws with the label when unsafe', () => {
    expect(() => assertSafeArg('x; rm -rf /', '--version')).toThrowError(/--version/)
  })
})

describe('discoverLocalRivetWorkers', () => {
  afterEach(() => {
    execSyncMock.mockReset()
    execSyncMock.mockImplementation(
      ((...args: Parameters<typeof execSync>) => {
        // fall through not needed — each test stubs return value
        throw new Error(`unexpected execSync: ${String(args[0])}`)
      }) as typeof execSync,
    )
  })

  it('returns enabled rivet-* units excluding rivetos.service', () => {
    execSyncMock.mockReturnValue(
      'rivetos.service\nrivet-compactor.service\nrivet-embedder.service\n' as unknown as Buffer,
    )
    expect(discoverLocalRivetWorkers()).toEqual([
      'rivet-compactor.service',
      'rivet-embedder.service',
    ])
  })

  it('returns empty when systemctl listing fails', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('no systemd')
    })
    expect(discoverLocalRivetWorkers()).toEqual([])
  })

  it('filters unsafe unit names', () => {
    execSyncMock.mockReturnValue(
      'rivet-ok.service\nrivet-bad;reboot.service\n' as unknown as Buffer,
    )
    expect(discoverLocalRivetWorkers()).toEqual(['rivet-ok.service'])
  })
})
