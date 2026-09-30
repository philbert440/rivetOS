import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDenForPairing, runPair } from './pair.js'
import { pairingRecordPath } from '../lib/pairing.js'

// Throwaway self-signed P-256 leaf (same one lib/pairing.test.ts pins).
const CERT = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUeftII8uGDz0GIq3GRfKuY4abqJMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJdGVzdC5tZXNoMB4XDTI2MDkzMDE1NDAyNVoXDTM2MDkyNzE1
NDAyNVowFDESMBAGA1UEAwwJdGVzdC5tZXNoMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE4mAjm4fe8MIe4cLK4mqVIHIBDt2IxgSjQxq4U2OnM6LFXK8lTyrHSw9S
qeSaJIUl8o5cN+t5W2sAYgAJhal7ZqNTMFEwHQYDVR0OBBYEFNaeKB+z3W5npZdQ
UmjiE8rzbgAAMB8GA1UdIwQYMBaAFNaeKB+z3W5npZdQUmjiE8rzbgAAMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAN7sbx1m5LNfbIJqkDlw6T2G
GpUBux6iHkHNwBl6aw0yAiBb1Y19AqndZYzJH7XGWkIaZTAiP9X4EqTLYxx1RORM
uA==
-----END CERTIFICATE-----
`
const CERT_SHA256 = '022ab72bf949c39a134d766ece5b288c60b51780c77540bf84f16b4944e37433'

/** A mesh node's home: config.yaml pointing den at its own node leaf, a users.json. */
function meshHome(): {
  home: string
  config: string
  users: string
  issued: string
  cleanup: () => void
} {
  const home = mkdtempSync(join(tmpdir(), 'pair-cmd-'))
  const issued = join(home, '.rivetos', 'shared', 'rivet-ca', 'issued')
  mkdirSync(issued, { recursive: true })
  writeFileSync(join(issued, 'arctic.crt'), CERT)
  const config = join(home, '.rivetos', 'config.yaml')
  const configText = [
    'memory:',
    '  postgres: {}',
    'den:',
    '  enabled: true',
    '  host: 0.0.0.0',
    '  port: 5174',
    `  tls_cert: ${join(issued, 'arctic.crt')}`,
    `  tls_key: ${join(issued, 'arctic.key')}`,
    '',
  ].join('\n')
  writeFileSync(config, configText)
  const users = join(home, '.rivetos', 'shared', 'rivetos', 'users.json')
  mkdirSync(join(home, '.rivetos', 'shared', 'rivetos'), { recursive: true })
  writeFileSync(
    users,
    JSON.stringify({
      ownerUserId: 'owner',
      unmappedIsOwner: false,
      users: { owner: { devices: ['desktop-arctic', 'phone-alex'] } },
    }),
  )
  return {
    home,
    config,
    users,
    issued,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

/** rivet-ca.sh issue-client + openssl pkcs12, faked: writes the files each would. */
function fakeCa(issued: string) {
  return vi.fn(async (file: string, args: string[]) => {
    const issue = args.indexOf('issue-client')
    if (issue >= 0) {
      writeFileSync(join(issued, `device-${args[issue + 1]}.crt`), 'c')
      writeFileSync(join(issued, `device-${args[issue + 1]}.key`), 'k')
    }
    const out = args.indexOf('-out')
    if (file === 'openssl' && out >= 0) writeFileSync(args[out + 1]!, 'p12')
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  })
}

describe('readDenForPairing', () => {
  it('reads the port and the certificate den serves', () => {
    expect(readDenForPairing('den:\n  port: 6000\n  tls_cert: /x/arctic.crt\n')).toEqual({
      port: 6000,
      tlsCert: '/x/arctic.crt',
    })
    expect(readDenForPairing('den:\n  tls_cert: /x/a.crt\n').port).toBe(5174)
  })

  it('refuses a den the phone cannot reach or pin', () => {
    expect(() => readDenForPairing('memory: {}\n')).toThrow(/not enabled/)
    expect(() => readDenForPairing('den:\n  enabled: false\n')).toThrow(/not enabled/)
    expect(() => readDenForPairing('den:\n  host: 127.0.0.1\n  tls_cert: /x\n')).toThrow(
      /127\.0\.0\.1/,
    )
    expect(() => readDenForPairing('den:\n  port: 5174\n')).toThrow(/tls_cert/)
  })
})

describe('runPair', () => {
  it('mints, allows and shows a QR without touching config.yaml', async () => {
    const m = meshHome()
    try {
      const before = readFileSync(m.config, 'utf-8')
      const exec = fakeCa(m.issued)
      const lines: string[] = []
      const res = await runPair(
        'phone-alex-debug',
        {},
        {
          home: m.home,
          configPath: m.config,
          usersFile: m.users,
          lanAddrs: ['192.168.0.183'],
          exec,
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
          log: (l) => lines.push(l),
        },
      )
      expect(readFileSync(m.config, 'utf-8')).toBe(before)
      expect(res.gateway).toBe('https://192.168.0.183:5174')
      expect(res.addedToUsers).toBe(true)
      expect(res.reshown).toBe(false)
      const qr = JSON.parse(res.qrText) as { gateway: string; certSha256: string; token: string }
      expect(qr.gateway).toBe('https://192.168.0.183:5174')
      // Pins the leaf named by den.tls_cert (arctic.crt), not the local-mode one.
      expect(qr.certSha256).toBe(CERT_SHA256)
      const rec = JSON.parse(readFileSync(pairingRecordPath(m.home, 'phone-alex-debug'), 'utf8'))
      expect(rec.token).toBe(qr.token)
      expect(existsSync(join(m.home, '.rivetos', 'devices', 'phone-alex-debug.p12'))).toBe(true)
      const users = JSON.parse(readFileSync(m.users, 'utf8'))
      expect(users.users.owner.devices).toEqual([
        'desktop-arctic',
        'phone-alex',
        'phone-alex-debug',
      ])
      expect(lines.join('\n')).toMatch(/restart/)
    } finally {
      m.cleanup()
    }
  })

  it('quiet mode returns the result with its expiry and prints nothing', async () => {
    const m = meshHome()
    try {
      const lines: string[] = []
      const res = await runPair(
        'tablet',
        {},
        {
          home: m.home,
          configPath: m.config,
          usersFile: m.users,
          lanAddrs: ['10.0.0.2'],
          exec: fakeCa(m.issued),
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
          now: 1_000,
          quiet: true,
          log: (l) => lines.push(l),
        },
      )
      expect(lines).toEqual([])
      expect(res.expiresAt).toBe(1_000 + 10 * 60 * 1000)
      expect(JSON.parse(res.qrText).kind).toBe('rivethub-pair')
    } finally {
      m.cleanup()
    }
  })

  it('re-shows a pending pairing instead of minting again', async () => {
    const m = meshHome()
    try {
      const deps = {
        home: m.home,
        configPath: m.config,
        usersFile: m.users,
        lanAddrs: ['10.0.0.2'],
        exec: fakeCa(m.issued),
        scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
        log: () => {},
      }
      const first = await runPair('tablet', {}, deps)
      const exec = fakeCa(m.issued)
      const again = await runPair('tablet', {}, { ...deps, exec })
      expect(again.reshown).toBe(true)
      expect(again.addedToUsers).toBe(false)
      expect(JSON.parse(again.qrText).token).toBe(JSON.parse(first.qrText).token)
      expect(exec).not.toHaveBeenCalled()
    } finally {
      m.cleanup()
    }
  })

  it('leaves tenancy off: no users.json is created when there is none', async () => {
    const m = meshHome()
    try {
      rmSync(m.users)
      const res = await runPair(
        'tablet',
        {},
        {
          home: m.home,
          configPath: m.config,
          usersFile: m.users,
          lanAddrs: ['10.0.0.2'],
          exec: fakeCa(m.issued),
          scriptPath: '/opt/rivetos/scripts/rivet-ca.sh',
          log: () => {},
        },
      )
      expect(res.addedToUsers).toBe(false)
      expect(existsSync(m.users)).toBe(false)
    } finally {
      m.cleanup()
    }
  })

  it('never re-mints a device that already has a certificate', async () => {
    const m = meshHome()
    try {
      writeFileSync(join(m.issued, 'device-phone-alex.crt'), 'live cert')
      writeFileSync(join(m.issued, 'device-phone-alex.key'), 'live key')
      const exec = fakeCa(m.issued)
      await expect(
        runPair(
          'phone-alex',
          {},
          {
            home: m.home,
            configPath: m.config,
            usersFile: m.users,
            lanAddrs: ['10.0.0.2'],
            exec,
            log: () => {},
          },
        ),
      ).rejects.toThrow(/already has a certificate/)
      expect(exec).not.toHaveBeenCalled()
      expect(readFileSync(join(m.issued, 'device-phone-alex.key'), 'utf8')).toBe('live key')
    } finally {
      m.cleanup()
    }
  })

  it('rejects a bad name and a host-less network', async () => {
    const m = meshHome()
    try {
      const deps = { home: m.home, configPath: m.config, usersFile: m.users, log: () => {} }
      await expect(runPair('my phone', {}, { ...deps, lanAddrs: ['10.0.0.2'] })).rejects.toThrow(
        /letters/,
      )
      await expect(runPair('tablet', {}, { ...deps, lanAddrs: [] })).rejects.toThrow(/--host/)
    } finally {
      m.cleanup()
    }
  })
})
