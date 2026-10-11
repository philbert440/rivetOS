use std::cmp::Ordering;
use std::path::Path;

use protocol::js::locale_compare;
use serde_json::Value;

use crate::case::case_path;
use crate::error::WorkflowError;
use crate::io_fs::{self, read_string, try_exists};
use crate::loader::load_workflow_dir;
use crate::pathutil::{node_join_paths, path_text};
use crate::types::{LoadedWorkflow, RunStatus, RunSummary};
use crate::wire::WireJson;

#[derive(Default)]
pub struct ListRunsOptions {
    pub limit: Option<usize>,
    pub depth: Option<usize>,
}

pub async fn list_runs(
    case_dir_root: &Path,
    opts: ListRunsOptions,
    on_warn: &(dyn Fn(&str) + Send + Sync),
) -> Result<Vec<RunSummary>, WorkflowError> {
    let limit = opts.limit.unwrap_or(100);
    let depth = opts.depth.unwrap_or(0);
    match try_exists(case_dir_root).await {
        Ok(true) => {}
        Ok(false) => return Ok(Vec::new()),
        Err(err) => {
            on_warn(&format!(
                "listRuns: cannot read {}: {err}",
                path_text(case_dir_root)
            ));
            return Ok(Vec::new());
        }
    }
    let mut found = Vec::new();
    scan_runs(case_dir_root, depth, 0, &mut found, on_warn, None).await;
    sort_with_locale(&mut found, |left, right| {
        let right_at = right.started_at.as_deref().unwrap_or("");
        let left_at = left.started_at.as_deref().unwrap_or("");
        locale_ordering(right_at, left_at)
    })?;
    found.truncate(limit);
    Ok(found)
}

pub async fn list_child_runs(
    case_dir: &Path,
    on_warn: &(dyn Fn(&str) + Send + Sync),
) -> Result<Vec<RunSummary>, WorkflowError> {
    match try_exists(case_dir).await {
        Ok(true) => {}
        Ok(false) => return Ok(Vec::new()),
        Err(err) => {
            on_warn(&format!(
                "listChildRuns: failed reading {}: {err}",
                path_text(case_dir)
            ));
            return Ok(Vec::new());
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
            return Ok(Vec::new());
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
    sort_with_locale(&mut found, |left, right| {
        let right_at = right.started_at.as_deref().unwrap_or("");
        let left_at = left.started_at.as_deref().unwrap_or("");
        locale_ordering(right_at, left_at)
    })?;
    Ok(found)
}

pub async fn list_workflow_defs(
    workflows_roots: &[impl AsRef<Path>],
    on_warn: &(dyn Fn(&str) + Send + Sync),
) -> Result<Vec<LoadedWorkflow>, WorkflowError> {
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
    sort_with_locale(&mut out, |left, right| {
        locale_ordering(&left.manifest.name, &right.manifest.name)
    })?;
    Ok(out)
}

fn locale_ordering(left: &str, right: &str) -> Result<Ordering, WorkflowError> {
    match locale_compare(left, right) {
        Ok(value) if value < 0 => Ok(Ordering::Less),
        Ok(value) if value > 0 => Ok(Ordering::Greater),
        Ok(_) => Ok(Ordering::Equal),
        Err(err) => Err(WorkflowError::message(format!(
            "localeCompare failed: {err}"
        ))),
    }
}

fn sort_with_locale<T>(
    items: &mut Vec<T>,
    compare: impl Fn(&T, &T) -> Result<Ordering, WorkflowError>,
) -> Result<(), WorkflowError> {
    locale_ordering("a", "b")?;
    fallible_sort(items, &compare)
}

fn fallible_sort<T>(
    items: &mut Vec<T>,
    compare: &impl Fn(&T, &T) -> Result<Ordering, WorkflowError>,
) -> Result<(), WorkflowError> {
    if items.len() < 2 {
        return Ok(());
    }
    let mid = items.len() / 2;
    let mut right = items.split_off(mid);
    fallible_sort(items, compare)?;
    fallible_sort(&mut right, compare)?;
    let left = std::mem::take(items);
    merge_into(items, left, right, compare)
}

fn merge_into<T>(
    out: &mut Vec<T>,
    left: Vec<T>,
    right: Vec<T>,
    compare: &impl Fn(&T, &T) -> Result<Ordering, WorkflowError>,
) -> Result<(), WorkflowError> {
    let mut left = left.into_iter();
    let mut right = right.into_iter();
    let mut hold_left = left.next();
    let mut hold_right = right.next();
    loop {
        match (hold_left.take(), hold_right.take()) {
            (Some(left_item), Some(right_item)) => match compare(&left_item, &right_item)? {
                Ordering::Greater => {
                    out.push(right_item);
                    hold_left = Some(left_item);
                    hold_right = right.next();
                }
                Ordering::Less | Ordering::Equal => {
                    out.push(left_item);
                    hold_right = Some(right_item);
                    hold_left = left.next();
                }
            },
            (Some(left_item), None) => {
                out.push(left_item);
                out.extend(left);
                break;
            }
            (None, Some(right_item)) => {
                out.push(right_item);
                out.extend(right);
                break;
            }
            (None, None) => break,
        }
    }
    Ok(())
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
    let document = WireJson::parse(&raw).ok()?.to_value();
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
    let document = match WireJson::parse(&raw) {
        Ok(document) => document.to_value(),
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

#[cfg(test)]
mod tests {
    use super::{locale_ordering, sort_with_locale};
    use crate::error::WorkflowError;

    #[test]
    fn locale_ordering_matches_the_node_golden() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
        let text = std::fs::read_to_string(&path).unwrap();
        let golden: serde_json::Value = serde_json::from_str(&text).unwrap();
        let names: Vec<String> = golden["locale_compare"]["sorted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect();
        let mut shuffled = names.clone();
        shuffled.reverse();
        shuffled.sort_by(|left, right| locale_ordering(left, right).unwrap());
        assert_eq!(shuffled, names);
        for pair in golden["locale_compare"]["pairs"].as_array().unwrap() {
            let left = pair["a"].as_str().unwrap();
            let right = pair["b"].as_str().unwrap();
            let sign = pair["sign"].as_i64().unwrap();
            let actual = match locale_ordering(left, right).unwrap() {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            };
            assert_eq!(actual, sign, "{left} vs {right}");
        }
        assert_eq!(
            locale_ordering("apple", "Zebra").unwrap(),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            locale_ordering("Zebra", "apple").unwrap(),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn sort_with_locale_is_stable_and_returns_compare_errors() {
        let mut items = vec![
            "b2".to_string(),
            "a".to_string(),
            "b1".to_string(),
            "c".to_string(),
            "a2".to_string(),
        ];
        sort_with_locale(&mut items, |left, right| {
            locale_ordering(&left[..1], &right[..1])
        })
        .unwrap();
        assert_eq!(items, vec!["a", "a2", "b2", "b1", "c"]);
        let mut broken = vec!["a".to_string(), "c".to_string(), "b".to_string()];
        let err = sort_with_locale(&mut broken, |left, right| {
            if left == "c" || right == "c" {
                Err(WorkflowError::message("compare broke"))
            } else {
                locale_ordering(left, right)
            }
        })
        .unwrap_err();
        assert!(err.to_string().contains("compare broke"), "{err}");
        assert!(!err.to_string().contains("localeCompare failed"), "{err}");
    }
}
