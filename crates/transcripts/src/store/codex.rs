use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::fsutil::{self, birth_ms, mtime_ms};
use crate::jsonl::parse_object;
use crate::roots::Roots;
use crate::turn::SessionRow;
use crate::value::{jtrim, js_slice, whitespace_collapse};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let mut found = rollouts(roots);
    found.sort_by_key(|file| std::cmp::Reverse(file.mtime));
    found.into_iter().take(limit).map(|file| session_row(&file.path, &file.id, file.mtime, file.birth)).collect()
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let path = find_rollout(roots, id)?;
    Some(session_row(&path, id, mtime_ms(&path).unwrap_or(0), birth_ms(&path)))
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    find_rollout(roots, id).is_some()
}

pub fn find_rollout(roots: &Roots, id: &str) -> Option<PathBuf> {
    if id.is_empty() || !native(id) || id.contains('/') || id.contains("..") {
        return None;
    }
    let root = sessions_dir(roots);
    let years = fsutil::read_dir_names(&root)?;
    let suffix = format!("-{id}.jsonl");
    let mut best: Option<(PathBuf, i64)> = None;
    for year in years {
        if !date_dir(&year, 4) {
            continue;
        }
        let Some(months) = fsutil::read_dir_names(&root.join(&year)) else {
            continue;
        };
        for month in months {
            if !date_dir(&month, 2) {
                continue;
            }
            let Some(days) = fsutil::read_dir_names(&root.join(&year).join(&month)) else {
                continue;
            };
            for day in days {
                if !date_dir(&day, 2) {
                    continue;
                }
                let dir = root.join(&year).join(&month).join(&day);
                let Some(files) = fsutil::read_dir_names(&dir) else {
                    continue;
                };
                for name in files {
                    if !name.ends_with(&suffix) {
                        continue;
                    }
                    let path = dir.join(&name);
                    if !fsutil::is_file(&path) {
                        continue;
                    }
                    let mtime = mtime_ms(&path).unwrap_or(0);
                    if best.as_ref().is_none_or(|(_, prev)| mtime > *prev) {
                        best = Some((path, mtime));
                    }
                }
            }
        }
    }
    best.map(|(path, _)| path)
}

pub fn find_room(roots: &Roots, room: &str) -> Option<PathBuf> {
    if room.is_empty() || room.contains('\0') {
        return None;
    }
    let sessions = sessions_dir(roots);
    let root = crate::fsutil::node_resolve(&roots.cwd, &sessions.to_string_lossy());
    let prefix = format!("{}/", root.to_string_lossy().trim_end_matches('/'));
    let pids = fsutil::read_dir_names(std::path::Path::new("/proc"))?;
    let mut paths = Vec::new();
    for pid in pids {
        if !pid.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if let Some(path) = room_rollout(&pid, room, &prefix)
            && !paths.iter().any(|item: &PathBuf| item == &path) {
                paths.push(path);
            }
    }
    if paths.len() == 1 { paths.pop() } else { None }
}

fn room_rollout(pid: &str, room: &str, prefix: &str) -> Option<PathBuf> {
    let dir = std::path::Path::new("/proc").join(pid);
    let argv = fsutil::read_lossy(&dir.join("cmdline"))?;
    let exe = argv.split('\0').next().unwrap_or("");
    let base = std::path::Path::new(exe).file_name().and_then(|name| name.to_str()).unwrap_or("");
    if base != "codex" {
        return None;
    }
    let env = fsutil::read_lossy(&dir.join("environ"))?;
    if !env.split('\0').any(|item| item == format!("RIVET_DEN_SESSION={room}")) {
        return None;
    }
    let fds = fsutil::read_dir_names(&dir.join("fd"))?;
    for fd in fds {
        let Ok(path) = std::fs::read_link(dir.join("fd").join(&fd)) else {
            continue;
        };
        let info = fsutil::read_lossy(&dir.join("fdinfo").join(&fd)).unwrap_or_default();
        let flags = info.lines().find_map(|line| line.strip_prefix("flags:")).map(str::trim).unwrap_or("");
        let writable = i64::from_str_radix(flags, 8).ok().is_some_and(|bits| bits & 3 != 0);
        if !writable {
            continue;
        }
        let text = path.to_string_lossy();
        if text.starts_with(prefix) && rollout_re().is_some_and(|re| re.is_match(path.file_name().and_then(|n| n.to_str()).unwrap_or("")))
        {
            return Some(path);
        }
    }
    None
}

pub fn sessions_dir(roots: &Roots) -> PathBuf {
    home(roots).join("sessions")
}

pub fn home(roots: &Roots) -> PathBuf {
    roots.env_trim("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| roots.join_home(&[".codex"]))
}

struct CodexFile {
    id: String,
    path: PathBuf,
    mtime: i64,
    birth: i64,
}

fn rollouts(roots: &Roots) -> Vec<CodexFile> {
    let root = sessions_dir(roots);
    let mut found = Vec::new();
    let Some(years) = fsutil::read_dir_names(&root) else {
        return found;
    };
    for year in years {
        if !date_dir(&year, 4) {
            continue;
        }
        let Some(months) = fsutil::read_dir_names(&root.join(&year)) else {
            continue;
        };
        for month in months {
            if !date_dir(&month, 2) {
                continue;
            }
            let Some(days) = fsutil::read_dir_names(&root.join(&year).join(&month)) else {
                continue;
            };
            for day in days {
                if !date_dir(&day, 2) {
                    continue;
                }
                let dir = root.join(&year).join(&month).join(&day);
                let Some(files) = fsutil::read_dir_names(&dir) else {
                    continue;
                };
                for name in files {
                    let Some(id) = uuid_from_name(&name) else {
                        continue;
                    };
                    let path = dir.join(&name);
                    if fsutil::is_file(&path) {
                        found.push(CodexFile {
                            id,
                            path: path.clone(),
                            mtime: mtime_ms(&path).unwrap_or(0),
                            birth: birth_ms(&path),
                        });
                    }
                }
            }
        }
    }
    found
}

fn session_row(path: &Path, id: &str, mtime: i64, birth: i64) -> SessionRow {
    let title = rollout_title(path);
    let collapsed_owned = whitespace_collapse(&title);
    let collapsed = jtrim(&collapsed_owned);
    SessionRow {
        id: id.to_string(),
        command: "codex".into(),
        title: if collapsed.is_empty() { id.to_string() } else { js_slice(collapsed, 0, Some(120)) },
        updated_at: mtime,
        created_at: Some(birth),
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    }
}

fn rollout_title(file: &Path) -> String {
    let Some(text) = fsutil::read_prefix_lossy(file, 64 * 1024) else {
        return String::new();
    };
    for line in text.split('\n') {
        if !jtrim(line).starts_with('{') {
            continue;
        }
        let Some(obj) = parse_object(line) else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = obj.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message") || payload.get("role").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        let text = payload_text(payload.get("content"));
        let trimmed = jtrim(&text);
        if trimmed.is_empty()
            || trimmed.starts_with("<environment_context>")
            || trimmed.starts_with("<skills_instructions>")
            || trimmed.starts_with("<multi_agent_")
        {
            continue;
        }
        return js_slice(trimmed, 0, Some(120));
    }
    String::new()
}

fn payload_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| {
                let Some(obj) = part.as_object() else {
                    return "";
                };
                let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "input_text" || kind == "text" {
                    obj.get("text").and_then(Value::as_str).unwrap_or("")
                } else {
                    ""
                }
            })
            .collect(),
        _ => String::new(),
    }
}

fn date_dir(name: &str, width: usize) -> bool {
    name.len() == width && name.bytes().all(|byte| byte.is_ascii_digit())
}

fn native(id: &str) -> bool {
    uuid_re().is_some_and(|re| re.is_match(id))
}

fn uuid_from_name(name: &str) -> Option<String> {
    let caps = rollout_re()?.captures(name)?;
    caps.get(1).map(|item| item.as_str().to_string())
}

fn uuid_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()).as_ref()
}

fn rollout_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$").ok()
    })
    .as_ref()
}
