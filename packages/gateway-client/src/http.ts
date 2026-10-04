/**
 * HTTP plumbing for the gateway client. Native fetch only (node ≥22 and every
 * evergreen browser) — no dependencies, so the package stays scope:contract
 * and bundles clean into rivethub-web.
 */

import type { GatewayClientConfig } from '@rivetos/types'

/** Non-2xx gateway reply, carrying the wire `{error}` body when present. */
export class GatewayError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.body = body
  }
}

export type QueryValue = string | number | boolean | undefined

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  query?: Record<string, QueryValue>
  body?: unknown
  signal?: AbortSignal
  /** Expect a non-JSON body (wiki /raw); returns the text verbatim. */
  raw?: boolean
}

/**
 * baseUrl must be an ORIGIN (`http://host:port`) — gateway paths are
 * absolute, so any path prefix on baseUrl would be silently discarded by URL
 * resolution. Reverse-proxying the gateway under a subpath is not supported;
 * proxy a whole (sub)domain instead.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * Error to rethrow when `signal` aborted the fetch. Prefer the signal's own
 * reason so a TimeoutError deadline is not reported as "gateway unreachable"
 * and is not collapsed to a generic AbortError just because that is the name
 * fetch threw. Undefined means this failure is not an abort.
 */
function abortReason(signal: AbortSignal | undefined, err: unknown): Error | undefined {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason
    if (reason instanceof Error) return reason
    if (err instanceof Error && err.name === 'AbortError') return err
    const message = typeof reason === 'string' && reason.length > 0 ? reason : 'aborted'
    return new DOMException(message, 'AbortError')
  }
  if (err instanceof Error && err.name === 'AbortError') return err
  if (err instanceof Error && signal?.reason !== undefined && err === signal.reason) return err
  if (
    err instanceof Error &&
    signal?.reason instanceof Error &&
    err.name === signal.reason.name &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return signal.reason
  }
  return undefined
}

export async function request<T>(
  config: GatewayClientConfig,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  // No Authorization / ?token= — gateway auth is mTLS device certs only.
  if (opts.body !== undefined) headers['content-type'] = 'application/json'

  // Single error surface: network/DNS/TLS failures and malformed 2xx JSON
  // also become GatewayError (status 0) so callers only ever catch one type.
  // Deliberate exception: an aborted call is the caller's signal, not a
  // gateway failure. Rethrow the signal's reason — a client deadline aborts
  // with TimeoutError, and wrapping that as status 0 reports a dead den.
  let res: Response
  try {
    // Client certs: browsers use the OS/browser store (no fetch option).
    // Node/native callers that need explicit PEM material should pass a custom
    // fetch bound to an undici Agent — this package stays dependency-free for
    // the web bundle (see GatewayClientConfig.fetch).
    res = await (config.fetch ?? globalThis.fetch)(buildUrl(config.baseUrl, path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (err: unknown) {
    const aborted = abortReason(opts.signal, err)
    if (aborted) throw aborted
    const msg = err instanceof Error ? err.message : String(err)
    throw new GatewayError(0, `gateway unreachable: ${msg}`, undefined)
  }

  if (!res.ok) {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => res.text().catch(() => undefined))
    const message =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `gateway ${res.status} on ${path}`
    throw new GatewayError(res.status, message, body)
  }

  if (opts.raw) return (await res.text()) as T
  try {
    return (await res.json()) as T
  } catch {
    throw new GatewayError(0, `gateway returned non-JSON body on ${path}`, undefined)
  }
}
