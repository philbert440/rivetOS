/**
 * Gateway access control — Rivet CA client certificates only.
 *
 * Bearer tokens and `?token=` query auth are gone. Unenrolled devices must not
 * reach Hub/API surfaces. Identity lives in the same CA as the mesh:
 *
 *   - Node leaves:    CN=<node>.mesh, EKU serverAuth+clientAuth  (issue-node)
 *   - Device leaves:  CN=device:<id>, OU=client, EKU clientAuth  (issue-client)
 *
 * Auth rules:
 *   1. /healthz is always open (liveness probes).
 *   2. Loopback HTTP without TLS is allowed (local node process: hooks, embed).
 *   3. Off-loopback requires TLS with a verified client cert whose subject is
 *      a device leaf (OU=client or CN starts with `device:`).
 *   4. WireGuard one-time enroll tokens on POST /api/devices/enroll stay as
 *      *pairing* secrets, not gateway application auth.
 */

import type { IncomingMessage } from 'node:http'
import type { PeerCertificate, TLSSocket } from 'node:tls'

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

export interface DenTlsConfig {
  /** PEM (or path contents already read) for the node server certificate. */
  cert: string
  /** Matching private key. */
  key: string
  /** CA chain used to verify client certificates (intermediate + root). */
  ca: string
  /**
   * When true (default), remote clients must present a device client cert.
   * Loopback connections never require a client cert even when this is true.
   */
  requireClientCert: boolean
}

/** Parsed identity from a verified peer certificate, or null if not a device. */
export interface DeviceIdentity {
  /** Full subject CN (e.g. device:pixel-phil). */
  cn: string
  /** Device id without the `device:` prefix when present. */
  deviceId: string
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

export function isLoopbackRemote(req: IncomingMessage): boolean {
  const raw = req.socket.remoteAddress ?? ''
  // Node may report IPv4-mapped IPv6
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost'
}

/**
 * Extract CN and OU from a certificate subject. Node's peerCertificate.subject
 * is either a string or an object depending on version/OpenSSL — handle both.
 */
export function parseCertSubject(cert: PeerCertificate | undefined | null): {
  cn: string
  ou: string
} {
  if (!cert?.subject) return { cn: '', ou: '' }
  const sub = cert.subject as unknown
  if (typeof sub === 'string') {
    const cn = /CN\s*=\s*([^,/]+)/i.exec(sub)?.[1]?.trim() ?? ''
    const ou = /OU\s*=\s*([^,/]+)/i.exec(sub)?.[1]?.trim() ?? ''
    return { cn, ou }
  }
  if (typeof sub === 'object' && sub !== null) {
    const o = sub as Record<string, string | string[] | undefined>
    const cnRaw = o.CN ?? o.cn ?? ''
    const ouRaw = o.OU ?? o.ou ?? ''
    const cn = Array.isArray(cnRaw) ? (cnRaw[0] ?? '') : cnRaw
    const ou = Array.isArray(ouRaw) ? (ouRaw[0] ?? '') : ouRaw
    return { cn: cn.trim(), ou: ou.trim() }
  }
  return { cn: '', ou: '' }
}

/** True when the peer leaf is an enrolled Hub/device client (not a mesh node). */
export function isDeviceClientCert(cert: PeerCertificate | undefined | null): boolean {
  const { cn, ou } = parseCertSubject(cert)
  if (ou.toLowerCase() === 'client') return true
  if (cn.startsWith('device:')) return true
  return false
}

export function deviceIdentityFromCert(
  cert: PeerCertificate | undefined | null,
): DeviceIdentity | null {
  if (!isDeviceClientCert(cert)) return null
  const { cn } = parseCertSubject(cert)
  const deviceId = cn.startsWith('device:') ? cn.slice('device:'.length) : cn
  if (!deviceId) return null
  return { cn, deviceId }
}

/**
 * Application-layer gate after TLS (or plain loopback HTTP).
 *
 * @param tlsConfigured whether this server is listening with TLS + client CA
 * @param requireClientCert from config (ignored for loopback remotes)
 */
export function isGatewayAuthorized(
  req: IncomingMessage,
  opts: { tlsConfigured: boolean; requireClientCert: boolean },
): boolean {
  // Plain HTTP loopback: node-local only (hooks, embedded processes).
  if (!opts.tlsConfigured) {
    return isLoopbackRemote(req)
  }

  // TLS connection
  const sock = req.socket as TLSSocket
  if (typeof sock.getPeerCertificate !== 'function') {
    // Not a TLS socket — should not happen when tlsConfigured
    return isLoopbackRemote(req)
  }

  // Loopback over TLS is still local operator traffic
  if (isLoopbackRemote(req)) return true

  if (!opts.requireClientCert) {
    // TLS without client auth: encrypt-only (not recommended for product;
    // kept for explicit lab opt-out). Remote is allowed if TLS completed.
    return sock.encrypted
  }

  // Mutual TLS required: peer cert must verify (socket.authorized — the TLS
  // layer verifies but never rejects, see server.ts) and be a device leaf
  if (!sock.authorized) return false
  const peer = sock.getPeerCertificate(true)
  return isDeviceClientCert(peer)
}

/** Attach parsed device identity for route handlers (optional). */
export function clientDevice(req: IncomingMessage): DeviceIdentity | null {
  const sock = req.socket as TLSSocket
  if (typeof sock.getPeerCertificate !== 'function') return null
  if (!sock.authorized) return null
  return deviceIdentityFromCert(sock.getPeerCertificate(true))
}
