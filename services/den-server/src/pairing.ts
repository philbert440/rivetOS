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
import { execFile } from 'node:child_process'
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

export type PairingState = 'pending' | 'paired' | 'expired'

export interface PairingRoutes {
  /** Handles POST /api/devices/pair; false for any other request. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  /** Where a device's pairing stands, for Settings → Pair a phone. */
  status(deviceId: string): PairingState
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
  /** deviceId → when this den handed it its p12. In memory: a restart forgets. */
  const redeemed = new Map<string, number>()

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
    status(deviceId) {
      const file = join(opts.dir, `${deviceId}.json`)
      let rec: PairingRecord | null = null
      try {
        rec = parsePairingRecord(readFileSync(file, 'utf8'))
      } catch {
        // no pending record
      }
      // A newer pending code outranks an older redemption (re-pairing).
      if (rec && rec.expiresAt > now()) return 'pending'
      return redeemed.has(deviceId) ? 'paired' : 'expired'
    },
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
      redeemed.set(hit.rec.deviceId, now())
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

// ---------------------------------------------------------------------------
// Settings → Pair a phone (behind the mTLS gate, owner only)
// ---------------------------------------------------------------------------

export const PHONE_PAIRING_PATH = '/api/phone-pairing'

/** Same charset the CA accepts for a client leaf name (CLI `rivetos pair`). */
const DEVICE_NAME = /^[A-Za-z0-9._-]{1,64}$/

/** What `rivetos pair <name> --json` prints. */
export interface PairCliResult {
  deviceId: string
  gateway: string
  expiresAt: number
  qrText: string
  reshown: boolean
  addedToUsers: boolean
}

/** Runs `rivetos pair <name> --json`; resolves its stdout, rejects on spawn failure. */
export type RunPairCli = (name: string) => Promise<{ stdout: string; code: number | null }>

export interface PhonePairingAdminOpts {
  pairing: PairingRoutes
  /** `rivetos` CLI entry (packages/cli/dist/index.js); absent = unavailable. */
  cliPath?: string
  /** The CA root this node signs device leaves with; absent = unavailable. */
  caRootDir: string
  run?: RunPairCli
  /** Re-read users.json after a new device was added, so it works without a restart. */
  reloadUsers: () => void
  exists?: (path: string) => boolean
  log?: (msg: string) => void
}

export interface PhonePairingAdmin {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

const readJsonBody = (req: IncomingMessage, limit = 4 * 1024): Promise<Record<string, unknown>> =>
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        resolve(body && typeof body === 'object' ? (body as Record<string, unknown>) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

function defaultRunPairCli(cliPath: string): RunPairCli {
  return (name) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [cliPath, 'pair', name, '--json'],
        { env: process.env, timeout: 60_000, maxBuffer: 256 * 1024 },
        (err, stdout) => {
          if (err && typeof (err as { code?: unknown }).code !== 'number') {
            reject(err instanceof Error ? err : new Error('rivetos pair failed to start'))
            return
          }
          resolve({ stdout, code: err ? ((err as { code?: number }).code ?? 1) : 0 })
        },
      )
    })
}

/**
 * Settings → Pair a phone. Mints a pairing code the same way the terminal
 * does — it runs `rivetos pair <name> --json`, so certificates are minted in
 * one place — and reloads users.json so the phone can use the API as soon
 * as it redeems, with no den restart. Mounted behind the mTLS gate; the
 * caller checks the requester is the owner (pairing adds a device with the
 * owner's access).
 *
 *   GET  /api/phone-pairing           → {available, reason?}
 *   POST /api/phone-pairing   {name}  → PairCliResult (qrText rendered by the client)
 *   GET  /api/phone-pairing/<device>  → {state: pending | paired | expired}
 */
export function createPhonePairingAdmin(opts: PhonePairingAdminOpts): PhonePairingAdmin {
  const exists = opts.exists ?? existsSync
  const log = opts.log ?? ((): void => {})
  const unavailable = (): string | null => {
    if (!opts.cliPath || !exists(opts.cliPath)) return 'the rivetos CLI is not found on this node'
    if (!exists(opts.caRootDir))
      return 'this node does not hold the device CA; pair from the node that does'
    return null
  }
  const run = opts.run ?? (opts.cliPath ? defaultRunPairCli(opts.cliPath) : undefined)

  return {
    async handle(req, res, url) {
      const path = url.pathname
      if (path !== PHONE_PAIRING_PATH && !path.startsWith(`${PHONE_PAIRING_PATH}/`)) return false

      if (path === PHONE_PAIRING_PATH && req.method === 'GET') {
        const reason = unavailable()
        json(res, 200, reason ? { available: false, reason } : { available: true })
        return true
      }

      if (path === PHONE_PAIRING_PATH && req.method === 'POST') {
        const reason = unavailable()
        if (reason || !run) {
          json(res, 503, { error: reason ?? 'phone pairing unavailable' })
          return true
        }
        let name: string
        try {
          const body = await readJsonBody(req)
          name = typeof body.name === 'string' ? body.name.trim() : ''
        } catch (e) {
          json(res, 400, { error: (e as Error).message })
          return true
        }
        if (!DEVICE_NAME.test(name)) {
          json(res, 400, { error: 'name may only use letters, digits, ".", "_" and "-"' })
          return true
        }
        let out: { stdout: string; code: number | null }
        try {
          out = await run(name)
        } catch (e) {
          log(`[den] phone pairing: rivetos pair failed to run: ${(e as Error).message}`)
          json(res, 500, { error: 'could not run rivetos pair' })
          return true
        }
        const line = out.stdout.trim().split('\n').at(-1) ?? ''
        let parsed: Partial<PairCliResult> & { error?: string }
        try {
          parsed = JSON.parse(line) as Partial<PairCliResult> & { error?: string }
        } catch {
          json(res, 500, { error: 'rivetos pair gave no result' })
          return true
        }
        if (out.code !== 0 || parsed.error || typeof parsed.qrText !== 'string') {
          // The CLI's own message (e.g. the name already has a certificate).
          json(res, 409, { error: parsed.error ?? 'pairing failed' })
          return true
        }
        if (parsed.addedToUsers) opts.reloadUsers()
        log(`[den] pairing code ready for ${name}`)
        json(res, 200, parsed)
        return true
      }

      const id = decodeURIComponent(path.slice(PHONE_PAIRING_PATH.length + 1))
      if (req.method === 'GET' && DEVICE_NAME.test(id)) {
        json(res, 200, { state: opts.pairing.status(id) })
        return true
      }
      json(res, 404, { error: 'not found' })
      return true
    },
  }
}
