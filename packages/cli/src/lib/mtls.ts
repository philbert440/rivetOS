/**
 * mTLS helpers for mesh-to-mesh HTTPS calls.
 *
 * Builds an undici dispatcher carrying this node's client cert/key so mesh peers
 * can authenticate us. Falls back gracefully (no dispatcher) when certs aren't
 * present, leaving the caller to proceed without mTLS.
 *
 * ⚠️ The dispatcher MUST be used with undici's own `fetch` (`meshFetch` below),
 * never Node's global fetch: the Agent comes from the node_modules `undici`
 * (8.x) while Node's global fetch is backed by a different bundled undici whose
 * dispatcher handler interface is incompatible. Handing our Agent to global
 * fetch throws `invalid onRequestStart method (UND_ERR_INVALID_ARG)` before the
 * request leaves the host — which surfaced as `rivetos mesh ping` reporting
 * "fetch failed" for every node fleet-wide (2026-09-04) while the certs were
 * fine. Same rule as packages/core/src/domain/mesh-delegation.ts.
 */

import { readFileSync } from 'node:fs'
import { sharedPath } from '@rivetos/types'
import { resolveLocalNodeName } from './node-identity.js'

/** CA chain path; RIVETOS_TLS_CA overrides (tests, off-share nodes), like RIVETOS_TLS_CERT/KEY. */
function caPath(): string {
  // Empty string = unset (an empty override must not silently drop mTLS).
  const override = process.env.RIVETOS_TLS_CA
  return override ? override : sharedPath('rivet-ca', 'intermediate', 'ca-chain.pem')
}

/**
 * Build an undici Agent dispatcher with this node's mTLS client cert, or
 * `undefined` if certs can't be resolved/read.
 */
export async function buildMeshDispatcher(): Promise<unknown> {
  try {
    const { Agent: UndiciAgent } = await import('undici')
    const nodeName = resolveLocalNodeName()
    const certPath =
      process.env.RIVETOS_TLS_CERT ??
      (nodeName ? sharedPath('rivet-ca', 'issued', `${nodeName}.crt`) : null)
    const keyPath =
      process.env.RIVETOS_TLS_KEY ??
      (nodeName ? sharedPath('rivet-ca', 'issued', `${nodeName}.key`) : null)

    if (!certPath || !keyPath) return undefined

    const ca = readFileSync(caPath())
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)

    return new UndiciAgent({ connect: { ca, cert, key, rejectUnauthorized: true } })
  } catch (err: unknown) {
    // Certs not available — caller proceeds without mTLS dispatcher. Silent by
    // default (nodes without certs are normal); RIVETOS_MTLS_DEBUG=1 surfaces why.
    if (process.env.RIVETOS_MTLS_DEBUG) {
      console.error(`[mtls] no dispatcher: ${(err as Error).message}`)
    }
    return undefined
  }
}

/** Options for meshFetch: standard fetch init plus a timeout (default 5 s). */
export interface MeshFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** The subset of the Response API mesh callers use (undici's Response). */
export interface MeshFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

/**
 * Perform a mesh HTTPS call with this node's mTLS client cert. Uses undici's
 * own `fetch` so it and the dispatcher come from the same undici instance (see
 * the file comment). Falls back to a plain undici fetch when certs are absent.
 */
export async function meshFetch(url: string, init: MeshFetchInit = {}): Promise<MeshFetchResponse> {
  const { fetch: undiciFetch } = await import('undici')
  const dispatcher = await buildMeshDispatcher()
  const { timeoutMs, ...rest } = init
  const req: Record<string, unknown> = {
    ...rest,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? 5000),
  }
  if (dispatcher) req.dispatcher = dispatcher
  const res = await undiciFetch(url, req)
  return res
}
