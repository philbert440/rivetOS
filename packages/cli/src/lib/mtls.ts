/**
 * mTLS helpers for mesh-to-mesh HTTPS calls.
 *
 * Builds an undici dispatcher carrying this node's client cert/key so mesh peers
 * can authenticate us. Falls back gracefully (no dispatcher) when certs aren't
 * present, leaving the caller to proceed without mTLS.
 */

import { readFileSync } from 'node:fs'
import { resolveLocalNodeName } from './node-identity.js'

const CA_PATH = '/rivet-shared/rivet-ca/intermediate/ca-chain.pem'

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
      (nodeName ? `/rivet-shared/rivet-ca/issued/${nodeName}.crt` : null)
    const keyPath =
      process.env.RIVETOS_TLS_KEY ??
      (nodeName ? `/rivet-shared/rivet-ca/issued/${nodeName}.key` : null)

    if (!certPath || !keyPath) return undefined

    const ca = readFileSync(CA_PATH)
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)

    return new UndiciAgent({ connect: { ca, cert, key, rejectUnauthorized: true } })
  } catch {
    // Certs not available — caller proceeds without mTLS dispatcher
    return undefined
  }
}

/**
 * Build `fetch` options (timeout signal + optional mTLS dispatcher) for a mesh call.
 */
export async function buildMeshFetchOptions(
  timeoutMs = 5000,
): Promise<RequestInit & { dispatcher?: unknown }> {
  const options: RequestInit & { dispatcher?: unknown } = {
    signal: AbortSignal.timeout(timeoutMs),
  }
  const dispatcher = await buildMeshDispatcher()
  if (dispatcher) {
    // @ts-expect-error — undici Agent vs undici-types Dispatcher type mismatch
    options.dispatcher = dispatcher
  }
  return options
}
