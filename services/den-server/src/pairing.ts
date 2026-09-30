/**
 * Phone pairing by QR (RivetHub Android enroll).
 *
 * `rivetos local --device <id>` mints the device PKCS#12 and drops a pairing
 * record in `~/.rivetos/devices/pairing/<id>.json`; the terminal shows a QR
 * holding this gateway's URL, the one-time token and the SHA-256 of the
 * gateway's TLS leaf (the phone has no CA yet, so it pins the leaf for this
 * one call). The phone redeems the token here and gets the p12 + passphrase.
 *
 *   POST /api/devices/pair   {token} → {deviceId, p12 (base64), passphrase}
 *
 * The token is the auth (the phone has no client cert yet) — this route sits
 * above the mTLS gate like the WireGuard enroll redemption (auth.ts rule 4).
 * A record redeems once: it is claimed by an atomic rename, and the p12 and
 * the record are deleted after the response, so the computer keeps no copy
 * of the phone's key.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const PAIR_PATH = '/api/devices/pair'

/** On-disk record, written by the CLI (`packages/cli/src/lib/pairing.ts`). */
export interface PairingRecord {
  v: 1
  deviceId: string
  token: string
  passphrase: string
  p12Path: string
  /** Unix ms; the record is refused (and swept) after this. */
  expiresAt: number
}

export interface PairingRoutes {
  /** Handles POST /api/devices/pair; false for any other request. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

export interface PairingRoutesOpts {
  dir: string
  now?: () => number
  log?: (msg: string) => void
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const tokenEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const readToken = (req: IncomingMessage, limit = 4 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += buf.length
      if (size > limit) reject(new Error('body too large'))
      else chunks.push(buf)
    })
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: unknown }
        resolve(typeof body.token === 'string' ? body.token : '')
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

export function parsePairingRecord(raw: string): PairingRecord | null {
  let o: Partial<PairingRecord>
  try {
    o = JSON.parse(raw) as Partial<PairingRecord>
  } catch {
    return null
  }
  if (
    o.v !== 1 ||
    typeof o.deviceId !== 'string' ||
    typeof o.token !== 'string' ||
    o.token.length < 32 ||
    typeof o.passphrase !== 'string' ||
    typeof o.p12Path !== 'string' ||
    typeof o.expiresAt !== 'number'
  ) {
    return null
  }
  return o as PairingRecord
}

const unlinkQuiet = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

export function createPairingRoutes(opts: PairingRoutesOpts): PairingRoutes {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((): void => {})

  /** Live record files in the dir; expired ones (and their p12s) are swept. */
  const liveRecords = (): Array<{ file: string; rec: PairingRecord }> => {
    if (!existsSync(opts.dir)) return []
    const out: Array<{ file: string; rec: PairingRecord }> = []
    for (const name of readdirSync(opts.dir)) {
      if (!name.endsWith('.json')) continue
      const file = join(opts.dir, name)
      let rec: PairingRecord | null
      try {
        rec = parsePairingRecord(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      if (!rec) continue
      if (rec.expiresAt <= now()) {
        unlinkQuiet(file)
        unlinkQuiet(rec.p12Path)
        log(`[den] pairing for ${rec.deviceId} expired — removed`)
        continue
      }
      out.push({ file, rec })
    }
    return out
  }

  return {
    async handle(req, res, url) {
      if (url.pathname !== PAIR_PATH) return false
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' })
        return true
      }
      let token: string
      try {
        token = await readToken(req)
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
        return true
      }
      const hit = token ? liveRecords().find((r) => tokenEqual(r.rec.token, token)) : undefined
      if (!hit) {
        json(res, 403, { error: 'invalid or expired pairing code' })
        return true
      }
      // Claim: rename is atomic, so two phones racing one QR cannot both win.
      const claimed = `${hit.file}.claimed`
      try {
        renameSync(hit.file, claimed)
      } catch {
        json(res, 403, { error: 'invalid or expired pairing code' })
        return true
      }
      let p12: Buffer
      try {
        p12 = readFileSync(hit.rec.p12Path)
      } catch {
        unlinkQuiet(claimed)
        json(res, 410, { error: 'device certificate is gone — pair again' })
        return true
      }
      res.on('close', () => {
        unlinkQuiet(hit.rec.p12Path)
        unlinkQuiet(claimed)
      })
      log(`[den] paired device ${hit.rec.deviceId}`)
      json(res, 200, {
        deviceId: hit.rec.deviceId,
        p12: p12.toString('base64'),
        passphrase: hit.rec.passphrase,
      })
      return true
    },
  }
}
