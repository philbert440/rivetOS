use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use protocol::js::js_trim;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::WorkflowError;
use crate::io_fs::{self, read_string, try_exists};
use crate::pathutil::node_join_paths;
use crate::types::{CacheSource, CachedStep, JournalEntry, OpenGate, StepKind};

pub const JOURNAL_FILENAME: &str = "journal.jsonl";

pub fn journal_path(case_dir: &Path) -> PathBuf {
    node_join_paths(case_dir, JOURNAL_FILENAME)
}

fn lock_table() -> &'static std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn path_lock(path: &Path) -> Arc<Mutex<()>> {
    let table = lock_table();
    let mut map = table.lock().unwrap_or_else(|err| err.into_inner());
    map.entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub async fn ensure_journal(case_dir: &Path) -> Result<(), WorkflowError> {
    crate::io_fs::create_dir_all(case_dir).await?;
    let path = journal_path(case_dir);
    if !try_exists(&path).await? {
        io_fs::write_bytes(&path, b"").await?;
    }
    Ok(())
}

pub async fn append_journal(case_dir: &Path, entry: &JournalEntry) -> Result<(), WorkflowError> {
    let path = journal_path(case_dir);
    let lock = path_lock(&path);
    let _guard = lock.lock().await;
    io_fs::create_dir_all(case_dir).await?;
    let mut line = entry
        .to_json_line()
        .map_err(|err| WorkflowError::message(err.to_string()))?;
    line.push('\n');
    io_fs::append_bytes(&path, line.as_bytes()).await
}

pub async fn read_journal(case_dir: &Path) -> Result<Vec<JournalEntry>, WorkflowError> {
    let path = journal_path(case_dir);
    let lock = path_lock(&path);
    let _guard = lock.lock().await;
    if !try_exists(&path).await? {
        return Ok(Vec::new());
    }
    let raw = read_string(&path).await?;
    parse_journal(&raw)
}

pub fn parse_journal(raw: &str) -> Result<Vec<JournalEntry>, WorkflowError> {
    if js_trim(raw).is_empty() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for line in raw.split('\n') {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        let entry = serde_json::from_str::<JournalEntry>(trimmed).map_err(|err| {
            WorkflowError::message(format!("failed to parse journal line: {err}"))
        })?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn find_cached_step_result(
    entries: &[JournalEntry],
    label: &str,
    seq: i64,
    kind: Option<&str>,
) -> Result<CachedStep, WorkflowError> {
    for entry in entries {
        match entry {
            JournalEntry::StepFinished {
                label: entry_label,
                seq: entry_seq,
                kind: entry_kind,
                result,
                ..
            } if entry_label == label && *entry_seq == seq => {
                if let Some(kind) = kind
                    && entry_kind.as_str() != kind
                {
                    return Err(WorkflowError::kind_mismatch(
                        label,
                        seq,
                        entry_kind.as_str(),
                        kind,
                    ));
                }
                return Ok(CachedStep::Hit {
                    result: result.clone(),
                    from: CacheSource::StepFinished,
                });
            }
            JournalEntry::GateResolved {
                label: entry_label,
                seq: entry_seq,
                values,
                ..
            } if entry_label == label && *entry_seq == seq => {
                if let Some(kind) = kind
                    && kind != StepKind::Human.as_str()
                {
                    return Err(WorkflowError::human_kind_mismatch(label, seq, kind));
                }
                return Ok(CachedStep::Hit {
                    result: Value::Object(values.clone()),
                    from: CacheSource::GateResolved,
                });
            }
            _ => {}
        }
    }
    Ok(CachedStep::Miss)
}

pub fn is_open_gate(entries: &[JournalEntry], label: &str, seq: i64) -> bool {
    let mut opened = false;
    let mut resolved = false;
    for entry in entries {
        match entry {
            JournalEntry::GateOpened {
                label: entry_label,
                seq: entry_seq,
                ..
            } if entry_label == label && *entry_seq == seq => opened = true,
            JournalEntry::GateResolved {
                label: entry_label,
                seq: entry_seq,
                ..
            } if entry_label == label && *entry_seq == seq => resolved = true,
            _ => {}
        }
    }
    opened && !resolved
}

pub fn find_open_gate(entries: &[JournalEntry]) -> Option<OpenGate> {
    let mut opened = Vec::new();
    let mut resolved = Vec::new();
    for entry in entries {
        match entry {
            JournalEntry::GateOpened {
                step_id,
                label,
                seq,
                fields,
                prompt,
                ..
            } => opened.push(OpenGate {
                step_id: step_id.clone(),
                label: label.clone(),
                seq: *seq,
                fields: fields.clone(),
                prompt: prompt.clone(),
            }),
            JournalEntry::GateResolved { step_id, .. } => resolved.push(step_id.clone()),
            _ => {}
        }
    }
    opened
        .into_iter()
        .rev()
        .find(|gate| !resolved.iter().any(|step_id| step_id == &gate.step_id))
}

pub fn max_seq_for_label(entries: &[JournalEntry], label: &str) -> i64 {
    let mut max = 0;
    for entry in entries {
        let matches = match entry {
            JournalEntry::StepStarted {
                label: entry_label,
                seq,
                ..
            }
            | JournalEntry::StepFinished {
                label: entry_label,
                seq,
                ..
            }
            | JournalEntry::StepFailed {
                label: entry_label,
                seq,
                ..
            }
            | JournalEntry::GateOpened {
                label: entry_label,
                seq,
                ..
            }
            | JournalEntry::GateResolved {
                label: entry_label,
                seq,
                ..
            } if entry_label == label => Some(*seq),
            _ => None,
        };
        if let Some(seq) = matches
            && seq > max
        {
            max = seq;
        }
    }
    max
}
