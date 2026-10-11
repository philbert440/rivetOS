use std::collections::BTreeMap;
use std::path::Path;

use protocol::host::Env;
use protocol::js::{js_trim, posix_resolve};

pub(crate) fn load_rivet_env(env: &dyn Env) -> BTreeMap<String, String> {
    let Some(path) = rivet_env_path(env) else {
        return BTreeMap::new();
    };
    let Ok(contents) = protocol::host::read_text(Path::new(&path)) else {
        return BTreeMap::new();
    };
    if env
        .var("RIVETOS_LOG_LEVEL")
        .is_some_and(|level| level.eq_ignore_ascii_case("debug"))
    {
        eprintln!("[env] loaded {path}");
    }
    let mut applied = BTreeMap::new();
    for (key, value) in parse_rivet_env(&contents) {
        if env.var(&key).is_some() {
            continue;
        }
        applied.insert(key, value);
    }
    applied
}

pub(crate) fn overlay_var(
    env: &dyn Env,
    file: &BTreeMap<String, String>,
    key: &str,
) -> Option<String> {
    if let Some(value) = env.var(key) {
        return Some(value);
    }
    file.get(key).cloned()
}

pub(crate) fn parse_rivet_env(contents: &str) -> BTreeMap<String, String> {
    let text = contents.strip_prefix('\u{FEFF}').unwrap_or(contents);
    let mut out = BTreeMap::new();
    for raw in split_env_lines(text) {
        let Some((key, value)) = parse_env_line(raw) else {
            continue;
        };
        out.insert(key, value);
    }
    out
}

fn rivet_env_path(env: &dyn Env) -> Option<String> {
    if let Some(raw) = env.var("RIVETOS_ENV_FILE") {
        let trimmed = js_trim(&raw);
        if !trimmed.is_empty() {
            return Some(expand_leading_tilde(env, trimmed));
        }
    }
    let home = protocol::host::home_dir(env)?;
    Some(posix_resolve(&process_cwd(), &[&home, ".rivetos", ".env"]))
}

fn expand_leading_tilde(env: &dyn Env, path: &str) -> String {
    if path == "~" {
        return protocol::host::home_dir(env).unwrap_or_else(|| "~".to_string());
    }
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = protocol::host::home_dir(env)
    {
        return posix_resolve(&process_cwd(), &[&home, rest]);
    }
    path.to_string()
}

fn process_cwd() -> String {
    match std::env::current_dir() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => ".".to_string(),
    }
}

fn split_env_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let mut end = index;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            lines.push(&text[start..end]);
            index += 1;
            start = index;
            continue;
        }
        index += 1;
    }
    lines.push(&text[start..]);
    lines
}

fn parse_env_line(raw: &str) -> Option<(String, String)> {
    let line = js_trim(raw);
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let rest = export_rest(line);
    let eq = rest.find('=')?;
    if eq == 0 {
        return None;
    }
    let key = js_trim(&rest[..eq]);
    if !is_env_key(key) {
        return None;
    }
    Some((key.to_string(), unquote_env_value(&rest[eq + 1..])))
}

fn export_rest(line: &str) -> &str {
    let Some(rest) = line.strip_prefix("export") else {
        return line;
    };
    if rest.chars().next().is_some_and(is_js_space) {
        js_trim(rest)
    } else {
        line
    }
}

fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn unquote_env_value(raw: &str) -> String {
    let s = js_trim(raw);
    if s.starts_with('#') {
        return String::new();
    }
    if s.starts_with('"') {
        return decode_double_quoted(s);
    }
    if let Some(body) = s.strip_prefix('\'') {
        let end = body.find('\'').unwrap_or(body.len());
        return body[..end].to_string();
    }
    js_trim(&strip_inline_comment(s)).to_string()
}

fn decode_double_quoted(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut index = 1usize;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '"' {
            break;
        }
        if ch == '\\' && index + 1 < chars.len() {
            let next = chars[index + 1];
            match next {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                other => out.push(other),
            }
            index += 2;
            continue;
        }
        out.push(ch);
        index += 1;
    }
    out
}

fn strip_inline_comment(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        if is_js_space(chars[index]) {
            let mut cursor = index;
            while cursor < chars.len() && is_js_space(chars[cursor]) {
                cursor += 1;
            }
            if chars.get(cursor) == Some(&'#') {
                return chars[..index].iter().collect();
            }
        }
        index += 1;
    }
    s.to_string()
}

fn is_js_space(ch: char) -> bool {
    let mut buf = [0u8; 4];
    js_trim(ch.encode_utf8(&mut buf)).is_empty()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use protocol::host::MapEnv;

    use super::{load_rivet_env, parse_rivet_env};

    fn temp_dir() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "rr2a-env-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn parse_matches_the_typescript_cases() {
        let parsed = parse_rivet_env(
            "
# full-line comment
FOO=bar
export BAZ=qux
QUOTED=\"hello world\"
SINGLE='keep # hash'
INLINE=value # trailing
EMPTY=
DISABLED= # intentionally empty
SPACES = padded
",
        );
        assert_eq!(parsed.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(parsed.get("BAZ").map(String::as_str), Some("qux"));
        assert_eq!(
            parsed.get("QUOTED").map(String::as_str),
            Some("hello world")
        );
        assert_eq!(
            parsed.get("SINGLE").map(String::as_str),
            Some("keep # hash")
        );
        assert_eq!(parsed.get("INLINE").map(String::as_str), Some("value"));
        assert_eq!(parsed.get("EMPTY").map(String::as_str), Some(""));
        assert_eq!(parsed.get("DISABLED").map(String::as_str), Some(""));
        assert_eq!(parsed.get("SPACES").map(String::as_str), Some("padded"));

        let escaped = parse_rivet_env(
            "A=\"a\\nb\"\nB=\"say \\\"hi\\\"\"\nNOT A KEY=nope\n=nokey\njusttext\n",
        );
        assert_eq!(escaped.get("A").map(String::as_str), Some("a\nb"));
        assert_eq!(escaped.get("B").map(String::as_str), Some("say \"hi\""));
        assert!(!escaped.contains_key("NOT A KEY"));
        assert_eq!(escaped.len(), 2);
        assert_eq!(
            parse_rivet_env("FOO=one\nFOO=two\n")
                .get("FOO")
                .map(String::as_str),
            Some("two")
        );
        assert_eq!(
            parse_rivet_env("FOO=bar\r\nBAZ=qux\r")
                .get("BAZ")
                .map(String::as_str),
            Some("qux")
        );
        assert_eq!(
            parse_rivet_env("\u{FEFF}FOO=bom\n")
                .get("FOO")
                .map(String::as_str),
            Some("bom")
        );
    }

    #[test]
    fn load_skips_a_missing_file_and_keeps_exported_keys() {
        let dir = temp_dir();
        let mut env = MapEnv::new();
        env.set("HOME", dir.join("home").to_string_lossy().as_ref());
        env.set(
            "RIVETOS_ENV_FILE",
            dir.join("missing.env").to_string_lossy().as_ref(),
        );
        assert!(load_rivet_env(&env).is_empty());

        let path = dir.join("present.env");
        fs::write(&path, "EXISTING=fromfile\nNEW=applied\n").expect("write");
        env.set("RIVETOS_ENV_FILE", path.to_string_lossy().as_ref());
        env.set("EXISTING", "preset");
        let applied = load_rivet_env(&env);
        assert!(!applied.contains_key("EXISTING"));
        assert_eq!(applied.get("NEW").map(String::as_str), Some("applied"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_keeps_a_legacy_byte_in_the_value() {
        let dir = temp_dir();
        let path = dir.join(".env");
        let mut bytes = b"RIVETOS_PG_URL=postgres://caf".to_vec();
        bytes.push(0xE9);
        bytes.extend_from_slice(b"/db\n");
        fs::write(&path, bytes).expect("write");
        let mut env = MapEnv::new();
        env.set("HOME", dir.to_string_lossy().as_ref());
        env.set("RIVETOS_ENV_FILE", path.to_string_lossy().as_ref());
        let applied = load_rivet_env(&env);
        assert_eq!(
            applied.get("RIVETOS_PG_URL").map(String::as_str),
            Some("postgres://caf\u{FFFD}/db")
        );
        let _ = fs::remove_dir_all(dir);
    }
}
