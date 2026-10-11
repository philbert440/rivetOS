use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::error::WorkflowError;
use crate::io_fs::{self, read_string, try_exists};
use crate::pathutil::{node_join_paths, path_text};
use crate::types::{CaseState, Run, RunStatus};
use crate::wire::{WireJson, typed_raw};

pub const CASE_FILENAME: &str = "case.json";

pub fn case_path(case_dir: &Path) -> PathBuf {
    node_join_paths(case_dir, CASE_FILENAME)
}

pub fn is_terminal_status(status: RunStatus) -> bool {
    status.is_terminal()
}

fn lock_table() -> &'static std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn case_lock(case_dir: &Path) -> Arc<Mutex<()>> {
    let table = lock_table();
    let mut map = table.lock().unwrap_or_else(|err| err.into_inner());
    map.entry(case_dir.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

pub fn child_case_dir(parent_case_dir: &Path, child_run_id: &str) -> PathBuf {
    node_join_paths(parent_case_dir, child_run_id)
}

pub async fn write_case(case_dir: &Path, state: &CaseState) -> Result<(), WorkflowError> {
    let lock = case_lock(case_dir);
    let _guard = lock.lock().await;
    write_case_unlocked(case_dir, state).await
}

async fn write_case_unlocked(case_dir: &Path, state: &CaseState) -> Result<(), WorkflowError> {
    let mut text = state.document.raw().to_string();
    text.push('\n');
    io_fs::atomic_write(&case_path(case_dir), text.as_bytes()).await
}

pub async fn read_case(case_dir: &Path) -> Result<CaseState, WorkflowError> {
    let lock = case_lock(case_dir);
    let _guard = lock.lock().await;
    read_case_unlocked(case_dir).await
}

async fn read_case_unlocked(case_dir: &Path) -> Result<CaseState, WorkflowError> {
    let path = case_path(case_dir);
    if !try_exists(&path).await? {
        return Err(WorkflowError::message(format!(
            "case.json not found in {}",
            path_text(case_dir)
        )));
    }
    let raw = read_string(&path).await?;
    parse_case(&raw)
}

pub fn parse_case(raw: &str) -> Result<CaseState, WorkflowError> {
    let document = WireJson::parse(raw)?;
    case_from_document(document)
}

fn case_from_document(document: WireJson) -> Result<CaseState, WorkflowError> {
    let view = document.to_value();
    let run_value = view
        .get("run")
        .cloned()
        .ok_or_else(|| WorkflowError::message("case.json missing run"))?;
    let run: Run =
        serde_json::from_value(run_value).map_err(|err| WorkflowError::message(err.to_string()))?;
    let fields = match view.get("fields") {
        Some(Value::Object(fields)) => fields.clone(),
        _ => Map::new(),
    };
    Ok(CaseState {
        run,
        fields,
        document,
    })
}

pub async fn update_case<F>(case_dir: &Path, mutate: F) -> Result<CaseState, WorkflowError>
where
    F: FnOnce(&mut WireJson) -> Result<(), WorkflowError>,
{
    let lock = case_lock(case_dir);
    let _guard = lock.lock().await;
    let state = read_case_unlocked(case_dir).await?;
    if is_terminal_status(state.run.status) {
        tracing::warn!(
            "updateCase: run {} is {} (terminal); write ignored",
            state.run.id,
            state.run.status
        );
        return Ok(state);
    }
    let mut document = state.document;
    mutate(&mut document)?;
    let state = case_from_document(document)?;
    write_case_unlocked(case_dir, &state).await?;
    Ok(state)
}

pub async fn merge_fields(
    case_dir: &Path,
    fields: &Map<String, Value>,
) -> Result<CaseState, WorkflowError> {
    let mut raw_fields = Vec::with_capacity(fields.len());
    for (key, value) in fields {
        raw_fields.push((key.clone(), WireJson::from_value(value)?.raw().to_string()));
    }
    merge_fields_raw(case_dir, raw_fields).await
}

pub async fn merge_fields_raw(
    case_dir: &Path,
    fields: Vec<(String, String)>,
) -> Result<CaseState, WorkflowError> {
    update_case(case_dir, move |document| {
        let existing = document.get_raw("fields")?;
        let mut entries = match existing {
            Some(raw) => WireJson::parse(&raw)?.entries()?,
            None => Vec::new(),
        };
        for (key, raw) in fields {
            if let Some(slot) = entries.iter_mut().find(|(name, _)| name == &key) {
                slot.1 = raw;
            } else {
                entries.push((key, raw));
            }
        }
        let merged = WireJson::from_entries(entries)?;
        *document = document.set_key("fields", merged.raw())?;
        Ok(())
    })
    .await
}

#[derive(Debug, Clone, Default)]
pub struct RunPatch {
    pub status: Option<RunStatus>,
    pub current: Option<String>,
    pub error: Option<String>,
    pub output: Option<WireJson>,
    pub finished_at: Option<String>,
    pub workflow_dir: Option<String>,
    pub started_at: Option<String>,
}

pub async fn update_run(case_dir: &Path, patch: RunPatch) -> Result<CaseState, WorkflowError> {
    update_case(case_dir, move |document| {
        let existing = document.get_raw("run")?.unwrap_or_else(|| "{}".to_string());
        let mut entries = WireJson::parse(&existing)?.entries()?;
        if let Some(status) = patch.status {
            upsert(&mut entries, "status", &json_string(status.as_str()));
        }
        if let Some(current) = patch.current {
            upsert(&mut entries, "current", &json_string(&current));
        }
        if let Some(error) = patch.error {
            upsert(&mut entries, "error", &json_string(&error));
        }
        if let Some(output) = patch.output {
            upsert(&mut entries, "output", output.raw());
        }
        if let Some(finished_at) = patch.finished_at {
            upsert(&mut entries, "finishedAt", &json_string(&finished_at));
        }
        if let Some(workflow_dir) = patch.workflow_dir {
            upsert(&mut entries, "workflowDir", &json_string(&workflow_dir));
        }
        if let Some(started_at) = patch.started_at {
            upsert(&mut entries, "startedAt", &json_string(&started_at));
        }
        let run = WireJson::from_entries(entries)?;
        *document = document.set_key("run", run.raw())?;
        Ok(())
    })
    .await
}

fn upsert(entries: &mut Vec<(String, String)>, key: &str, raw_value: &str) {
    if let Some(slot) = entries.iter_mut().find(|(name, _)| name == key) {
        slot.1 = raw_value.to_string();
    } else {
        entries.push((key.to_string(), raw_value.to_string()));
    }
}

fn json_string(text: &str) -> String {
    protocol::js::stringify(&protocol::js::JsValue::from_text(text))
}

pub fn initial_document(run: &Run, fields: &Map<String, Value>) -> Result<WireJson, WorkflowError> {
    let run_raw = typed_raw(run)?;
    let fields_raw = WireJson::from_value(&Value::Object(fields.clone()))?;
    WireJson::from_entries(vec![
        ("run".to_string(), run_raw),
        ("fields".to_string(), fields_raw.raw().to_string()),
    ])
}

pub fn case_state(run: Run, fields: Map<String, Value>) -> Result<CaseState, WorkflowError> {
    let document = initial_document(&run, &fields)?;
    case_from_document(document)
}

pub fn case_state_from_wire(run: Run, fields: &WireJson) -> Result<CaseState, WorkflowError> {
    let run_raw = typed_raw(&run)?;
    let document = WireJson::from_entries(vec![
        ("run".to_string(), run_raw),
        ("fields".to_string(), fields.raw().to_string()),
    ])?;
    case_from_document(document)
}
