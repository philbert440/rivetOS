use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::fsutil::{self, mtime_ms};
use crate::jsonl::parse_object;
use crate::roots::Roots;
use crate::text::extract_turn_text;
use crate::timeutil::{kimi_time_number, parse_date_ms};
use crate::turn::SessionRow;
use crate::value::{jtrim, js_slice, whitespace_collapse};

const PREFIX: &str = "session_";
const SCAN_MAX: u64 = 1024 * 1024;
const CHUNK: usize = 64 * 1024;

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let root = sessions_dir(roots);
    let Some(wd_dirs) = fsutil::read_dir_names(&root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for wd in wd_dirs {
        let Some(entries) = fsutil::read_dir_names(&root.join(&wd)) else {
            continue;
        };
        for name in entries {
            if !name.starts_with(PREFIX) {
                continue;
            }
            let path = root.join(&wd).join(&name);
            let state = path.join("state.json");
            if fsutil::is_file(&state) {
                found.push((name, path, mtime_ms(&state).unwrap_or(0)));
            }
        }
    }
    found.sort_by_key(|row| std::cmp::Reverse(row.2));
    let mut out = Vec::new();
    for (id, path, _) in found.into_iter().take(limit) {
        if let Some(row) = read_session(&path, &id) {
            out.push(row);
        }
    }
    out
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let dir = session_dir(roots, id)?;
    read_session(&dir, id)
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    if !id.starts_with(PREFIX) {
        return false;
    }
    let root = sessions_dir(roots);
    let Some(wd_dirs) = fsutil::read_dir_names(&root) else {
        return false;
    };
    wd_dirs.iter().any(|wd| fsutil::exists(&root.join(wd).join(id)))
}

pub fn session_dir(roots: &Roots, id: &str) -> Option<PathBuf> {
    let indexed = index_dir(roots, id);
    if let Some(path) = indexed
        && path.file_name().and_then(|name| name.to_str()) == Some(id) && fsutil::exists(&path) {
            return Some(path);
        }
    let root = sessions_dir(roots);
    let wd_dirs = fsutil::read_dir_names(&root)?;
    for wd in wd_dirs {
        let path = root.join(&wd).join(id);
        if fsutil::exists(&path) {
            return Some(path);
        }
    }
    None
}

pub fn wire_path(dir: &Path) -> PathBuf {
    dir.join("agents").join("main").join("wire.jsonl")
}

pub fn home(roots: &Roots) -> PathBuf {
    roots.env_trim("KIMI_CODE_HOME").map(PathBuf::from).unwrap_or_else(|| roots.join_home(&[".kimi-code"]))
}

pub fn sessions_dir(roots: &Roots) -> PathBuf {
    home(roots).join("sessions")
}

fn index_dir(roots: &Roots, id: &str) -> Option<PathBuf> {
    let text = fsutil::read_lossy(&home(roots).join("session_index.jsonl"))?;
    let mut indexed = None;
    for line in text.split('\n') {
        let trimmed = jtrim(line);
        if !trimmed.starts_with('{') {
            continue;
        }
        let Some(obj) = parse_object(trimmed) else {
            continue;
        };
        if obj.get("sessionId").and_then(Value::as_str) == Some(id)
            && let Some(dir) = obj.get("sessionDir").and_then(Value::as_str) {
                indexed = Some(PathBuf::from(dir));
            }
    }
    indexed
}

fn read_session(dir: &Path, id: &str) -> Option<SessionRow> {
    let state_file = dir.join("state.json");
    let text = fsutil::read_lossy(&state_file)?;
    let obj = parse_object(&text)?;
    let mtime = mtime_ms(&state_file).unwrap_or(0);
    let title_field = string_field(&obj, "title");
    let last_prompt = string_field(&obj, "lastPrompt");
    let wire = wire_title(&wire_path(dir));
    let raw = if !title_field.is_empty() {
        title_field
    } else if !last_prompt.is_empty() {
        last_prompt
    } else {
        wire
    };
    let collapsed_owned = whitespace_collapse(&raw);
    let collapsed = jtrim(&collapsed_owned);
    let title = if collapsed.is_empty() { id.to_string() } else { js_slice(collapsed, 0, Some(120)) };
    let updated = time_of(obj.get("updatedAt"));
    let mut row = SessionRow {
        id: id.to_string(),
        command: "kimi".into(),
        title,
        updated_at: if updated == 0 { mtime } else { updated },
        created_at: None,
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    };
    let created = time_of(obj.get("createdAt"));
    if created != 0 {
        row.created_at = Some(created);
    }
    Some(row)
}

fn string_field(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    obj.get(key).and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default()
}

fn time_of(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().map(kimi_time_number).unwrap_or(0),
        Some(Value::String(text)) => parse_date_ms(text).unwrap_or(0),
        _ => 0,
    }
}

fn wire_title(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    use std::io::{Read, Seek, SeekFrom};
    let mut offset: u64 = 0;
    let mut carry = String::new();
    let mut buf = vec![0_u8; CHUNK];
    while offset < SCAN_MAX {
        if file.seek(SeekFrom::Start(offset)).is_err() {
            break;
        }
        let Ok(n) = file.read(&mut buf) else {
            break;
        };
        if n == 0 {
            break;
        }
        offset += n as u64;
        carry.push_str(&String::from_utf8_lossy(&buf[..n]));
        let mut lines: Vec<&str> = carry.split('\n').collect();
        let rest = lines.pop().unwrap_or("").to_string();
        for line in lines {
            if let Some(title) = title_from_line(line) {
                return title;
            }
        }
        carry = rest;
    }
    String::new()
}

fn title_from_line(line: &str) -> Option<String> {
    let trimmed = jtrim(line);
    if !trimmed.starts_with('{') {
        return None;
    }
    let obj = parse_object(trimmed)?;
    if obj.get("type").and_then(Value::as_str) != Some("context.append_message") {
        return None;
    }
    let msg = obj.get("message")?.as_object()?;
    if msg.get("origin").and_then(Value::as_object).and_then(|origin| origin.get("kind")).and_then(Value::as_str) != Some("user")
    {
        return None;
    }
    let text = extract_turn_text(msg.get("content").unwrap_or(&Value::Null), "user")?;
    let clipped = js_slice(&text, 0, Some(120));
    if clipped.is_empty() { None } else { Some(clipped) }
}
