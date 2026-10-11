pub const LOOPBACK_HOSTS: [&str; 4] = ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"];

pub const UNAUTHORIZED_HTML: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\"/>\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\n<title>RivetHub — device certificate required</title>\n<style>\n  :root { color-scheme: dark; }\n  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#111; color:#ddd;\n         max-width:40rem; margin:12vh auto; padding:0 1.5rem; line-height:1.55; }\n  h1 { font-size:1.15rem; color:#e8c547; font-weight:600; }\n  code { background:#1c1c1c; padding:0.1em 0.4em; border-radius:4px; font-size:0.92em; }\n  .muted { color:#888; font-size:0.9rem; }\n</style>\n</head>\n<body>\n<h1>Device certificate required</h1>\n<p>This gateway only accepts enrolled devices. Clicking through the padlock /\ncertificate warning trusts the <em>server</em> CA — it is not a client certificate.</p>\n<p>Open <strong>RivetHub desktop</strong> (it presents your device identity),\nor import a device PKCS#12 issued with <code>rivet-ca.sh issue-client</code>\ninto this browser and reload.</p>\n<p class=\"muted\">Liveness is at <code>/healthz</code> and does not need a client cert.</p>\n</body>\n</html>\n";

#[derive(Debug, Clone)]
pub struct ConnInfo {
    pub remote: String,
    pub encrypted: bool,
    pub authorized: bool,
    pub cn: String,
    pub ou: String,
}

impl ConnInfo {
    pub fn plain(remote: impl Into<String>) -> Self {
        Self {
            remote: remote.into(),
            encrypted: false,
            authorized: false,
            cn: String::new(),
            ou: String::new(),
        }
    }
}

pub fn is_loopback_host(host: &str) -> bool {
    let name = host.trim().to_ascii_lowercase();
    LOOPBACK_HOSTS.contains(&name.as_str())
}

pub fn is_device_client(cn: &str, ou: &str) -> bool {
    ou.eq_ignore_ascii_case("client") || cn.starts_with("device:")
}

pub fn device_id_from_subject(cn: &str, ou: &str) -> Option<String> {
    if !is_device_client(cn, ou) {
        return None;
    }
    let device_id = cn.strip_prefix("device:").unwrap_or(cn);
    if device_id.is_empty() {
        None
    } else {
        Some(device_id.to_string())
    }
}

pub fn is_gateway_authorized(
    info: &ConnInfo,
    tls_configured: bool,
    require_client_cert: bool,
) -> bool {
    if !tls_configured {
        return identity::is_loopback_remote(&info.remote);
    }
    if identity::is_loopback_remote(&info.remote) {
        return true;
    }
    if !require_client_cert {
        return info.encrypted;
    }
    info.authorized && is_device_client(&info.cn, &info.ou)
}

pub fn wants_html_unauthorized(method: &str, pathname: &str, accept: &str) -> bool {
    let method = method.to_ascii_uppercase();
    if method != "GET" && method != "HEAD" {
        return false;
    }
    if pathname.starts_with("/api/") {
        return false;
    }
    accept.contains("text/html")
}
