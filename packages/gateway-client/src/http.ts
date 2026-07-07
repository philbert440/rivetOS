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
  method?: 'GET' | 'POST' | 'DELETE'
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

export async function request<T>(
  config: GatewayClientConfig,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (config.token) headers.authorization = `Bearer ${config.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'

  // Single error surface: network/DNS/TLS failures and malformed 2xx JSON
  // also become GatewayError (status 0) so callers only ever catch one type.
  // Deliberate exception: AbortError propagates untouched — an abort is the
  // caller's own signal, not a gateway failure.
  let res: Response
  try {
    res = await fetch(buildUrl(config.baseUrl, path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw err
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
