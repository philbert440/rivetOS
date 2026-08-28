/**
 * Desktop gateway mTLS bridge (#491). Neither desktop webview presents a TLS
 * client certificate from the page, so the shell runs one loopback byte-pipe
 * per https gateway, wrapping every connection in TLS with the enrolled
 * device identity. Inside a shell an https gateway base is swapped for its
 * loopback pipe; in plain browsers this module is a pass-through — the
 * browser itself presents the OS client cert.
 *
 * Shell resolution order: `window.rivetShell` (Electron preload bridge),
 * then `__TAURI__.core.invoke` (Tauri shell / Android shim).
 */

import { rivetShell } from './shell-bridge.js'

interface TauriGlobal {
  core: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }
}

const resolved = new Map<string, Promise<string>>()

/** Resolve a fresh loopback pipe port from whichever shell is hosting us,
 *  or undefined when no shell bridge exists (plain browser). */
function invokePort(baseUrl: string): Promise<string> | undefined {
  const shell = rivetShell()
  if (shell) {
    return shell.mtlsProxyPort(baseUrl).then((port) => `http://127.0.0.1:${String(port)}`)
  }
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__
  if (tauri) {
    return tauri.core
      .invoke('mtls_proxy_port', { target: baseUrl })
      .then((port) => `http://127.0.0.1:${String(port as number)}`)
  }
  return undefined
}

/**
 * True when the loopback pipe still answers at the connection level. The
 * probe is forwarded through the pipe to the gateway, so any HTTP response —
 * of any status — means the listener is alive. `no-cors` because the
 * gateway's response carries no CORS headers: an opaque response still
 * resolves, and only a connection-level failure (ECONNREFUSED on an evicted
 * listener, a reset from a dead upstream) rejects. The timeout bounds a
 * hung-but-open socket; a spurious timeout is harmless (see below).
 */
async function pipeAlive(pipeBase: string): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => {
    ctl.abort()
  }, 2000)
  try {
    await fetch(pipeBase, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The base URL transport should actually dial for `baseUrl`. */
export function transportBase(baseUrl: string): Promise<string> {
  if (!baseUrl.startsWith('https://')) return Promise.resolve(baseUrl)
  const cached = resolved.get(baseUrl)
  if (!cached) {
    const fresh = invokePort(baseUrl)
    if (!fresh) return Promise.resolve(baseUrl) // plain browser — direct https
    const p = fresh.catch(() => {
      // No identity installed (or refused target): don't cache, so an
      // identity dropped in later is picked up without a relaunch.
      resolved.delete(baseUrl)
      return baseUrl
    })
    resolved.set(baseUrl, p)
    return p
  }
  // Cached pipe: verify the listener before handing the port out. The shell
  // caps live listeners and evicts the stalest past the cap, which can abort
  // a listener this page still holds a port for. A dead probe → drop the
  // cache and re-resolve; the shell starts a fresh listener and returns its
  // port, so an evicted pipe heals on the next resolve instead of
  // ECONNREFUSED-until-reload. A probe that failed for a transient reason
  // re-resolves to the SAME port (the listener is still mapped shell-side),
  // so a false positive costs one invoke and nothing else.
  return cached.then(async (transport) => {
    if (transport === baseUrl || (await pipeAlive(transport))) return transport
    resolved.delete(baseUrl)
    return transportBase(baseUrl)
  })
}
