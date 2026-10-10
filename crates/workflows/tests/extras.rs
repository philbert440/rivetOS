use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Map, Value};
use workflows::{
    DEFAULT_MAX_RUN_RUNTIME_MS, DEFAULT_STEP_TIMEOUT_MS, EngineConfig, ExecutorRegistry,
    HumanStepOpts, JournalEntry, MockExecutorRegistry, RunFinishedStatus, RunStatus,
    StartRunOptions, StartedBy, StartedByType, WorkflowEngine, WorkflowError,
    check_run_script_determinism, default_case_dir_root, default_workflows_defs_root,
    edit_path_for_def_dir, is_workflow_allowed, load_workflow_dir, materialize_detached_failure,
    read_case, read_journal, resolve_defs_roots, resolve_max_run_runtime_ms, resolve_runs_dir,
    resolve_step_timeout_ms, run_script, validate_workflow_dir, workflows_enabled,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("wf-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn write_minimal(dir: &Path) {
    tokio::fs::create_dir_all(dir.join("agents")).await.unwrap();
    tokio::fs::write(
        dir.join("workflow.yaml"),
        "id: test-wf\nversion: \"1.0.0\"\nname: Test\ninput:\n  - name: message\n    type: string\n    required: true\noutput:\n  - name: result\n    type: string\n    required: false\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        dir.join("run.ts"),
        "export default async function run() {}\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        dir.join("agents").join("example.md"),
        "---\ntools: []\n---\n\n# hi\n",
    )
    .await
    .unwrap();
}

#[test]
fn edit_path_rejects_escapes_and_prefix_lookalikes() {
    assert_eq!(
        edit_path_for_def_dir("/rivet-shared/workflows/defs/demo", Some("/rivet-shared"))
            .as_deref(),
        Some("workflows/defs/demo")
    );
    assert_eq!(
        edit_path_for_def_dir("/rivet-shared", Some("/rivet-shared")).as_deref(),
        Some("")
    );
    assert_eq!(
        edit_path_for_def_dir("/other/place", Some("/rivet-shared")),
        None
    );
    assert_eq!(
        edit_path_for_def_dir("/rivet-shared/defs/demo", Some("")),
        None
    );
    assert_eq!(edit_path_for_def_dir("/rivet-shared/defs/demo", None), None);
    assert_eq!(
        edit_path_for_def_dir("/rivet-shared-evil/defs/demo", Some("/rivet-shared")),
        None
    );
    assert_eq!(
        edit_path_for_def_dir("/rivet-shared/../etc", Some("/rivet-shared")),
        None
    );
    assert_eq!(
        edit_path_for_def_dir("/rivet-shared/defs/", Some("/rivet-shared/")).as_deref(),
        Some("defs")
    );
}

#[test]
fn defs_roots_runs_dir_and_allowlist_follow_the_boot_rules() {
    let kept = resolve_defs_roots(
        Some(&["  /keep/me  ".to_string(), "   ".to_string()]),
        Some(Path::new("/opt/app")),
    );
    assert_eq!(kept, vec![PathBuf::from("  /keep/me  ")]);
    let defaults = resolve_defs_roots(None, Some(Path::new("/opt/app")));
    assert_eq!(defaults[0], default_workflows_defs_root());
    assert_eq!(defaults[1], PathBuf::from("/opt/app/workflows"));
    assert_eq!(resolve_runs_dir(None), default_case_dir_root());
    assert_eq!(resolve_runs_dir(Some("   ")), default_case_dir_root());
    assert_eq!(
        resolve_runs_dir(Some("/var/runs")),
        PathBuf::from("/var/runs")
    );
    assert!(workflows_enabled(None));
    assert!(workflows_enabled(Some(true)));
    assert!(!workflows_enabled(Some(false)));
    assert!(!is_workflow_allowed("demo", None));
    assert!(!is_workflow_allowed("demo", Some(&[])));
    assert!(is_workflow_allowed("demo", Some(&["*".to_string()])));
    assert!(is_workflow_allowed("demo", Some(&["demo".to_string()])));
    assert!(!is_workflow_allowed("demo", Some(&["other".to_string()])));
    assert_eq!(resolve_step_timeout_ms(Some(0.0)), 0.0);
    assert_eq!(resolve_step_timeout_ms(None), DEFAULT_STEP_TIMEOUT_MS);
    assert_eq!(resolve_max_run_runtime_ms(Some(0.0)), 0.0);
    assert_eq!(resolve_max_run_runtime_ms(None), DEFAULT_MAX_RUN_RUNTIME_MS);
}

#[test]
fn determinism_scanner_reports_every_rule_in_pattern_order() {
    let source = "\
const t = Date.now()
const d = new Date()
const r = Math.random()
import fs from 'node:fs'
const x = require('fs')
await fetch('https://example.test')
";
    let findings = check_run_script_determinism(source);
    let rules: Vec<_> = findings.iter().map(|item| item.rule).collect();
    assert_eq!(
        rules,
        vec![
            "no-date-now",
            "no-new-date",
            "no-math-random",
            "no-fs-import",
            "no-fs-require",
            "no-fetch",
        ]
    );
    assert!(findings[0].message.contains("Date.now()"));
    assert!(findings[3].message.contains("Direct fs import"));
    assert_eq!(findings[0].line, 1);
}

#[test]
fn timeout_and_kill_error_text() {
    let step = WorkflowError::step_timeout("prepare#1", 10.0);
    assert_eq!(step.name(), "StepTimeoutError");
    assert_eq!(step.to_string(), "Step prepare#1 timed out after 10ms");
    let run = WorkflowError::run_timeout("r1", 0.0);
    assert_eq!(run.to_string(), "Run r1 exceeded max runtime of 0ms");
    let killed = WorkflowError::killed("r1");
    assert_eq!(killed.name(), "WorkflowKilled");
    assert_eq!(killed.to_string(), "Run r1 was killed");
}

#[tokio::test]
async fn non_positive_max_runtime_fails_without_starting_the_script() {
    let root = temp_root("timeout0");
    let dir = root.join("wf");
    write_minimal(&dir).await;
    let workflow = load_workflow_dir(&dir).await.unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let ran_h = ran.clone();
    let executors: Arc<dyn ExecutorRegistry> = Arc::new(MockExecutorRegistry::new());
    let mut config = EngineConfig::new(executors);
    config.case_dir_root = Some(root.join("runs"));
    config.workflow_dirs = vec![("test-wf".to_string(), dir)];
    config.max_run_runtime_ms = Some(0.0);
    let engine = WorkflowEngine::new(config);
    let result = engine
        .start_run(
            "test-wf",
            {
                let mut input = Map::new();
                input.insert("message".to_string(), Value::String("x".to_string()));
                input
            },
            StartedBy::new(StartedByType::Human),
            StartRunOptions {
                run_script: Some(run_script(move |_step, _ctx| {
                    let ran = ran_h.clone();
                    async move {
                        ran.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                })),
                workflow: Some(workflow),
                ..StartRunOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Failed);
    assert!(!ran.load(Ordering::SeqCst));
    assert!(
        result
            .run
            .error
            .unwrap_or_default()
            .contains("exceeded max runtime")
    );
}

#[tokio::test]
async fn positive_max_runtime_cancels_a_slow_script() {
    let root = temp_root("timeout");
    let dir = root.join("wf");
    write_minimal(&dir).await;
    let workflow = load_workflow_dir(&dir).await.unwrap();
    let executors: Arc<dyn ExecutorRegistry> = Arc::new(MockExecutorRegistry::new());
    let mut config = EngineConfig::new(executors);
    config.case_dir_root = Some(root.join("runs"));
    config.workflow_dirs = vec![("test-wf".to_string(), dir)];
    config.max_run_runtime_ms = Some(40.0);
    let engine = WorkflowEngine::new(config);
    let result = engine
        .start_run(
            "test-wf",
            {
                let mut input = Map::new();
                input.insert("message".to_string(), Value::String("x".to_string()));
                input
            },
            StartedBy::new(StartedByType::Human),
            StartRunOptions {
                run_script: Some(run_script(|_step, _ctx| async {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    Ok(())
                })),
                workflow: Some(workflow),
                ..StartRunOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Failed);
    let error = result.run.error.unwrap_or_default();
    assert!(error.contains("exceeded max runtime"), "{error}");
    assert!(error.contains("40"), "{error}");
}

#[tokio::test]
async fn kill_run_writes_killed_marker_and_journal() {
    let root = temp_root("kill");
    let dir = root.join("wf");
    write_minimal(&dir).await;
    let workflow = load_workflow_dir(&dir).await.unwrap();
    let executors: Arc<dyn ExecutorRegistry> = Arc::new(MockExecutorRegistry::new());
    let mut config = EngineConfig::new(executors);
    config.case_dir_root = Some(root.join("runs"));
    config.workflow_dirs = vec![("test-wf".to_string(), dir)];
    let engine = WorkflowEngine::new(config);
    let started = engine
        .start_run(
            "test-wf",
            {
                let mut input = Map::new();
                input.insert("message".to_string(), Value::String("x".to_string()));
                input
            },
            StartedBy::new(StartedByType::Human),
            StartRunOptions {
                run_id: Some("kill-1".to_string()),
                run_script: Some(run_script(|step, _ctx| async move {
                    step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
                        .await?;
                    Ok(())
                })),
                workflow: Some(workflow),
                ..StartRunOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(started.suspended);
    engine.kill_run("kill-1").await.unwrap();
    let state = read_case(Path::new(&started.case_dir)).await.unwrap();
    assert_eq!(state.run.status, RunStatus::Killed);
    let marker = tokio::fs::read_to_string(Path::new(&started.case_dir).join("KILLED"))
        .await
        .unwrap();
    assert!(!marker.is_empty());
    assert!(!marker.ends_with('\n'));
    assert!(marker.ends_with('Z'));
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    assert!(journal.iter().any(|entry| {
        matches!(
            entry,
            JournalEntry::RunFinished {
                status: RunFinishedStatus::Killed,
                ..
            }
        )
    }));
}

#[tokio::test]
async fn validate_workflow_dir_accepts_a_clean_script() {
    let root = temp_root("validate");
    let dir = root.join("wf");
    write_minimal(&dir).await;
    let response = validate_workflow_dir(&dir).await;
    assert!(response.ok, "{:?}", response.diagnostics);
    let hello = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workflows/hello-world");
    let hello_response = validate_workflow_dir(&hello).await;
    assert!(!hello_response.ok);
    let reported: Vec<_> = hello_response
        .diagnostics
        .iter()
        .map(|item| {
            (
                item.file.as_str(),
                item.line,
                item.severity,
                item.message.as_str(),
            )
        })
        .collect();
    assert_eq!(
        reported,
        vec![
            (
                "run.ts",
                Some(4),
                "error",
                "no-date-now: Date.now() is nondeterministic — use a step if you need wall clock",
            ),
            (
                "run.ts",
                Some(4),
                "error",
                "no-math-random: Math.random() is nondeterministic — use a step if you need entropy",
            ),
        ]
    );
}

#[test]
fn hello_world_determinism_scan_matches_typescript() {
    let source = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workflows/hello-world/run.ts"),
    )
    .unwrap();
    let findings = check_run_script_determinism(&source);
    let reported: Vec<_> = findings
        .iter()
        .map(|item| {
            (
                item.line,
                item.column,
                item.rule,
                item.message,
                item.snippet.as_str(),
            )
        })
        .collect();
    assert_eq!(
        reported,
        vec![
            (
                4,
                25,
                "no-date-now",
                "Date.now() is nondeterministic — use a step if you need wall clock",
                "* DETERMINISM RULE: no Date.now(), Math.random(), or I/O outside step.* calls.",
            ),
            (
                4,
                37,
                "no-math-random",
                "Math.random() is nondeterministic — use a step if you need entropy",
                "* DETERMINISM RULE: no Date.now(), Math.random(), or I/O outside step.* calls.",
            ),
        ]
    );
}

#[tokio::test]
async fn materialize_detached_failure_writes_case_and_journal() {
    let root = temp_root("detach");
    let case_dir = root.join("run-1");
    materialize_detached_failure(
        &case_dir,
        "run-1",
        "test-wf",
        "1.0.0",
        StartedBy::new(StartedByType::Human),
        "detached boom",
    )
    .await
    .unwrap();
    let state = read_case(&case_dir).await.unwrap();
    assert_eq!(state.run.status, RunStatus::Failed);
    assert_eq!(state.run.error.as_deref(), Some("detached boom"));
    let journal = read_journal(&case_dir).await.unwrap();
    assert!(
        journal
            .iter()
            .any(|entry| entry.entry_type() == "run_finished")
    );
    materialize_detached_failure(
        &case_dir,
        "run-1",
        "test-wf",
        "1.0.0",
        StartedBy::new(StartedByType::Human),
        "second",
    )
    .await
    .unwrap();
    assert_eq!(
        read_case(&case_dir).await.unwrap().run.error.as_deref(),
        Some("detached boom")
    );
}
