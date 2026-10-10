use std::path::Path;

use serde_json::Map;

use crate::case::{RunPatch, case_state, read_case, update_run, write_case};
use crate::determinism::check_run_script_determinism;
use crate::engine::WorkflowEngine;
use crate::error::WorkflowError;
use crate::io_fs::{read_string, try_exists};
use crate::journal::{append_journal, find_open_gate, read_journal};
use crate::list_runs::list_child_runs;
use crate::list_runs::list_workflow_defs;
use crate::loader::load_workflow_dir;
use crate::pathutil::{node_join_paths, path_text};
use crate::timeutil::now_iso;
use crate::types::{
    JournalEntry, Run, RunDetail, RunFinishedStatus, RunStatus, StartedBy, WorkflowDiagnostic,
    WorkflowValidateResponse,
};

pub async fn load_run_detail(
    engine: &WorkflowEngine,
    run_id: &str,
) -> Result<RunDetail, WorkflowError> {
    let case_dir = engine.resolve_case_dir(run_id).await?;
    let state = read_case(&case_dir).await?;
    let journal = read_journal(&case_dir).await?;
    let children = list_child_runs(&case_dir, &|message| tracing::warn!("{message}")).await;
    let open_gate = find_open_gate(&journal);
    Ok(RunDetail {
        run: state.run,
        fields: state.fields,
        journal,
        children,
        open_gate,
    })
}

pub async fn validate_workflow_dir(dir: &Path) -> WorkflowValidateResponse {
    let mut diagnostics = Vec::new();
    match load_workflow_dir(dir).await {
        Ok(loaded) => match read_string(Path::new(&loaded.run_path)).await {
            Ok(source) => {
                let file = relative_run(dir, &loaded.run_path);
                for finding in check_run_script_determinism(&source) {
                    diagnostics.push(WorkflowDiagnostic {
                        file: file.clone(),
                        line: Some(finding.line),
                        severity: "error",
                        message: format!("{}: {}", finding.rule, finding.message),
                    });
                }
            }
            Err(err) => diagnostics.push(WorkflowDiagnostic {
                file: "run.ts".to_string(),
                line: None,
                severity: "error",
                message: format!("could not read run script: {err}"),
            }),
        },
        Err(err) => diagnostics.extend(diagnostics_from_load_error(&err)),
    }
    let ok = diagnostics.iter().all(|item| item.severity != "error");
    WorkflowValidateResponse { ok, diagnostics }
}

pub fn diagnostics_from_load_error(err: &WorkflowError) -> Vec<WorkflowDiagnostic> {
    let message = err.to_string();
    let file = diagnostic_file(&message);
    vec![WorkflowDiagnostic {
        file,
        line: None,
        severity: "error",
        message,
    }]
}

fn diagnostic_file(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if message.contains("agents/") || lower.contains("agent \"") {
        return agent_path(message).unwrap_or_else(|| "agents".to_string());
    }
    if lower.contains("run.ts")
        || lower.contains("run.js")
        || lower.contains("run.mjs")
        || lower.contains("no run.ts")
    {
        return "run.ts".to_string();
    }
    if lower.contains("frontmatter") {
        return agent_path(message).unwrap_or_else(|| "agents".to_string());
    }
    "workflow.yaml".to_string()
}

fn agent_path(message: &str) -> Option<String> {
    let bytes = message.as_bytes();
    let marker = b"agents/";
    let mut index = 0;
    while index + marker.len() <= bytes.len() {
        if &bytes[index..index + marker.len()] == marker {
            let start = index;
            let mut end = index + marker.len();
            while end < bytes.len() {
                let ch = bytes[end];
                if ch.is_ascii_whitespace() || ch == b':' {
                    break;
                }
                end += 1;
            }
            let text = &message[start..end];
            if text.ends_with(".md") {
                return Some(text.to_string());
            }
        }
        index += 1;
    }
    None
}

fn relative_run(dir: &Path, run_path: &str) -> String {
    let root = path_text(dir);
    let prefix = if root.ends_with('/') {
        root
    } else {
        format!("{root}/")
    };
    let normalized = run_path.replace('\\', "/");
    let rel = normalized
        .strip_prefix(&prefix)
        .unwrap_or("run.ts")
        .to_string();
    if rel.is_empty() {
        "run.ts".to_string()
    } else {
        rel
    }
}

pub async fn resolve_def_dir_for_validate(
    roots: &[impl AsRef<Path>],
    workflow_id: &str,
    warn: &(dyn Fn(&str) + Send + Sync),
) -> Option<String> {
    let loaded = list_workflow_defs(roots, warn).await;
    if let Some(found) = loaded.iter().find(|item| item.manifest.id == workflow_id) {
        return Some(found.dir.clone());
    }
    for root in roots {
        let root = root.as_ref();
        let Ok(entries) = crate::io_fs::read_dir(root).await else {
            continue;
        };
        for entry in &entries {
            if !entry.is_dir || entry.name != workflow_id {
                continue;
            }
            let dir = node_join_paths(root, &entry.name);
            if read_string(&node_join_paths(&dir, "workflow.yaml"))
                .await
                .is_ok()
            {
                return Some(path_text(&dir));
            }
        }
        for entry in &entries {
            if !entry.is_dir {
                continue;
            }
            let dir = node_join_paths(root, &entry.name);
            let Ok(text) = read_string(&node_join_paths(&dir, "workflow.yaml")).await else {
                continue;
            };
            if manifest_id_line(&text).as_deref() == Some(workflow_id) {
                return Some(path_text(&dir));
            }
        }
    }
    None
}

fn manifest_id_line(text: &str) -> Option<String> {
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(rest) = line.strip_prefix("id:") else {
            continue;
        };
        let rest = rest.trim_matches([' ', '\t']);
        let value = if let Some(quoted) = rest.strip_prefix('"') {
            quoted.split('"').next().unwrap_or("")
        } else if let Some(quoted) = rest.strip_prefix('\'') {
            quoted.split('\'').next().unwrap_or("")
        } else {
            rest.split('#').next().unwrap_or(rest)
        };
        let value = value.trim_matches([' ', '\t']);
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub async fn materialize_detached_failure(
    case_dir: &Path,
    run_id: &str,
    workflow_id: &str,
    version: &str,
    started_by: StartedBy,
    message: &str,
) -> Result<(), WorkflowError> {
    let ts = now_iso();
    if let Ok(existing) = read_case(case_dir).await {
        if existing.run.status.is_terminal() {
            return Ok(());
        }
        update_run(
            case_dir,
            RunPatch {
                status: Some(RunStatus::Failed),
                error: Some(message.to_string()),
                finished_at: Some(ts.clone()),
                ..RunPatch::default()
            },
        )
        .await?;
    } else {
        let run = Run {
            id: run_id.to_string(),
            workflow_id: workflow_id.to_string(),
            version: version.to_string(),
            started_by,
            parent: None,
            case_dir: path_text(case_dir),
            status: RunStatus::Failed,
            current: None,
            workflow_dir: None,
            error: Some(message.to_string()),
            output: None,
            started_at: Some(ts.clone()),
            finished_at: Some(ts.clone()),
        };
        let state = case_state(run, Map::new())?;
        if !try_exists(case_dir).await? {
            crate::io_fs::create_dir_all(case_dir).await?;
        }
        write_case(case_dir, &state).await?;
    }
    append_journal(
        case_dir,
        &JournalEntry::RunFinished {
            ts,
            run_id: run_id.to_string(),
            status: RunFinishedStatus::Failed,
            output: None,
            error: Some(message.to_string()),
        },
    )
    .await
}
