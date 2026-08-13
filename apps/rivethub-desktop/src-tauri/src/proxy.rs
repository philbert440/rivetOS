// Loopback mTLS bridge (#491): WebKitGTK cannot present a TLS client
// certificate, so the shell runs one 127.0.0.1 byte-pipe per https gateway.
// The webview speaks plain HTTP/WS to the loopback port; the pipe wraps every
// connection in TLS with the device identity and the Rivet CA as the only
// trust root. Because it forwards raw bytes, page loads, fetch, and WebSocket
// upgrades all work unchanged.
//
// Device identity lives in the app config dir (see identity_dir): device.crt,
// device.key (a rivet-ca.sh issue-client leaf) and ca.pem (the CA chain).
// Missing material is a per-call soft error — http nodes keep working — and
// is re-read on every call so enrolling mid-run needs no relaunch.
//
// Known trade-offs, on purpose:
// - The pipe forwards bytes verbatim, so the gateway sees Host/Origin
//   `127.0.0.1:<port>`. The den is Host-agnostic and mTLS means no cookies;
//   if cookie auth ever appears, note that all piped gateways share one
//   loopback cookie jar (host-scoped, not port-scoped).
// - The listener is an unauthenticated loopback socket: any same-user local
//   process can ride the device identity — the same trust domain as the key
//   file on disk beside it.
// - `.mesh` names resolve at connect time with no pinning; the LAN resolver
//   is trusted (certificate verification still gates the far end).
// - Live listeners are capped (MAX_LISTENERS, oldest evicted): a gateway
//   dialed once must not hold an identity-serving loopback socket open for
//   process lifetime just because the roster grew.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

/// Cap on live gateway listeners: without one, every https gateway ever
/// dialed keeps an identity-serving loopback socket open for process
/// lifetime. 8 is generous for a real roster; past it the oldest is evicted.
const MAX_LISTENERS: usize = 8;

struct ListenerEntry {
    port: u16,
    /// Accept-loop task. Aborted on eviction so the OS listener dies WITH
    /// its map entry — an orphaned listener would keep serving the device
    /// identity on an unrecorded port, the leak the lock discipline in
    /// proxy_port exists to prevent.
    accept: tauri::async_runtime::JoinHandle<()>,
}

/// Live listeners keyed by normalized gateway base, plus insertion order for
/// eviction. Generic over the entry so the eviction policy is unit-testable
/// without a runtime. FIFO rather than LRU: the cap is a leak bound, not a
/// working-set policy. Known trade-off: the web side caches a resolved port
/// for the page's lifetime (mtls-proxy.ts), so evicting a gateway a window
/// is still using breaks that window's pipe until reload — acceptable when
/// hitting the cap means dialing 9+ distinct https gateways in one run.
struct ListenerSet<T> {
    entries: HashMap<String, T>,
    order: VecDeque<String>,
}

impl<T> ListenerSet<T> {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&T> {
        self.entries.get(key)
    }

    /// Insert `key`, evicting the OLDEST listener to `on_evict` when the cap
    /// is exceeded. Callers insert only after a `get` miss under the same
    /// lock, so duplicate keys never reach this.
    fn insert(&mut self, key: String, entry: T, mut on_evict: impl FnMut(String, T)) {
        self.order.push_back(key.clone());
        self.entries.insert(key, entry);
        while self.order.len() > MAX_LISTENERS {
            let oldest = self.order.pop_front().expect("order mirrors entries");
            if let Some(evicted) = self.entries.remove(&oldest) {
                on_evict(oldest, evicted);
            }
        }
    }
}

pub struct ProxyState {
    /// target base url (normalized, e.g. "https://192.0.2.7:5174") → its loopback listener
    listeners: Mutex<ListenerSet<ListenerEntry>>,
    /// Only a WORKING connector is cached — failures (no identity yet) fall
    /// through to a fresh disk read next call, so enrollment recovers live.
    connector: Mutex<Option<TlsConnector>>,
    identity_dir: PathBuf,
}

impl ProxyState {
    pub fn new(identity_dir: PathBuf) -> Self {
        Self {
            listeners: Mutex::new(ListenerSet::new()),
            connector: Mutex::new(None),
            identity_dir,
        }
    }
}

/// Host allow-list: gateways live on the LAN or the mesh overlay — refuse to
/// present the device identity to anything else.
fn host_allowed(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".mesh") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            let o = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                // CGNAT 100.64/10 — used by some WG overlays
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        // v6: loopback + unique-local fd00::/7 (WG overlay addressing)
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

fn load_pem_certs(path: &PathBuf) -> Result<Vec<CertificateDer<'static>>, String> {
    let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let certs: Vec<_> = rustls_pemfile::certs(&mut data.as_slice())
        .collect::<Result<_, _>>()
        .map_err(|e| format!("{}: bad PEM: {e}", path.display()))?;
    if certs.is_empty() {
        return Err(format!("{}: no certificates found", path.display()));
    }
    Ok(certs)
}

/// The key IS the device identity: warn (never fail) when a sloppy enroll
/// left it group/world-readable. Warn-only because group-readable can be a
/// deliberate sharing choice, and http nodes must keep working regardless.
#[cfg(unix)]
fn warn_key_permissions(key_path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(key_path) {
        let mode = meta.permissions().mode();
        if mode & 0o077 != 0 {
            eprintln!(
                "RivetHub mtls-proxy: {} is group/world-readable (mode {:04o}) — \
                 chmod 600 recommended",
                key_path.display(),
                mode & 0o777
            );
        }
    }
}

#[cfg(not(unix))]
fn warn_key_permissions(_key_path: &std::path::Path) {}

fn build_connector(dir: &Path) -> Result<TlsConnector, String> {
    let cert_path = dir.join("device.crt");
    let key_path = dir.join("device.key");
    let ca_path = dir.join("ca.pem");

    let certs = load_pem_certs(&cert_path)?;
    warn_key_permissions(&key_path);
    let key_data =
        std::fs::read(&key_path).map_err(|e| format!("{}: {e}", key_path.display()))?;
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_data.as_slice())
        .map_err(|e| format!("{}: bad PEM: {e}", key_path.display()))?
        .ok_or_else(|| format!("{}: no private key found", key_path.display()))?;

    let mut roots = RootCertStore::empty();
    for ca in load_pem_certs(&ca_path)? {
        roots
            .add(ca)
            .map_err(|e| format!("{}: {e}", ca_path.display()))?;
    }

    // No ALPN on purpose: the webview speaks HTTP/1.1 into the pipe, and a
    // client offering no ALPN gets the gateway's http/1.1 default (Node
    // https server). IP targets verify against IP SANs (no SNI) — issue-node
    // leaves must carry every literal address the roster dials.
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|e| format!("device identity rejected: {e}"))?;
    Ok(TlsConnector::from(Arc::new(config)))
}

/// Parse "https://host:port" (path-less gateway base) → (host, port).
fn parse_target(target: &str) -> Result<(String, u16), String> {
    let rest = target
        .strip_prefix("https://")
        .ok_or_else(|| format!("not an https url: {target}"))?;
    let rest = rest.trim_end_matches('/');
    if rest.contains('/') {
        return Err(format!("gateway base must not carry a path: {target}"));
    }
    // Accepted shapes: host, host:port, [v6]:port, [v6] — bracketed v6 so a
    // ULA overlay base with an explicit port actually reaches the allow-list.
    // Userinfo/query forms fall through to host_allowed and FAIL CLOSED.
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (h, after) = v6
            .split_once(']')
            .ok_or_else(|| format!("unclosed v6 bracket in {target}"))?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| format!("bad port in {target}"))?,
            // Dens listen on 5174. Implicit https://[v6] must not fall to 443.
            None if after.is_empty() => 5174,
            None => return Err(format!("bad v6 authority in {target}")),
        };
        (h.to_string(), port)
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => {
                (h.to_string(), p.parse::<u16>().map_err(|_| format!("bad port in {target}"))?)
            }
            _ => (rest.to_string(), 5174),
        }
    };
    if host.is_empty() {
        return Err(format!("empty host in {target}"));
    }
    if !host_allowed(&host) {
        return Err(format!("refusing to proxy device identity to {host}"));
    }
    Ok((host, port))
}

async fn pipe(mut client: TcpStream, connector: TlsConnector, host: String, port: u16) {
    let sni = match ServerName::try_from(host.clone()) {
        Ok(name) => name,
        Err(_) => return,
    };
    let upstream = match TcpStream::connect((host.as_str(), port)).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("RivetHub mtls-proxy: connect {host}:{port}: {e}");
            return;
        }
    };
    let mut tls = match connector.connect(sni, upstream).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("RivetHub mtls-proxy: TLS to {host}:{port}: {e}");
            return;
        }
    };
    let _ = copy_bidirectional(&mut client, &mut tls).await;
}

/// Resolve (starting if needed) the loopback port bridging to `target`.
pub async fn proxy_port(state: &ProxyState, target: String) -> Result<u16, String> {
    let (host, port) = parse_target(&target)?;
    let key = format!("https://{host}:{port}");

    // The listeners lock is held across check + bind + spawn + insert:
    // multiple windows (each webview has its own JS-side cache) can race the
    // same target, and a lost race would leak an orphaned listener that still
    // serves the device identity on an unrecorded port.
    let mut listeners = state.listeners.lock().await;
    if let Some(entry) = listeners.get(&key) {
        return Ok(entry.port);
    }

    let connector = {
        let mut slot = state.connector.lock().await;
        match slot.as_ref() {
            Some(c) => c.clone(),
            None => {
                // Failures are NOT cached: enrolling identity mid-run must
                // start working on the next call, not after a relaunch.
                let c = build_connector(&state.identity_dir)?;
                *slot = Some(c.clone());
                c
            }
        }
    };

    let listener = TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0))
        .await
        .map_err(|e| format!("bind loopback: {e}"))?;
    let local: SocketAddr = listener.local_addr().map_err(|e| e.to_string())?;

    let accept = tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((client, _)) => {
                    let connector = connector.clone();
                    let host = host.clone();
                    tauri::async_runtime::spawn(pipe(client, connector, host, port));
                }
                Err(e) => {
                    // Transient (EMFILE, ECONNABORTED…): don't kill the pipe —
                    // the port stays cached web-side, a dead loop would brick
                    // this gateway until relaunch. Back off briefly and retry.
                    eprintln!("RivetHub mtls-proxy: accept on :{}: {e}", local.port());
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    });

    let local_port = local.port();
    listeners.insert(
        key,
        ListenerEntry {
            port: local_port,
            accept,
        },
        |evicted_target, evicted| {
            evicted.accept.abort();
            eprintln!(
                "RivetHub mtls-proxy: evicted {evicted_target} (listener cap {MAX_LISTENERS})"
            );
        },
    );
    Ok(local_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_lan_mesh_and_loopback_hosts_only() {
        assert!(host_allowed("192.168.1.10"));
        assert!(host_allowed("10.0.0.5"));
        assert!(host_allowed("172.16.9.9")); // generic RFC1918 example, not a host — secret-scan-allow
        assert!(host_allowed("127.0.0.1"));
        assert!(host_allowed("100.64.0.7")); // CGNAT (WG overlay)
        assert!(host_allowed("fd00::7")); // v6 ULA (WG overlay) — generic RFC4193 example, secret-scan-allow
        assert!(host_allowed("ct112.mesh"));
        assert!(host_allowed("localhost"));
        assert!(!host_allowed("8.8.8.8"));
        assert!(!host_allowed("100.128.0.1")); // past CGNAT /10
        assert!(!host_allowed("2001:db8::1"));
        assert!(!host_allowed("example.com"));
    }

    #[test]
    fn parses_gateway_bases() {
        assert_eq!(parse_target("https://192.0.2.7:5174"), Err("refusing to proxy device identity to 192.0.2.7".into()));
        assert_eq!(parse_target("https://10.0.0.7:5174").unwrap(), ("10.0.0.7".into(), 5174));
        assert_eq!(parse_target("https://ct112.mesh:5174/").unwrap(), ("ct112.mesh".into(), 5174));
        assert_eq!(parse_target("https://ct112.mesh").unwrap(), ("ct112.mesh".into(), 5174));
        assert!(parse_target("http://10.0.0.7:5174").is_err());
        assert!(parse_target("https://10.0.0.7:5174/den").is_err());
        // bracketed v6 — ULA overlay with explicit port (generic RFC4193 examples, secret-scan-allow)
        assert_eq!(parse_target("https://[fd00::7]:5174").unwrap(), ("fd00::7".into(), 5174)); // secret-scan-allow
        assert_eq!(parse_target("https://[fd00::7]").unwrap(), ("fd00::7".into(), 5174)); // secret-scan-allow
        assert!(parse_target("https://[2001:db8::1]:5174").is_err()); // public v6 refused
        assert!(parse_target("https://[fd00::7").is_err()); // unclosed bracket — secret-scan-allow
    }

    #[test]
    fn listener_set_evicts_oldest_past_cap() {
        let mut set: ListenerSet<u16> = ListenerSet::new();
        let mut evicted: Vec<String> = Vec::new();
        for i in 0..MAX_LISTENERS {
            set.insert(format!("https://10.0.0.{i}:5174"), i as u16, |t, _| {
                evicted.push(t);
            });
        }
        assert!(evicted.is_empty(), "at cap, nothing evicted yet");
        // One past the cap evicts the first-inserted and only that one.
        set.insert("https://ct112.mesh:5174".into(), 9999, |t, _| {
            evicted.push(t);
        });
        assert_eq!(evicted, ["https://10.0.0.0:5174"]);
        assert!(set.get("https://10.0.0.0:5174").is_none());
        assert!(set.get("https://10.0.0.7:5174").is_some());
        assert_eq!(set.get("https://ct112.mesh:5174"), Some(&9999));
    }
}
