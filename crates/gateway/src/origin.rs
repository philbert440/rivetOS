use crate::auth::{ConnInfo, is_loopback_host};

pub const BUILTIN_ALLOWED_ORIGINS: [&str; 1] = ["app://bundle"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginDecision {
    Allow { allow_origin: Option<String> },
    Deny { reason: String },
}

pub fn parse_list(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(|ch: char| ch.is_whitespace() || ch == ',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() == "http" || parsed.scheme() == "https" {
        return Some(parsed.origin().ascii_serialization());
    }
    let host = parsed.host_str()?;
    let with_port = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    Some(format!("{}://{with_port}", parsed.scheme()).to_ascii_lowercase())
}

pub fn hostname_of(host_header: &str) -> String {
    let host = host_header.trim().to_ascii_lowercase();
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].to_string();
        }
        return host;
    }
    let colon = host.rfind(':');
    let first = host.find(':');
    if let (Some(colon), Some(first)) = (colon, first)
        && colon > 0
        && first == colon
    {
        return host[..colon].to_string();
    }
    host
}

fn host_allowed(host_header: &str, allowed_hosts: &[String]) -> bool {
    let name = hostname_of(host_header);
    if name.is_empty() {
        return false;
    }
    if is_loopback_host(&name) || name.ends_with(".localhost") {
        return true;
    }
    allowed_hosts.iter().any(|host| hostname_of(host) == name)
}

pub fn check_origin(
    info: &ConnInfo,
    tls: bool,
    host_header: &str,
    origin_header: Option<&str>,
    allowed_origins: &[String],
    allowed_hosts: &[String],
    peer_origins: &[String],
) -> OriginDecision {
    if !tls
        && identity::is_loopback_remote(&info.remote)
        && !host_allowed(host_header, allowed_hosts)
    {
        return OriginDecision::Deny {
            reason: format!("host \"{host_header}\" is not allowed (add it to den.allowed_hosts)"),
        };
    }
    let Some(raw) = origin_header else {
        return OriginDecision::Allow { allow_origin: None };
    };
    let Some(origin) = normalize_origin(raw) else {
        return OriginDecision::Deny {
            reason: format!("origin \"{raw}\" is not allowed"),
        };
    };
    let host_cmp = host_header.trim().to_ascii_lowercase();
    if !host_cmp.is_empty()
        && let Some(index) = origin.find("//")
        && origin[index + 2..] == host_cmp
    {
        return OriginDecision::Allow {
            allow_origin: Some(origin),
        };
    }
    if BUILTIN_ALLOWED_ORIGINS.contains(&origin.as_str()) {
        return OriginDecision::Allow {
            allow_origin: Some(origin),
        };
    }
    if allowed_origins
        .iter()
        .any(|allowed| normalize_origin(allowed).as_deref() == Some(origin.as_str()))
    {
        return OriginDecision::Allow {
            allow_origin: Some(origin),
        };
    }
    if peer_origins
        .iter()
        .any(|peer| normalize_origin(peer).as_deref() == Some(origin.as_str()))
    {
        return OriginDecision::Allow {
            allow_origin: Some(origin),
        };
    }
    OriginDecision::Deny {
        reason: format!("origin \"{origin}\" is not allowed (add it to den.allowed_origins)"),
    }
}
