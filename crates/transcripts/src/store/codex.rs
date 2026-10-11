use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::reutil::Regex;
use serde_json::Value;

use crate::fsutil::{self, birth_ms, mtime_ms};
use crate::jsonl::parse_object;
use crate::roots::Roots;
use crate::turn::SessionRow;
use crate::value::{jtrim, slice_text, whitespace_collapse};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let mut found = rollouts(roots);
    found.sort_by_key(|file| std::cmp::Reverse(file.mtime));
    found
        .into_iter()
        .take(limit)
        .map(|file| session_row(&file.path, &file.id, file.mtime, file.birth))
        .collect()
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let path = find_rollout(roots, id)?;
    Some(session_row(
        &path,
        id,
        mtime_ms(&path).unwrap_or(0),
        birth_ms(&path),
    ))
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
    find_room_in(roots, room, Path::new("/proc"))
}

fn find_room_in(roots: &Roots, room: &str, proc_root: &Path) -> Option<PathBuf> {
    if room.is_empty() || room.contains('\0') {
        return None;
    }
    let sessions = sessions_dir(roots);
    let root = crate::fsutil::node_resolve(&roots.cwd, &sessions.to_string_lossy());
    let prefix = format!("{}/", root.to_string_lossy().trim_end_matches('/'));
    let pids = fsutil::read_dir_names(proc_root)?;
    let mut paths = Vec::new();
    for pid in pids {
        if !pid.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        for path in room_rollouts(proc_root, &pid, room, &prefix) {
            if !paths.iter().any(|item: &PathBuf| item == &path) {
                paths.push(path);
            }
        }
    }
    if paths.len() == 1 { paths.pop() } else { None }
}

fn room_rollouts(proc_root: &Path, pid: &str, room: &str, prefix: &str) -> Vec<PathBuf> {
    let dir = proc_root.join(pid);
    let Some(argv) = fsutil::read_lossy(&dir.join("cmdline")) else {
        return Vec::new();
    };
    let exe = argv.split('\0').next().unwrap_or("");
    let base = std::path::Path::new(exe)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if base != "codex" {
        return Vec::new();
    }
    let Some(env) = fsutil::read_lossy(&dir.join("environ")) else {
        return Vec::new();
    };
    if !env
        .split('\0')
        .any(|item| item == format!("RIVET_DEN_SESSION={room}"))
    {
        return Vec::new();
    }
    let Some(fds) = fsutil::read_dir_names(&dir.join("fd")) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for fd in fds {
        let Ok(path) = std::fs::read_link(dir.join("fd").join(&fd)) else {
            continue;
        };
        let info = fsutil::read_lossy(&dir.join("fdinfo").join(&fd)).unwrap_or_default();
        let flags = info
            .lines()
            .find_map(|line| line.strip_prefix("flags:"))
            .map(str::trim)
            .unwrap_or("");
        let writable = i64::from_str_radix(flags, 8)
            .ok()
            .is_some_and(|bits| bits & 3 != 0);
        if !writable {
            continue;
        }
        let text = path.to_string_lossy();
        if text.starts_with(prefix)
            && rollout_re().is_some_and(|re| {
                re.is_match(path.file_name().and_then(|n| n.to_str()).unwrap_or(""))
            })
        {
            found.push(path);
        }
    }
    found
}

pub fn sessions_dir(roots: &Roots) -> PathBuf {
    home(roots).join("sessions")
}

pub fn home(roots: &Roots) -> PathBuf {
    roots
        .nonempty_var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| roots.join_home(&[".codex"]))
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
        title: if collapsed.is_empty() {
            id.to_string()
        } else {
            slice_text(collapsed, 0, Some(120))
        },
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
        if payload.get("type").and_then(Value::as_str) != Some("message")
            || payload.get("role").and_then(Value::as_str) != Some("user")
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
        return slice_text(trimmed, 0, Some(120));
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
    RE.get_or_init(|| {
        Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()
    })
    .as_ref()
}

fn rollout_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$").ok()
    })
    .as_ref()
}

#[cfg(test)]
mod tests {
    use super::find_room_in;
    use crate::roots::Roots;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    fn rollout(dir: &std::path::Path, id: &str) -> PathBuf {
        let path = dir.join(format!("rollout-2026-01-01T00-00-00-{id}.jsonl"));
        fs::write(&path, "{}\n").expect("rollout");
        path
    }

    #[test]
    fn two_writable_rollouts_in_one_pid_return_nothing() {
        let root = std::env::temp_dir().join(format!("rr4a-codex-room-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sessions = root.join("sessions");
        let day = sessions.join("2026/01/01");
        fs::create_dir_all(&day).expect("day");
        let first = rollout(&day, "00000000-0000-4000-8000-0000000000a1");
        let second = rollout(&day, "00000000-0000-4000-8000-0000000000a2");
        let proc_root = root.join("proc");
        let pid = proc_root.join("7");
        fs::create_dir_all(pid.join("fd")).expect("fd");
        fs::create_dir_all(pid.join("fdinfo")).expect("fdinfo");
        fs::write(pid.join("cmdline"), "codex\0").expect("cmdline");
        fs::write(pid.join("environ"), "RIVET_DEN_SESSION=room-a\0").expect("environ");
        symlink(&first, pid.join("fd/3")).expect("link 3");
        symlink(&second, pid.join("fd/4")).expect("link 4");
        fs::write(pid.join("fdinfo/3"), "flags:\t02\n").expect("flags 3");
        fs::write(pid.join("fdinfo/4"), "flags:\t02\n").expect("flags 4");
        let mut roots = Roots::isolated(&root);
        roots.set_env("CODEX_HOME", root.to_string_lossy());
        assert!(find_room_in(&roots, "room-a", &proc_root).is_none());
        fs::remove_file(pid.join("fd/4")).expect("drop second");
        let found = find_room_in(&roots, "room-a", &proc_root).expect("one rollout");
        assert_eq!(found, first);
        let _ = fs::remove_dir_all(&root);
    }
}
