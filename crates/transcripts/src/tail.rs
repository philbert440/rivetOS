use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::fsutil;
use crate::identity::{den_session_ref, path_unsafe};
use crate::jsonl::read_jsonl;
use crate::store::Store;
use crate::turn::Turn;

#[derive(Clone, Debug, PartialEq)]
pub struct TailFrame {
    pub rev: u64,
    pub from: usize,
    pub turns: Vec<Turn>,
    pub total: usize,
    pub command: String,
    pub truncated_before: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WatchFrame {
    pub kind: String,
    pub session: String,
    pub rev: u64,
    pub from: usize,
    pub turns: Vec<Turn>,
    pub total: usize,
    pub command: String,
    pub truncated_before: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonlCursor {
    pub text: String,
    pub offset: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqliteCursor {
    pub rowid: i64,
    pub time_ms: i64,
}

pub struct TranscriptTail {
    jsonl: HashMap<String, u64>,
    sqlite: HashMap<String, SqliteCursor>,
    sigs: Vec<String>,
    turns: Vec<Turn>,
    command: String,
    rev: u64,
}

impl TranscriptTail {
    pub fn new() -> Self {
        Self {
            jsonl: HashMap::new(),
            sqlite: HashMap::new(),
            sigs: Vec::new(),
            turns: Vec::new(),
            command: String::new(),
            rev: 0,
        }
    }

    pub fn poll_display(&mut self, turns: &[Turn], command: &str, truncated: bool, snapshot: bool) -> Option<TailFrame> {
        let merged = merge_transcript_window(&self.turns, turns, truncated);
        if snapshot {
            return Some(self.emit(0, merged, command, truncated));
        }
        let next_sigs: Vec<String> = merged.iter().map(turn_sig).collect();
        let mut from = 0;
        let max = self.sigs.len().min(next_sigs.len());
        while from < max && self.sigs[from] == next_sigs[from] {
            from += 1;
        }
        if from == next_sigs.len() && next_sigs.len() == self.sigs.len() && self.command == command {
            return None;
        }
        Some(self.emit(from, merged, command, truncated))
    }

    pub fn read_new_jsonl(&mut self, path: &Path) -> JsonlCursor {
        let key = path.to_string_lossy().into_owned();
        let bytes = fsutil::read_bytes(path).unwrap_or_default();
        let mut offset = self.jsonl.get(&key).copied().unwrap_or(0);
        if bytes.len() as u64 <= offset && bytes.len() as u64 != offset {
            offset = 0;
        }
        if (bytes.len() as u64) < offset {
            offset = 0;
        }
        let start = offset as usize;
        let end = if start > bytes.len() {
            start
        } else {
            bytes[start..].iter().rposition(|byte| *byte == b'\n').map(|index| start + index + 1).unwrap_or(start)
        };
        let text = if end > start { String::from_utf8_lossy(&bytes[start..end]).into_owned() } else { String::new() };
        self.jsonl.insert(key, end as u64);
        JsonlCursor { text, offset: end as u64 }
    }

    pub fn rows_after(&mut self, key: &str, rows: &[(i64, i64)]) -> Vec<usize> {
        let cursor = self.sqlite.get(key).cloned().unwrap_or(SqliteCursor { rowid: i64::MIN, time_ms: i64::MIN });
        let mut out = Vec::new();
        let mut next = cursor;
        for (index, (time_ms, rowid)) in rows.iter().copied().enumerate() {
            let fresh = time_ms > next.time_ms || (time_ms == next.time_ms && rowid > next.rowid);
            if fresh {
                out.push(index);
                next = SqliteCursor { rowid, time_ms };
            }
        }
        if next.rowid != i64::MIN || next.time_ms != i64::MIN {
            self.sqlite.insert(key.to_string(), next);
        }
        out
    }

    fn emit(&mut self, from: usize, turns: Vec<Turn>, command: &str, truncated: bool) -> TailFrame {
        self.sigs = turns.iter().map(turn_sig).collect();
        self.command = command.to_string();
        self.rev += 1;
        let frame = TailFrame {
            rev: self.rev,
            from,
            turns: turns[from..].to_vec(),
            total: turns.len(),
            command: command.to_string(),
            truncated_before: truncated,
        };
        self.turns = turns;
        frame
    }
}

impl Default for TranscriptTail {
    fn default() -> Self {
        Self::new()
    }
}

pub fn merge_transcript_window(prev: &[Turn], next: &[Turn], truncated: bool) -> Vec<Turn> {
    if !truncated || prev.is_empty() || next.is_empty() {
        return next.to_vec();
    }
    let next0 = turn_sig(&next[0]);
    let Some(overlap) = prev.iter().position(|turn| turn_sig(turn) == next0) else {
        return next.to_vec();
    };
    let overlap_len = (prev.len() - overlap).min(next.len());
    for index in 1..overlap_len {
        if turn_sig(&prev[overlap + index]) != turn_sig(&next[index]) {
            return next.to_vec();
        }
    }
    let mut out = prev[..overlap].to_vec();
    out.extend(next.iter().cloned());
    out
}

fn turn_sig(turn: &Turn) -> String {
    serde_json::to_string(turn).unwrap_or_else(|_| "{}".into())
}

struct Watched {
    refs: u64,
    rev: u64,
    turns: Vec<Turn>,
    sigs: Vec<String>,
    command: String,
    path: Option<String>,
    last_size: u64,
    last_mtime: i64,
}

pub struct TranscriptWatch {
    watched: HashMap<String, Watched>,
}

impl TranscriptWatch {
    pub fn new() -> Self {
        Self { watched: HashMap::new() }
    }

    pub fn watch(&mut self, store: &Store, session: &str) -> Vec<WatchFrame> {
        let native = den_session_ref(session).native;
        if native.is_empty() || path_unsafe(&native) {
            return Vec::new();
        }
        if let Some(existing) = self.watched.get_mut(session) {
            existing.refs += 1;
            return self.snapshot(store, session);
        }
        self.watched.insert(session.to_string(), fresh());
        let Some(refer) = store.resolve(session) else {
            return vec![self.emit_empty(session)];
        };
        if let Some(slot) = self.watched.get_mut(session) {
            slot.path = Some(refer.path.clone());
            let stamp = fsutil::file_stamp(Path::new(&refer.path));
            slot.last_size = stamp.as_ref().map(|item| item.size).unwrap_or(0);
            slot.last_mtime = stamp.as_ref().map(|item| item.mtime_ms).unwrap_or(0);
        }
        self.snapshot(store, session)
    }

    pub fn poll(&mut self, store: &Store, session: &str) -> Vec<WatchFrame> {
        let Some(path) = self.watched.get(session).and_then(|slot| slot.path.clone()) else {
            return self.try_resolve(store, session);
        };
        let stamp = fsutil::file_stamp(Path::new(&path));
        let Some(stamp) = stamp else {
            if let Some(slot) = self.watched.get_mut(session) {
                slot.path = None;
                slot.last_size = 0;
                slot.last_mtime = 0;
            }
            return self.try_resolve(store, session);
        };
        let changed = self.watched.get(session).is_some_and(|slot| slot.last_size != stamp.size || slot.last_mtime != stamp.mtime_ms);
        if let Some(slot) = self.watched.get_mut(session) {
            slot.last_size = stamp.size;
            slot.last_mtime = stamp.mtime_ms;
        }
        if !changed {
            return Vec::new();
        }
        self.delta(store, session, false)
    }

    pub fn sync(&mut self, store: &Store, session: &str) -> Vec<WatchFrame> {
        if !self.watched.contains_key(session) {
            return Vec::new();
        }
        self.snapshot(store, session)
    }

    pub fn unwatch(&mut self, session: &str) {
        let Some(slot) = self.watched.get_mut(session) else {
            return;
        };
        slot.refs = slot.refs.saturating_sub(1);
        if slot.refs == 0 {
            self.watched.remove(session);
        }
    }

    pub fn note_sessions_dirty(&self) -> WatchFrame {
        WatchFrame {
            kind: "sessions-dirty".into(),
            session: String::new(),
            rev: 0,
            from: 0,
            turns: Vec::new(),
            total: 0,
            command: String::new(),
            truncated_before: false,
        }
    }

    fn try_resolve(&mut self, store: &Store, session: &str) -> Vec<WatchFrame> {
        let Some(refer) = store.resolve(session) else {
            return Vec::new();
        };
        if let Some(slot) = self.watched.get_mut(session) {
            slot.path = Some(refer.path);
        }
        self.snapshot(store, session)
    }

    fn snapshot(&mut self, store: &Store, session: &str) -> Vec<WatchFrame> {
        self.delta(store, session, true)
    }

    fn delta(&mut self, store: &Store, session: &str, snapshot: bool) -> Vec<WatchFrame> {
        let Some(slot) = self.watched.get(session) else {
            return Vec::new();
        };
        let path = slot.path.clone();
        let transcript = if let Some(path) = path {
            let refer = crate::turn::StoreRef { command: String::new(), path, watch_paths: None };
            let mut parsed = store.read_transcript(session);
            if parsed.turns.is_empty() {
                parsed = store.read_store_at(&crate::turn::StoreRef { command: parsed.command.clone(), ..refer }, session);
            }
            if parsed.turns.is_empty() {
                store.read_transcript(session)
            } else {
                parsed
            }
        } else {
            store.read_transcript(session)
        };
        let _ = Value::Null;
        let prev = self.watched.get(session).map(|slot| slot.turns.clone()).unwrap_or_default();
        let merged = merge_transcript_window(&prev, &transcript.turns, transcript.truncated);
        let sigs: Vec<String> = merged.iter().map(turn_sig).collect();
        let old = self.watched.get(session).map(|slot| (slot.sigs.clone(), slot.command.clone())).unwrap_or_default();
        let mut from = 0;
        if !snapshot {
            let max = old.0.len().min(sigs.len());
            while from < max && old.0[from] == sigs[from] {
                from += 1;
            }
            if from == sigs.len() && sigs.len() == old.0.len() && old.1 == transcript.command {
                return Vec::new();
            }
        }
        let Some(slot) = self.watched.get_mut(session) else {
            return Vec::new();
        };
        slot.rev += 1;
        slot.turns = merged.clone();
        slot.sigs = sigs;
        slot.command = transcript.command.clone();
        vec![WatchFrame {
            kind: "transcript".into(),
            session: session.to_string(),
            rev: slot.rev,
            from,
            turns: merged[from..].to_vec(),
            total: merged.len(),
            command: transcript.command,
            truncated_before: transcript.truncated,
        }]
    }

    fn emit_empty(&mut self, session: &str) -> WatchFrame {
        let Some(slot) = self.watched.get_mut(session) else {
            return WatchFrame {
                kind: "transcript".into(),
                session: session.to_string(),
                rev: 1,
                from: 0,
                turns: Vec::new(),
                total: 0,
                command: String::new(),
                truncated_before: false,
            };
        };
        slot.rev += 1;
        slot.turns.clear();
        slot.sigs.clear();
        slot.command.clear();
        WatchFrame {
            kind: "transcript".into(),
            session: session.to_string(),
            rev: slot.rev,
            from: 0,
            turns: Vec::new(),
            total: 0,
            command: String::new(),
            truncated_before: false,
        }
    }
}

impl Default for TranscriptWatch {
    fn default() -> Self {
        Self::new()
    }
}

fn fresh() -> Watched {
    Watched { refs: 1, rev: 0, turns: Vec::new(), sigs: Vec::new(), command: String::new(), path: None, last_size: u64::MAX, last_mtime: -1 }
}

pub fn capped_objects(path: &Path, max_bytes: u64) -> (Vec<crate::value::Obj>, bool) {
    let parsed = read_jsonl(path, max_bytes);
    (parsed.objects, parsed.truncated)
}
