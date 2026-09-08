import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installLaunchdAgent,
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  stopLaunchdAgent,
} from './launchd.js'

describe('renderLaunchdPlist', () => {
  it('escapes XML, embeds PATH, and logs under ~/.rivetos/logs when logDir is set', () => {
    const xml = renderLaunchdPlist({
      nodePath: '/usr/bin/node',
      cliEntry: '/opt/rivetos/packages/cli/dist/index.js',
      workingDir: '/opt/rivetos',
      logDir: '/home/tester/.rivetos/logs',
      env: {
        PATH: '/usr/bin:/home/tester/.local/bin',
        ANTHROPIC_API_KEY: 'sk&<>"',
      },
    })
    expect(xml).toContain('<string>/usr/bin/node</string>')
    expect(xml).toContain('<string>start</string>')
    expect(xml).toContain('<key>PATH</key>')
    expect(xml).toContain('/home/tester/.local/bin')
    expect(xml).toContain('sk&amp;&lt;&gt;&quot;')
    expect(xml).toContain('/home/tester/.rivetos/logs/launchd.out.log')
    expect(xml).toContain('/home/tester/.rivetos/logs/launchd.err.log')
    expect(xml).not.toContain('/opt/rivetos/launchd.out.log')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<key>RunAtLoad</key>')
  })
})

describe('installLaunchdAgent / stopLaunchdAgent', () => {
  it('writes the plist 0600, bootout then enable then bootstrap, and disable on stop', async () => {
    const home = mkdtempSync(join(tmpdir(), 'launchd-'))
    try {
      const calls: string[][] = []
      const exec = vi.fn(async (_file: string, args: string[]) => {
        calls.push(args)
        return { stdout: '', stderr: '', code: 0, timedOut: false }
      })
      const { plistPath } = await installLaunchdAgent({
        home,
        uid: 501,
        nodePath: '/usr/bin/node',
        cliEntry: '/opt/rivetos/packages/cli/dist/index.js',
        workingDir: '/opt/rivetos',
        env: { PATH: '/usr/bin:/home/tester/.local/bin', RIVETOS_MODE: 'workspace' },
        exec,
      })
      expect(plistPath).toBe(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))
      expect(statSync(plistPath).mode & 0o777).toBe(0o600)
      const body = readFileSync(plistPath, 'utf-8')
      expect(body).toContain('RIVETOS_MODE')
      expect(body).toContain('/home/tester/.local/bin')
      expect(calls[0]).toEqual(['bootout', `gui/501/${LAUNCHD_LABEL}`])
      expect(calls[1]).toEqual(['enable', `gui/501/${LAUNCHD_LABEL}`])
      expect(calls[2]?.[0]).toBe('bootstrap')
      expect(calls[2]?.[1]).toBe('gui/501')
      expect(calls[2]?.[2]).toBe(plistPath)

      await stopLaunchdAgent({ uid: 501, exec })
      expect(calls.some((a) => a[0] === 'bootout')).toBe(true)
      expect(calls.some((a) => a[0] === 'disable')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('treats spawn error (code null) on bootstrap as failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'launchd-null-'))
    try {
      const exec = vi.fn(async (_file: string, args: string[]) => {
        if (args[0] === 'enable') {
          return { stdout: '', stderr: '', code: 0, timedOut: false }
        }
        return { stdout: '', stderr: 'spawn launchctl ENOENT', code: null, timedOut: false }
      })
      await expect(
        installLaunchdAgent({
          home,
          uid: 501,
          nodePath: '/usr/bin/node',
          cliEntry: '/opt/rivetos/packages/cli/dist/index.js',
          workingDir: '/opt/rivetos',
          env: {},
          exec,
        }),
      ).rejects.toThrow(/launchctl bootstrap failed/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('stopLaunchdAgent ignores a missing job and fails on a real bootout error', async () => {
    const missing = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'bootout') {
        return { stdout: '', stderr: 'Could not find specified service', code: 5, timedOut: false }
      }
      return { stdout: '', stderr: '', code: 0, timedOut: false }
    })
    await stopLaunchdAgent({ uid: 501, exec: missing })

    const boom = vi.fn(async () => ({
      stdout: '',
      stderr: 'permission denied',
      code: 1,
      timedOut: false,
    }))
    await expect(stopLaunchdAgent({ uid: 501, exec: boom })).rejects.toThrow(
      /launchctl bootout failed/,
    )
  })
})
