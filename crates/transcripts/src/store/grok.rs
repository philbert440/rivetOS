use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::fsutil;
use crate::identity::is_bare_native_uuid;
use crate::jsonl::parse_object;
use crate::nest::with_ancestors;
use crate::roots::Roots;
use crate::timeutil::parse_date_ms;
use crate::turn::SessionRow;
use crate::value::{jtrim, js_slice};

const LOCATE_TTL_MS: i64 = 30_000;
const LOCATE_MISS_TTL_MS: i64 = 5_000;
const LOCATE_MAX: usize = 256;

struct SpawnCursor {
    parsed_until: u64,
    mtime_ms: i64,
    children: Vec<String>,
    ino: u64,
    dev: u64,
}

struct Located {
    at: i64,
    dir: Option<PathBuf>,
    absent: bool,
}

pub struct GrokIndex {
    root: String,
    parents: HashMap<String, String>,
    files: HashMap<String, SpawnCursor>,
    locations: VecDeque<(String, Located)>,
    update_files: Option<(Vec<String>, i64)>,
}

impl GrokIndex {
    pub fn new() -> Self {
        Self {
            root: String::new(),
            parents: HashMap::new(),
            files: HashMap::new(),
            locations: VecDeque::new(),
            update_files: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }
}

impl Default for GrokIndex {
    fn default() -> Self {
        Self::new()
    }
}

pub fn list(roots: &Roots, index: &mut GrokIndex, limit: usize) -> Vec<SessionRow> {
    let dir = sessions_dir(roots);
    ensure_root(index, &dir);
    let Some(cwd_dirs) = fsutil::read_dir_names(&dir) else {
        return Vec::new();
    };
    let mut reads = Vec::new();
    let mut updates = Vec::new();
    for cwd in cwd_dirs {
        let Some(entries) = fsutil::read_dir_names(&dir.join(&cwd)) else {
            continue;
        };
        for name in entries {
            let session_dir = dir.join(&cwd).join(&name);
            if !fsutil::is_dir(&session_dir) {
                continue;
            }
            updates.push(session_dir.join("updates.jsonl"));
            if let Some(read) = read_summary(&session_dir, &name) {
                reads.push(read);
            }
        }
    }
    index.update_files = Some((updates.iter().map(|path| path.to_string_lossy().into_owned()).collect(), now_ms()));
    let parents = sync_parents(index, &updates);
    let mut rows = stamp_parents(reads, &parents);
    rows.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
    with_ancestors(rows, limit)
}

pub fn describe(roots: &Roots, index: &mut GrokIndex, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let root = sessions_dir(roots);
    ensure_root(index, &root);
    if let Some(cached) = cached_location(index, id) {
        if cached.absent {
            return None;
        }
        if let Some(dir) = cached.dir.clone() {
            if let Some(found) = read_summary(&dir, id) {
                return Some(finish(index, &root, found));
            }
            index.locations.retain(|(key, _)| key != id);
        }
    }
    match locate(&root, id) {
        Locate::NoStore | Locate::Pending => None,
        Locate::Absent => {
            remember(index, id, Located { at: now_ms(), dir: None, absent: true });
            None
        }
        Locate::Hit { dir, found } => {
            remember(index, id, Located { at: now_ms(), dir: Some(dir), absent: false });
            Some(finish(index, &root, *found))
        }
    }
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    let dir = sessions_dir(roots);
    let Some(tops) = fsutil::read_dir_names(&dir) else {
        return false;
    };
    tops.iter().any(|cwd| fsutil::is_dir(&dir.join(cwd).join(id)))
}

pub fn find_chat_history(roots: &Roots, id: &str) -> Option<PathBuf> {
    let dir = sessions_dir(roots);
    let cwd_dirs = fsutil::read_dir_names(&dir)?;
    let mut best: Option<(PathBuf, i64)> = None;
    for cwd in cwd_dirs {
        let path = dir.join(&cwd).join(id).join("chat_history.jsonl");
        if !fsutil::is_file(&path) {
            continue;
        }
        let mtime = fsutil::mtime_ms(&path).unwrap_or(0);
        if best.as_ref().is_none_or(|(_, prev)| mtime > *prev) {
            best = Some((path, mtime));
        }
    }
    best.map(|(path, _)| path)
}

pub fn sessions_dir(roots: &Roots) -> PathBuf {
    let base = roots.env_trim("GROK_HOME").map(PathBuf::from).unwrap_or_else(|| roots.join_home(&[".grok"]));
    base.join("sessions")
}

struct SummaryRead {
    row: SessionRow,
    nested: bool,
}

enum Locate {
    Hit { dir: PathBuf, found: Box<SummaryRead> },
    Pending,
    Absent,
    NoStore,
}

fn ensure_root(index: &mut GrokIndex, root: &Path) {
    let text = root.to_string_lossy();
    if index.root != text {
        let root = text.into_owned();
        *index = GrokIndex::new();
        index.root = root;
    }
}

fn finish(index: &mut GrokIndex, root: &Path, found: SummaryRead) -> SessionRow {
    if !found.nested {
        return found.row;
    }
    let files = update_files(index, root);
    let parents = sync_parents(index, &files);
    stamp_parents(vec![found], &parents).into_iter().next().unwrap_or_else(empty_row)
}

fn empty_row() -> SessionRow {
    SessionRow {
        id: String::new(),
        command: "grok".into(),
        title: String::new(),
        updated_at: 0,
        created_at: None,
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    }
}

fn update_files(index: &mut GrokIndex, root: &Path) -> Vec<PathBuf> {
    if let Some((paths, at)) = &index.update_files
        && now_ms() - *at < LOCATE_TTL_MS {
            return paths.iter().map(PathBuf::from).collect();
        }
    let Some(tops) = fsutil::read_dir_names(root) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for cwd in tops {
        let Some(entries) = fsutil::read_dir_names(&root.join(&cwd)) else {
            continue;
        };
        for name in entries {
            let session_dir = root.join(&cwd).join(&name);
            if fsutil::is_dir(&session_dir) {
                paths.push(session_dir.join("updates.jsonl"));
            }
        }
    }
    index.update_files = Some((paths.iter().map(|path| path.to_string_lossy().into_owned()).collect(), now_ms()));
    paths
}

fn locate(root: &Path, id: &str) -> Locate {
    let Some(cwd_dirs) = fsutil::read_dir_names(root) else {
        return Locate::NoStore;
    };
    let mut best: Option<(SummaryRead, PathBuf)> = None;
    let mut saw_dir = false;
    for cwd in cwd_dirs {
        let session_dir = root.join(&cwd).join(id);
        if let Some(read) = read_summary(&session_dir, id) {
            let replace = best.as_ref().is_none_or(|(prev, _)| read.row.updated_at > prev.row.updated_at);
            if replace {
                best = Some((read, session_dir));
            }
            continue;
        }
        if !saw_dir && fsutil::is_dir(&session_dir) {
            saw_dir = true;
        }
    }
    if let Some((found, dir)) = best {
        return Locate::Hit { dir, found: Box::new(found) };
    }
    if saw_dir { Locate::Pending } else { Locate::Absent }
}

fn read_summary(dir: &Path, fallback_id: &str) -> Option<SummaryRead> {
    let text = fsutil::read_lossy(&dir.join("summary.json"))?;
    let obj = parse_object(&text)?;
    let id = obj
        .get("info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or(fallback_id)
        .to_string();
    let updated = obj.get("updated_at").and_then(Value::as_str).and_then(parse_date_ms).unwrap_or(0);
    let created = obj.get("created_at").and_then(Value::as_str).and_then(parse_date_ms);
    let title_raw = obj.get("session_summary").and_then(Value::as_str).unwrap_or("");
    let title = {
        let trimmed = jtrim(title_raw);
        if trimmed.is_empty() { id.clone() } else { js_slice(trimmed, 0, Some(120)) }
    };
    let mut row = SessionRow {
        id,
        command: "grok".into(),
        title,
        updated_at: updated,
        created_at: created,
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    };
    let agent = clip(obj.get("agent_name"), 64);
    if !agent.is_empty() {
        row.agent_name = Some(agent);
    }
    let model = clip(obj.get("current_model_id"), 80);
    if !model.is_empty() {
        row.model = Some(model);
    }
    let kind = obj.get("session_kind").and_then(Value::as_str);
    let nested = kind == Some("subagent") || kind == Some("subagent_fork");
    Some(SummaryRead { row, nested })
}

fn clip(value: Option<&Value>, max: isize) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let trimmed = jtrim(text);
    if trimmed.is_empty() { String::new() } else { js_slice(trimmed, 0, Some(max)) }
}

fn stamp_parents(rows: Vec<SummaryRead>, parents: &HashMap<String, String>) -> Vec<SessionRow> {
    let mut out = Vec::new();
    for mut read in rows {
        if read.nested
            && let Some(parent) = parents.get(&read.row.id)
                && parent != &read.row.id {
                    read.row.parent_session_id = Some(parent.clone());
                }
        out.push(read.row);
    }
    out
}

fn sync_parents(index: &mut GrokIndex, files: &[PathBuf]) -> HashMap<String, String> {
    let live: HashMap<String, ()> = files.iter().map(|path| (path.to_string_lossy().into_owned(), ())).collect();
    let stale: Vec<String> = index.files.keys().filter(|path| !live.contains_key(path.as_str())).cloned().collect();
    for file in stale {
        drop_file(index, &file);
    }
    for file in files {
        sync_file(index, file);
    }
    index.parents.clone()
}

fn drop_file(index: &mut GrokIndex, file: &str) {
    let Some(prev) = index.files.remove(file) else {
        return;
    };
    for child in prev.children {
        index.parents.remove(&child);
    }
}

fn sync_file(index: &mut GrokIndex, file: &Path) {
    let key = file.to_string_lossy().into_owned();
    let Some(stamp) = fsutil::file_stamp(file) else {
        drop_file(index, &key);
        return;
    };
    if let Some(prev) = index.files.get(&key)
        && prev.parsed_until == stamp.size && prev.mtime_ms == stamp.mtime_ms && prev.ino == stamp.ino && prev.dev == stamp.dev {
            return;
        }
    let (replaced, shrink, start) = match index.files.get(&key) {
        None => (false, false, 0),
        Some(prev) => {
            let replaced = prev.ino != stamp.ino || prev.dev != stamp.dev;
            let shrink = stamp.size < prev.parsed_until;
            let start = if replaced || shrink { 0 } else { prev.parsed_until };
            (replaced, shrink, start)
        }
    };
    if (replaced || shrink)
        && let Some(prev) = index.files.get_mut(&key) {
            for child in std::mem::take(&mut prev.children) {
                index.parents.remove(&child);
            }
            prev.parsed_until = 0;
        }
    let mut found = Vec::new();
    let mut parsed_until = start;
    if let Some(buf) = fsutil::read_range(file, start, stamp.size) {
        let complete = buf.iter().rposition(|byte| *byte == b'\n').map(|index| index + 1).unwrap_or(0);
        if complete > 0 {
            let text = fsutil::lossy(&buf[..complete]);
            for line in text.split('\n') {
                if let Some(spawn) = take_spawn(line) {
                    found.push(spawn);
                }
            }
            parsed_until = start + complete as u64;
        }
    }
    for (child, parent) in found {
        index.parents.insert(child.clone(), parent);
        let cursor = index.files.entry(key.clone()).or_insert_with(|| SpawnCursor {
            parsed_until,
            mtime_ms: stamp.mtime_ms,
            children: Vec::new(),
            ino: stamp.ino,
            dev: stamp.dev,
        });
        if !cursor.children.iter().any(|item| item == &child) {
            cursor.children.push(child);
        }
    }
    let cursor = index.files.entry(key).or_insert_with(|| SpawnCursor {
        parsed_until,
        mtime_ms: stamp.mtime_ms,
        children: Vec::new(),
        ino: stamp.ino,
        dev: stamp.dev,
    });
    cursor.parsed_until = parsed_until;
    cursor.mtime_ms = stamp.mtime_ms;
    cursor.ino = stamp.ino;
    cursor.dev = stamp.dev;
}

fn take_spawn(line: &str) -> Option<(String, String)> {
    if !line.contains("subagent_spawned") {
        return None;
    }
    let obj = parse_object(line)?;
    let update = obj.get("params")?.as_object()?.get("update")?.as_object()?;
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("subagent_spawned") {
        return None;
    }
    let child = spawn_id(update.get("child_session_id").or_else(|| update.get("subagent_id")))?;
    let parent = spawn_id(update.get("parent_session_id"))?;
    if child == parent {
        return None;
    }
    Some((child, parent))
}

fn spawn_id(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?;
    let id = jtrim(text);
    is_bare_native_uuid(id).then(|| id.to_string())
}

fn cached_location(index: &mut GrokIndex, id: &str) -> Option<Located> {
    let pos = index.locations.iter().position(|(key, _)| key == id)?;
    let (_, hit) = index.locations.get(pos)?.clone();
    let ttl = if hit.dir.is_some() { LOCATE_TTL_MS } else { LOCATE_MISS_TTL_MS };
    if now_ms() - hit.at > ttl {
        index.locations.remove(pos);
        return None;
    }
    Some(hit)
}

fn remember(index: &mut GrokIndex, id: &str, located: Located) {
    index.locations.retain(|(key, _)| key != id);
    index.locations.push_back((id.to_string(), located));
    while index.locations.len() > LOCATE_MAX {
        index.locations.pop_front();
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|dur| i64::try_from(dur.as_millis()).unwrap_or(i64::MAX)).unwrap_or(0)
}

impl Clone for Located {
    fn clone(&self) -> Self {
        Self { at: self.at, dir: self.dir.clone(), absent: self.absent }
    }
}
