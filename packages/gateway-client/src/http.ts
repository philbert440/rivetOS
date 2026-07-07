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

  const res = await fetch(buildUrl(config.baseUrl, path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  })

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
  return (await res.json()) as T
}
