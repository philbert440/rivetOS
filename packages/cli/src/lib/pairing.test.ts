import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  armPairing,
  certSha256,
  createPairing,
  PAIRING_TTL_MS,
  pairingQrText,
  pairingRecordPath,
  releasePairing,
  renderTerminalQr,
} from './pairing.js'
import { formatPairingQrs } from '../commands/local.js'
import { localCaPaths } from './local-ca.js'

// Throwaway self-signed P-256 leaf (CN=test.mesh); fingerprint from
// `openssl x509 -noout -fingerprint -sha256`.
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

function withHome(fn: (home: string) => Promise<void> | void) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'pairing-cli-'))
    try {
      await fn(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

describe('createPairing / armPairing', () => {
  it(
    'writes an owner-only record with a fresh 256-bit token and a TTL',
    withHome((home) => {
      const rec = createPairing({
        home,
        deviceId: 'pixel',
        p12Path: '/x/pixel.p12',
        passphrase: 'pw',
        now: 1_000,
      })
      const path = pairingRecordPath(home, 'pixel')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(rec)
      expect(rec.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(rec.expiresAt).toBe(1_000 + PAIRING_TTL_MS)

      const again = createPairing({ home, deviceId: 'pixel', p12Path: '/x', passphrase: 'pw' })
      expect(again.token).not.toBe(rec.token)
    }),
  )

  it(
    'arm restarts the TTL, and is null once the record is gone',
    withHome((home) => {
      createPairing({ home, deviceId: 'pixel', p12Path: '/x', passphrase: 'pw', now: 0 })
      expect(armPairing(home, 'pixel', 50_000)?.expiresAt).toBe(50_000 + PAIRING_TTL_MS)
      expect(armPairing(home, 'tablet', 50_000)).toBeNull()
    }),
  )

  it(
    'arm rotates the token, so an earlier QR stops redeeming',
    withHome((home) => {
      const first = createPairing({
        home,
        deviceId: 'pixel',
        p12Path: '/x',
        passphrase: 'pw',
        now: 0,
      })
      const shown = armPairing(home, 'pixel', 1_000)
      expect(shown?.token).not.toBe(first.token)
      const reshown = armPairing(home, 'pixel', 2_000)
      expect(reshown?.token).not.toBe(shown?.token)
      expect(JSON.parse(readFileSync(pairingRecordPath(home, 'pixel'), 'utf8')).token).toBe(
        reshown?.token,
      )
    }),
  )

  it(
    'arm never revives an expired record: it, its p12 and its unused cert are deleted',
    withHome((home) => {
      const p12 = join(home, '.rivetos', 'devices', 'pixel.p12')
      const cert = join(home, '.rivetos', 'shared', 'rivet-ca', 'issued', 'device-pixel.crt')
      mkdirSync(dirname(p12), { recursive: true })
      mkdirSync(dirname(cert), { recursive: true })
      writeFileSync(p12, 'p12')
      writeFileSync(cert, 'crt')
      createPairing({
        home,
        deviceId: 'pixel',
        p12Path: p12,
        certPath: cert,
        passphrase: 'pw',
        now: 0,
      })
      expect(armPairing(home, 'pixel', PAIRING_TTL_MS)).toBeNull()
      expect(existsSync(pairingRecordPath(home, 'pixel'))).toBe(false)
      expect(existsSync(p12)).toBe(false)
      expect(existsSync(cert)).toBe(false)
    }),
  )

  it(
    'arm never unlinks p12/cert paths outside ~/.rivetos/',
    withHome((home) => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'outside-'))
      const p12 = join(elsewhere, 'pixel.p12')
      const cert = join(elsewhere, 'issued', 'device-pixel.crt')
      mkdirSync(join(elsewhere, 'issued'))
      writeFileSync(p12, 'keep')
      writeFileSync(cert, 'keep')
      createPairing({
        home,
        deviceId: 'pixel',
        p12Path: p12,
        certPath: cert,
        passphrase: 'pw',
        now: 0,
      })
      expect(armPairing(home, 'pixel', PAIRING_TTL_MS)).toBeNull()
      expect(existsSync(p12)).toBe(true)
      expect(existsSync(cert)).toBe(true)
      rmSync(elsewhere, { recursive: true, force: true })
    }),
  )

  it(
    'release drops a live record for a manual import and keeps the p12',
    withHome((home) => {
      const p12 = join(home, '.rivetos', 'devices', 'pixel.p12')
      mkdirSync(dirname(p12), { recursive: true })
      writeFileSync(p12, 'p12')
      const rec = createPairing({ home, deviceId: 'pixel', p12Path: p12, passphrase: 'pw', now: 0 })
      expect(releasePairing(home, 'pixel', 1_000)).toEqual(rec)
      expect(existsSync(pairingRecordPath(home, 'pixel'))).toBe(false)
      expect(existsSync(p12)).toBe(true)
      expect(releasePairing(home, 'pixel', 1_000)).toBeNull()
    }),
  )

  it(
    'release hands over an expired record too (no QR means nothing to expire)',
    withHome((home) => {
      const p12 = join(home, '.rivetos', 'devices', 'pixel.p12')
      mkdirSync(dirname(p12), { recursive: true })
      writeFileSync(p12, 'p12')
      const rec = createPairing({
        home,
        deviceId: 'pixel',
        p12Path: p12,
        passphrase: 'secret',
        now: 0,
      })
      const handed = releasePairing(home, 'pixel', PAIRING_TTL_MS)
      expect(handed).toEqual(rec)
      expect(existsSync(pairingRecordPath(home, 'pixel'))).toBe(false)
      expect(existsSync(p12)).toBe(true)
    }),
  )

  it(
    'honours RIVETOS_DEN_PAIRING_DIR for where records are written',
    withHome((home) => {
      const custom = join(home, 'custom-pairing')
      const prev = process.env.RIVETOS_DEN_PAIRING_DIR
      process.env.RIVETOS_DEN_PAIRING_DIR = custom
      try {
        createPairing({
          home,
          deviceId: 'pixel',
          p12Path: '/x',
          passphrase: 'pw',
        })
        expect(existsSync(join(custom, 'pixel.json'))).toBe(true)
        expect(existsSync(join(home, '.rivetos', 'devices', 'pairing', 'pixel.json'))).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.RIVETOS_DEN_PAIRING_DIR
        else process.env.RIVETOS_DEN_PAIRING_DIR = prev
      }
    }),
  )
})

describe('QR payload', () => {
  it('pins the leaf by lowercase hex SHA-256 of its DER', () => {
    expect(certSha256(CERT)).toBe(CERT_SHA256)
  })

  it('is the v1 rivethub-pair JSON the phone parses', () => {
    const text = pairingQrText({ gateway: 'https://10.0.0.5:5174', token: 't', certSha256: 'ab' })
    expect(JSON.parse(text)).toEqual({
      v: 1,
      kind: 'rivethub-pair',
      gateway: 'https://10.0.0.5:5174',
      token: 't',
      certSha256: 'ab',
    })
  })

  it('renders to a terminal block', async () => {
    const out = await renderTerminalQr('hello')
    expect(out.split('\n').length).toBeGreaterThan(10)
  })
})

describe('formatPairingQrs', () => {
  const seed = (home: string) => {
    const cert = localCaPaths(home, 'box').nodeCert
    mkdirSync(join(cert, '..'), { recursive: true })
    writeFileSync(cert, CERT)
    return createPairing({ home, deviceId: 'pixel', p12Path: '/x', passphrase: 'pw' })
  }

  it(
    'shows one QR per pending device, pointed at the first LAN address',
    withHome(async (home) => {
      seed(home)
      const out = await formatPairingQrs({
        home,
        hostname: 'box',
        devices: ['pixel', 'never-minted'],
        port: 5174,
        exposeLan: true,
        lanAddrs: ['192.168.1.20', '10.0.0.2'],
      })
      expect(out).toContain('Pair pixel')
      expect(out).toContain('https://192.168.1.20:5174')
      expect(out).not.toContain('never-minted')
    }),
  )

  it(
    'is empty with nothing to pair',
    withHome(async (home) => {
      const out = await formatPairingQrs({
        home,
        hostname: 'box',
        devices: ['pixel'],
        port: 5174,
        exposeLan: true,
        lanAddrs: ['192.168.1.20'],
      })
      expect(out).toBe('')
    }),
  )

  it(
    'explains instead of throwing when the node certificate is missing',
    withHome(async (home) => {
      createPairing({ home, deviceId: 'pixel', p12Path: '/x', passphrase: 'pw' })
      const out = await formatPairingQrs({
        home,
        hostname: 'box',
        devices: ['pixel'],
        port: 5174,
        exposeLan: true,
        lanAddrs: ['192.168.1.20'],
      })
      expect(out).toContain('cannot read the node certificate')
    }),
  )

  it(
    'explains instead of showing a QR on a loopback-only node',
    withHome(async (home) => {
      seed(home)
      const out = await formatPairingQrs({
        home,
        hostname: 'box',
        devices: ['pixel'],
        port: 5174,
        exposeLan: false,
        lanAddrs: ['192.168.1.20'],
      })
      expect(out).toContain('--no-lan')
      expect(out).not.toContain('https://')
    }),
  )

  it(
    'remints a fresh QR when the previous pairing has expired',
    withHome(async (home) => {
      const cert = localCaPaths(home, 'box').nodeCert
      mkdirSync(dirname(cert), { recursive: true })
      writeFileSync(cert, CERT)
      const p12 = join(home, '.rivetos', 'devices', 'pixel.p12')
      mkdirSync(dirname(p12), { recursive: true })
      writeFileSync(p12, 'old')
      createPairing({
        home,
        deviceId: 'pixel',
        p12Path: p12,
        passphrase: 'old-pw',
        now: 0,
      })
      const mint = async () => {
        const fresh = join(home, '.rivetos', 'devices', 'pixel.p12')
        writeFileSync(fresh, 'new')
        return {
          id: 'pixel',
          p12Path: fresh,
          passphrase: 'new-pw',
          certPath: join(home, '.rivetos', 'shared', 'rivet-ca', 'issued', 'device-pixel.crt'),
        }
      }
      const out = await formatPairingQrs({
        home,
        hostname: 'box',
        devices: ['pixel'],
        port: 5174,
        exposeLan: true,
        lanAddrs: ['192.168.1.20'],
        now: PAIRING_TTL_MS,
        mint: mint as never,
      })
      expect(out).toContain('Previous pairing code for pixel expired')
      expect(out).toContain('Pair pixel')
      expect(out).toContain('https://192.168.1.20:5174')
      expect(existsSync(pairingRecordPath(home, 'pixel'))).toBe(true)
      expect(existsSync(p12)).toBe(true)
    }),
  )

  it(
    'says so when an expired pairing cannot be reminted, instead of printing nothing',
    withHome(async (home) => {
      const cert = localCaPaths(home, 'box').nodeCert
      mkdirSync(dirname(cert), { recursive: true })
      writeFileSync(cert, CERT)
      createPairing({ home, deviceId: 'pixel', p12Path: '/x', passphrase: 'old-pw', now: 0 })
      const mint = async () => {
        throw new Error('rivet-ca.sh: no CA')
      }
      const out = await formatPairingQrs({
        home,
        hostname: 'box',
        devices: ['pixel', 'never-minted'],
        port: 5174,
        exposeLan: true,
        lanAddrs: ['192.168.1.20'],
        mint,
      })
      expect(out).toContain('pixel: the pairing code expired and a fresh one could not be minted')
      expect(out).toContain('rivet-ca.sh: no CA')
      expect(out).toContain('rivetos pair pixel')
      expect(out).not.toContain('never-minted')
      expect(out).not.toContain('https://')
    }),
  )
})
