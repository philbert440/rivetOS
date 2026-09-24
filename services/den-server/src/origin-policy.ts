/**
 * Browser origin policy for the gateway.
 *
 * Gateway auth is ambient (loopback trust, browser-installed client certs —
 * see auth.ts), so the browser's own cross-site protections are the only
 * thing standing between a web page and the API. This module decides, per
 * request and per WebSocket upgrade, whether the calling browser context may
 * talk to den at all:
 *
 *   1. No `Origin` header → allowed. Native clients (Android/OkHttp, hooks,
 *      curl, mesh peers) send none; browsers always send one on WebSocket
 *      upgrades and on cross-origin fetches and non-GET requests.
 *   2. `Origin` present → allowed only when it is same-origin with the
 *      request's Host, the RivetHub desktop shell (`app://bundle`), a mesh
 *      peer's den (cross-node RivetHub), or listed in `den.allowed_origins`.
 *      `Origin: null` (sandboxed frames, file://) is never allowed.
 *   3. Loopback callers of a plain-HTTP (no TLS) den: the `Host` header must
 *      be a loopback name or listed in `den.allowed_hosts`. Without this, DNS
 *      rebinding turns an attacker hostname into "same-origin" with
 *      127.0.0.1, and loopback is fully trusted. Under TLS the browser's
 *      certificate name check rules that out; remote plain-HTTP callers are
 *      not authorized anyway (auth.ts), so peer /healthz probes by IP work.
 *
 * Allowed origins are echoed back in `Access-Control-Allow-Origin` (with
 * `Vary: Origin`); nothing ever gets `*`.
 */

import type { IncomingMessage } from 'node:http'
import { isLoopbackHost, isLoopbackRemote } from './auth.js'

/** Origins every den accepts: the RivetHub desktop shell (apps/rivethub-electron). */
export const BUILTIN_ALLOWED_ORIGINS: readonly string[] = ['app://bundle']

export interface OriginPolicyOptions {
  /** den serves TLS — skips the Host check (certificate names cover it). */
  tls: boolean
  /** Extra origins from `den.allowed_origins` (`scheme://host[:port]`). */
  allowedOrigins: readonly string[]
  /** Extra Host names from `den.allowed_hosts` (loopback callers of a plain-HTTP den). */
  allowedHosts: readonly string[]
  /** Mesh peers' den origins, read at call time (refreshed elsewhere). */
  peerOrigins?: () => Iterable<string>
}

export type OriginDecision =
  { ok: true; allowOrigin: string | null } | { ok: false; reason: string }

/**
 * Canonical `scheme://host[:port]` for comparison, or null when unparseable.
 * http(s) go through URL (drops default ports, lowercases); other schemes
 * (app://bundle) are compared as lowercase `scheme://host[:port]`, since
 * WHATWG URL reports their origin as the opaque "null".
 */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim()
  if (!s || s === 'null') return null
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  if (!url.host) return null
  return `${url.protocol}//${url.host}`.toLowerCase()
}

/** Hostname part of a Host header (`name`, `name:port`, `[v6]:port`), lowercased. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(1, end) : h
  }
  const colon = h.lastIndexOf(':')
  return colon > 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h
}

function hostAllowed(hostHeader: string, allowedHosts: readonly string[]): boolean {
  const name = hostnameOf(hostHeader)
  if (!name) return false
  if (isLoopbackHost(name) || name.endsWith('.localhost')) return true
  return allowedHosts.some((h) => hostnameOf(h) === name)
}

/** Decide whether this request's browser context may reach den. */
export function checkOrigin(req: IncomingMessage, opts: OriginPolicyOptions): OriginDecision {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (!opts.tls && isLoopbackRemote(req) && !hostAllowed(host, opts.allowedHosts)) {
    return { ok: false, reason: `host "${host}" is not allowed (add it to den.allowed_hosts)` }
  }

  const raw = req.headers.origin
  if (raw === undefined) return { ok: true, allowOrigin: null }
  const origin = normalizeOrigin(raw)
  if (!origin) return { ok: false, reason: `origin "${raw}" is not allowed` }

  // Same-origin: the page was served by this den under this Host. Compare
  // host[:port] only — a TLS-terminating proxy in front of a plain-HTTP den
  // changes the scheme, and the Host check above already pins the name.
  if (host && origin.slice(origin.indexOf('//') + 2) === host.trim().toLowerCase()) {
    return { ok: true, allowOrigin: origin }
  }
  if (BUILTIN_ALLOWED_ORIGINS.includes(origin)) return { ok: true, allowOrigin: origin }
  if (opts.allowedOrigins.some((o) => normalizeOrigin(o) === origin)) {
    return { ok: true, allowOrigin: origin }
  }
  for (const peer of opts.peerOrigins?.() ?? []) {
    if (normalizeOrigin(peer) === origin) return { ok: true, allowOrigin: origin }
  }
  return { ok: false, reason: `origin "${origin}" is not allowed (add it to den.allowed_origins)` }
}

/** Parse a comma/whitespace-separated env list. */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
