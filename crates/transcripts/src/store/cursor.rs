use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::cursor::cursor_turns_from_objects;
use crate::fsutil::{self, birth_ms, mtime_ms};
use crate::jsonl::parse_object;
use crate::paths::cursor_project_slug;
use crate::roots::Roots;
use crate::turn::{Role, SessionRow};
use crate::value::{jtrim, js_slice, whitespace_collapse};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let mut newest: HashMap<String, CursorFile> = HashMap::new();
    for row in collect(roots) {
        match newest.get(&row.id) {
            Some(prev) if row.mtime < prev.mtime => {}
            _ => {
                newest.insert(row.id.clone(), row);
            }
        }
    }
    let mut ranked: Vec<CursorFile> = newest.into_values().collect();
    ranked.sort_by_key(|row| std::cmp::Reverse(row.mtime));
    ranked
        .into_iter()
        .take(limit)
        .map(|row| {
            let title = preview_title(&row.path);
            SessionRow {
                id: row.id.clone(),
                command: "cursor".into(),
                title: if title.is_empty() { row.id } else { title },
                updated_at: row.mtime,
                created_at: Some(row.birth),
                cwd: None,
                model: None,
                parent_session_id: None,
                agent_name: None,
                task_id: None,
            }
        })
        .collect()
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let path = transcript_path(roots, id)?;
    let mtime = mtime_ms(&path)?;
    let title = preview_title(&path);
    Some(SessionRow {
        id: id.to_string(),
        command: "cursor".into(),
        title: if title.is_empty() { id.to_string() } else { title },
        updated_at: mtime,
        created_at: Some(birth_ms(&path)),
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    })
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    transcript_path(roots, id).is_some()
}

pub fn transcript_path(roots: &Roots, id: &str) -> Option<PathBuf> {
    if id.is_empty() || !uuid(id) || id.contains('/') || id.contains("..") {
        return None;
    }
    let root = projects_dir(roots);
    let projects = fsutil::read_dir_names(&root)?;
    let mut best: Option<(PathBuf, i64)> = None;
    for project in projects {
        if project.starts_with('.') {
            continue;
        }
        let path = root.join(&project).join("agent-transcripts").join(id).join(format!("{id}.jsonl"));
        if !fsutil::is_file(&path) {
            continue;
        }
        let mtime = mtime_ms(&path).unwrap_or(0);
        if best.as_ref().is_none_or(|(_, prev)| mtime >= *prev) {
            best = Some((path, mtime));
        }
    }
    best.map(|(path, _)| path)
}

pub fn newest_after(roots: &Roots, cwd: &str, since_ms: i64) -> Option<String> {
    let dir = projects_dir(roots).join(cursor_project_slug(cwd, &roots.cwd)).join("agent-transcripts");
    let ids = fsutil::read_dir_names(&dir)?;
    let mut best: Option<(String, i64)> = None;
    for id in ids {
        if !uuid(&id) {
            continue;
        }
        let path = dir.join(&id).join(format!("{id}.jsonl"));
        if !fsutil::is_file(&path) {
            continue;
        }
        let mtime = mtime_ms(&path).unwrap_or(0);
        if mtime < since_ms {
            continue;
        }
        if best.as_ref().is_none_or(|(_, prev)| mtime >= *prev) {
            best = Some((id, mtime));
        }
    }
    best.map(|(id, _)| id)
}

pub fn projects_dir(roots: &Roots) -> PathBuf {
    let base = roots.cursor_home.clone().unwrap_or_else(|| roots.join_home(&[".cursor"]));
    base.join("projects")
}

struct CursorFile {
    id: String,
    path: PathBuf,
    mtime: i64,
    birth: i64,
}

fn collect(roots: &Roots) -> Vec<CursorFile> {
    let root = projects_dir(roots);
    let mut out = Vec::new();
    let Some(projects) = fsutil::read_dir_names(&root) else {
        return out;
    };
    for project in projects {
        if project.starts_with('.') {
            continue;
        }
        let Some(ids) = fsutil::read_dir_names(&root.join(&project).join("agent-transcripts")) else {
            continue;
        };
        for id in ids {
            if !uuid(&id) {
                continue;
            }
            let path = root.join(&project).join("agent-transcripts").join(&id).join(format!("{id}.jsonl"));
            if !fsutil::is_file(&path) {
                continue;
            }
            out.push(CursorFile {
                id,
                path: path.clone(),
                mtime: mtime_ms(&path).unwrap_or(0),
                birth: birth_ms(&path),
            });
        }
    }
    out
}

fn preview_title(file: &Path) -> String {
    let Some(raw) = fsutil::read_prefix_lossy(file, 16_384) else {
        return String::new();
    };
    for line in raw.split('\n') {
        let trimmed = jtrim(line);
        if !trimmed.starts_with('{') {
            continue;
        }
        let Some(obj) = parse_object(trimmed) else {
            continue;
        };
        let Some(turn) = cursor_turns_from_objects(&[obj]).into_iter().next() else {
            continue;
        };
        if turn.role != Role::User {
            continue;
        }
        let text = jtrim(&turn.text);
        if text.is_empty() {
            continue;
        }
        return js_slice(&whitespace_collapse(text), 0, Some(120));
    }
    String::new()
}

fn uuid(id: &str) -> bool {
    uuid_re().is_some_and(|re| re.is_match(id))
}

fn uuid_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok()).as_ref()
}
