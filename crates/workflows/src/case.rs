use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use serde_json::{Map, Value};

use crate::error::WorkflowError;
use crate::io_fs;
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

fn lock_table() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn case_lock(case_dir: &Path) -> Arc<Mutex<()>> {
    let table = lock_table();
    let mut map = table.lock();
    map.entry(case_dir.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[cfg(test)]
fn case_waiters_map() -> &'static Mutex<HashMap<PathBuf, usize>> {
    static CASE_WAITERS: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    CASE_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn note_case_wait(dir: &Path) {
    let mut map = case_waiters_map().lock();
    *map.entry(dir.to_path_buf()).or_insert(0) += 1;
}

#[cfg(test)]
fn case_waiters(dir: &Path) -> usize {
    case_waiters_map().lock().get(dir).copied().unwrap_or(0)
}

async fn with_case_lock<T, F>(case_dir: PathBuf, work: F) -> Result<T, WorkflowError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, WorkflowError> + Send + 'static,
{
    let lock = case_lock(&case_dir);
    let label = path_text(&case_dir);
    let task = tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        note_case_wait(&case_dir);
        let _guard = lock.lock();
        work()
    });
    match task.await {
        Ok(result) => result,
        Err(_) => Err(WorkflowError::message(format!("case task failed: {label}"))),
    }
}

pub fn child_case_dir(parent_case_dir: &Path, child_run_id: &str) -> PathBuf {
    node_join_paths(parent_case_dir, child_run_id)
}

pub async fn write_case(case_dir: &Path, state: &CaseState) -> Result<(), WorkflowError> {
    let mut text = state.document.raw().to_string();
    text.push('\n');
    let case_dir = case_dir.to_path_buf();
    with_case_lock(case_dir.clone(), move || {
        write_case_locked(&case_dir, text.as_bytes())
    })
    .await
}

fn write_case_locked(case_dir: &Path, bytes: &[u8]) -> Result<(), WorkflowError> {
    io_fs::replace_bytes(&case_path(case_dir), bytes)
}

pub async fn read_case(case_dir: &Path) -> Result<CaseState, WorkflowError> {
    let case_dir = case_dir.to_path_buf();
    with_case_lock(case_dir.clone(), move || read_case_locked(&case_dir)).await
}

fn read_case_locked(case_dir: &Path) -> Result<CaseState, WorkflowError> {
    let path = case_path(case_dir);
    match protocol::host::stat(&path) {
        Ok(_) => {}
        Err(err) if err.code == "ENOENT" => {
            return Err(WorkflowError::message(format!(
                "case.json not found in {}",
                path_text(case_dir)
            )));
        }
        Err(err) => return Err(WorkflowError::from_fs(err)),
    }
    let raw = protocol::host::read_text(&path).map_err(WorkflowError::from_fs)?;
    parse_case(&raw)
}

pub fn parse_case(raw: &str) -> Result<CaseState, WorkflowError> {
    let document = WireJson::parse(raw)?;
    case_from_document(document)
}

fn case_from_document(document: WireJson) -> Result<CaseState, WorkflowError> {
    let run_raw = document
        .get_raw("run")?
        .ok_or_else(|| WorkflowError::message("case.json missing run"))?;
    let run_doc = WireJson::parse(&run_raw)?;
    let output = match run_doc.get_raw("output")? {
        Some(raw) => Some(WireJson::parse(&raw)?),
        None => None,
    };
    let mut run_view = run_doc.to_value();
    if let Some(object) = run_view.as_object_mut() {
        object.remove("output");
    }
    let mut run: Run =
        serde_json::from_value(run_view).map_err(|err| WorkflowError::message(err.to_string()))?;
    run.output = output;
    let fields = match document.value().get("fields") {
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
    F: FnOnce(&mut WireJson) -> Result<(), WorkflowError> + Send + 'static,
{
    let case_dir = case_dir.to_path_buf();
    with_case_lock(case_dir.clone(), move || {
        let state = read_case_locked(&case_dir)?;
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
        let mut text = state.document.raw().to_string();
        text.push('\n');
        write_case_locked(&case_dir, text.as_bytes())?;
        Ok(state)
    })
    .await
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

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::Map;

    use super::{RunPatch, case_path, case_state, read_case, update_run, write_case};
    use crate::io_fs::replace_bytes_by;
    use crate::types::{Run, RunStatus, StartedBy, StartedByType};

    #[tokio::test]
    async fn timed_out_replace_does_not_clobber_a_later_terminal_write() {
        let dir = std::env::temp_dir().join(format!(
            "wf-case-late-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = Run {
            id: "run-1".to_string(),
            workflow_id: "wf".to_string(),
            version: "1.0.0".to_string(),
            started_by: StartedBy::new(StartedByType::Human),
            parent: None,
            case_dir: dir.display().to_string(),
            status: RunStatus::Running,
            current: None,
            workflow_dir: None,
            error: None,
            output: None,
            started_at: Some("2026-01-01T00:00:00.000Z".to_string()),
            finished_at: None,
        };
        let state = case_state(run, Map::new()).unwrap();
        write_case(&dir, &state).await.unwrap();
        let path = case_path(&dir);
        let committed = std::fs::read(&path).unwrap();
        let err = replace_bytes_by(
            &path,
            b"STALE-SNAPSHOT\n",
            Instant::now() - Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), committed);
        update_run(
            &dir,
            RunPatch {
                status: Some(RunStatus::Failed),
                error: Some("stopped".to_string()),
                finished_at: Some("2026-01-01T00:00:01.000Z".to_string()),
                ..RunPatch::default()
            },
        )
        .await
        .unwrap();
        let text = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
        assert!(text.contains("\"failed\""), "{text}");
        assert!(text.contains("stopped"), "{text}");
        assert!(!text.contains("STALE-SNAPSHOT"), "{text}");
        let stored = read_case(&dir).await.unwrap();
        assert_eq!(stored.run.status, RunStatus::Failed);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn cancelled_writer_serializes_before_a_queued_terminal_update() {
        let dir = std::env::temp_dir().join(format!(
            "wf-case-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = Run {
            id: "run-1".to_string(),
            workflow_id: "wf".to_string(),
            version: "1.0.0".to_string(),
            started_by: StartedBy::new(StartedByType::Human),
            parent: None,
            case_dir: dir.display().to_string(),
            status: RunStatus::Running,
            current: None,
            workflow_dir: None,
            error: None,
            output: None,
            started_at: Some("2026-01-01T00:00:00.000Z".to_string()),
            finished_at: None,
        };
        let state = case_state(run, Map::new()).unwrap();
        write_case(&dir, &state).await.unwrap();
        let stale = std::fs::read(case_path(&dir)).unwrap();
        assert!(!String::from_utf8_lossy(&stale).contains("stopped"));
        let (hold_tx, hold_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let stalled_dir = dir.clone();
        let stalled = tokio::spawn(async move {
            super::with_case_lock(stalled_dir.clone(), move || {
                let _ = hold_tx.send(());
                let _ = release_rx.recv();
                super::write_case_locked(&stalled_dir, &stale)
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if hold_rx.try_recv().is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled writer did not acquire the case lock");
        stalled.abort();
        let aborted = stalled.await.expect_err("caller was not cancelled");
        assert!(aborted.is_cancelled());
        let seen = super::case_waiters(&dir);
        let update_dir = dir.clone();
        let update = tokio::spawn(async move {
            update_run(
                &update_dir,
                RunPatch {
                    status: Some(RunStatus::Failed),
                    error: Some("stopped".to_string()),
                    finished_at: Some("2026-01-01T00:00:01.000Z".to_string()),
                    ..RunPatch::default()
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if super::case_waiters(&dir) > seen {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal update did not reach the case lock");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !update.is_finished(),
            "terminal update finished while the cancelled writer still held the case lock"
        );
        release_tx.send(()).unwrap();
        let updated = tokio::time::timeout(Duration::from_secs(5), update)
            .await
            .expect("terminal update timed out")
            .unwrap()
            .unwrap();
        assert_eq!(updated.run.status, RunStatus::Failed);
        let text = String::from_utf8(std::fs::read(case_path(&dir)).unwrap()).unwrap();
        assert!(text.contains("\"failed\""), "{text}");
        assert!(text.contains("stopped"), "{text}");
        assert_eq!(read_case(&dir).await.unwrap().run.status, RunStatus::Failed);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
