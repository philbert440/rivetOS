use std::collections::BTreeMap;
use std::fs::DirBuilder;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;

use serde_json::{Map, Value};

pub const CODEX_SESSION_MAP: &str = "codex-cli-sessions.json";
pub const HERMES_SESSION_MAP: &str = "hermes-cli-sessions.json";
pub const KIMI_SESSION_MAP: &str = "kimi-code-sessions.json";
pub const OPENCODE_SESSION_MAP: &str = "opencode-cli-sessions.json";
pub const PI_SESSION_MAP: &str = "pi-cli-sessions.json";
pub const QWEN_SESSION_MAP: &str = "qwen-code-sessions.json";
pub const GROK_SESSION_MAP: &str = "grok-cli-sessions.json";

pub fn load_session_map(path: &str) -> Map<String, Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Map::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Map::new();
    };
    let Some(map) = value.as_object() else {
        return Map::new();
    };
    let mut out = Map::new();
    for (key, item) in map {
        if let Some(text) = item.as_str() {
            out.insert(key.clone(), Value::from(text));
        }
    }
    out
}

pub fn session_map_strings(path: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (key, value) in load_session_map(path) {
        if let Some(text) = value.as_str() {
            out.insert(key, text.to_string());
        }
    }
    out
}

pub fn save_session_map(path: &str, map: &BTreeMap<String, String>) {
    let _ = write_pretty(path, map, false);
}

pub fn save_session_map_merge(
    path: &str,
    changes: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut fresh = session_map_strings(path);
    for (key, value) in changes {
        fresh.insert(key.clone(), value.clone());
    }
    replace_session_map(path, &fresh)
}

pub fn delete_session_map_key(path: &str, key: &str) {
    let mut fresh = session_map_strings(path);
    if fresh.remove(key).is_none() {
        return;
    }
    let _ = write_pretty(path, &fresh, false);
}

pub fn delete_session_map_key_merge(path: &str, key: &str) -> Result<(), String> {
    let mut fresh = session_map_strings(path);
    if fresh.remove(key).is_none() {
        return Ok(());
    }
    replace_session_map(path, &fresh)
}

pub fn uuid_for_conversation(key: &str) -> String {
    let mut hash = sha1(key.as_bytes());
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    format_uuid(&hash)
}

pub fn sha1_hex(data: &[u8]) -> String {
    sha1(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn random_uuid_v4() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    let mut file = std::fs::File::open("/dev/urandom").map_err(|err| err.to_string())?;
    std::io::Read::read_exact(&mut file, &mut bytes).map_err(|err| err.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format_uuid(&bytes))
}

pub fn session_not_found(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("no session") {
        return true;
    }
    let mut rest = lower.as_str();
    while let Some(index) = rest.find("session") {
        if session_tail(&rest[index + "session".len()..]) {
            return true;
        }
        rest = &rest[index + 1..];
    }
    false
}

pub fn qwen_resume_rejected(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !trimmed
        .to_ascii_lowercase()
        .contains("no saved session found with id")
    {
        return false;
    }
    if trimmed.starts_with('{') && serde_json::from_str::<Value>(trimmed).is_ok() {
        return false;
    }
    true
}

pub fn qwen_saw_init(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return false;
    };
    value.get("type").and_then(Value::as_str) == Some("system")
        && value.get("subtype").and_then(Value::as_str) == Some("init")
}

fn session_tail(mut after: &str) -> bool {
    loop {
        if !after.starts_with(|ch: char| ch.is_whitespace()) {
            return false;
        }
        after = after.trim_start();
        if after.starts_with("not found") {
            return true;
        }
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        if end == 0 {
            return false;
        }
        after = &after[end..];
    }
}

fn format_uuid(bytes: &[u8]) -> String {
    let hex: String = bytes
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn write_pretty(path: &str, map: &BTreeMap<String, String>, newline: bool) -> Result<(), String> {
    let parent = parent_dir(path);
    std::fs::create_dir_all(&parent).map_err(|err| err.to_string())?;
    let mut text = pretty(map)?;
    if newline {
        text.push('\n');
    }
    std::fs::write(path, text).map_err(|err| err.to_string())
}

fn replace_session_map(path: &str, map: &BTreeMap<String, String>) -> Result<(), String> {
    let parent = parent_dir(path);
    let parent_existed = Path::new(&parent).exists();
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    builder.mode(0o700);
    builder.create(&parent).map_err(|err| err.to_string())?;
    if !parent_existed {
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| err.to_string())?;
    }
    let text = format!("{}\n", pretty(map)?);
    protocol::host::atomic_replace(Path::new(path), text.as_bytes())
        .map_err(|err| err.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|err| err.to_string())
}

fn pretty(map: &BTreeMap<String, String>) -> Result<String, String> {
    let mut value = Map::new();
    for (key, item) in map {
        value.insert(key.clone(), Value::from(item.clone()));
    }
    serde_json::to_string_pretty(&Value::Object(value)).map_err(|err| err.to_string())
}

fn parent_dir(path: &str) -> String {
    match Path::new(path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().into_owned(),
        _ => ".".to_string(),
    }
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x6745_2301;
    let mut h1: u32 = 0xEFCD_AB89;
    let mut h2: u32 = 0x98BA_DCFE;
    let mut h3: u32 = 0x1032_5476;
    let mut h4: u32 = 0xC3D2_E1F0;
    let bit_len = (data.len() as u64).saturating_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut words = [0u32; 80];
        for index in 0..16 {
            words[index] = u32::from_be_bytes([
                chunk[index * 4],
                chunk[index * 4 + 1],
                chunk[index * 4 + 2],
                chunk[index * 4 + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;
        for (index, word) in words.iter().enumerate() {
            let (f, k) = if index < 20 {
                ((b & c) | ((!b) & d), 0x5A82_7999)
            } else if index < 40 {
                (b ^ c ^ d, 0x6ED9_EBA1)
            } else if index < 60 {
                ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC)
            } else {
                (b ^ c ^ d, 0xCA62_C1D6)
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }
    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::{
        delete_session_map_key, delete_session_map_key_merge, load_session_map,
        qwen_resume_rejected, save_session_map, save_session_map_merge, session_map_strings,
        session_not_found, sha1_hex, uuid_for_conversation,
    };
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> String {
        let dir = format!("/tmp/rr6p-session-{}-{}", std::process::id(), name);
        let _ = std::fs::create_dir_all(&dir);
        format!("{dir}/map.json")
    }

    #[test]
    fn sha1_abc_matches_the_known_digest() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn conversation_uuid_is_stable_and_key_dependent() {
        let id = uuid_for_conversation("default");
        assert!(id.len() == 36);
        assert_eq!(uuid_for_conversation("default"), id);
        assert_ne!(uuid_for_conversation("other"), id);
        assert_eq!(&id[14..15], "5");
        let variant = id.as_bytes()[19];
        assert!(matches!(variant, b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn best_effort_map_round_trips_and_ignores_non_strings() {
        let path = scratch("best");
        let mut map = BTreeMap::new();
        map.insert("a".to_string(), "1".to_string());
        map.insert("b".to_string(), "2".to_string());
        save_session_map(&path, &map);
        let loaded = session_map_strings(&path);
        assert_eq!(loaded.get("a").map(String::as_str), Some("1"));
        assert_eq!(loaded.get("b").map(String::as_str), Some("2"));
        std::fs::write(&path, "[1,2]").unwrap();
        assert!(load_session_map(&path).is_empty());
        std::fs::write(&path, "not-json").unwrap();
        assert!(load_session_map(&path).is_empty());
        delete_session_map_key(&path, "missing");
    }

    #[test]
    fn atomic_merge_keeps_existing_keys_and_file_mode() {
        let path = scratch("atomic");
        let mut first = BTreeMap::new();
        first.insert("keep".to_string(), "yes".to_string());
        save_session_map_merge(&path, &first).unwrap();
        let mut change = BTreeMap::new();
        change.insert("keep".to_string(), "updated".to_string());
        change.insert("new".to_string(), "n".to_string());
        save_session_map_merge(&path, &change).unwrap();
        let loaded = session_map_strings(&path);
        assert_eq!(loaded.get("keep").map(String::as_str), Some("updated"));
        assert_eq!(loaded.get("new").map(String::as_str), Some("n"));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with('\n'));
        delete_session_map_key_merge(&path, "absent").unwrap();
        assert!(session_map_strings(&path).contains_key("keep"));
        delete_session_map_key_merge(&path, "keep").unwrap();
        assert!(!session_map_strings(&path).contains_key("keep"));
    }

    #[test]
    fn session_not_found_matches_the_typescript_pattern() {
        assert!(session_not_found("no session"));
        assert!(session_not_found("No Session here"));
        assert!(session_not_found("session not found"));
        assert!(session_not_found("session foo not found"));
        assert!(session_not_found("session foo bar not found"));
        assert!(!session_not_found("sessionnot found"));
        assert!(!session_not_found("all good"));
    }

    #[test]
    fn qwen_rejects_plain_resume_lines_only() {
        assert!(qwen_resume_rejected("No saved session found with ID abc"));
        assert!(!qwen_resume_rejected(
            r#"{"type":"text","text":"No saved session found with ID abc"}"#
        ));
        assert!(!qwen_resume_rejected("other"));
    }
}
