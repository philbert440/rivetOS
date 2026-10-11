use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use protocol::js::{JsObject, JsValue, js_trim};

use crate::error::WorkflowError;
use crate::io_fs;
use crate::pathutil::node_join_paths;
use crate::types::{CacheSource, CachedStep, JournalEntry, OpenGate, RunFinishedStatus, StepKind};
use crate::wire::{WireJson, parse_typed};

pub const JOURNAL_FILENAME: &str = "journal.jsonl";

pub fn journal_path(case_dir: &Path) -> PathBuf {
    node_join_paths(case_dir, JOURNAL_FILENAME)
}

fn lock_table() -> &'static std::sync::Mutex<HashMap<PathBuf, Arc<std::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<std::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn path_lock(path: &Path) -> Arc<std::sync::Mutex<()>> {
    let table = lock_table();
    let mut map = table.lock().unwrap_or_else(|err| err.into_inner());
    map.entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
        .clone()
}

pub async fn ensure_journal(case_dir: &Path) -> Result<(), WorkflowError> {
    crate::io_fs::create_dir_all(case_dir).await?;
    let path = journal_path(case_dir);
    if !io_fs::try_exists(&path).await? {
        io_fs::write_bytes(&path, b"").await?;
    }
    Ok(())
}

pub async fn append_journal(case_dir: &Path, entry: &JournalEntry) -> Result<(), WorkflowError> {
    let path = journal_path(case_dir);
    let mut line = entry.to_json_line()?;
    line.push('\n');
    let task = tokio::task::spawn_blocking(move || {
        let lock = path_lock(&path);
        let _guard = lock.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| WorkflowError::io(parent, err))?;
        }
        if !path.exists() {
            std::fs::write(&path, b"").map_err(|err| WorkflowError::io(&path, err))?;
        }
        io_fs::repair_torn_tail(&path)?;
        io_fs::append_line_blocking(&path, line.as_bytes())
    });
    match task.await {
        Ok(result) => result,
        Err(_) => Err(WorkflowError::message("journal append task failed")),
    }
}

pub async fn read_journal(case_dir: &Path) -> Result<Vec<JournalEntry>, WorkflowError> {
    let path = journal_path(case_dir);
    let task = tokio::task::spawn_blocking(move || {
        let lock = path_lock(&path);
        let _guard = lock.lock().unwrap_or_else(|err| err.into_inner());
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw = std::fs::read_to_string(&path).map_err(|err| WorkflowError::io(&path, err))?;
        parse_journal(&raw)
    });
    match task.await {
        Ok(result) => result,
        Err(_) => Err(WorkflowError::message("journal read task failed")),
    }
}

pub fn parse_journal(raw: &str) -> Result<Vec<JournalEntry>, WorkflowError> {
    if js_trim(raw).is_empty() {
        return Ok(Vec::new());
    }
    let complete = raw.ends_with('\n');
    let mut lines: Vec<&str> = raw.split('\n').collect();
    if complete && lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let last = lines.len().saturating_sub(1);
    let mut entries = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        match parse_entry(trimmed) {
            Ok(entry) => entries.push(entry),
            Err(err) => {
                if !complete && index == last {
                    continue;
                }
                return Err(err);
            }
        }
    }
    Ok(entries)
}

fn parse_entry(line: &str) -> Result<JournalEntry, WorkflowError> {
    let value = protocol::js::parse(line)
        .map_err(|err| WorkflowError::message(format!("failed to parse journal line: {err}")))?;
    let Some(object) = value.as_object() else {
        return Err(WorkflowError::message(
            "failed to parse journal line: expected object",
        ));
    };
    let kind = object.get("type").and_then(JsValue::as_str).unwrap_or("");
    match kind {
        "run_started" => Ok(JournalEntry::RunStarted {
            ts: req_str(object, "ts")?,
            run_id: req_str(object, "runId")?,
            workflow_id: req_str(object, "workflowId")?,
            version: req_str(object, "version")?,
            input: req_wire(object, "input")?,
            started_by: req_typed(object, "startedBy")?,
            parent: opt_typed(object, "parent")?,
        }),
        "run_finished" => {
            let status = req_str(object, "status")?;
            let status = RunFinishedStatus::parse(&status).ok_or_else(|| {
                WorkflowError::message(format!(
                    "failed to parse journal line: unknown status {status}"
                ))
            })?;
            Ok(JournalEntry::RunFinished {
                ts: req_str(object, "ts")?,
                run_id: req_str(object, "runId")?,
                status,
                output: opt_wire(object, "output"),
                error: opt_str(object, "error"),
            })
        }
        "step_started" => Ok(JournalEntry::StepStarted {
            ts: req_str(object, "ts")?,
            step_id: req_str(object, "stepId")?,
            label: req_str(object, "label")?,
            seq: req_i64(object, "seq")?,
            kind: req_kind(object)?,
        }),
        "step_finished" => Ok(JournalEntry::StepFinished {
            ts: req_str(object, "ts")?,
            step_id: req_str(object, "stepId")?,
            label: req_str(object, "label")?,
            seq: req_i64(object, "seq")?,
            kind: req_kind(object)?,
            result: opt_wire(object, "result"),
            usage: opt_typed(object, "usage")?,
        }),
        "step_failed" => Ok(JournalEntry::StepFailed {
            ts: req_str(object, "ts")?,
            step_id: req_str(object, "stepId")?,
            label: req_str(object, "label")?,
            seq: req_i64(object, "seq")?,
            kind: req_kind(object)?,
            error: req_str(object, "error")?,
        }),
        "gate_opened" => Ok(JournalEntry::GateOpened {
            ts: req_str(object, "ts")?,
            step_id: req_str(object, "stepId")?,
            label: req_str(object, "label")?,
            seq: req_i64(object, "seq")?,
            prompt: opt_wire(object, "prompt"),
            fields: req_strings(object, "fields")?,
        }),
        "gate_resolved" => Ok(JournalEntry::GateResolved {
            ts: req_str(object, "ts")?,
            step_id: req_str(object, "stepId")?,
            label: req_str(object, "label")?,
            seq: req_i64(object, "seq")?,
            values: req_wire(object, "values")?,
        }),
        "manifest_warn" => Ok(JournalEntry::ManifestWarn {
            ts: req_str(object, "ts")?,
            step_id: req_str(object, "stepId")?,
            label: req_str(object, "label")?,
            seq: req_i64(object, "seq")?,
            undeclared: req_strings(object, "undeclared")?,
            message: req_str(object, "message")?,
        }),
        other => Err(WorkflowError::message(format!(
            "failed to parse journal line: unknown type {other}"
        ))),
    }
}

fn missing(key: &str) -> WorkflowError {
    WorkflowError::message(format!("failed to parse journal line: missing {key}"))
}

fn req_str(object: &JsObject, key: &str) -> Result<String, WorkflowError> {
    object
        .get(key)
        .and_then(JsValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| missing(key))
}

fn opt_str(object: &JsObject, key: &str) -> Option<String> {
    match object.get(key) {
        None | Some(JsValue::Null) => None,
        Some(value) => value.as_str().map(str::to_string),
    }
}

fn req_i64(object: &JsObject, key: &str) -> Result<i64, WorkflowError> {
    object
        .get(key)
        .and_then(JsValue::as_i64)
        .ok_or_else(|| missing(key))
}

fn req_wire(object: &JsObject, key: &str) -> Result<WireJson, WorkflowError> {
    object
        .get(key)
        .map(WireJson::from_js)
        .ok_or_else(|| missing(key))
}

fn opt_wire(object: &JsObject, key: &str) -> Option<WireJson> {
    object.get(key).map(WireJson::from_js)
}

fn req_typed<T: serde::de::DeserializeOwned>(
    object: &JsObject,
    key: &str,
) -> Result<T, WorkflowError> {
    let value = object.get(key).ok_or_else(|| missing(key))?;
    parse_typed(value)
}

fn opt_typed<T: serde::de::DeserializeOwned>(
    object: &JsObject,
    key: &str,
) -> Result<Option<T>, WorkflowError> {
    match object.get(key) {
        None | Some(JsValue::Null) => Ok(None),
        Some(value) => parse_typed(value).map(Some),
    }
}

fn req_kind(object: &JsObject) -> Result<StepKind, WorkflowError> {
    let text = req_str(object, "kind")?;
    StepKind::parse(&text).ok_or_else(|| {
        WorkflowError::message(format!("failed to parse journal line: unknown kind {text}"))
    })
}

fn req_strings(object: &JsObject, key: &str) -> Result<Vec<String>, WorkflowError> {
    let Some(items) = object.get(key).and_then(JsValue::as_array) else {
        return Err(missing(key));
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(WorkflowError::message(format!(
                "failed to parse journal line: {key} must be strings"
            )));
        };
        out.push(text.to_string());
    }
    Ok(out)
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
                    result: Some(values.clone()),
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
                prompt: prompt
                    .as_ref()
                    .and_then(|wire| wire.value().as_str().map(str::to_string)),
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
