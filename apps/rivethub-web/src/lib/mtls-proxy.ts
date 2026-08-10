/**
 * Desktop (Tauri) gateway mTLS bridge (#491). WebKitGTK cannot present a TLS
 * client certificate, so the Rust shell exposes `mtls_proxy_port`: one
 * loopback byte-pipe per https gateway, wrapping every connection in TLS with
 * the enrolled device identity. Inside Tauri an https gateway base is swapped
 * for its loopback pipe; in plain browsers this module is a pass-through —
 * the browser itself presents the OS client cert.
 */

interface TauriGlobal {
  core: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }
}

const resolved = new Map<string, Promise<string>>()

/** The base URL transport should actually dial for `baseUrl`. */
export function transportBase(baseUrl: string): Promise<string> {
  // Detection rides the injected global, which exists only because the shell
  // sets `app.withGlobalTauri: true` in tauri.conf.json — if that flag ever
  // goes away this must switch to importing @tauri-apps/api directly, or the
  // bridge silently fails open to direct (unauthenticatable) https.
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__
  if (!tauri || !baseUrl.startsWith('https://')) return Promise.resolve(baseUrl)
  let p = resolved.get(baseUrl)
  if (!p) {
    p = tauri.core
      .invoke('mtls_proxy_port', { target: baseUrl })
      .then((port) => `http://127.0.0.1:${String(port as number)}`)
      .catch(() => {
        // No identity installed (or refused target): don't cache, so an
        // identity dropped in later is picked up without a relaunch.
        resolved.delete(baseUrl)
        return baseUrl
      })
    resolved.set(baseUrl, p)
  }
  return p
}
