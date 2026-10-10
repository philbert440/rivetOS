use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::fsutil::{self, birth_ms, mtime_ms};
use crate::jsonl::read_jsonl;
use crate::pi::pi_turns_from_lines;
use crate::roots::Roots;
use crate::turn::SessionRow;
use crate::value::{jtrim, js_slice};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let mut newest: std::collections::HashMap<String, PiFile> = std::collections::HashMap::new();
    for row in collect(roots) {
        match newest.get(&row.id) {
            Some(prev) if row.mtime < prev.mtime => {}
            _ => {
                newest.insert(row.id.clone(), row);
            }
        }
    }
    let mut ranked: Vec<PiFile> = newest.into_values().collect();
    ranked.sort_by_key(|row| std::cmp::Reverse(row.mtime));
    let mut out = Vec::new();
    for row in ranked.into_iter().take(limit) {
        if let Some(session) = read_known(roots, &row.id, &row.path) {
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
    read_known(roots, id, &path)
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    transcript_path(roots, id).is_some()
}

pub fn transcript_path(roots: &Roots, id: &str) -> Option<PathBuf> {
    if id.is_empty() || !native(id) || id.contains('/') || id.contains("..") {
        return None;
    }
    let root = sessions_dir(roots);
    let entries = fsutil::read_dir_names(&root)?;
    let mut best: Option<(PathBuf, i64, String)> = None;
    for entry in entries {
        if entry.starts_with('.') {
            continue;
        }
        let full = root.join(&entry);
        if fsutil::is_file(&full) {
            best = consider(best, &full, &entry, id);
            continue;
        }
        if !fsutil::is_dir(&full) {
            continue;
        }
        let Some(names) = fsutil::read_dir_names(&full) else {
            continue;
        };
        for name in names {
            best = consider(best, &full.join(&name), &name, id);
        }
    }
    best.map(|(path, _, _)| path)
}

pub fn sessions_dir(roots: &Roots) -> PathBuf {
    home(roots).join("sessions")
}

pub fn home(roots: &Roots) -> PathBuf {
    roots.pi_home.clone().unwrap_or_else(|| roots.join_home(&[".pi", "agent"]))
}

struct PiFile {
    id: String,
    path: PathBuf,
    mtime: i64,
}

fn collect(roots: &Roots) -> Vec<PiFile> {
    let root = sessions_dir(roots);
    let mut out = Vec::new();
    let Some(entries) = fsutil::read_dir_names(&root) else {
        return out;
    };
    for entry in entries {
        if entry.starts_with('.') {
            continue;
        }
        let full = root.join(&entry);
        if fsutil::is_file(&full) {
            push_file(&mut out, &root, &entry);
            continue;
        }
        if !fsutil::is_dir(&full) {
            continue;
        }
        let Some(files) = fsutil::read_dir_names(&full) else {
            continue;
        };
        for name in files {
            if fsutil::is_file(&full.join(&name)) {
                push_file(&mut out, &full, &name);
            }
        }
    }
    out
}

fn push_file(out: &mut Vec<PiFile>, dir: &Path, name: &str) {
    let Some(id) = native_from_filename(name) else {
        return;
    };
    let path = dir.join(name);
    if fsutil::is_file(&path) {
        let mtime = mtime_ms(&path).unwrap_or(0);
        out.push(PiFile { id, path, mtime });
    }
}

fn consider(best: Option<(PathBuf, i64, String)>, full: &Path, name: &str, id: &str) -> Option<(PathBuf, i64, String)> {
    if native_from_filename(name).as_deref() != Some(id) || !fsutil::is_file(full) {
        return best;
    }
    let prefix = name.strip_suffix(&format!("_{id}.jsonl")).unwrap_or(name).to_string();
    let mtime = mtime_ms(full).unwrap_or(0);
    match &best {
        Some((_, prev_mtime, prev_prefix))
            if mtime < *prev_mtime || (mtime == *prev_mtime && prefix.as_str() <= prev_prefix.as_str()) =>
        {
            best
        }
        _ => Some((full.to_path_buf(), mtime, prefix)),
    }
}

fn read_known(_roots: &Roots, id: &str, path: &Path) -> Option<SessionRow> {
    if !fsutil::is_file(path) {
        return None;
    }
    let mtime = mtime_ms(path)?;
    let title = title_from(path);
    Some(SessionRow {
        id: id.to_string(),
        command: "pi".into(),
        title: if title.is_empty() { id.to_string() } else { title },
        updated_at: mtime,
        created_at: Some(birth_ms(path)),
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    })
}

fn title_from(path: &Path) -> String {
    let parsed = read_jsonl(path, u64::MAX);
    for obj in &parsed.objects {
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "name" || kind == "session_name" {
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| obj.get("session_name").and_then(Value::as_str))
                .unwrap_or("");
            let trimmed = jtrim(name);
            if !trimmed.is_empty() {
                return js_slice(trimmed, 0, Some(120));
            }
        }
    }
    for turn in pi_turns_from_lines(&parsed.objects) {
        if turn.role == crate::turn::Role::User {
            let trimmed = jtrim(&turn.text);
            if !trimmed.is_empty() {
                return js_slice(trimmed, 0, Some(120));
            }
        }
    }
    String::new()
}

fn native(id: &str) -> bool {
    uuid_re().is_some_and(|re| re.is_match(id))
}

fn native_from_filename(name: &str) -> Option<String> {
    let caps = file_re()?.captures(name)?;
    caps.get(2).map(|item| item.as_str().to_string())
}

fn uuid_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()).as_ref()
}

fn file_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$").ok()
    })
    .as_ref()
}
