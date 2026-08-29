/**
 * Loopback mTLS bridge (#491).
 *
 * Chromium in Electron *can* present client certificates, but only from the
 * OS store (NSS on Linux), and importing the enrolled device identity there
 * programmatically is fragile across distros. Doing TLS in the main process
 * with Node's tls keeps the identity as plain PEM files — the exact material
 * rivet-ca.sh already issues: one 127.0.0.1 byte-pipe per https gateway,
 * wrapping every connection in TLS with the device identity and the Rivet CA
 * as the only trust root. Page loads, fetch, and WebSocket upgrades all ride
 * it unchanged because it forwards raw bytes.
 *
 * Device identity: device.crt, device.key (a rivet-ca.sh issue-client leaf)
 * and ca.pem in the identity dir. Missing material is a per-call soft error —
 * http nodes keep working — and is re-read on every call so enrolling mid-run
 * needs no relaunch.
 *
 * Known trade-offs, on purpose:
 * - The pipe forwards bytes verbatim, so the gateway sees Host/Origin
 *   `127.0.0.1:<port>`. The den is Host-agnostic and mTLS means no cookies.
 * - The listener is an unauthenticated loopback socket: any same-user local
 *   process can ride the device identity — the same trust domain as the key
 *   file on disk beside it.
 * - `.mesh` names resolve at connect time with no pinning; the LAN resolver
 *   is trusted (certificate verification still gates the far end).
 * - Live listeners are capped (MAX_LISTENERS, stalest evicted): a gateway
 *   dialed once must not hold an identity-serving loopback socket open for
 *   process lifetime just because the roster grew.
 *
 * Interactive traffic (terminal keystrokes are 1-byte WebSocket frames)
 * requires TCP_NODELAY on BOTH legs of the splice. Node's default is Nagle
 * ON; combined with Windows delayed ACK that turns every typed character
 * into ~200ms of echo lag and makes the TUI unusable. See
 * tuneInteractiveSocket.
 */

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import * as tls from 'node:tls'

/**
 * Cap on live gateway listeners. The web roster caps at 20 (ROSTER_MAX) and
 * the node picker additionally probes every discovered mesh row, so 32 covers
 * a full roster plus mesh headroom; past it the STALEST listener is evicted
 * (see ListenerSet for why that is never the pipe in active use).
 */
export const MAX_LISTENERS = 32

/**
 * net.Server option that disables Nagle on every accepted loopback socket.
 * The LAN TLS socket is a separate outbound connect — it is NOT covered by
 * this and must still go through tuneInteractiveSocket.
 */
export const INTERACTIVE_SERVER_OPTIONS = { noDelay: true } as const

/**
 * Disable Nagle on a socket. Safe to call before 'connect' / 'secureConnect':
 * Node applies it to the underlying handle. TLSSocket inherits this.
 *
 * Windows delayed ACK waits up to 200ms to piggyback an ACK; Nagle then
 * refuses to send the next tiny packet until that ACK arrives. Terminal
 * echo is exactly that pattern (1-byte in, 1-byte out).
 */
export function tuneInteractiveSocket(socket: net.Socket): void {
  socket.setNoDelay(true)
}

/**
 * Host allow-list: gateways live on the LAN or the mesh overlay — refuse to
 * present the device identity to anything else.
 */
export function hostAllowed(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.mesh')) return true
  if (net.isIPv4(host)) {
    const o = host.split('.').map(Number)
    return (
      o[0] === 10 || // RFC1918
      (o[0] === 172 && (o[1] & 0xf0) === 16) || // RFC1918
      (o[0] === 192 && o[1] === 168) || // RFC1918
      o[0] === 127 || // loopback
      (o[0] === 169 && o[1] === 254) || // link-local
      (o[0] === 100 && (o[1] & 0xc0) === 64) // CGNAT 100.64/10 — WG overlays
    )
  }
  if (net.isIPv6(host)) {
    // Canonicalize first (URL compresses zero runs and lowercases), so the
    // expanded spelling `0:0:0:0:0:0:0:1` is loopback here exactly as Rust's
    // Ipv6Addr::is_loopback() treated it — review finding, PR #555.
    let canon: string
    try {
      canon = new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, '')
    } catch {
      return false
    }
    if (canon === '::1') return true
    // Unique-local fc00::/7 (WG overlays allocate from fd00::/8, but the
    // mask — first hextet fc00–fdff — matches the Rust reference exactly).
    // An address opening with `::` has a zero first hextet and correctly
    // fails. v6 link-local (fe80::/10) is NOT allowed — same as Rust; those
    // need zone ids and never appear as roster bases.
    const first = canon.split(':', 1)[0]
    if (first === '') return false
    const value = parseInt(first, 16)
    return (value & 0xfe00) === 0xfc00
  }
  return false
}

/** Parse "https://host:port" (path-less gateway base) → { host, port }. */
export function parseTarget(target: string): { host: string; port: number } {
  if (!target.startsWith('https://')) throw new Error(`not an https url: ${target}`)
  const rest = target.slice('https://'.length).replace(/\/+$/, '')
  if (rest.includes('/')) throw new Error(`gateway base must not carry a path: ${target}`)
  // Accepted shapes: host, host:port, [v6]:port, [v6] — bracketed v6 so a ULA
  // overlay base with an explicit port actually reaches the allow-list.
  // Userinfo/query forms fall through to hostAllowed and FAIL CLOSED.
  let host: string
  let port: number
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) throw new Error(`unclosed v6 bracket in ${target}`)
    host = rest.slice(1, close)
    const after = rest.slice(close + 1)
    if (after === '') {
      // Dens listen on 5174. Implicit https://[v6] must not fall to 443.
      port = 5174
    } else if (after.startsWith(':')) {
      port = parsePort(after.slice(1), target)
    } else {
      throw new Error(`bad v6 authority in ${target}`)
    }
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon !== -1 && !rest.slice(0, colon).includes(':')) {
      host = rest.slice(0, colon)
      port = parsePort(rest.slice(colon + 1), target)
    } else {
      host = rest
      port = 5174
    }
  }
  if (host === '') throw new Error(`empty host in ${target}`)
  if (!hostAllowed(host)) throw new Error(`refusing to proxy device identity to ${host}`)
  return { host, port }
}

/**
 * Deliberately STRICTER than the Rust reference: `u16::from_str` accepted
 * `"0"` and a leading `"+"`, both useless as dial targets. The delta is
 * fail-closed (we refuse what Rust tolerated) and pinned by tests.
 */
function parsePort(raw: string, target: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`bad port in ${target}`)
  const port = Number(raw)
  if (port < 1 || port > 65535) throw new Error(`bad port in ${target}`)
  return port
}

/**
 * Live listeners keyed by normalized gateway base, kept in LRU order (last =
 * most recently active). Recency is touched on every resolve (`get`) and on
 * every accepted connection: the pipe the UI is bound to carries constant
 * traffic, while the node picker's per-row name probes go stale right after
 * their one fetch — so eviction past the cap takes an idle probe, never the
 * live pipe. Should a page's cached port be evicted anyway, the web side
 * (mtls-proxy.ts) detects the dead loopback port on its next resolve and
 * re-invokes for a fresh listener: eviction is recoverable, not a brick.
 */
export class ListenerSet<T> {
  private entries = new Map<string, T>()

  /** Look up `key`, marking it most-recently-used on a hit: a window
   *  (re)asking for a port is activity, same as a connection. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry !== undefined) this.touch(key)
    return entry
  }

  /** Move `key` to the most-recent position. No-op for unknown keys — an
   *  evicted listener's server is closed, but a connection accepted just
   *  before the close can still touch after eviction. */
  touch(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  /** Insert `key`, evicting the STALEST listener to `onEvict` when the cap
   *  is exceeded. The per-target pending map means duplicate keys should
   *  never reach this — but if one ever does, the PREVIOUS entry is evicted
   *  through `onEvict` rather than silently overwritten, which would orphan
   *  a live identity-serving socket with no record of it. */
  insert(key: string, entry: T, onEvict: (key: string, entry: T) => void): void {
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      this.entries.delete(key)
      onEvict(key, existing)
    }
    this.entries.set(key, entry)
    while (this.entries.size > MAX_LISTENERS) {
      const stalest = this.entries.keys().next().value as string
      const evicted = this.entries.get(stalest) as T
      this.entries.delete(stalest)
      onEvict(stalest, evicted)
    }
  }

  /** Snapshot of live values, insertion (LRU) order. Read-only — iterating
   *  must not perturb recency, so this bypasses `get`. */
  values(): T[] {
    return [...this.entries.values()]
  }

  /** Drop `key` outright (dead listener). Returns whether it was present. */
  remove(key: string): boolean {
    return this.entries.delete(key)
  }

  /** Drop every entry (dispose path). */
  clear(): void {
    this.entries.clear()
  }
}

interface Identity {
  cert: Buffer
  key: Buffer
  ca: Buffer
}

interface ListenerEntry {
  port: number
  server: net.Server
}

export class PipeState {
  readonly listeners = new ListenerSet<ListenerEntry>()
  /** Only a WORKING identity is cached — failures (no identity yet) fall
   *  through to a fresh disk read next call, so enrollment recovers live.
   *  Keyed by the dir it came from: identityDir() can legitimately move
   *  (legacy Tauri dir → own dir once an enroll lands) and the old cache
   *  must not shadow the new material. */
  private identity: { dir: string; material: Identity } | undefined
  /** In-flight resolves per key: concurrent windows racing the same target
   *  must share one bind, or the loser leaks an orphaned identity-serving
   *  listener on an unrecorded port. */
  private pending = new Map<string, Promise<number>>()

  constructor(private identityDir: () => string) {}

  private loadIdentity(): Identity {
    const dir = this.identityDir()
    if (this.identity && this.identity.dir === dir) return this.identity.material
    const read = (name: string, mustContain: string): Buffer => {
      const p = path.join(dir, name)
      let data: Buffer
      try {
        data = fs.readFileSync(p)
      } catch (e) {
        throw new Error(`${p}: ${e instanceof Error ? e.message : String(e)}`)
      }
      // Rust's load_pem_certs / private_key errored on files with no PEM
      // blocks; createSecureContext alone does not reliably reject an EMPTY
      // ca.pem, and a partial enroll (leaf+key landed, CA not yet) must fail
      // THIS resolve uncached so the completed enroll recovers live (review
      // finding, PR #555).
      if (!data.includes(mustContain)) throw new Error(`${p}: no PEM ${mustContain} block found`)
      return data
    }
    const identity = {
      cert: read('device.crt', '-----BEGIN CERTIFICATE-----'),
      key: read('device.key', '-----BEGIN'),
      ca: read('ca.pem', '-----BEGIN CERTIFICATE-----'),
    }
    // Cryptographic validation BEFORE caching — the Rust reference only
    // cached a connector that fully built. createSecureContext throws on
    // truncated or garbage PEM, so a corrupt enroll fails this resolve
    // (uncached) instead of minting a port whose every connection dies at
    // handshake, unhealable until relaunch.
    try {
      tls.createSecureContext({ cert: identity.cert, key: identity.key, ca: identity.ca })
    } catch (e) {
      throw new Error(
        `device identity rejected (${dir}): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    warnKeyPermissions(path.join(dir, 'device.key'))
    this.identity = { dir, material: identity }
    return identity
  }

  /** Resolve (starting if needed) the loopback port bridging to `target`. */
  async proxyPort(target: string): Promise<number> {
    const { host, port } = parseTarget(target)
    const key = `https://${host}:${port}`

    const live = this.listeners.get(key)
    if (live) return live.port
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const resolve = (async (): Promise<number> => {
      const identity = this.loadIdentity()
      const server = net.createServer({ ...INTERACTIVE_SERVER_OPTIONS }, (client) => {
        // LRU-touch on every connection: the pipe the UI is bound to is
        // always most-recent and unreachable by eviction; one-shot name
        // probes go stale and become the victims.
        this.listeners.touch(key)
        pipe(client, identity, host, port)
      })
      server.on('error', (e) => {
        // A post-listen server error is fatal to the listener. Drop the map
        // entry (only if it is still THIS server — a re-resolve may have
        // replaced it) so the web side's pipeAlive → re-resolve path binds a
        // FRESH listener instead of being handed the same dead port forever —
        // the "bricked until relaunch" failure the Rust accept-retry loop
        // existed to prevent (review finding, PR #555).
        console.error(`RivetHub mtls-pipe: listener for ${key}: ${e.message}`)
        const current = this.listeners.values()
        if (current.some((entry) => entry.server === server)) {
          this.listeners.remove(key)
        }
        server.close()
      })
      await new Promise<void>((res, rej) => {
        server.once('error', rej)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', rej)
          res()
        })
      })
      const local = server.address() as net.AddressInfo
      this.listeners.insert(key, { port: local.port, server }, (evictedKey, evicted) => {
        // close() stops accepting; established pipes drain naturally — same
        // semantics as aborting the Rust accept loop.
        evicted.server.close()
        console.error(`RivetHub mtls-pipe: evicted ${evictedKey} (listener cap ${MAX_LISTENERS})`)
      })
      return local.port
    })()

    // Failures are NOT cached: `loadIdentity` only caches a successful read
    // (enrolling mid-run starts working on the next call), and a failed
    // resolve leaves no listener entry behind. A bind failure does not
    // discard a working identity.
    this.pending.set(key, resolve)
    try {
      return await resolve
    } finally {
      this.pending.delete(key)
    }
  }

  /** Close every listener AND drop the entries — a post-dispose resolve must
   *  bind fresh, never be handed a closed listener's port. Best-effort on
   *  the close side: the OS reclaims the sockets on exit either way. */
  dispose(): void {
    for (const entry of this.listeners.values()) entry.server.close()
    this.listeners.clear()
  }
}

/** The key IS the device identity: warn (never fail) when a sloppy enroll
 *  left it group/world-readable. Warn-only because group-readable can be a
 *  deliberate sharing choice, and http nodes must keep working regardless. */
function warnKeyPermissions(keyPath: string): void {
  if (process.platform === 'win32') return
  try {
    const mode = fs.statSync(keyPath).mode
    if ((mode & 0o077) !== 0) {
      console.error(
        `RivetHub mtls-pipe: ${keyPath} is group/world-readable (mode ${(mode & 0o777).toString(8).padStart(4, '0')}) — chmod 600 recommended`,
      )
    }
  } catch {
    /* stat raced the read; the read's error is the real signal */
  }
}

/**
 * TLS options for one upstream gateway connection. Exported for the parity
 * tests: no SNI for IP targets (RFC 6066) with cert verification still
 * running against IP SANs — issue-node leaves must carry every literal
 * address the roster dials; no ALPN on purpose (the webview speaks HTTP/1.1
 * into the pipe, and a client offering no ALPN gets the gateway's http/1.1
 * default); `rejectUnauthorized` with the Rivet CA as the ONLY trust root.
 */
export function tlsConnectOptions(
  host: string,
  port: number,
  identity: { cert: Buffer; key: Buffer; ca: Buffer },
): tls.ConnectionOptions {
  return {
    host,
    port,
    cert: identity.cert,
    key: identity.key,
    ca: identity.ca,
    rejectUnauthorized: true,
    servername: net.isIP(host) ? undefined : host,
  }
}

/** Wrap one accepted loopback connection in TLS to the gateway and splice. */
function pipe(client: net.Socket, identity: Identity, host: string, port: number): void {
  // Loopback accept (Chromium ↔ pipe) AND the LAN TLS connect (pipe ↔ den).
  // Server noDelay only covers the former; the latter is a different socket.
  tuneInteractiveSocket(client)
  const upstream = tls.connect(tlsConnectOptions(host, port, identity))
  tuneInteractiveSocket(upstream)
  const tearDown = (err?: Error): void => {
    if (err) console.error(`RivetHub mtls-pipe: ${host}:${port}: ${err.message}`)
    client.destroy()
    upstream.destroy()
  }
  client.on('error', tearDown)
  upstream.on('error', tearDown)
  upstream.on('secureConnect', () => {
    client.pipe(upstream)
    upstream.pipe(client)
  })
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
}
