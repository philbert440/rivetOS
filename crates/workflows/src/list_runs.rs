use std::path::Path;

use serde_json::Value;

use crate::case::case_path;
use crate::io_fs::{self, read_string, try_exists};
use crate::loader::load_workflow_dir;
use crate::pathutil::{node_join_paths, path_text};
use crate::types::{LoadedWorkflow, RunStatus, RunSummary};

#[derive(Default)]
pub struct ListRunsOptions {
    pub limit: Option<usize>,
    pub depth: Option<usize>,
}

pub async fn list_runs(
    case_dir_root: &Path,
    opts: ListRunsOptions,
    on_warn: &(dyn Fn(&str) + Send + Sync),
) -> Vec<RunSummary> {
    let limit = opts.limit.unwrap_or(100);
    let depth = opts.depth.unwrap_or(0);
    match try_exists(case_dir_root).await {
        Ok(true) => {}
        Ok(false) => return Vec::new(),
        Err(err) => {
            on_warn(&format!(
                "listRuns: cannot read {}: {err}",
                path_text(case_dir_root)
            ));
            return Vec::new();
        }
    }
    let mut found = Vec::new();
    scan_runs(case_dir_root, depth, 0, &mut found, on_warn, None).await;
    found.sort_by(|left, right| {
        let right_at = right.started_at.as_deref().unwrap_or("");
        let left_at = left.started_at.as_deref().unwrap_or("");
        right_at.cmp(left_at)
    });
    found.truncate(limit);
    found
}

pub async fn list_child_runs(
    case_dir: &Path,
    on_warn: &(dyn Fn(&str) + Send + Sync),
) -> Vec<RunSummary> {
    match try_exists(case_dir).await {
        Ok(true) => {}
        Ok(false) => return Vec::new(),
        Err(err) => {
            on_warn(&format!(
                "listChildRuns: failed reading {}: {err}",
                path_text(case_dir)
            ));
            return Vec::new();
        }
    }
    let parent_run_id = read_parent_id(case_dir).await;
    let entries = match io_fs::read_dir(case_dir).await {
        Ok(entries) => entries,
        Err(err) => {
            on_warn(&format!(
                "listChildRuns: failed reading {}: {err}",
                path_text(case_dir)
            ));
            return Vec::new();
        }
    };
    let mut found = Vec::new();
    for entry in entries {
        if !entry.is_dir {
            continue;
        }
        let child = node_join_paths(case_dir, &entry.name);
        if let Some(mut summary) = read_run_summary(&child, on_warn, parent_run_id.clone()).await {
            summary.nested = true;
            found.push(summary);
        }
    }
    found.sort_by(|left, right| {
        let right_at = right.started_at.as_deref().unwrap_or("");
        let left_at = left.started_at.as_deref().unwrap_or("");
        right_at.cmp(left_at)
    });
    found
}

pub async fn list_workflow_defs(
    workflows_roots: &[impl AsRef<Path>],
    on_warn: &(dyn Fn(&str) + Send + Sync),
) -> Vec<LoadedWorkflow> {
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for root in workflows_roots {
        let root = root.as_ref();
        match try_exists(root).await {
            Ok(true) => {}
            Ok(false) => {
                on_warn(&format!(
                    "listWorkflowDefs: root missing: {}",
                    path_text(root)
                ));
                continue;
            }
            Err(err) => {
                on_warn(&format!(
                    "listWorkflowDefs: cannot read {}: {err}",
                    path_text(root)
                ));
                continue;
            }
        }
        let entries = match io_fs::read_dir(root).await {
            Ok(entries) => entries,
            Err(err) => {
                on_warn(&format!(
                    "listWorkflowDefs: cannot read {}: {err}",
                    path_text(root)
                ));
                continue;
            }
        };
        for entry in entries {
            if !entry.is_dir {
                continue;
            }
            let dir = node_join_paths(root, &entry.name);
            match try_exists(&node_join_paths(&dir, "workflow.yaml")).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(err) => {
                    on_warn(&format!(
                        "listWorkflowDefs: skip {}: {err}",
                        path_text(&dir)
                    ));
                    continue;
                }
            }
            match load_workflow_dir(&dir).await {
                Ok(loaded) => {
                    if seen.iter().any(|id: &String| id == &loaded.manifest.id) {
                        on_warn(&format!(
                            "listWorkflowDefs: duplicate id \"{}\" in {} (keeping first)",
                            loaded.manifest.id,
                            path_text(&dir)
                        ));
                        continue;
                    }
                    seen.push(loaded.manifest.id.clone());
                    out.push(loaded);
                }
                Err(err) => {
                    on_warn(&format!(
                        "listWorkflowDefs: skip {}: {err}",
                        path_text(&dir)
                    ));
                }
            }
        }
    }
    out.sort_by(|left, right| left.manifest.name.cmp(&right.manifest.name));
    out
}

async fn scan_runs(
    dir: &Path,
    max_depth: usize,
    depth: usize,
    out: &mut Vec<RunSummary>,
    on_warn: &(dyn Fn(&str) + Send + Sync),
    parent_run_id: Option<String>,
) {
    let entries = match io_fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) => {
            on_warn(&format!("listRuns: cannot read {}: {err}", path_text(dir)));
            return;
        }
    };
    for entry in entries {
        if !entry.is_dir {
            continue;
        }
        let child = node_join_paths(dir, &entry.name);
        let Some(mut summary) = read_run_summary(&child, on_warn, parent_run_id.clone()).await
        else {
            continue;
        };
        summary.nested = depth > 0;
        let child_id = summary.id.clone();
        out.push(summary);
        if depth < max_depth {
            Box::pin(scan_runs(
                &child,
                max_depth,
                depth + 1,
                out,
                on_warn,
                Some(child_id),
            ))
            .await;
        }
    }
}

async fn read_parent_id(case_dir: &Path) -> Option<String> {
    let raw = read_string(&case_path(case_dir)).await.ok()?;
    let document: Value = serde_json::from_str(&raw).ok()?;
    document
        .get("run")
        .and_then(|run| run.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn read_run_summary(
    case_dir: &Path,
    on_warn: &(dyn Fn(&str) + Send + Sync),
    parent_run_id: Option<String>,
) -> Option<RunSummary> {
    let path = case_path(case_dir);
    match try_exists(&path).await {
        Ok(true) => {}
        Ok(false) => return None,
        Err(err) => {
            on_warn(&format!("listRuns: skip {}: {err}", path_text(case_dir)));
            return None;
        }
    }
    let raw = match read_string(&path).await {
        Ok(raw) => raw,
        Err(err) => {
            on_warn(&format!("listRuns: skip {}: {err}", path_text(case_dir)));
            return None;
        }
    };
    let document: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => {
            on_warn(&format!("listRuns: skip {}: {err}", path_text(case_dir)));
            return None;
        }
    };
    let run = document.get("run");
    let id = run.and_then(|item| item.get("id")).and_then(Value::as_str);
    let workflow_id = run
        .and_then(|item| item.get("workflowId"))
        .and_then(Value::as_str);
    let (Some(id), Some(workflow_id)) = (id, workflow_id) else {
        on_warn(&format!(
            "listRuns: malformed case.json (missing run.id/workflowId) in {}",
            path_text(case_dir)
        ));
        return None;
    };
    let status = run
        .and_then(|item| item.get("status"))
        .and_then(Value::as_str)
        .and_then(RunStatus::parse)
        .unwrap_or(RunStatus::Running);
    let own_parent = run
        .and_then(|item| item.get("parent"))
        .and_then(|parent| parent.get("runId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(RunSummary {
        id: id.to_string(),
        workflow_id: workflow_id.to_string(),
        status,
        started_at: run
            .and_then(|item| item.get("startedAt"))
            .and_then(Value::as_str)
            .map(str::to_string),
        finished_at: run
            .and_then(|item| item.get("finishedAt"))
            .and_then(Value::as_str)
            .map(str::to_string),
        current: run
            .and_then(|item| item.get("current"))
            .and_then(Value::as_str)
            .map(str::to_string),
        case_dir: path_text(case_dir),
        nested: false,
        parent_run_id: parent_run_id.or(own_parent),
        version: run
            .and_then(|item| item.get("version"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
