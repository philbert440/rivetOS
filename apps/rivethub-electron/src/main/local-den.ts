/**
 * First-run local den probe. When RivetHub has no saved gateway, the shell
 * asks localhost:5174 /healthz and, on a hit, writes baseUrl + roster so
 * the renderer hydrates missing keys (settings-sync per-key merge). Real
 * traffic still rides mtls-pipe (CA-pinned, localhost allowed); this path
 * is probe-only.
 *
 * Never throws. Total wall time is ~2× timeoutMs (default ≤ ~3 s). A
 * timed-out attempt aborts the in-flight request so a trickling body
 * cannot outlive the cap.
 */

import * as http from 'node:http'
import * as https from 'node:https'
import type { IncomingMessage, RequestOptions } from 'node:http'

export interface LocalDenHit {
  baseUrl: string
  name: string
}

export interface ProbeLocalDenOpts {
  port?: number
  /** Identity-dir ca.pem when present. */
  caPem?: string
  /** Per-attempt budget. Two attempts fit in ~2× this (default 1500 → ~3 s). */
  timeoutMs?: number
}

/** Test seam — production wraps node:https / node:http. */
export type ProbeGet = (
  kind: 'https' | 'http',
  options: {
    hostname: string
    port: number
    path: string
    ca?: string
    rejectUnauthorized: boolean
    timeoutMs: number
    signal?: AbortSignal
  },
) => Promise<{ statusCode: number; body: string }>

export interface ProbeLocalDenDeps {
  get?: ProbeGet
}

export interface LocalDenSettings {
  get(key: string): unknown
  setAll(updates: Record<string, unknown>): void
}

const DEFAULT_PORT = 5174
const DEFAULT_TIMEOUT_MS = 1500
const MAX_BODY = 64 * 1024
const HEALTHZ_PATH = '/healthz'

export async function probeLocalDen(
  opts: ProbeLocalDenOpts = {},
  deps: ProbeLocalDenDeps = {},
): Promise<LocalDenHit | null> {
  try {
    const port = opts.port ?? DEFAULT_PORT
    const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const get = deps.get ?? defaultGet
    const deadline = Date.now() + timeoutMs * 2
    const caPem = opts.caPem && opts.caPem.length > 0 ? opts.caPem : undefined

    const httpsWithCa =
      caPem !== undefined
        ? await attempt(get, 'https', port, timeoutMs, deadline, {
            ca: caPem,
            rejectUnauthorized: true,
          })
        : undefined

    if (httpsWithCa?.hit) return httpsWithCa.hit

    // Cert errors fail fast — retry without verifying. A CA-path timeout
    // must not consume a second HTTPS budget or HTTP would miss the ~3 s cap.
    const skipInsecureHttps = httpsWithCa?.timeout === true
    if (!skipInsecureHttps) {
      const insecure = await attempt(get, 'https', port, timeoutMs, deadline, {
        rejectUnauthorized: false,
      })
      if (insecure.hit) return insecure.hit
    }

    const plain = await attempt(get, 'http', port, timeoutMs, deadline, {
      rejectUnauthorized: false,
    })
    return plain.hit ?? null
  } catch {
    return null
  }
}

/**
 * If settings have no rivethub.baseUrl and a local den answers, persist
 * baseUrl + a roster row. Existing non-empty baseUrl is left alone. An
 * existing roster is merged: a row with the same baseUrl is kept as-is.
 */
export async function adoptLocalDenIfUnconfigured(
  settings: LocalDenSettings,
  opts: ProbeLocalDenOpts = {},
  deps: ProbeLocalDenDeps = {},
): Promise<LocalDenHit | null> {
  try {
    if (hasBaseUrl(settings.get('rivethub.baseUrl'))) return null
    const hit = await probeLocalDen(opts, deps)
    if (!hit) return null
    settings.setAll({
      'rivethub.baseUrl': hit.baseUrl,
      'rivethub.roster': mergeRoster(settings.get('rivethub.roster'), {
        name: hit.name,
        baseUrl: hit.baseUrl,
      }),
    })
    return hit
  } catch {
    return null
  }
}

function hasBaseUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** Saved-node row written to `rivethub.roster` (same shape as the renderer RosterNode). */
interface RosterEntry {
  name: string
  baseUrl: string
}

function isRosterEntry(value: unknown): value is RosterEntry {
  if (value === null || typeof value !== 'object') return false
  if (!('name' in value) || !('baseUrl' in value)) return false
  return typeof value.name === 'string' && typeof value.baseUrl === 'string'
}

/** Array.isArray narrows to any[]; recast then filter so the merge spread is typed. */
function parseRoster(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) return []
  const items: unknown[] = value as unknown[]
  return items.filter(isRosterEntry)
}

function mergeRoster(existing: unknown, row: RosterEntry): RosterEntry[] {
  const roster = parseRoster(existing)
  if (roster.some((entry) => entry.baseUrl === row.baseUrl)) return roster
  return [...roster, row]
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'ETIMEDOUT'
}

type AttemptResult =
  { hit: LocalDenHit; timeout?: undefined } | { hit?: undefined; timeout: boolean }

async function attempt(
  get: ProbeGet,
  kind: 'https' | 'http',
  port: number,
  timeoutMs: number,
  deadline: number,
  tls: { ca?: string; rejectUnauthorized: boolean },
): Promise<AttemptResult> {
  const budget = Math.min(timeoutMs, remaining(deadline))
  if (budget <= 0) return { timeout: true }
  const abort = new AbortController()
  try {
    const res = await timed(
      get(kind, {
        hostname: 'localhost',
        port,
        path: HEALTHZ_PATH,
        ca: tls.ca,
        rejectUnauthorized: tls.rejectUnauthorized,
        timeoutMs: budget,
        signal: abort.signal,
      }),
      budget,
      abort,
    )
    const parsed = parseHealthz(res.statusCode, res.body)
    if (!parsed) return { timeout: false }
    return {
      hit: { baseUrl: `${kind}://localhost:${String(port)}`, name: parsed.name },
    }
  } catch (err) {
    return { timeout: isTimeout(err) }
  }
}

function parseHealthz(statusCode: number, body: string): { name: string } | null {
  if (statusCode < 200 || statusCode >= 300) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rec = parsed as { ok?: unknown; name?: unknown }
  if (rec.ok !== true) return null
  if (typeof rec.name !== 'string' || rec.name.trim() === '') return null
  return { name: rec.name.trim() }
}

function timed<T>(work: Promise<T>, ms: number, abort?: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      abort?.abort()
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    }, ms)
    work.then(
      (value) => {
        clearTimeout(t)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(t)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

async function defaultGet(
  kind: 'https' | 'http',
  options: {
    hostname: string
    port: number
    path: string
    ca?: string
    rejectUnauthorized: boolean
    timeoutMs: number
    signal?: AbortSignal
  },
): Promise<{ statusCode: number; body: string }> {
  const request = kind === 'https' ? https.request : http.request
  const reqOpts: RequestOptions = {
    hostname: options.hostname,
    port: options.port,
    path: options.path,
    method: 'GET',
    timeout: options.timeoutMs,
    agent: false,
  }
  if (kind === 'https') {
    const tlsOpts = reqOpts as https.RequestOptions
    tlsOpts.rejectUnauthorized = options.rejectUnauthorized
    tlsOpts.servername = options.hostname
    if (options.ca) tlsOpts.ca = options.ca
  }
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, result?: { statusCode: number; body: string }): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(result as { statusCode: number; body: string })
    }
    const req = request(reqOpts, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        size += buf.length
        if (size > MAX_BODY) {
          req.destroy()
          finish(new Error('healthz body too large'))
          return
        }
        chunks.push(buf)
      })
      res.on('end', () => {
        finish(null, {
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      res.on('error', (err: Error) => finish(err))
    })
    const onAbort = (): void => {
      req.destroy()
      finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    }
    req.on('timeout', () => {
      req.destroy()
      finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', (err: Error) => finish(err))
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort)
    }
    req.end()
  })
}
