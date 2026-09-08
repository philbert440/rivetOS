import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extraDeviceP12Path,
  identityPathsToReset,
  installDesktopIdentity,
  mintDeviceP12,
  rivethubMtlsDir,
  rivethubUserDataDir,
} from './hub-identity.js'
import { localCaPaths } from './local-ca.js'

const HOME = '/home/tester'

describe('rivethubUserDataDir', () => {
  it('linux → ~/.config/RivetHub', () => {
    expect(rivethubUserDataDir('linux', HOME)).toBe(join(HOME, '.config', 'RivetHub'))
  })

  it('darwin → ~/Library/Application Support/RivetHub', () => {
    expect(rivethubUserDataDir('darwin', HOME)).toBe(
      join(HOME, 'Library', 'Application Support', 'RivetHub'),
    )
  })

  it('win32 → %APPDATA%\\RivetHub (or ~/AppData/Roaming/RivetHub)', () => {
    expect(rivethubUserDataDir('win32', HOME, 'C:\\Users\\tester\\AppData\\Roaming')).toBe(
      join('C:\\Users\\tester\\AppData\\Roaming', 'RivetHub'),
    )
    expect(rivethubUserDataDir('win32', HOME)).toBe(join(HOME, 'AppData', 'Roaming', 'RivetHub'))
  })
})

describe('rivethubMtlsDir', () => {
  it('nests mtls under userData (Electron identityDir)', () => {
    expect(rivethubMtlsDir('linux', HOME)).toBe(join(HOME, '.config', 'RivetHub', 'mtls'))
    expect(rivethubMtlsDir('darwin', HOME)).toBe(
      join(HOME, 'Library', 'Application Support', 'RivetHub', 'mtls'),
    )
  })
})

describe('extraDeviceP12Path', () => {
  it('writes ~/.rivetos/devices/<name>.p12', () => {
    expect(extraDeviceP12Path(HOME, 'phone')).toBe(join(HOME, '.rivetos', 'devices', 'phone.p12'))
  })
})

describe('identityPathsToReset', () => {
  it('stays under ~/.rivetos (does not include RivetHub mtls)', () => {
    const paths = identityPathsToReset(HOME)
    expect(paths.every((p) => p.startsWith(join(HOME, '.rivetos')))).toBe(true)
    expect(paths.some((p) => p.includes('RivetHub'))).toBe(false)
  })
})

describe('installDesktopIdentity', () => {
  it('copies 0600 files and preserves a previous enrollment', () => {
    const home = mkdtempSync(join(tmpdir(), 'hub-id-'))
    try {
      const paths = localCaPaths(home)
      const desktop = 'device-desktop-testhost'
      mkdirSync(join(paths.sharedDir, 'issued'), { recursive: true })
      mkdirSync(join(paths.sharedDir, 'intermediate'), { recursive: true })
      writeFileSync(join(paths.sharedDir, 'issued', `${desktop}.crt`), 'new-cert')
      writeFileSync(join(paths.sharedDir, 'issued', `${desktop}.key`), 'new-key')
      writeFileSync(paths.chainPem, 'new-ca')
      const destDir = rivethubMtlsDir('linux', home)
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, 'device.crt'), 'old-cert')
      writeFileSync(join(destDir, 'device.key'), 'old-key')
      writeFileSync(join(destDir, 'ca.pem'), 'old-ca')
      const installed = installDesktopIdentity({
        home,
        hostname: 'testhost',
        platform: 'linux',
      })
      expect(readFileSync(installed.cert, 'utf-8')).toBe('new-cert')
      expect(statSync(installed.cert).mode & 0o777).toBe(0o600)
      expect(statSync(installed.key).mode & 0o777).toBe(0o600)
      expect(statSync(installed.ca).mode & 0o777).toBe(0o600)
      expect(installed.preservedDir).toBeTruthy()
      expect(readFileSync(join(installed.preservedDir!, 'device.crt'), 'utf-8')).toBe('old-cert')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('mintDeviceP12', () => {
  it('passes passphrase via env:RIVETOS_P12_PASS and omits it from errors', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hub-p12-'))
    try {
      const issued = join(home, '.rivetos', 'shared', 'rivet-ca', 'issued')
      mkdirSync(issued, { recursive: true })
      writeFileSync(join(issued, 'device-phone.crt'), 'c')
      writeFileSync(join(issued, 'device-phone.key'), 'k')
      const exec = vi.fn(
        async (_file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
          expect(args).toContain('env:RIVETOS_P12_PASS')
          expect(args.join(' ')).not.toContain('secret-pass')
          expect(opts?.env?.RIVETOS_P12_PASS).toBe('secret-pass')
          const outIdx = args.indexOf('-out')
          writeFileSync(args[outIdx + 1]!, 'p12')
          return { stdout: '', stderr: '', code: 0, timedOut: false }
        },
      )
      const minted = await mintDeviceP12({
        home,
        name: 'phone',
        passphrase: 'secret-pass',
        exec,
        scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
      })
      expect(minted.p12Path).toBe(join(home, '.rivetos', 'devices', 'phone.p12'))
      expect(statSync(minted.p12Path).mode & 0o777).toBe(0o600)

      const fail = vi.fn(async () => ({
        stdout: '',
        stderr: 'boom',
        code: 1,
        timedOut: false,
      }))
      await expect(
        mintDeviceP12({
          home,
          name: 'phone',
          passphrase: 'secret-pass',
          exec: fail,
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
        }),
      ).rejects.toThrow(/openssl pkcs12/)
      try {
        await mintDeviceP12({
          home,
          name: 'phone',
          passphrase: 'secret-pass',
          exec: fail,
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
        })
      } catch (err) {
        expect((err as Error).message).not.toContain('secret-pass')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
