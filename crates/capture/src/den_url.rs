use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::env::EnvLookup;

pub const DEFAULT_CA_PATH: &str = "/rivet-shared/rivet-ca/intermediate/chain.pem";
pub const DEFAULT_DEN_PORT: u32 = 5174;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DenConfigScalars {
    pub port: Option<String>,
    pub tls_ca: Option<String>,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
    pub node_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardedDenUrl {
    pub den_url: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDenUrl {
    pub den_url: String,
    pub ca_path: String,
    pub warnings: Option<Vec<String>>,
}

pub type ExistsFn = Arc<dyn Fn(&Path) -> bool + Send + Sync>;

pub fn den_settings(raw: &str) -> DenConfigScalars {
    let mut result = DenConfigScalars::default();
    let mut section: Option<&str> = None;
    let mut child_indent: Option<usize> = None;
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        if let Some(name) = section_header(line) {
            section = Some(name);
            child_indent = None;
            continue;
        }
        if starts_unindented(line) && !line.starts_with('#') {
            section = None;
        }
        let Some(section_name) = section else {
            continue;
        };
        if blank_or_comment(line) {
            continue;
        }
        let Some(indent) = leading_ws(line) else {
            continue;
        };
        if child_indent.is_none() {
            child_indent = Some(indent);
        }
        if Some(indent) != child_indent {
            continue;
        }
        let Some((key, raw_value)) = split_key(line) else {
            continue;
        };
        if !wanted(section_name, key) || scalar_set(&result, key) {
            continue;
        }
        let value = unwrap_quotes(strip_inline_comment(raw_value).trim());
        set_scalar(&mut result, key, value);
    }
    result
}

fn section_header(line: &str) -> Option<&'static str> {
    let rest = line
        .strip_prefix("den:")
        .or_else(|| line.strip_prefix("mesh:"))?;
    let name = if line.starts_with("den:") {
        "den"
    } else {
        "mesh"
    };
    let rest = rest.trim_start_matches([' ', '\t']);
    if rest.is_empty() || rest.starts_with('#') {
        Some(name)
    } else {
        None
    }
}

fn starts_unindented(line: &str) -> bool {
    line.chars().next().is_some_and(|ch| !ch.is_whitespace())
}

fn blank_or_comment(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#')
}

fn leading_ws(line: &str) -> Option<usize> {
    let count = line.chars().take_while(|ch| ch.is_whitespace()).count();
    if count == 0 { None } else { Some(count) }
}

fn split_key(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    let (key, rest) = trimmed.split_once(':')?;
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return None;
    }
    Some((key, rest))
}

fn wanted(section: &str, key: &str) -> bool {
    match section {
        "den" => matches!(key, "port" | "tls_ca" | "tls_cert" | "tls_key"),
        "mesh" => key == "node_name",
        _ => false,
    }
}

fn scalar_set(config: &DenConfigScalars, key: &str) -> bool {
    match key {
        "port" => config.port.is_some(),
        "tls_ca" => config.tls_ca.is_some(),
        "tls_cert" => config.tls_cert.is_some(),
        "tls_key" => config.tls_key.is_some(),
        "node_name" => config.node_name.is_some(),
        _ => false,
    }
}

fn set_scalar(config: &mut DenConfigScalars, key: &str, value: String) {
    match key {
        "port" => config.port = Some(value),
        "tls_ca" => config.tls_ca = Some(value),
        "tls_cert" => config.tls_cert = Some(value),
        "tls_key" => config.tls_key = Some(value),
        "node_name" => config.node_name = Some(value),
        _ => {}
    }
}

fn strip_inline_comment(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' || ch == '\'' {
            out.push(ch);
            for inner in chars.by_ref() {
                out.push(inner);
                if inner == ch {
                    break;
                }
            }
            continue;
        }
        if ch == ' ' && chars.peek() == Some(&'#') {
            break;
        }
        out.push(ch);
    }
    out
}

fn unwrap_quotes(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let last = value.chars().next_back();
    if value.len() >= 2 && (first == '"' || first == '\'') && last == Some(first) {
        value[first.len_utf8()..value.len() - first.len_utf8()].to_string()
    } else {
        value.to_string()
    }
}

pub fn den_tls_configured(
    env: &dyn EnvLookup,
    config: &DenConfigScalars,
    exists: &dyn Fn(&Path) -> bool,
) -> bool {
    let cert_env = env.get("RIVETOS_DEN_TLS_CERT");
    let key_env = env.get("RIVETOS_DEN_TLS_KEY");
    let mut cert = first_non_empty([
        config.tls_cert.as_deref(),
        cert_env.as_deref().map(str::trim),
    ]);
    let mut key = first_non_empty([config.tls_key.as_deref(), key_env.as_deref().map(str::trim)]);
    if (cert.is_empty() || key.is_empty())
        && let Some(node_name) = config.node_name.as_deref().filter(|name| !name.is_empty())
    {
        let shared_env = env.get("RIVETOS_SHARED_DIR");
        let shared = shared_env
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("/rivet-shared");
        let issued = Path::new(shared).join("rivet-ca").join("issued");
        if cert.is_empty() {
            let path = issued.join(format!("{node_name}.crt"));
            if exists(&path) {
                cert = path.to_string_lossy().into_owned();
            }
        }
        if key.is_empty() {
            let path = issued.join(format!("{node_name}.key"));
            if exists(&path) {
                key = path.to_string_lossy().into_owned();
            }
        }
    }
    !cert.is_empty() && !key.is_empty()
}

fn first_non_empty(values: [Option<&str>; 2]) -> String {
    for value in values {
        if let Some(text) = value.filter(|item| !item.is_empty()) {
            return text.to_string();
        }
    }
    String::new()
}

pub fn guard_den_url(raw: &str, tls_configured: bool) -> GuardedDenUrl {
    let mut warnings = Vec::new();
    let mut url = raw.trim().to_string();
    if url.contains(',') {
        let first = url.split(',').next().unwrap_or("").trim().to_string();
        warnings.push(format!(
            "RIVET_DEN_URL lists several origins; den transport uses one — using {first} (fix ~/.rivetos/.env)"
        ));
        url = first;
    }
    if tls_configured && loopback_http(&url) {
        let fixed = format!("https://{}", &url["http://".len()..]);
        warnings.push(format!(
            "RIVET_DEN_URL={url} but this den serves https only — using {fixed}; set RIVET_DEN_URL={fixed} in ~/.rivetos/.env or remove the line"
        ));
        url = fixed;
    }
    GuardedDenUrl {
        den_url: url,
        warnings,
    }
}

fn loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let (host, after_host) = if let Some(v6) = rest.strip_prefix("[::1]") {
        ("[::1]", v6)
    } else if let Some(v4) = rest.strip_prefix("127.0.0.1") {
        ("127.0.0.1", v4)
    } else if let Some(local) = rest.strip_prefix("localhost") {
        ("localhost", local)
    } else {
        return false;
    };
    let _ = host;
    if after_host.is_empty() {
        return true;
    }
    if let Some(port_and_path) = after_host.strip_prefix(':') {
        let (port, path) = match port_and_path.split_once('/') {
            Some((port, path)) => (port, Some(path)),
            None => (port_and_path, None),
        };
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        if let Some(path) = path {
            return !path.contains(' ');
        }
        return true;
    }
    after_host.starts_with('/')
}

pub fn resolve_den_url(
    env: &dyn EnvLookup,
    mut read_config: impl FnMut() -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<ResolvedDenUrl> {
    let config = den_settings(&read_config().unwrap_or_default());
    let port = match config.port.as_deref() {
        Some(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            format_port(value)
        }
        _ => DEFAULT_DEN_PORT.to_string(),
    };
    let mut den_url = format!("https://127.0.0.1:{port}");
    let mut warnings = Vec::new();
    if let Some(preset) = env
        .get("RIVET_DEN_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let guarded = guard_den_url(&preset, den_tls_configured(env, &config, exists));
        den_url = guarded.den_url;
        warnings = guarded.warnings;
    }
    if !acceptable_http_url(&den_url) {
        return None;
    }
    let den_ca = env.get("RIVET_DEN_CA");
    let tls_ca_env = env.get("RIVETOS_DEN_TLS_CA");
    let ca_path = den_ca
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            config
                .tls_ca
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            tls_ca_env
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| DEFAULT_CA_PATH.to_string());
    Some(ResolvedDenUrl {
        den_url,
        ca_path,
        warnings: if warnings.is_empty() {
            None
        } else {
            Some(warnings)
        },
    })
}

fn format_port(digits: &str) -> String {
    let stripped = digits.trim_start_matches('0');
    if stripped.is_empty() {
        "0".to_string()
    } else if stripped.len() > 308 {
        "Infinity".to_string()
    } else {
        stripped.to_string()
    }
}

pub fn acceptable_http_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => matches!(parsed.scheme(), "http" | "https"),
        Err(_) => false,
    }
}

pub fn den_scheme_is_https(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "https")
}

pub fn default_config_reader() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home).join(".rivetos").join("config.yaml");
    std::fs::read_to_string(path).ok()
}

pub fn path_exists(path: &Path) -> bool {
    path.exists()
}
