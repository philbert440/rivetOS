use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::error::WorkflowError;
use crate::io_fs::{self, read_string, try_exists};
use crate::pathutil::{node_join_paths, path_text};
use crate::types::{CaseState, Run, RunStatus};

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
    let mut text = serde_json::to_string_pretty(&state.document)
        .map_err(|err| WorkflowError::message(err.to_string()))?;
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
    let document: Value =
        serde_json::from_str(raw).map_err(|err| WorkflowError::message(err.to_string()))?;
    case_from_document(document)
}

fn case_from_document(document: Value) -> Result<CaseState, WorkflowError> {
    let run_value = document
        .get("run")
        .cloned()
        .ok_or_else(|| WorkflowError::message("case.json missing run"))?;
    let run: Run =
        serde_json::from_value(run_value).map_err(|err| WorkflowError::message(err.to_string()))?;
    let fields = match document.get("fields") {
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
    F: FnOnce(&mut Value) -> Result<(), WorkflowError>,
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
    let fields = fields.clone();
    update_case(case_dir, move |document| {
        let object = document
            .as_object_mut()
            .ok_or_else(|| WorkflowError::message("case.json root must be an object"))?;
        let slot = object
            .entry("fields")
            .or_insert_with(|| Value::Object(Map::new()));
        let map = slot
            .as_object_mut()
            .ok_or_else(|| WorkflowError::message("case.json fields must be an object"))?;
        for (key, value) in fields {
            map.insert(key, value);
        }
        Ok(())
    })
    .await
}

#[derive(Debug, Clone, Default)]
pub struct RunPatch {
    pub status: Option<RunStatus>,
    pub current: Option<String>,
    pub error: Option<String>,
    pub output: Option<Value>,
    pub finished_at: Option<String>,
    pub workflow_dir: Option<String>,
    pub started_at: Option<String>,
}

pub async fn update_run(case_dir: &Path, patch: RunPatch) -> Result<CaseState, WorkflowError> {
    update_case(case_dir, move |document| {
        let object = document
            .as_object_mut()
            .ok_or_else(|| WorkflowError::message("case.json root must be an object"))?;
        let run = object
            .entry("run")
            .or_insert_with(|| Value::Object(Map::new()));
        let run = run
            .as_object_mut()
            .ok_or_else(|| WorkflowError::message("case.json run must be an object"))?;
        if let Some(status) = patch.status {
            run.insert(
                "status".to_string(),
                Value::String(status.as_str().to_string()),
            );
        }
        if let Some(current) = patch.current {
            run.insert("current".to_string(), Value::String(current));
        }
        if let Some(error) = patch.error {
            run.insert("error".to_string(), Value::String(error));
        }
        if let Some(output) = patch.output {
            run.insert("output".to_string(), output);
        }
        if let Some(finished_at) = patch.finished_at {
            run.insert("finishedAt".to_string(), Value::String(finished_at));
        }
        if let Some(workflow_dir) = patch.workflow_dir {
            run.insert("workflowDir".to_string(), Value::String(workflow_dir));
        }
        if let Some(started_at) = patch.started_at {
            run.insert("startedAt".to_string(), Value::String(started_at));
        }
        Ok(())
    })
    .await
}

pub fn initial_document(run: &Run, fields: &Map<String, Value>) -> Result<Value, WorkflowError> {
    let mut document = Map::new();
    document.insert(
        "run".to_string(),
        serde_json::to_value(run).map_err(|err| WorkflowError::message(err.to_string()))?,
    );
    document.insert("fields".to_string(), Value::Object(fields.clone()));
    Ok(Value::Object(document))
}

pub fn case_state(run: Run, fields: Map<String, Value>) -> Result<CaseState, WorkflowError> {
    let document = initial_document(&run, &fields)?;
    Ok(CaseState {
        run,
        fields,
        document,
    })
}
