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
import { basename, dirname, join, resolve, sep } from 'node:path'
import QRCode from 'qrcode'

/** How long a shown QR stays redeemable. */
export const PAIRING_TTL_MS = 10 * 60 * 1000

export interface PairingRecord {
  v: 1
  deviceId: string
  token: string
  passphrase: string
  p12Path: string
  /**
   * The device's issued leaf. Kept after redemption (revocation needs it);
   * deleted with the p12 when the code expires unredeemed, since no device
   * ever held its key.
   */
  certPath?: string
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

/**
 * Where pairing records live. Honours `RIVETOS_DEN_PAIRING_DIR` (same knob
 * den reads) so CLI and den always look at one directory.
 */
export function pairingDir(home: string): string {
  const fromEnv = process.env.RIVETOS_DEN_PAIRING_DIR?.trim()
  if (fromEnv) return fromEnv
  return join(home, '.rivetos', 'devices', 'pairing')
}

/** Where the CLI writes device p12s — independent of a custom pairing dir. */
export function devicesDir(home: string): string {
  return join(home, '.rivetos', 'devices')
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
  certPath?: string
  now?: number
}): PairingRecord {
  mkdirSync(pairingDir(opts.home), { recursive: true, mode: 0o700 })
  const rec: PairingRecord = {
    v: 1,
    deviceId: opts.deviceId,
    token: newToken(),
    passphrase: opts.passphrase,
    p12Path: opts.p12Path,
    ...(opts.certPath ? { certPath: opts.certPath } : {}),
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
 * Only unlink paths the CLI itself writes under `~/.rivetos/` (p12s under
 * `devices/`, unused leaves under `…/issued/device-*.crt`) — same
 * defence-in-depth den applies. A corrupt record must not delete arbitrary
 * files.
 */
function unlinkDeviceArtifact(home: string, path: string | undefined, kind: 'p12' | 'cert'): void {
  if (!path) return
  const p = resolve(path)
  const rivetos = resolve(join(home, '.rivetos')) + sep
  if (!p.startsWith(rivetos)) return
  if (kind === 'p12') {
    const devices = resolve(devicesDir(home)) + sep
    if (p.startsWith(devices) && p.endsWith('.p12')) unlinkQuiet(p)
    return
  }
  // kind === 'cert'
  if (
    basename(dirname(p)) === 'issued' &&
    basename(p).startsWith('device-') &&
    basename(p).endsWith('.crt')
  ) {
    unlinkQuiet(p)
  }
}

/** A still-live (not yet expired) pairing record, or null. Does not mutate. */
export function readLivePairing(
  home: string,
  deviceId: string,
  now = Date.now(),
): PairingRecord | null {
  try {
    const rec = JSON.parse(readFileSync(pairingRecordPath(home, deviceId), 'utf8')) as PairingRecord
    if (typeof rec.expiresAt !== 'number' || rec.expiresAt <= now) return null
    return rec
  } catch {
    return null
  }
}

/**
 * Restart the TTL when the QR is actually shown (after den is ready), so a
 * slow `init` does not eat the scan window. Every call rotates the token, so
 * a copy of an earlier QR (photo, screenshot, scrollback) never redeems. An
 * expired record is gone: it, its p12 and its never-delivered certificate
 * are deleted and the caller mints afresh. Null when the record is gone (redeemed, swept or expired).
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
    unlinkDeviceArtifact(home, rec.p12Path, 'p12')
    unlinkDeviceArtifact(home, rec.certPath, 'cert')
    return null
  }
  rec.token = newToken()
  rec.expiresAt = now + PAIRING_TTL_MS
  writeRecord(path, rec)
  return rec
}

/**
 * For when no QR can be shown (`--no-lan`, no LAN address): drop the pairing
 * record so den's expiry sweep leaves the p12 alone, and return it so the
 * caller can print the p12 path and passphrase for a manual import. With no
 * QR there is nothing to expire — an expired record is handed over the same
 * way (p12 and passphrase kept). Null only when the record is already gone.
 */
export function releasePairing(
  home: string,
  deviceId: string,
  _now = Date.now(),
): PairingRecord | null {
  const path = pairingRecordPath(home, deviceId)
  let rec: PairingRecord
  try {
    rec = JSON.parse(readFileSync(path, 'utf8')) as PairingRecord
  } catch {
    return null
  }
  unlinkQuiet(path)
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
