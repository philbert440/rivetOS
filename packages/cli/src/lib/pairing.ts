/**
 * Phone pairing by QR — the CLI half.
 *
 * `rivetos local --device <id>` mints the device PKCS#12, then writes a
 * one-time pairing record next to it and shows a QR once den is up. The
 * phone scans it, pins the gateway leaf by `certSha256`, and redeems the
 * token at POST /api/devices/pair (services/den-server/src/pairing.ts) for
 * the p12 + passphrase. Den deletes the p12 and the record on redemption.
 */

import { randomBytes, X509Certificate } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'

/** How long a shown QR stays redeemable. */
export const PAIRING_TTL_MS = 10 * 60 * 1000

export interface PairingRecord {
  v: 1
  deviceId: string
  token: string
  passphrase: string
  p12Path: string
  expiresAt: number
}

/** The QR body. Keep in sync with the Android `PairingCode` parser. */
export interface PairingQr {
  v: 1
  kind: 'rivethub-pair'
  gateway: string
  token: string
  certSha256: string
}

export function pairingDir(home: string): string {
  return join(home, '.rivetos', 'devices', 'pairing')
}

export function pairingRecordPath(home: string, deviceId: string): string {
  return join(pairingDir(home), `${deviceId}.json`)
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function writeRecord(path: string, rec: PairingRecord): void {
  writeFileSync(path, JSON.stringify(rec), { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may ignore mode bits
  }
}

/** Write (or replace) the pairing record for a freshly minted p12. */
export function createPairing(opts: {
  home: string
  deviceId: string
  p12Path: string
  passphrase: string
  now?: number
}): PairingRecord {
  mkdirSync(pairingDir(opts.home), { recursive: true, mode: 0o700 })
  const rec: PairingRecord = {
    v: 1,
    deviceId: opts.deviceId,
    token: newToken(),
    passphrase: opts.passphrase,
    p12Path: opts.p12Path,
    expiresAt: (opts.now ?? Date.now()) + PAIRING_TTL_MS,
  }
  writeRecord(pairingRecordPath(opts.home, opts.deviceId), rec)
  return rec
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

/**
 * Restart the TTL when the QR is actually shown (after den is ready), so a
 * slow `init` does not eat the scan window. Every call rotates the token, so
 * a copy of an earlier QR (photo, screenshot, scrollback) never redeems. An
 * expired record is gone: it and its p12 are deleted and the caller mints
 * afresh. Null when the record is gone (redeemed, swept or expired).
 */
export function armPairing(home: string, deviceId: string, now = Date.now()): PairingRecord | null {
  const path = pairingRecordPath(home, deviceId)
  let rec: PairingRecord
  try {
    rec = JSON.parse(readFileSync(path, 'utf8')) as PairingRecord
  } catch {
    return null
  }
  if (typeof rec.expiresAt !== 'number' || rec.expiresAt <= now) {
    unlinkQuiet(path)
    if (typeof rec.p12Path === 'string') unlinkQuiet(rec.p12Path)
    return null
  }
  rec.token = newToken()
  rec.expiresAt = now + PAIRING_TTL_MS
  writeRecord(path, rec)
  return rec
}

/** Lowercase hex SHA-256 of the certificate's DER — what the phone pins. */
export function certSha256(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase()
}

export function pairingQrText(opts: {
  gateway: string
  token: string
  certSha256: string
}): string {
  const qr: PairingQr = {
    v: 1,
    kind: 'rivethub-pair',
    gateway: opts.gateway,
    token: opts.token,
    certSha256: opts.certSha256,
  }
  return JSON.stringify(qr)
}

export async function renderTerminalQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
}
