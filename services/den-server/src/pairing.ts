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
 * of the phone's key. The device's certificate stays in `issued/` so it can
 * be revoked, unless the code expires unredeemed or the response never
 * reached the phone: then no device holds its key, and it is deleted too so
 * the name can be paired again.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const PAIR_PATH = '/api/devices/pair'

/** On-disk record, written by the CLI (`packages/cli/src/lib/pairing.ts`). */
export interface PairingRecord {
  v: 1
  deviceId: string
  token: string
  passphrase: string
  p12Path: string
  /** The device's issued leaf (`issued/device-<id>.crt`), when the CLI recorded it. */
  certPath?: string
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

/**
 * Reads a small JSON body. An oversized one is refused and the connection
 * dropped, so a client cannot keep streaming into a route that sits above
 * the mTLS gate.
 */
const readBody = (req: IncomingMessage, limit = 4 * 1024): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += buf.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(buf)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown)
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })

const readToken = async (req: IncomingMessage): Promise<string> => {
  const body = (await readBody(req)) as { token?: unknown } | null
  return body && typeof body.token === 'string' ? body.token : ''
}

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
    (o.certPath !== undefined && typeof o.certPath !== 'string') ||
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
  /** Where the CLI writes p12s (`~/.rivetos/devices`, the pairing dir's parent). */
  const devicesDir = resolve(dirname(opts.dir))

  // A record is data on disk: only delete files where the CLI puts them.
  const unlinkP12 = (rec: PairingRecord): void => {
    const p = resolve(rec.p12Path)
    if (p.startsWith(devicesDir + sep) && p.endsWith('.p12')) unlinkQuiet(p)
  }
  /** Only for a leaf no device holds the key of (expired, or never delivered). */
  const unlinkUnusedCert = (rec: PairingRecord): void => {
    if (!rec.certPath) return
    const p = resolve(rec.certPath)
    if (basename(p) === `device-${rec.deviceId}.crt` && basename(dirname(p)) === 'issued') {
      unlinkQuiet(p)
    }
  }

  /**
   * Live record files in the dir. Expired ones are swept with their p12 and
   * unused cert, and so is a claim left behind by a crash mid-response
   * (whether the phone got that p12 is unknown, so its cert stays).
   */
  const liveRecords = (): Array<{ file: string; rec: PairingRecord }> => {
    if (!existsSync(opts.dir)) return []
    const out: Array<{ file: string; rec: PairingRecord }> = []
    for (const name of readdirSync(opts.dir)) {
      const claimed = name.endsWith('.json.claimed')
      if (!name.endsWith('.json') && !claimed) continue
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
        unlinkP12(rec)
        if (!claimed) unlinkUnusedCert(rec)
        log(`[den] pairing for ${rec.deviceId} expired — removed`)
        continue
      }
      if (!claimed) out.push({ file, rec })
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
      // 'finish' means the whole response was handed to the socket; a close
      // without it means the phone never got its key. Either way the code is
      // spent, but only a delivered pairing shows as paired and keeps its cert.
      let delivered = false
      res.on('finish', () => {
        delivered = true
        redeemed.set(hit.rec.deviceId, now())
        log(`[den] paired device ${hit.rec.deviceId}`)
      })
      res.on('close', () => {
        unlinkP12(hit.rec)
        unlinkQuiet(claimed)
        if (!delivered) {
          unlinkUnusedCert(hit.rec)
          log(`[den] pairing response for ${hit.rec.deviceId} was not delivered — show a new code`)
        }
      })
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

/** Runs `rivetos pair <args…>`; resolves its stdout, rejects on spawn failure. */
export type RunPairCli = (args: string[]) => Promise<{ stdout: string; code: number | null }>

/** A host the phone can dial, as Settings may pass it to `--host`. */
const HOST = /^[A-Za-z0-9.:[\]-]{1,253}$/

/** How long a `rivetos pair --check` answer is reused for GET availability. */
const CHECK_TTL_MS = 30_000

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
  now?: () => number
}

export interface PhonePairingAdmin {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
}

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const body = await readBody(req)
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

/** The last line of `rivetos pair … --json` output, parsed; null when there is none. */
function lastJsonLine(stdout: string): (Record<string, unknown> & { error?: string }) | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function defaultRunPairCli(cliPath: string): RunPairCli {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [cliPath, 'pair', ...args],
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
 *   GET  /api/phone-pairing                 → {available, reason?, gateway?}
 *   POST /api/phone-pairing   {name, host?} → PairCliResult (qrText rendered by the client)
 *   GET  /api/phone-pairing/<device>        → {state: pending | paired | expired}
 *
 * Availability runs `rivetos pair --check --json`, the same checks a mint
 * runs (den reachable off loopback, `den.tls_cert` readable, an address for
 * the QR), so the button is only offered when minting can work.
 */
export function createPhonePairingAdmin(opts: PhonePairingAdminOpts): PhonePairingAdmin {
  const exists = opts.exists ?? existsSync
  const log = opts.log ?? ((): void => {})
  const now = opts.now ?? Date.now
  const unavailable = (): string | null => {
    if (!opts.cliPath || !exists(opts.cliPath)) return 'the rivetos CLI is not found on this node'
    if (!exists(opts.caRootDir))
      return 'this node does not hold the device CA; pair from the node that does'
    return null
  }
  const run = opts.run ?? (opts.cliPath ? defaultRunPairCli(opts.cliPath) : undefined)

  let checked: { at: number; body: Record<string, unknown> } | null = null
  const availability = async (): Promise<Record<string, unknown>> => {
    const reason = unavailable()
    if (reason || !run) return { available: false, reason: reason ?? 'phone pairing unavailable' }
    if (checked && now() - checked.at < CHECK_TTL_MS) return checked.body
    let body: Record<string, unknown>
    try {
      const out = lastJsonLine((await run(['--check', '--json'])).stdout)
      body =
        !out || typeof out.error === 'string'
          ? { available: false, reason: out?.error ?? 'rivetos pair --check gave no result' }
          : {
              available: true,
              ...(typeof out.gateway === 'string' ? { gateway: out.gateway } : {}),
            }
    } catch (e) {
      log(`[den] phone pairing: rivetos pair --check failed to run: ${(e as Error).message}`)
      body = { available: false, reason: 'could not run rivetos pair' }
    }
    checked = { at: now(), body }
    return body
  }

  return {
    async handle(req, res, url) {
      const path = url.pathname
      if (path !== PHONE_PAIRING_PATH && !path.startsWith(`${PHONE_PAIRING_PATH}/`)) return false

      if (path === PHONE_PAIRING_PATH && req.method === 'GET') {
        json(res, 200, await availability())
        return true
      }

      if (path === PHONE_PAIRING_PATH && req.method === 'POST') {
        const reason = unavailable()
        if (reason || !run) {
          json(res, 503, { error: reason ?? 'phone pairing unavailable' })
          return true
        }
        let name: string
        let host: string
        try {
          const body = await readJsonBody(req)
          name = typeof body.name === 'string' ? body.name.trim() : ''
          host = typeof body.host === 'string' ? body.host.trim() : ''
        } catch (e) {
          json(res, 400, { error: (e as Error).message })
          return true
        }
        if (!DEVICE_NAME.test(name)) {
          json(res, 400, { error: 'name may only use letters, digits, ".", "_" and "-"' })
          return true
        }
        if (host && !HOST.test(host)) {
          json(res, 400, { error: 'host must be an IP address or a host name' })
          return true
        }
        let out: { stdout: string; code: number | null }
        try {
          out = await run([name, '--json', ...(host ? ['--host', host] : [])])
        } catch (e) {
          log(`[den] phone pairing: rivetos pair failed to run: ${(e as Error).message}`)
          json(res, 500, { error: 'could not run rivetos pair' })
          return true
        }
        const parsed = lastJsonLine(out.stdout) as
          (Partial<PairCliResult> & { error?: string }) | null
        if (!parsed) {
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

      let id: string
      try {
        id = decodeURIComponent(path.slice(PHONE_PAIRING_PATH.length + 1))
      } catch {
        json(res, 400, { error: 'malformed device name' })
        return true
      }
      if (req.method === 'GET' && DEVICE_NAME.test(id)) {
        json(res, 200, { state: opts.pairing.status(id) })
        return true
      }
      json(res, 404, { error: 'not found' })
      return true
    },
  }
}
