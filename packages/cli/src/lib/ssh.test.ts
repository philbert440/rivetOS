import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isSafeArg,
  assertSafeArg,
  quoteShellArg,
  discoverLocalRivetWorkers,
  restartViaSystemd,
} from './ssh.js'
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
      '2001:db8::1',
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
      'foo$bar',
      'a|b',
      'a b',
      'a>b',
      "a'b",
      'a"b',
      'a\nb',
      'host;rm',
    ]) {
      expect(isSafeArg(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('quoteShellArg', () => {
  it('wraps a simple path in single quotes', () => {
    expect(quoteShellArg('/opt/rivetos')).toBe("'/opt/rivetos'")
  })

  it('preserves spaces inside the quotes', () => {
    expect(quoteShellArg('/opt/rivet os')).toBe("'/opt/rivet os'")
  })

  it("escapes embedded single quotes with the POSIX '\\'' sequence", () => {
    expect(quoteShellArg("/opt/rivet's")).toBe("'/opt/rivet'\\''s'")
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

describe('restartViaSystemd', () => {
  afterEach(() => {
    execSyncMock.mockReset()
  })

  /** Commands the mock was asked to run, in order. */
  const calls = () => execSyncMock.mock.calls.map((c) => String(c[0]))

  it('stops at system scope when the unit restarts there', () => {
    execSyncMock.mockReturnValue('' as unknown as Buffer)
    expect(restartViaSystemd()).toBe(true)
    expect(calls()).toEqual(['systemctl restart rivetos'])
  })

  // Some nodes run the agent runtime as a user unit; both system-scope
  // commands fail with "Unit rivetos.service not found" and the update used to
  // give up, leaving the node on the old build with the new one on disk.
  it('falls back to the per-user manager without escalating to sudo', () => {
    execSyncMock.mockImplementation(((cmd: string) => {
      if (String(cmd).includes('--user')) return '' as unknown as Buffer
      throw new Error('Unit rivetos.service not found.')
    }) as typeof execSync)
    expect(restartViaSystemd()).toBe(true)
    expect(calls()).toEqual(['systemctl restart rivetos', 'systemctl --user restart rivetos'])
    expect(calls().some((c) => c.startsWith('sudo'))).toBe(false)
  })

  it('still escalates to sudo for a system unit needing privileges', () => {
    execSyncMock.mockImplementation(((cmd: string) => {
      if (String(cmd).startsWith('sudo ')) return '' as unknown as Buffer
      throw new Error('Interactive authentication required.')
    }) as typeof execSync)
    expect(restartViaSystemd()).toBe(true)
    expect(calls()).toEqual([
      'systemctl restart rivetos',
      'systemctl --user restart rivetos',
      'sudo systemctl restart rivetos',
    ])
  })

  it('returns false when every scope fails', () => {
    execSyncMock.mockImplementation((() => {
      throw new Error('no systemd')
    }) as typeof execSync)
    expect(restartViaSystemd()).toBe(false)
    expect(calls()).toHaveLength(3)
  })

  it('refuses an unsafe unit name without running anything', () => {
    expect(restartViaSystemd('rivetos;reboot')).toBe(false)
    expect(execSyncMock).not.toHaveBeenCalled()
  })
})
