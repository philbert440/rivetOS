use std::path::PathBuf;
use std::sync::Mutex;

use crate::capture::{capture_parsed, capture_snapshot, project_turns};
use crate::identity::{den_session_ref, path_unsafe};
use crate::jsonl::read_jsonl;
use crate::nest::DelegatedLink;
use crate::roots::Roots;
use crate::turn::{CaptureMessage, SessionRow, StoreRef, Transcript};

mod claude;
mod codex;
mod cowork;
mod cursor;
mod grok;
mod hermes;
mod kimi;
mod opencode;
mod pi;
mod qwen;

pub use cowork::config_roots as cowork_config_roots;
pub use grok::GrokIndex;

pub struct Store {
    pub roots: Roots,
    grok: Mutex<GrokIndex>,
}

impl Store {
    pub fn new(roots: Roots) -> Self {
        Self {
            roots,
            grok: Mutex::new(GrokIndex::new()),
        }
    }

    pub fn reset_grok(&self) {
        if let Ok(mut index) = self.grok.lock() {
            index.reset();
        }
    }

    pub fn list(
        &self,
        commands: &[&str],
        limit: usize,
        links: &[DelegatedLink],
    ) -> Vec<SessionRow> {
        let mut all = Vec::new();
        if commands.contains(&"claude") {
            all.extend(claude::list(&self.roots, limit, links));
        }
        if commands.contains(&"grok")
            && let Ok(mut index) = self.grok.lock()
        {
            all.extend(grok::list(&self.roots, &mut index, limit));
        }
        if commands.contains(&"hermes") {
            all.extend(hermes::list(&self.roots, limit));
        }
        if commands.contains(&"kimi") {
            all.extend(kimi::list(&self.roots, limit));
        }
        if commands.contains(&"codex") {
            all.extend(codex::list(&self.roots, limit));
        }
        if commands.contains(&"opencode") {
            all.extend(opencode::list(&self.roots, limit));
        }
        if commands.contains(&"pi") {
            all.extend(pi::list(&self.roots, limit));
        }
        if commands.contains(&"qwen") {
            all.extend(qwen::list(&self.roots, limit));
        }
        if commands.contains(&"cursor") {
            all.extend(cursor::list(&self.roots, limit));
        }
        if commands.contains(&"cowork") {
            all.extend(cowork::list(&self.roots, limit));
        }
        all.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
        crate::nest::with_ancestors(all, limit)
    }

    pub fn describe_claude(&self, id: &str, parent: Option<&str>) -> Option<SessionRow> {
        claude::describe(&self.roots, id, parent)
    }

    pub fn describe_grok(&self, id: &str) -> Option<SessionRow> {
        self.grok
            .lock()
            .ok()
            .and_then(|mut index| grok::describe(&self.roots, &mut index, id))
    }

    pub fn describe_hermes(&self, id: &str) -> Option<SessionRow> {
        hermes::describe(&self.roots, id)
    }

    pub fn describe_kimi(&self, id: &str) -> Option<SessionRow> {
        kimi::describe(&self.roots, id)
    }

    pub fn describe_codex(&self, id: &str) -> Option<SessionRow> {
        codex::describe(&self.roots, id)
    }

    pub fn describe_opencode(&self, id: &str) -> Option<SessionRow> {
        opencode::describe(&self.roots, id)
    }

    pub fn describe_pi(&self, id: &str) -> Option<SessionRow> {
        pi::describe(&self.roots, id)
    }

    pub fn describe_qwen(&self, id: &str) -> Option<SessionRow> {
        qwen::describe(&self.roots, id)
    }

    pub fn describe_cursor(&self, id: &str) -> Option<SessionRow> {
        cursor::describe(&self.roots, id)
    }

    pub fn session_exists(&self, command: &str, id: &str) -> bool {
        if id.is_empty() || id.contains('/') || id.contains("..") {
            return false;
        }
        match command {
            "hermes" => hermes::exists_session(&self.roots, id),
            "kimi" => kimi::exists_session(&self.roots, id),
            "codex" => codex::exists_session(&self.roots, id),
            "opencode" => opencode::exists_session(&self.roots, id),
            "pi" => pi::exists_session(&self.roots, id),
            "qwen" => qwen::exists_session(&self.roots, id),
            "cursor" => cursor::exists_session(&self.roots, id),
            "cowork" => false,
            "claude" => claude::exists_session(&self.roots, id),
            "grok" => grok::exists_session(&self.roots, id),
            _ => false,
        }
    }

    pub fn read_transcript(&self, id: &str) -> Transcript {
        let refer = den_session_ref(id);
        if path_unsafe(&refer.native) {
            return Transcript::empty(id);
        }
        let wants = |store: &str| refer.command.is_none_or(|command| command == store);
        if wants("claude") && claude::find_jsonl(&self.roots, &refer.native, None).is_some() {
            let read = self.read_claude(&refer.native, None);
            if !read.turns.is_empty() || read.truncated {
                return transcript(id, "claude", read.turns, read.messages, read.truncated);
            }
        }
        if wants("grok")
            && let Some(path) = grok::find_chat_history(&self.roots, &refer.native)
        {
            let read = self.finish_grok(id, &path);
            if !read.turns.is_empty() {
                return read;
            }
        }
        if wants("codex") {
            let codex = self.read_codex(&refer.native);
            if !codex.turns.is_empty() {
                return transcript(id, "codex", codex.turns, codex.messages, codex.truncated);
            }
        }
        if wants("hermes") {
            let (turns, messages) = hermes::load(&self.roots, &refer.native);
            if !turns.is_empty() {
                return transcript(id, "hermes", turns, messages, false);
            }
        }
        if wants("kimi") && refer.native.starts_with("session_") {
            let kimi = self.read_kimi(&refer.native);
            if !kimi.turns.is_empty() {
                return transcript(id, "kimi", kimi.turns, kimi.messages, kimi.truncated);
            }
        }
        if wants("opencode") && refer.native.starts_with("ses_") {
            let open = self.read_opencode(&refer.native);
            if !open.turns.is_empty() {
                return transcript(id, "opencode", open.turns, open.messages, false);
            }
        }
        if wants("pi") {
            let pi = self.read_pi(&refer.native);
            if !pi.turns.is_empty() {
                return transcript(id, "pi", pi.turns, pi.messages, pi.truncated);
            }
        }
        if wants("qwen") {
            let qwen = self.read_qwen(&refer.native);
            if !qwen.turns.is_empty() {
                return transcript(id, "qwen", qwen.turns, qwen.messages, qwen.truncated);
            }
        }
        if wants("cursor") {
            let cursor = self.read_cursor(&refer.native);
            if !cursor.turns.is_empty() {
                return transcript(
                    id,
                    "cursor",
                    cursor.turns,
                    cursor.messages,
                    cursor.truncated,
                );
            }
        }
        if wants("cowork") {
            let cowork = self.read_cowork(&refer.native);
            if !cowork.turns.is_empty() {
                return transcript(
                    id,
                    "cowork",
                    cowork.turns,
                    cowork.messages,
                    cowork.truncated,
                );
            }
        }
        Transcript::empty(id)
    }

    pub fn read_claude(&self, id: &str, parent: Option<&str>) -> Transcript {
        if path_unsafe(id) {
            return Transcript::empty(id);
        }
        if let Some(parent) = parent
            && path_unsafe(parent)
        {
            return Transcript::empty(id);
        }
        let Some(path) = claude::find_jsonl(&self.roots, id, parent) else {
            return Transcript::empty(id);
        };
        let source = path.to_string_lossy().into_owned();
        let (turns, messages, truncated) = self.windowed(id, "claude", &path, Some(&source));
        transcript(id, "claude", turns, messages, truncated)
    }

    pub fn read_grok(&self, id: &str) -> Transcript {
        if path_unsafe(id) {
            return Transcript::empty(id);
        }
        let Some(path) = grok::find_chat_history(&self.roots, id) else {
            return Transcript::empty(id);
        };
        self.finish_grok(id, &path)
    }

    fn finish_grok(&self, id: &str, path: &std::path::Path) -> Transcript {
        let parsed = read_jsonl(path, self.roots.max_bytes);
        let native = den_session_ref(id).native;
        let hint = (!native.is_empty()).then_some(native.as_str());
        let turns = project_turns("grok", &parsed.lines, None, parsed.truncated, 0);
        let updates = path
            .parent()
            .map(|dir| dir.join("updates.jsonl"))
            .filter(|path| crate::fsutil::is_file(path));
        let messages = updates
            .as_ref()
            .map(|path| capture_snapshot(path, "grok", hint))
            .unwrap_or_default();
        transcript(id, "grok", turns, messages, parsed.truncated)
    }

    pub fn read_hermes(&self, id: &str) -> Transcript {
        if path_unsafe(id) {
            return Transcript::empty(id);
        }
        let (turns, messages) = hermes::load(&self.roots, id);
        transcript(id, "hermes", turns, messages, false)
    }

    pub fn read_kimi(&self, id: &str) -> Transcript {
        if path_unsafe(id) {
            return Transcript::empty(id);
        }
        let Some(dir) = kimi::session_dir(&self.roots, id) else {
            return Transcript::empty(id);
        };
        let path = kimi::wire_path(&dir);
        let (turns, messages, truncated) = self.windowed(id, "kimi", &path, None);
        transcript(id, "kimi", turns, messages, truncated)
    }

    pub fn read_codex(&self, id: &str) -> Transcript {
        if path_unsafe(id) {
            return Transcript::empty(id);
        }
        let path =
            codex::find_rollout(&self.roots, id).or_else(|| codex::find_room(&self.roots, id));
        self.read_jsonl_id(id, "codex", path)
    }

    pub fn read_opencode(&self, id: &str) -> Transcript {
        if id.is_empty()
            || id.contains('/')
            || id.contains("..")
            || !opencode::exists_session(&self.roots, id)
        {
            return Transcript::empty(id);
        }
        let (turns, messages, seen) = opencode::load(&self.roots, id);
        transcript_seen(id, "opencode", turns, messages, false, seen)
    }

    pub fn read_pi(&self, id: &str) -> Transcript {
        self.read_jsonl_id(id, "pi", pi::transcript_path(&self.roots, id))
    }

    pub fn read_qwen(&self, id: &str) -> Transcript {
        self.read_jsonl_id(id, "qwen", qwen::transcript_path(&self.roots, id))
    }

    pub fn read_cursor(&self, id: &str) -> Transcript {
        self.read_jsonl_id(id, "cursor", cursor::transcript_path(&self.roots, id))
    }

    pub fn read_cowork(&self, id: &str) -> Transcript {
        self.read_jsonl_id(id, "cowork", cowork::find_transcript(&self.roots, id))
    }

    pub fn read_store_at(&self, store_ref: &StoreRef, id: &str) -> Transcript {
        if store_ref.command == "hermes" {
            let (turns, messages) = hermes::load(&self.roots, &den_session_ref(id).native);
            return transcript(id, "hermes", turns, messages, false);
        }
        if store_ref.command == "opencode" {
            let (turns, messages, seen) = opencode::load(&self.roots, &den_session_ref(id).native);
            return transcript_seen(id, "opencode", turns, messages, false, seen);
        }
        if store_ref.command == "grok" {
            return self.finish_grok(id, std::path::Path::new(&store_ref.path));
        }
        let source = (store_ref.command == "claude").then_some(store_ref.path.as_str());
        let (turns, messages, truncated) = self.windowed(
            id,
            &store_ref.command,
            std::path::Path::new(&store_ref.path),
            source,
        );
        transcript(id, &store_ref.command, turns, messages, truncated)
    }

    pub fn resolve(&self, id: &str) -> Option<StoreRef> {
        let refer = den_session_ref(id);
        if path_unsafe(&refer.native) {
            return None;
        }
        let wants = |store: &str| refer.command.is_none_or(|command| command == store);
        if wants("claude")
            && let Some(path) = claude::find_jsonl(&self.roots, &refer.native, None)
        {
            return Some(ref_of("claude", path));
        }
        if wants("grok")
            && let Some(path) = grok::find_chat_history(&self.roots, &refer.native)
        {
            return Some(ref_of("grok", path));
        }
        if wants("codex")
            && let Some(path) = codex::find_rollout(&self.roots, &refer.native)
                .or_else(|| codex::find_room(&self.roots, &refer.native))
        {
            return Some(ref_of("codex", path));
        }
        if wants("hermes") && hermes::exists_session(&self.roots, &refer.native) {
            return Some(ref_of("hermes", hermes::db_path(&self.roots)));
        }
        if wants("kimi")
            && refer.native.starts_with("session_")
            && let Some(dir) = kimi::session_dir(&self.roots, &refer.native)
        {
            return Some(ref_of("kimi", kimi::wire_path(&dir)));
        }
        if wants("opencode")
            && refer.native.starts_with("ses_")
            && opencode::exists_session(&self.roots, &refer.native)
        {
            let path = opencode::db_path(&self.roots);
            let text = path.to_string_lossy().into_owned();
            return Some(StoreRef {
                command: "opencode".into(),
                path: text.clone(),
                watch_paths: Some(vec![
                    text.clone(),
                    format!("{text}-wal"),
                    format!("{text}-shm"),
                ]),
            });
        }
        if wants("pi")
            && let Some(path) = pi::transcript_path(&self.roots, &refer.native)
        {
            return Some(ref_of("pi", path));
        }
        if wants("qwen")
            && let Some(path) = qwen::transcript_path(&self.roots, &refer.native)
        {
            return Some(ref_of("qwen", path));
        }
        if wants("cursor")
            && let Some(path) = cursor::transcript_path(&self.roots, &refer.native)
        {
            return Some(ref_of("cursor", path));
        }
        if wants("cowork")
            && let Some(path) = cowork::find_transcript(&self.roots, &refer.native)
        {
            return Some(ref_of("cowork", path));
        }
        None
    }

    pub fn store_dirs(&self) -> Vec<String> {
        let mut candidates = vec![
            claude::projects_dir(&self.roots),
            grok::sessions_dir(&self.roots),
            hermes::db_path(&self.roots)
                .parent()
                .unwrap_or(std::path::Path::new(""))
                .to_path_buf(),
            kimi::sessions_dir(&self.roots),
            codex::sessions_dir(&self.roots),
            opencode::data_dir(&self.roots),
            pi::sessions_dir(&self.roots),
            qwen::projects_dir(&self.roots),
            cursor::projects_dir(&self.roots),
        ];
        candidates.extend(cowork::watch_dirs(&self.roots));
        candidates
            .into_iter()
            .filter(|dir| crate::fsutil::exists(dir))
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect()
    }

    pub fn newest_opencode_after(&self, cwd: &str, since_ms: i64) -> Option<String> {
        opencode::newest_after(&self.roots, cwd, since_ms)
    }

    pub fn newest_cursor_after(&self, cwd: &str, since_ms: i64) -> Option<String> {
        cursor::newest_after(&self.roots, cwd, since_ms)
    }

    pub fn qwen_session_cwd(&self, id: &str) -> Option<String> {
        qwen::session_cwd(&self.roots, id)
    }

    fn read_jsonl_id(&self, id: &str, command: &str, path: Option<PathBuf>) -> Transcript {
        if path_unsafe(id) {
            return Transcript::empty(id);
        }
        let Some(path) = path else {
            return Transcript::empty(id);
        };
        let source = (command == "claude").then(|| path.to_string_lossy().into_owned());
        let (turns, messages, truncated) = self.windowed(id, command, &path, source.as_deref());
        transcript(id, command, turns, messages, truncated)
    }

    fn windowed(
        &self,
        id: &str,
        command: &str,
        path: &std::path::Path,
        source: Option<&str>,
    ) -> (Vec<crate::turn::Turn>, Vec<CaptureMessage>, bool) {
        let Some(bytes) = crate::fsutil::read_bytes(path) else {
            return (Vec::new(), Vec::new(), false);
        };
        let text = crate::fsutil::lossy(&bytes);
        let lines = crate::jsonl::parse_lines(&text);
        let (kept, truncated) = crate::jsonl::kept_window_offset(&bytes, self.roots.max_bytes);
        let native = den_session_ref(id).native;
        let hint = (!native.is_empty()).then_some(native.as_str());
        let turns = project_turns(command, &lines, source, truncated, kept);
        let mtime = crate::fsutil::file_stamp(path).map(|stamp| stamp.mtime_ms);
        let last_line = crate::jsonl::last_line_index(&text);
        let messages = capture_parsed(command, &lines, hint, path, mtime, last_line);
        (turns, messages, truncated)
    }
}

fn ref_of(command: &str, path: PathBuf) -> StoreRef {
    StoreRef {
        command: command.into(),
        path: path.to_string_lossy().into_owned(),
        watch_paths: None,
    }
}

fn transcript(
    id: &str,
    command: &str,
    turns: Vec<crate::turn::Turn>,
    messages: Vec<CaptureMessage>,
    truncated: bool,
) -> Transcript {
    Transcript {
        id: id.to_string(),
        command: command.to_string(),
        turns,
        messages,
        seen_stamps: Vec::new(),
        truncated,
    }
}

fn transcript_seen(
    id: &str,
    command: &str,
    turns: Vec<crate::turn::Turn>,
    messages: Vec<CaptureMessage>,
    truncated: bool,
    seen_stamps: Vec<(i64, i64)>,
) -> Transcript {
    let mut read = transcript(id, command, turns, messages, truncated);
    read.seen_stamps = seen_stamps;
    read
}
