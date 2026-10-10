use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::claude::claude_turns_from_lines;
use crate::fsutil::{self, mtime_ms};
use crate::jsonl::{parse_object, read_jsonl};
use crate::roots::Roots;
use crate::timeutil::parse_date_ms;
use crate::turn::{SessionRow, Turn};
use crate::value::jtrim;

const WALK_DEPTH: usize = 6;
const TAIL_BYTES: u64 = 8_000_000;

struct TaskMeta {
    cli_session_id: String,
    title: Option<String>,
    cwd: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    transcript_path: Option<PathBuf>,
}

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    tasks(roots)
        .into_iter()
        .take(limit)
        .map(|task| SessionRow {
            id: task.cli_session_id.clone(),
            command: "cowork".into(),
            title: task.title.unwrap_or(task.cli_session_id),
            updated_at: task.updated_at_ms,
            created_at: Some(task.created_at_ms),
            cwd: task.cwd,
            model: None,
            parent_session_id: None,
            agent_name: None,
            task_id: None,
        })
        .collect()
}

pub fn turns(roots: &Roots, id: &str) -> Vec<Turn> {
    let Some(task) = find(roots, id) else {
        return Vec::new();
    };
    let Some(path) = task.transcript_path else {
        return Vec::new();
    };
    let parsed = read_jsonl(&path, TAIL_BYTES);
    claude_turns_from_lines(&parsed.objects)
}

pub fn find_transcript(roots: &Roots, id: &str) -> Option<PathBuf> {
    find(roots, id).and_then(|task| task.transcript_path)
}

pub fn watch_dirs(roots: &Roots) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in config_roots(roots) {
        out.push(root.join("local-agent-mode-sessions"));
        out.push(root.join("claude-code-sessions"));
    }
    out
}

pub fn config_roots(roots: &Roots) -> Vec<PathBuf> {
    if let Some(over) = &roots.cowork_roots {
        return over.clone();
    }
    let mut list = vec![
        roots.join_home(&["Library", "Application Support", "Claude"]),
        roots.join_home(&[".config", "Claude"]),
    ];
    if let Some(extra) = roots.env_trim("CLAUDE_CONFIG_DIR") {
        let path = PathBuf::from(extra);
        if !list.iter().any(|item| item == &path) {
            list.push(path);
        }
    }
    list
}

fn find(roots: &Roots, id: &str) -> Option<TaskMeta> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    tasks(roots).into_iter().find(|task| task.cli_session_id == id)
}

fn tasks(roots: &Roots) -> Vec<TaskMeta> {
    let mut files = Vec::new();
    for dir in watch_dirs(roots) {
        walk_meta(&dir, &mut files, 0);
    }
    let mut by_id: Vec<TaskMeta> = Vec::new();
    for file in files {
        let Some(meta) = read_meta(&file) else {
            continue;
        };
        if let Some(prev) = by_id.iter_mut().find(|item| item.cli_session_id == meta.cli_session_id) {
            if meta.updated_at_ms >= prev.updated_at_ms {
                *prev = meta;
            }
        } else {
            by_id.push(meta);
        }
    }
    by_id.sort_by_key(|item| std::cmp::Reverse(item.updated_at_ms));
    by_id
}

fn walk_meta(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > WALK_DEPTH {
        return;
    }
    let Some(entries) = fsutil::read_dir_names(dir) else {
        return;
    };
    for name in entries {
        if name.starts_with('.') {
            continue;
        }
        let full = dir.join(&name);
        if fsutil::is_dir(&full) {
            walk_meta(&full, out, depth + 1);
        } else if fsutil::is_file(&full) && meta_re().is_some_and(|re| re.is_match(&name)) {
            out.push(full);
        }
    }
}

fn read_meta(path: &Path) -> Option<TaskMeta> {
    let text = fsutil::read_lossy(path)?;
    let row = parse_object(&text)?;
    let id = row.get("cliSessionId").and_then(Value::as_str).map(jtrim).unwrap_or("");
    if id.is_empty() || id.contains('/') || id.contains("..") || id.contains('\\') {
        return None;
    }
    let created = epoch_ms(row.get("createdAt")).or_else(|| epoch_ms(row.get("created_at")))?;
    let updated = epoch_ms(row.get("lastActivityAt")).or_else(|| epoch_ms(row.get("updatedAt"))).unwrap_or(created);
    let cwd = row.get("cwd").and_then(Value::as_str).map(jtrim).filter(|text| !text.is_empty()).map(|text| text.to_string());
    let title = row.get("title").and_then(Value::as_str).map(jtrim).filter(|text| !text.is_empty()).map(|text| text.to_string());
    let transcript_path = transcript_for(path, id, cwd.as_deref());
    Some(TaskMeta {
        cli_session_id: id.to_string(),
        title,
        cwd,
        created_at_ms: created,
        updated_at_ms: updated,
        transcript_path,
    })
}

fn transcript_for(meta_file: &Path, id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    for task_dir in candidates(meta_file, cwd) {
        if let Some(found) = find_jsonl(&task_dir, id) {
            return Some(found);
        }
    }
    None
}

fn candidates(meta_file: &Path, cwd: Option<&str>) -> Vec<PathBuf> {
    let dir = meta_file.parent().unwrap_or(Path::new(""));
    let base = meta_file.file_stem().and_then(|name| name.to_str()).unwrap_or("");
    let mut out = Vec::new();
    let mut push = |candidate: PathBuf| {
        let key = candidate.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string();
        if !out.iter().any(|item: &PathBuf| item.to_string_lossy().replace('\\', "/").trim_end_matches('/') == key) {
            out.push(candidate);
        }
    };
    push(dir.join(base));
    if let Some(cwd) = cwd {
        let trimmed = jtrim(cwd);
        if !trimmed.is_empty() {
            let parent = Path::new(trimmed).parent().unwrap_or(Path::new(""));
            if parent.parent() == Some(dir) {
                push(parent.to_path_buf());
            }
        }
    }
    let uuid = base.strip_prefix("local_").unwrap_or("");
    if uuid.len() >= 8 {
        push(dir.join(&uuid[..8]));
    }
    out
}

fn find_jsonl(task_dir: &Path, id: &str) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, i64)> = None;
    walk_projects(&task_dir.join(".claude").join("projects"), id, 0, &mut best);
    best.map(|(path, _)| path)
}

fn walk_projects(dir: &Path, id: &str, depth: usize, best: &mut Option<(PathBuf, i64)>) {
    if depth > 6 {
        return;
    }
    let Some(entries) = fsutil::read_dir_names(dir) else {
        return;
    };
    for name in entries {
        if name.contains("..") {
            continue;
        }
        let path = dir.join(&name);
        if fsutil::is_dir(&path) {
            walk_projects(&path, id, depth + 1, best);
            continue;
        }
        if name != format!("{id}.jsonl") || !fsutil::is_file(&path) {
            continue;
        }
        let mtime = mtime_ms(&path).unwrap_or(0);
        if best.as_ref().is_none_or(|(_, prev)| mtime >= *prev) {
            *best = Some((path, mtime));
        }
    }
}

fn epoch_ms(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.is_finite()).map(|n| n as i64),
        Some(Value::String(text)) => {
            let trimmed = jtrim(text);
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(number) = trimmed.parse::<f64>()
                && number.is_finite() {
                    return Some(number as i64);
                }
            parse_date_ms(trimmed)
        }
        _ => None,
    }
}

fn meta_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^local_.+\.json$").ok()).as_ref()
}
