use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::fsutil::{self, birth_ms, mtime_ms};
use crate::jsonl::parse_object;
use crate::nest::{DelegatedLink, apply_delegated_nesting, with_ancestors};
use crate::roots::Roots;
use crate::text::strip_pasted_content_wrapper;
use crate::turn::SessionRow;
use crate::value::{jtrim, js_slice};

struct ClaudeFile {
    id: String,
    path: PathBuf,
    mtime: i64,
    birth: i64,
    parent: Option<String>,
}

pub fn list(roots: &Roots, limit: usize, links: &[DelegatedLink]) -> Vec<SessionRow> {
    let Some(slugs) = fsutil::read_dir_names(&projects_dir(roots)) else {
        return Vec::new();
    };
    let mut by_id: HashMap<String, ClaudeFile> = HashMap::new();
    for slug in slugs {
        if !id_safe(&slug) {
            continue;
        }
        let slug_dir = projects_dir(roots).join(&slug);
        let Some(entries) = fsutil::read_dir_names(&slug_dir) else {
            continue;
        };
        for name in entries {
            if !id_safe(&name) {
                continue;
            }
            let path = slug_dir.join(&name);
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.is_file() {
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let id = name.trim_end_matches(".jsonl").to_string();
                let mtime = mtime_ms_floor(&path);
                let birth = birth_ms(&path);
                remember(
                    &mut by_id,
                    ClaudeFile { id, path, mtime, birth, parent: None },
                );
            } else if meta.is_dir() {
                for agent in agent_files(&path, &name) {
                    remember(&mut by_id, agent);
                }
            }
        }
    }
    let session_ids: HashSet<String> =
        by_id.values().filter(|file| file.parent.is_none()).map(|file| file.id.clone()).collect();
    if !session_ids.is_empty() {
        by_id.retain(|_, file| !(file.parent.is_some() && session_ids.contains(&file.id)));
    }
    let mut ranked: Vec<ClaudeFile> = by_id.values().cloned().collect();
    ranked.sort_by_key(|file| std::cmp::Reverse(file.mtime));
    let rows: Vec<SessionRow> = ranked
        .iter()
        .map(|file| {
            let mut row = row_stub(&file.id, file.mtime, file.birth);
            row.parent_session_id = file.parent.clone();
            row
        })
        .collect();
    let nested = apply_delegated_nesting(rows, links);
    let mut kept = with_ancestors(nested, limit);
    let index: HashMap<String, ClaudeFile> =
        by_id.into_iter().collect();
    for row in &mut kept {
        let Some(file) = file_for_row(&index, row) else {
            continue;
        };
        if let Some(title) = session_title(&file.path)
            && !title.is_empty() {
                row.title = title;
            }
        if file.parent.is_none() {
            continue;
        }
        let labels = agent_labels(&file.path);
        if let Some(name) = labels.0 {
            row.agent_name = Some(name);
        }
        if let Some(model) = labels.1 {
            row.model = Some(model);
        }
    }
    kept
}

pub fn describe(roots: &Roots, id: &str, parent: Option<&str>) -> Option<SessionRow> {
    if !id_safe(id) {
        return None;
    }
    if let Some(parent) = parent
        && !id_safe(parent) {
            return None;
        }
    let path = find_jsonl(roots, id, parent)?;
    let mtime = mtime_ms(&path)?;
    let mut row = row_stub(id, mtime, birth_ms(&path));
    if let Some(title) = session_title(&path)
        && !title.is_empty() {
            row.title = title;
        }
    if let Some(owner) = parent_from_agent_path(&path)
        && owner != id {
            row.parent_session_id = Some(owner);
            let labels = agent_labels(&path);
            row.agent_name = labels.0;
            row.model = labels.1;
        }
    Some(row)
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    let dir = projects_dir(roots);
    let Some(tops) = fsutil::read_dir_names(&dir) else {
        return false;
    };
    tops.iter().any(|slug| fsutil::is_file(&dir.join(slug).join(format!("{id}.jsonl"))))
}

pub fn find_jsonl(roots: &Roots, id: &str, parent: Option<&str>) -> Option<PathBuf> {
    if !id_safe(id) {
        return None;
    }
    if let Some(parent) = parent
        && !id_safe(parent) {
            return None;
        }
    let dir = projects_dir(roots);
    if parent.is_none() {
        let slugs = fsutil::read_dir_names(&dir).unwrap_or_default();
        let mut best: Option<(PathBuf, i64)> = None;
        for slug in slugs {
            if !id_safe(&slug) {
                continue;
            }
            best = consider(best, dir.join(&slug).join(format!("{id}.jsonl")));
        }
        if best.is_some() {
            return best.map(|(path, _)| path);
        }
        if uuid_re().is_some_and(|re| re.is_match(id)) {
            return None;
        }
    }
    find_agent(&dir, id, parent).map(|(path, _)| path)
}

pub fn projects_dir(roots: &Roots) -> PathBuf {
    let base = roots.env_trim("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| roots.join_home(&[".claude"]));
    base.join("projects")
}

fn row_stub(id: &str, mtime: i64, birth: i64) -> SessionRow {
    SessionRow {
        id: id.to_string(),
        command: "claude".into(),
        title: id.to_string(),
        updated_at: mtime,
        created_at: Some(birth),
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    }
}

fn mtime_ms_floor(path: &Path) -> i64 {
    mtime_ms(path).unwrap_or(0)
}

fn id_safe(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains("..") && id != "." && id != ".."
}

fn file_key(id: &str, parent: Option<&str>) -> String {
    match parent {
        Some(parent) => format!("{parent}\0{id}"),
        None => id.to_string(),
    }
}

fn remember(by_id: &mut HashMap<String, ClaudeFile>, next: ClaudeFile) {
    if !id_safe(&next.id) {
        return;
    }
    let key = file_key(&next.id, next.parent.as_deref());
    match by_id.get(&key) {
        Some(prev) if next.mtime < prev.mtime => {}
        _ => {
            by_id.insert(key, next);
        }
    }
}

fn file_for_row<'a>(by_id: &'a HashMap<String, ClaudeFile>, row: &SessionRow) -> Option<&'a ClaudeFile> {
    let scoped = by_id.get(&file_key(&row.id, row.parent_session_id.as_deref()));
    if scoped.is_some() {
        return scoped;
    }
    row.parent_session_id.as_ref()?;
    by_id.get(&row.id)
}

fn agent_files(session_dir: &Path, session_id: &str) -> Vec<ClaudeFile> {
    if !id_safe(session_id) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let subagents = session_dir.join("subagents");
    if let Some(names) = fsutil::read_dir_names(&subagents) {
        for name in names {
            if agent_re().is_some_and(|re| re.is_match(&name)) {
                push_agent(&mut out, &subagents.join(&name), session_id);
            }
        }
    }
    if let Some(runs) = fsutil::read_dir_names(&subagents.join("workflows")) {
        for run in runs {
            if !id_safe(&run) {
                continue;
            }
            let run_dir = subagents.join("workflows").join(&run);
            let Some(agents) = fsutil::read_dir_names(&run_dir) else {
                continue;
            };
            for name in agents {
                if agent_re().is_some_and(|re| re.is_match(&name)) {
                    push_agent(&mut out, &run_dir.join(&name), session_id);
                }
            }
        }
    }
    if let Some(direct) = fsutil::read_dir_names(session_dir) {
        for name in direct {
            if agent_re().is_some_and(|re| re.is_match(&name)) {
                push_agent(&mut out, &session_dir.join(&name), session_id);
            }
        }
    }
    out
}

fn push_agent(files: &mut Vec<ClaudeFile>, path: &Path, parent: &str) {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Some(id) = agent_id(name) else {
        return;
    };
    if !id_safe(&id) || !id_safe(parent) || id == parent || !fsutil::is_file(path) {
        return;
    }
    files.push(ClaudeFile {
        id,
        path: path.to_path_buf(),
        mtime: mtime_ms_floor(path),
        birth: birth_ms(path),
        parent: Some(parent.to_string()),
    });
}

fn parent_from_agent_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    agent_id(name)?;
    let mut dir = path.parent()?.to_path_buf();
    let workflows = dir.parent().and_then(|parent| parent.file_name()).and_then(|name| name.to_str()) == Some("workflows")
        && dir.parent().and_then(|parent| parent.parent()).and_then(|parent| parent.file_name()).and_then(|name| name.to_str())
            == Some("subagents");
    if workflows {
        dir = dir.parent()?.parent()?.parent()?.to_path_buf();
    } else if dir.file_name().and_then(|name| name.to_str()) == Some("subagents") {
        dir = dir.parent()?.to_path_buf();
    }
    let session_id = dir.file_name()?.to_str()?.to_string();
    id_safe(&session_id).then_some(session_id)
}

fn agent_labels(file: &Path) -> (Option<String>, Option<String>) {
    let mut agent = String::new();
    let mut model = String::new();
    let meta = file.to_string_lossy();
    if let Some(stem) = meta.strip_suffix(".jsonl")
        && let Some(text) = fsutil::read_lossy(Path::new(&format!("{stem}.meta.json")))
            && let Some(obj) = parse_object(&text) {
                agent = clip_label(obj.get("agentType").or_else(|| obj.get("subagent_type")).or_else(|| obj.get("agent_type")), 64);
                model = clip_label(obj.get("model"), 80);
            }
    if agent.is_empty() || model.is_empty() {
        let head = head_labels(file);
        if agent.is_empty() {
            agent = head.0;
        }
        if model.is_empty() {
            model = head.1;
        }
    }
    (non_empty(agent), non_empty(model))
}

fn head_labels(file: &Path) -> (String, String) {
    let mut agent = String::new();
    let mut model = String::new();
    let Some(text) = fsutil::read_prefix_lossy(file, 64 * 1024) else {
        return (agent, model);
    };
    for line in text.split('\n') {
        if !jtrim(line).starts_with('{') {
            continue;
        }
        let Some(obj) = parse_object(line) else {
            continue;
        };
        if agent.is_empty() {
            agent = clip_label(obj.get("agentType").or_else(|| obj.get("subagent_type")).or_else(|| obj.get("agent_type")), 64);
        }
        if model.is_empty() {
            let from_message = obj.get("message").and_then(Value::as_object).map(|msg| clip_label(msg.get("model"), 80)).unwrap_or_default();
            model = if from_message.is_empty() { clip_label(obj.get("model"), 80) } else { from_message };
        }
        if !agent.is_empty() && !model.is_empty() {
            break;
        }
    }
    (agent, model)
}

fn session_title(file: &Path) -> Option<String> {
    let text = fsutil::read_prefix_lossy(file, 64 * 1024)?;
    for line in text.split('\n') {
        if jtrim(line).is_empty() {
            continue;
        }
        let Some(obj) = parse_object(line) else {
            continue;
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "summary"
            && let Some(summary) = obj.get("summary").and_then(Value::as_str) {
                let trimmed = jtrim(summary);
                if !trimmed.is_empty() {
                    return Some(js_slice(trimmed, 0, Some(120)));
                }
            }
        if kind == "user" {
            let content = obj.get("message").and_then(Value::as_object).and_then(|msg| msg.get("content"));
            let txt = content_text(content);
            let trimmed = jtrim(&txt);
            if !trimmed.is_empty() {
                let stripped = strip_pasted_content_wrapper(trimmed);
                return Some(js_slice(jtrim(&stripped), 0, Some(120)));
            }
        }
    }
    Some(String::new())
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| part.as_object().and_then(|obj| obj.get("text")).and_then(Value::as_str).unwrap_or(""))
            .collect(),
        _ => String::new(),
    }
}

fn clip_label(value: Option<&Value>, max: isize) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let trimmed = jtrim(text);
    if trimmed.is_empty() { String::new() } else { js_slice(trimmed, 0, Some(max)) }
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

fn consider(best: Option<(PathBuf, i64)>, path: PathBuf) -> Option<(PathBuf, i64)> {
    if !fsutil::is_file(&path) {
        return best;
    }
    let mtime = mtime_ms(&path).unwrap_or(0);
    match best {
        Some((_, prev)) if mtime <= prev => best,
        _ => Some((path, mtime)),
    }
}

fn find_agent(root: &Path, id: &str, parent: Option<&str>) -> Option<(PathBuf, i64)> {
    let name = format!("agent-{id}.jsonl");
    let mut matches: Vec<(PathBuf, i64, String)> = Vec::new();
    let slugs = fsutil::read_dir_names(root)?;
    for slug in slugs {
        if !id_safe(&slug) {
            continue;
        }
        let Some(entries) = fsutil::read_dir_names(&root.join(&slug)) else {
            continue;
        };
        for ent in entries {
            if !id_safe(&ent) || ent.contains('.') {
                continue;
            }
            if let Some(parent) = parent
                && ent != parent {
                    continue;
                }
            let session_dir = root.join(&slug).join(&ent);
            let take = |path: PathBuf, matches: &mut Vec<(PathBuf, i64, String)>| {
                if let Some((path, mtime)) = consider(None, path) {
                    matches.push((path, mtime, ent.clone()));
                }
            };
            take(session_dir.join("subagents").join(&name), &mut matches);
            take(session_dir.join(&name), &mut matches);
            let Some(runs) = fsutil::read_dir_names(&session_dir.join("subagents").join("workflows")) else {
                continue;
            };
            for run in runs {
                if !id_safe(&run) {
                    continue;
                }
                take(session_dir.join("subagents").join("workflows").join(&run).join(&name), &mut matches);
            }
        }
    }
    if parent.is_none() {
        let parents: HashSet<&str> = matches.iter().map(|item| item.2.as_str()).collect();
        if parents.len() != 1 {
            return None;
        }
    }
    matches.into_iter().max_by_key(|item| item.1).map(|(path, mtime, _)| (path, mtime))
}

fn agent_id(name: &str) -> Option<String> {
    let re = agent_re()?;
    let caps = re.captures(name)?;
    caps.get(1).map(|m| m.as_str().to_string())
}

fn agent_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^agent-(.+)\.jsonl$").ok()).as_ref()
}

fn uuid_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").ok())
        .as_ref()
}

impl Clone for ClaudeFile {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            path: self.path.clone(),
            mtime: self.mtime,
            birth: self.birth,
            parent: self.parent.clone(),
        }
    }
}
