use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::fsutil::{self, birth_ms, mtime_ms};
use crate::jsonl::{parse_object, read_jsonl};
use crate::qwen::qwen_turns_from_lines;
use crate::roots::Roots;
use crate::turn::{Role, SessionRow};
use crate::value::{jtrim, js_slice};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let mut newest = std::collections::HashMap::new();
    for row in collect(roots) {
        match newest.get(&row.0) {
            Some((_, _, prev)) if row.2 < *prev => {}
            _ => {
                newest.insert(row.0.clone(), row);
            }
        }
    }
    let mut ranked: Vec<(String, PathBuf, i64)> = newest.into_values().collect();
    ranked.sort_by_key(|row| std::cmp::Reverse(row.2));
    let mut out = Vec::new();
    for (id, path, _) in ranked.into_iter().take(limit) {
        if let Some(session) = read_known(&id, &path) {
            out.push(session);
        }
    }
    out
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let path = transcript_path(roots, id)?;
    read_known(id, &path)
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    transcript_path(roots, id).is_some()
}

pub fn session_cwd(roots: &Roots, id: &str) -> Option<String> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    cwd_from_file(&transcript_path(roots, id)?)
}

pub fn transcript_path(roots: &Roots, id: &str) -> Option<PathBuf> {
    if id.is_empty() || !native(id) || id.contains('/') || id.contains("..") {
        return None;
    }
    let root = projects_dir(roots);
    let buckets = fsutil::read_dir_names(&root)?;
    let mut best: Option<(PathBuf, i64)> = None;
    for bucket in buckets {
        if bucket.starts_with('.') {
            continue;
        }
        let Some(names) = fsutil::read_dir_names(&root.join(&bucket).join("chats")) else {
            continue;
        };
        for name in names {
            best = consider(best, root.join(&bucket).join("chats").join(&name), &name, id);
        }
    }
    best.map(|(path, _)| path)
}

pub fn projects_dir(roots: &Roots) -> PathBuf {
    home(roots).join("projects")
}

pub fn home(roots: &Roots) -> PathBuf {
    roots.qwen_home.clone().unwrap_or_else(|| roots.join_home(&[".qwen"]))
}

fn collect(roots: &Roots) -> Vec<(String, PathBuf, i64)> {
    let root = projects_dir(roots);
    let mut out = Vec::new();
    let Some(buckets) = fsutil::read_dir_names(&root) else {
        return out;
    };
    for bucket in buckets {
        if bucket.starts_with('.') || !fsutil::is_dir(&root.join(&bucket)) {
            continue;
        }
        let chats = root.join(&bucket).join("chats");
        let Some(files) = fsutil::read_dir_names(&chats) else {
            continue;
        };
        for name in files {
            if name.ends_with(".runtime.json") || !session_file(&name) {
                continue;
            }
            let id = name.trim_end_matches(".jsonl").to_string();
            let full = chats.join(&name);
            if fsutil::is_file(&full) {
                out.push((id, full.clone(), mtime_ms(&full).unwrap_or(0)));
            }
        }
    }
    out
}

fn consider(best: Option<(PathBuf, i64)>, full: PathBuf, name: &str, id: &str) -> Option<(PathBuf, i64)> {
    if name.ends_with(".runtime.json") || !session_file(name) {
        return best;
    }
    if !name.trim_end_matches(".jsonl").eq_ignore_ascii_case(id) {
        return best;
    }
    if !fsutil::is_file(&full) {
        return best;
    }
    let mtime = mtime_ms(&full).unwrap_or(0);
    match best {
        Some((_, prev)) if mtime <= prev => best,
        _ => Some((full, mtime)),
    }
}

fn read_known(id: &str, path: &Path) -> Option<SessionRow> {
    let mtime = mtime_ms(path)?;
    let title = title_from(path);
    let cwd = cwd_from_file(path);
    Some(SessionRow {
        id: id.to_string(),
        command: "qwen".into(),
        title: if title.is_empty() { id.to_string() } else { title },
        updated_at: mtime,
        created_at: Some(birth_ms(path)),
        cwd,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    })
}

fn title_from(path: &Path) -> String {
    let parsed = read_jsonl(path, u64::MAX);
    for obj in &parsed.objects {
        if obj.get("type").and_then(Value::as_str) != Some("user") || obj.get("provenance").and_then(Value::as_str) != Some("real_user")
        {
            continue;
        }
        let Some(message) = obj.get("message").and_then(Value::as_object) else {
            continue;
        };
        let parts = message.get("parts").and_then(Value::as_array);
        let text = parts
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.as_object())
                    .map(|part| part.get("text").and_then(Value::as_str).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let trimmed = jtrim(&text);
        if !trimmed.is_empty() {
            return js_slice(trimmed, 0, Some(120));
        }
    }
    for turn in qwen_turns_from_lines(&parsed.objects) {
        if turn.role == Role::User {
            let trimmed = jtrim(&turn.text);
            if !trimmed.is_empty() {
                return js_slice(trimmed, 0, Some(120));
            }
        }
    }
    String::new()
}

fn cwd_from_file(path: &Path) -> Option<String> {
    let text = fsutil::read_lossy(path)?;
    let window = if text.len() > 64 * 1024 { text[..64 * 1024].to_string() } else { text };
    for line in window.split('\n') {
        if jtrim(line).is_empty() {
            continue;
        }
        let Some(obj) = parse_object(line) else {
            continue;
        };
        if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
            let trimmed = jtrim(cwd);
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn native(id: &str) -> bool {
    uuid_re().is_some_and(|re| re.is_match(id))
}

fn session_file(name: &str) -> bool {
    file_re().is_some_and(|re| re.is_match(name))
}

fn uuid_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()).as_ref()
}

fn file_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$").ok())
        .as_ref()
}
