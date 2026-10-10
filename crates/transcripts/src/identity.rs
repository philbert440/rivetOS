use std::sync::OnceLock;

use protocol::{HARNESS_IDS, parse_session_id_str};
use regex::Regex;

pub const TRANSCRIPT_PROBE: &[&str] =
    &["claude", "grok", "codex", "hermes", "kimi", "opencode", "pi", "qwen", "cursor", "cowork"];

pub const REGISTRY_PROBE: &[&str] = &[
    "claude-code",
    "grok-build",
    "hermes",
    "kimi-code",
    "pi",
    "qwen-code",
    "cursor",
    "cowork",
    "opencode",
    "codex",
];

pub struct DenSessionRef {
    pub native: String,
    pub command: Option<&'static str>,
}

pub fn store_command(harness_id: &str) -> Option<&'static str> {
    Some(match harness_id {
        "claude-code" => "claude",
        "grok-build" => "grok",
        "kimi-code" => "kimi",
        "hermes" => "hermes",
        "codex" => "codex",
        "opencode" => "opencode",
        "pi" => "pi",
        "qwen-code" => "qwen",
        "cursor" => "cursor",
        "cowork" => "cowork",
        _ => return None,
    })
}

pub fn is_bare_native_uuid(value: &str) -> bool {
    uuid_re().is_some_and(|re| re.is_match(value))
}

pub fn codex_native_id(value: &str) -> bool {
    is_bare_native_uuid(value)
}

pub fn opencode_native_id(value: &str) -> bool {
    opencode_re().is_some_and(|re| re.is_match(value))
}

pub fn hermes_timestamp_id(value: &str) -> bool {
    hermes_shape_re().is_some_and(|re| re.is_match(value))
}

pub fn hermes_announced_id(value: &str) -> bool {
    !value.is_empty() && !value.starts_with("unknown-")
}

pub fn kimi_session_id(value: &str) -> bool {
    kimi_re().is_some_and(|re| re.is_match(value))
}

pub fn collapse_path_fallback(id: &str) -> String {
    let Ok(parsed) = parse_session_id_str(id) else {
        return id.to_string();
    };
    let Some(slash) = parsed.native_session_id.rfind('/') else {
        return id.to_string();
    };
    let tail = &parsed.native_session_id[slash + 1..];
    if !is_bare_native_uuid(tail) {
        return id.to_string();
    }
    format!("{}:{tail}", parsed.harness_id)
}

pub fn den_session_ref(raw: &str) -> DenSessionRef {
    match normalize_session_id(raw) {
        Ok(Normalized::Bare(native)) => DenSessionRef { native, command: None },
        Ok(Normalized::Canonical { harness_id, native }) => {
            DenSessionRef { native, command: store_command(&harness_id) }
        }
        Err(()) => DenSessionRef { native: raw.to_string(), command: None },
    }
}

pub fn den_join_key(raw: &str) -> String {
    den_session_ref(raw).native
}

enum Normalized {
    Bare(String),
    Canonical { harness_id: String, native: String },
}

fn normalize_session_id(raw: &str) -> Result<Normalized, ()> {
    if raw.is_empty() || raw != protocol::js::js_trim(raw) || raw.starts_with("task:") {
        return Err(());
    }
    if is_bare_native_uuid(raw) {
        return Ok(Normalized::Bare(raw.to_string()));
    }
    let collapsed = collapse_path_fallback(raw);
    let parsed = parse_session_id_str(&collapsed).map_err(|_| ())?;
    if !HARNESS_IDS.contains(&parsed.harness_id.as_str()) {
        return Err(());
    }
    Ok(Normalized::Canonical { harness_id: parsed.harness_id, native: parsed.native_session_id })
}

fn uuid_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()).as_ref()
}

fn opencode_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ses_[A-Za-z0-9]{20,}$").ok()).as_ref()
}

fn hermes_shape_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{8}_\d{6}_[0-9a-fA-F]{6}$").ok()).as_ref()
}

fn kimi_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()
    })
    .as_ref()
}

pub fn path_unsafe(id: &str) -> bool {
    id.is_empty() || id.contains('/') || id.contains("..")
}
