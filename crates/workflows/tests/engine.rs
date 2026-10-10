use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use std::collections::HashMap;

use workflows::{
    AgentStepOpts, ContractReason, EngineConfig, ExecutorRegistry, HumanStepOpts, JournalEntry,
    LoadedWorkflow, MockExecutorRegistry, ResumeRunOptions, RunFinishedStatus, RunPatch, RunScript,
    RunStatus, RunStepOpts, ScaffoldOptions, StartRunOptions, StartedBy, StartedByType, StepKind,
    StepUsage, WorkflowEngine, WorkflowError, agent_handler, append_journal, branch,
    check_run_script_determinism, is_max_concurrent_runs, journal_path, load_workflow_dir,
    make_step_id, node_join, parse_call_ref, parse_manifest, path_text, read_case, read_journal,
    run_handler, run_script, scaffold_workflow, update_run, validate_start_input,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("wf-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn write_minimal(dir: &Path, id: &str, yaml: Option<&str>) {
    tokio::fs::create_dir_all(dir.join("agents")).await.unwrap();
    let body = match yaml {
        Some(text) => text.to_string(),
        None => format!(
            "id: {id}\nversion: \"1.0.0\"\nname: Test\ninput:\n  - name: message\n    type: string\n    required: true\noutput:\n  - name: result\n    type: string\n    required: false\n"
        ),
    };
    tokio::fs::write(dir.join("workflow.yaml"), body)
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

async fn load_min(root: &Path, id: &str, yaml: Option<&str>) -> (PathBuf, LoadedWorkflow) {
    let dir = root.join(id);
    write_minimal(&dir, id, yaml).await;
    let workflow = load_workflow_dir(&dir).await.unwrap();
    (dir, workflow)
}

fn human() -> StartedBy {
    StartedBy::new(StartedByType::Human)
}

fn message_input(text: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("message".to_string(), Value::String(text.to_string()));
    map
}

fn result_output(value: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("result".to_string(), value);
    map
}

fn bool_map(key: &str, value: bool) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(key.to_string(), Value::Bool(value));
    map
}

fn start_opts(
    script: RunScript,
    workflow: LoadedWorkflow,
    run_id: Option<&str>,
) -> StartRunOptions {
    StartRunOptions {
        run_id: run_id.map(str::to_string),
        case_dir: None,
        parent: None,
        run_script: Some(script),
        workflow: Some(workflow),
    }
}

fn resume_opts(
    script: RunScript,
    workflow: LoadedWorkflow,
    gate: Option<Map<String, Value>>,
) -> ResumeRunOptions {
    ResumeRunOptions {
        gate_response: gate,
        run_script: Some(script),
        workflow: Some(workflow),
    }
}

fn engine_for(
    runs: &Path,
    executors: Arc<dyn ExecutorRegistry>,
    dirs: Vec<(&str, &Path)>,
) -> WorkflowEngine {
    let mut config = EngineConfig::new(executors);
    config.case_dir_root = Some(runs.to_path_buf());
    config.workflow_dirs = dirs
        .into_iter()
        .map(|(id, path)| (id.to_string(), path.to_path_buf()))
        .collect();
    WorkflowEngine::new(config)
}

fn arc_exec(registry: MockExecutorRegistry) -> Arc<dyn ExecutorRegistry> {
    Arc::new(registry)
}

fn branch_digit(label: &str) -> String {
    let bytes = label.as_bytes();
    let mut index = 0;
    while index + 3 < bytes.len() {
        if bytes[index] == b'/' && bytes[index + 1] == b'b' && bytes[index + 2].is_ascii_digit() {
            let mut end = index + 2;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end < bytes.len() && bytes[end] == b':' {
                return label[index + 2..end].to_string();
            }
        }
        index += 1;
    }
    "?".to_string()
}

#[test]
fn parses_workflow_yaml_fields() {
    let manifest = parse_manifest(&json!({
        "id": "x",
        "version": "1",
        "name": "X",
        "input": [{"name": "a", "type": "string", "required": true}],
        "output": [{"name": "b", "type": "number"}],
        "budgets": {"maxTokens": 10}
    }))
    .unwrap();
    assert_eq!(manifest.id, "x");
    assert_eq!(manifest.input[0].name, "a");
    assert_eq!(manifest.budgets.unwrap().max_tokens, Some(10.0));
    let implicit = parse_manifest(&json!({
        "id": "x",
        "version": "1",
        "name": "X",
        "input": [{"name": "a", "type": "string"}],
        "output": []
    }))
    .unwrap();
    assert!(implicit.input[0].is_required());
}

#[test]
fn rejects_missing_required_fields_with_structured_issues() {
    let fields = parse_manifest(&json!({
        "id": "x",
        "version": "1",
        "name": "X",
        "input": [
            {"name": "message", "type": "string", "required": true},
            {"name": "count", "type": "number", "required": true}
        ],
        "output": []
    }))
    .unwrap()
    .input;
    let err = validate_start_input(&fields, &message_input("hi")).unwrap_err();
    match err {
        WorkflowError::Contract { issues, .. } => {
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].field, "count");
            assert_eq!(issues[0].reason, ContractReason::Missing);
        }
        other => panic!("unexpected {other}"),
    }
}

#[tokio::test]
async fn start_run_rejects_missing_fields_before_creating_work() {
    let root = temp_root("contract");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let err = engine
        .start_run(
            "test-wf",
            Map::new(),
            human(),
            start_opts(run_script(|_step, _ctx| async { Ok(()) }), workflow, None),
        )
        .await
        .unwrap_err();
    assert_eq!(err.name(), "ContractValidationError");
    assert!(!root.join("runs").exists());
}

#[tokio::test]
async fn skips_executed_steps_on_replay() {
    let root = temp_root("replay");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let live = Arc::new(AtomicUsize::new(0));
    let live_h = live.clone();
    let executors = arc_exec(MockExecutorRegistry::with_agent(agent_handler(
        move |_opts| {
            let live = live_h.clone();
            async move {
                let n = live.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(json!({"result": format!("live-{n}")}))
            }
        },
    )));
    let engine = engine_for(
        &root.join("runs"),
        executors,
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        let agent = step
            .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.human(
            "gate",
            HumanStepOpts::fields(vec!["ok".to_string()]).with_prompt("go?"),
        )
        .await?;
        step.done(result_output(
            agent.get("result").cloned().unwrap_or(Value::Null),
        ))
        .await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(script.clone(), workflow.clone(), Some("replay-1")),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    assert_eq!(live.load(Ordering::SeqCst), 1);
    let resumed = engine
        .resume_run(
            "replay-1",
            resume_opts(script, workflow, Some(bool_map("ok", true))),
        )
        .await
        .unwrap();
    assert!(!resumed.suspended);
    assert_eq!(resumed.run.status, RunStatus::Done);
    assert_eq!(live.load(Ordering::SeqCst), 1);
    assert_eq!(resumed.run.output, Some(json!({"result": "live-1"})));
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    let finished = journal
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                JournalEntry::StepFinished { label, .. } if label == "work"
            )
        })
        .count();
    assert_eq!(finished, 1);
}

#[tokio::test]
async fn gate_suspension_and_resume() {
    let root = temp_root("gate");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_run(run_handler(|_opts| async {
            Ok(json!({"loaded": true}))
        }))),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        step.run("load", RunStepOpts::script("noop")).await?;
        let gate = step
            .human(
                "review-gate",
                HumanStepOpts::fields(vec!["approved".to_string()]).with_prompt("Approve?"),
            )
            .await?;
        let mut output = Map::new();
        output.insert(
            "approved".to_string(),
            gate.get("approved").cloned().unwrap_or(Value::Null),
        );
        step.done(output).await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    assert_eq!(started.run.status, RunStatus::PausedHuman);
    assert_eq!(started.suspension.as_ref().unwrap().label, "review-gate");
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    assert!(
        journal
            .iter()
            .any(|entry| entry.entry_type() == "gate_opened")
    );
    let resumed = engine
        .resume_run(
            &started.run.id,
            resume_opts(script, workflow, Some(bool_map("approved", true))),
        )
        .await
        .unwrap();
    assert!(!resumed.suspended);
    assert_eq!(resumed.run.status, RunStatus::Done);
    assert_eq!(
        resumed
            .run
            .output
            .as_ref()
            .and_then(|value| value.get("approved")),
        Some(&Value::Bool(true))
    );
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    assert!(
        journal
            .iter()
            .any(|entry| entry.entry_type() == "gate_resolved")
    );
    assert!(journal.iter().any(|entry| {
        matches!(
            entry,
            JournalEntry::RunFinished {
                status: RunFinishedStatus::Done,
                ..
            }
        )
    }));
}

#[tokio::test]
async fn loop_iterations_get_distinct_seq_ids() {
    let root = temp_root("loop");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let seqs = Arc::new(Mutex::new(Vec::new()));
    let seqs_h = seqs.clone();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            move |opts| {
                let seqs = seqs_h.clone();
                async move {
                    let seq = opts
                        .step_id
                        .split('#')
                        .nth(1)
                        .unwrap()
                        .parse::<i64>()
                        .unwrap();
                    seqs.lock().unwrap().push(seq);
                    Ok(json!({"result": seq}))
                }
            },
        ))),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        for _ in 0..3 {
            step.agent("loop-body", AgentStepOpts::out(vec!["result".to_string()]))
                .await?;
        }
        step.done(result_output(Value::String("ok".to_string())))
            .await
    });
    let result = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(script, workflow, None),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Done);
    assert_eq!(*seqs.lock().unwrap(), vec![1, 2, 3]);
    assert_eq!(make_step_id("loop-body", 2), "loop-body#2");
    let journal = read_journal(Path::new(&result.case_dir)).await.unwrap();
    let started: Vec<i64> = journal
        .iter()
        .filter_map(|entry| match entry {
            JournalEntry::StepStarted { label, seq, .. } if label == "loop-body" => Some(*seq),
            _ => None,
        })
        .collect();
    assert_eq!(started, vec![1, 2, 3]);
}

#[tokio::test]
async fn nests_child_case_dir_under_parent() {
    let root = temp_root("child");
    let (parent_dir, parent_wf) = load_min(&root, "parent", None).await;
    let (child_dir, _) = load_min(&root, "child", None).await;
    tokio::fs::write(
        child_dir.join("run.mjs"),
        "export default async function run(step) {\n  const a = await step.agent('c', { out: ['result'] });\n  await step.done({ result: a.result });\n}\n",
    )
    .await
    .unwrap();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            |_opts| async { Ok(json!({"result": "nested-ok"})) },
        ))),
        vec![
            ("parent", parent_dir.as_path()),
            ("child", child_dir.as_path()),
        ],
    );
    let script = run_script(|step, _ctx| async move {
        let out = step
            .call("child-call", "child", message_input("from-parent"))
            .await?;
        step.done(result_output(out)).await
    });
    let started = engine
        .start_run(
            "parent",
            message_input("p"),
            human(),
            start_opts(script, parent_wf, None),
        )
        .await
        .unwrap();
    assert_eq!(
        started.run.status,
        RunStatus::Done,
        "{}",
        started.run.error.unwrap_or_default()
    );
    let mut child_names = Vec::new();
    let mut reader = tokio::fs::read_dir(&started.case_dir).await.unwrap();
    while let Some(entry) = reader.next_entry().await.unwrap() {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().await.unwrap().is_dir() && name.starts_with("child-") {
            child_names.push(name);
        }
    }
    assert!(!child_names.is_empty());
    let nested = Path::new(&started.case_dir).join(&child_names[0]);
    let child = read_case(&nested).await.unwrap();
    assert_eq!(child.run.workflow_id, "child");
    assert_eq!(
        child
            .run
            .parent
            .as_ref()
            .map(|parent| parent.run_id.as_str()),
        Some(started.run.id.as_str())
    );
    assert_eq!(child.run.status, RunStatus::Done);
    assert_eq!(
        child.fields.get("result"),
        Some(&Value::String("nested-ok".to_string()))
    );
}

#[tokio::test]
async fn child_failure_fails_the_parent_call() {
    let root = temp_root("child-fail");
    let (parent_dir, parent_wf) = load_min(&root, "parent", None).await;
    let (child_dir, _) = load_min(&root, "child", None).await;
    tokio::fs::write(
        child_dir.join("run.mjs"),
        "export default async function run(step) {\n  await step.agent('boom', { out: ['result'] });\n  await step.done({ result: 'unreachable' });\n}\n",
    )
    .await
    .unwrap();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            |_opts| async { Err(WorkflowError::message("child agent exploded")) },
        ))),
        vec![
            ("parent", parent_dir.as_path()),
            ("child", child_dir.as_path()),
        ],
    );
    let script = run_script(|step, _ctx| async move {
        step.call("child-call", "child", message_input("x")).await?;
        step.done(result_output(Value::String("parent-ok".to_string())))
            .await
    });
    let started = engine
        .start_run(
            "parent",
            message_input("p"),
            human(),
            start_opts(script, parent_wf, None),
        )
        .await
        .unwrap();
    assert_eq!(started.run.status, RunStatus::Failed);
    let error = started.run.error.unwrap_or_default();
    assert!(
        error.contains("child agent exploded") || error.contains("Child workflow"),
        "{error}"
    );
}

#[tokio::test]
async fn undeclared_agent_fields_are_not_merged() {
    let root = temp_root("undecl");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let warns = Arc::new(Mutex::new(Vec::new()));
    let hook = warns.clone();
    let mut config = EngineConfig::new(arc_exec(MockExecutorRegistry::with_agent(agent_handler(
        |_opts| async { Ok(json!({"result": "declared", "secretStuff": "nope", "extra": 1})) },
    ))));
    config.case_dir_root = Some(root.join("runs"));
    config.workflow_dirs = vec![("test-wf".to_string(), dir)];
    config.warn = Arc::new(move |message: &str| hook.lock().unwrap().push(message.to_string()));
    let engine = WorkflowEngine::new(config);
    let script = run_script(|step, _ctx| async move {
        let agent = step
            .agent("a", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.done(result_output(
            agent.get("result").cloned().unwrap_or(Value::Null),
        ))
        .await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(script, workflow, None),
        )
        .await
        .unwrap();
    assert_eq!(started.run.status, RunStatus::Done);
    let state = read_case(Path::new(&started.case_dir)).await.unwrap();
    assert_eq!(
        state.fields.get("result"),
        Some(&Value::String("declared".to_string()))
    );
    assert!(state.fields.get("secretStuff").is_none());
    assert!(state.fields.get("extra").is_none());
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    let warnings: Vec<_> = journal
        .iter()
        .filter(|entry| entry.entry_type() == "manifest_warn")
        .collect();
    assert_eq!(warnings.len(), 1);
    match warnings[0] {
        JournalEntry::ManifestWarn { undeclared, .. } => {
            let mut keys = undeclared.clone();
            keys.sort();
            assert_eq!(keys, vec!["extra".to_string(), "secretStuff".to_string()]);
        }
        _ => panic!("expected manifest_warn"),
    }
    assert!(
        warns
            .lock()
            .unwrap()
            .iter()
            .any(|item| item.contains("undeclared"))
    );
}

#[tokio::test]
async fn errors_on_unknown_namespace() {
    let registry = workflows::create_call_registry(Some(Arc::new(|_name, _input, _ctx| {
        Box::pin(async { Ok(json!({})) })
    })));
    registry.register(
        "ext",
        Arc::new(|_name, _input, _ctx| Box::pin(async { Ok(json!({"ok": true})) })),
    );
    let err = registry
        .call(
            "other:foo",
            Map::new(),
            workflows::CallContext {
                parent_run_id: "r".to_string(),
                parent_step_id: "s".to_string(),
                parent_case_dir: "/tmp".to_string(),
                timeout_ms: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.name(), "UnknownCallNamespaceError");
    let (namespace, name) = parse_call_ref("ext:deploy");
    assert_eq!(namespace, "ext");
    assert_eq!(name, "deploy");
    assert_eq!(parse_call_ref("bare").0, "");
}

#[test]
fn determinism_flags_date_now_and_math_random() {
    let source = "\n      const t = Date.now()\n      const r = Math.random()\n      await step.agent('x', { out: [] })\n    ";
    let findings = check_run_script_determinism(source);
    assert!(findings.iter().any(|item| item.rule == "no-date-now"));
    assert!(findings.iter().any(|item| item.rule == "no-math-random"));
    let clean = "\n      export default async function run(step, ctx) {\n        const a = await step.agent('a', { out: ['x'] })\n        await step.done({ x: a.x })\n      }\n    ";
    assert!(check_run_script_determinism(clean).is_empty());
}

#[tokio::test]
async fn scaffold_creates_the_workflow_directory_layout() {
    let root = temp_root("scaffold");
    let result = scaffold_workflow(
        "demo-flow",
        ScaffoldOptions {
            dir: Some(root.clone()),
            description: None,
            fixture_test: Some(true),
        },
    )
    .await
    .unwrap();
    assert!(result.files.iter().any(|file| file == "workflow.yaml"));
    assert!(result.files.iter().any(|file| file == "run.ts"));
    assert!(result.files.iter().any(|file| file == "agents/example.md"));
    let yaml = tokio::fs::read_to_string(Path::new(&result.workflow_dir).join("workflow.yaml"))
        .await
        .unwrap();
    assert!(yaml.contains("id: demo-flow"));
    let loaded = load_workflow_dir(Path::new(&result.workflow_dir))
        .await
        .unwrap();
    assert!(loaded.agents.contains_key("example"));
    assert_eq!(loaded.manifest.input[0].name, "message");
    let again = scaffold_workflow(
        "demo-flow",
        ScaffoldOptions {
            dir: Some(root),
            description: None,
            fixture_test: Some(false),
        },
    )
    .await
    .unwrap_err();
    assert!(again.to_string().contains("Workflow already exists"));
    let invalid = scaffold_workflow("Bad Name", ScaffoldOptions::default())
        .await
        .unwrap_err();
    assert!(invalid.to_string().contains("Invalid workflow name"));
}

#[tokio::test]
async fn loads_agent_frontmatter() {
    let root = temp_root("load");
    let (dir, _) = load_min(&root, "wf", None).await;
    tokio::fs::write(
        dir.join("agents").join("example.md"),
        "---\ntools:\n  - shell\nmodel: test-model\nmaxTurns: 3\n---\n\nYou are the example agent.\n",
    )
    .await
    .unwrap();
    let loaded = load_workflow_dir(&dir).await.unwrap();
    let agent = loaded.agents.get("example").unwrap();
    assert_eq!(agent.config.model.as_deref(), Some("test-model"));
    assert_eq!(agent.config.max_turns.unwrap().as_f64(), 3.0);
    assert_eq!(agent.config.tools, Some(vec![json!("shell")]));
    assert!(agent.prompt.contains("You are the example agent."));
}

fn budget_yaml(id: &str, max_tokens: i64) -> String {
    format!(
        "id: {id}\nversion: \"1.0.0\"\nname: Budget\ninput:\n  - name: message\n    type: string\noutput:\n  - name: result\n    type: string\nbudgets:\n  maxTokens: {max_tokens}\n"
    )
}

#[tokio::test]
async fn budget_fails_when_max_tokens_exceeded() {
    let root = temp_root("budget");
    let yaml = budget_yaml("budget-wf", 150);
    let (dir, workflow) = load_min(&root, "wf", Some(&yaml)).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            |opts| async move {
                (opts.report_usage)(StepUsage::tokens(100.0));
                Ok(json!({"result": "ok"}))
            },
        ))),
        vec![("budget-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        step.agent("a1", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.agent("a2", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.agent("a3", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.done(result_output(Value::String("never".to_string())))
            .await
    });
    let result = engine
        .start_run(
            "budget-wf",
            message_input("x"),
            human(),
            start_opts(script, workflow, None),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Failed);
    let error = result.run.error.unwrap_or_default();
    assert!(
        error.contains("Budget exceeded") && error.contains("maxTokens"),
        "{error}"
    );
    assert!(error.contains("150"), "{error}");
    let journal = read_journal(Path::new(&result.case_dir)).await.unwrap();
    let finished: Vec<_> = journal
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                JournalEntry::StepFinished {
                    kind: StepKind::Agent,
                    ..
                }
            )
        })
        .collect();
    assert_eq!(finished.len(), 2);
    for entry in finished {
        match entry {
            JournalEntry::StepFinished { usage, .. } => {
                assert_eq!(
                    usage.as_ref().and_then(|item| item.token_f64()),
                    Some(100.0)
                );
            }
            _ => panic!("expected step_finished"),
        }
    }
}

#[tokio::test]
async fn resumed_run_keeps_spent_total() {
    let root = temp_root("budget-resume");
    let yaml = budget_yaml("budget-resume", 150);
    let (dir, workflow) = load_min(&root, "wf", Some(&yaml)).await;
    let live = Arc::new(AtomicUsize::new(0));
    let live_h = live.clone();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            move |opts| {
                let live = live_h.clone();
                async move {
                    let n = live.fetch_add(1, Ordering::SeqCst) + 1;
                    (opts.report_usage)(StepUsage::tokens(100.0));
                    Ok(json!({"result": format!("live-{n}")}))
                }
            },
        ))),
        vec![("budget-resume", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        step.agent("pre", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        step.agent("post", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.done(result_output(Value::String("ok".to_string())))
            .await
    });
    let started = engine
        .start_run(
            "budget-resume",
            message_input("x"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    assert_eq!(live.load(Ordering::SeqCst), 1);
    let resumed = engine
        .resume_run(
            &started.run.id,
            resume_opts(script, workflow, Some(bool_map("ok", true))),
        )
        .await
        .unwrap();
    assert_eq!(resumed.run.status, RunStatus::Failed);
    let error = resumed.run.error.unwrap_or_default();
    assert!(
        error.contains("Budget exceeded") && error.contains("maxTokens"),
        "{error}"
    );
    assert_eq!(live.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn max_concurrent_runs_refuses_a_second_start() {
    let root = temp_root("conc");
    let yaml = "id: conc-wf\nversion: \"1.0.0\"\nname: Conc\ninput:\n  - name: message\n    type: string\noutput:\n  - name: result\n    type: string\nbudgets:\n  maxConcurrentRuns: 1\n";
    let (dir, workflow) = load_min(&root, "wf", Some(yaml)).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("conc-wf", dir.as_path())],
    );
    let gate_script = run_script(|step, _ctx| async move {
        step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        step.done(result_output(Value::String("done".to_string())))
            .await
    });
    let first = engine
        .start_run(
            "conc-wf",
            message_input("a"),
            human(),
            start_opts(gate_script.clone(), workflow.clone(), Some("conc-1")),
        )
        .await
        .unwrap();
    assert!(first.suspended);
    let err = engine
        .start_run(
            "conc-wf",
            message_input("b"),
            human(),
            start_opts(gate_script.clone(), workflow.clone(), Some("conc-2")),
        )
        .await
        .unwrap_err();
    assert_eq!(err.name(), "MaxConcurrentRunsError");
    assert!(is_max_concurrent_runs(&err));
    let finished = engine
        .resume_run(
            "conc-1",
            resume_opts(gate_script, workflow.clone(), Some(bool_map("ok", true))),
        )
        .await
        .unwrap();
    assert_eq!(finished.run.status, RunStatus::Done);
    let third = engine
        .start_run(
            "conc-wf",
            message_input("c"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.done(result_output(Value::String("ok".to_string())))
                        .await
                }),
                workflow,
                Some("conc-3"),
            ),
        )
        .await
        .unwrap();
    assert_eq!(third.run.status, RunStatus::Done);
}

#[tokio::test]
async fn absent_budgets_are_unlimited() {
    let root = temp_root("nobudget");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    assert!(workflow.manifest.budgets.is_none());
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            |opts| async move {
                (opts.report_usage)(StepUsage {
                    tokens: Some(1_000_000.0.into()),
                    cost_usd: Some(999.0.into()),
                });
                Ok(json!({"result": "big"}))
            },
        ))),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.agent("a", AgentStepOpts::out(vec!["result".to_string()]))
                        .await?;
                    step.done(result_output(Value::String("ok".to_string())))
                        .await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Done);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_returns_results_in_branch_index_order() {
    let root = temp_root("par");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let pending: Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>> =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let pending_h = pending.clone();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_run(run_handler(move |opts| {
            let pending = pending_h.clone();
            async move {
                let script = opts.script.clone().unwrap_or_default();
                let (sender, receiver) = tokio::sync::oneshot::channel();
                pending.lock().await.insert(script, sender);
                receiver
                    .await
                    .map_err(|_| WorkflowError::message("resolver dropped"))
            }
        }))),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        let results = step
            .parallel(
                "fan",
                vec![
                    branch(|step| async move {
                        let value = step.run("work", RunStepOpts::script("a")).await?;
                        Ok(json!({"i": 0, "r": value}))
                    }),
                    branch(|step| async move {
                        let value = step.run("work", RunStepOpts::script("b")).await?;
                        Ok(json!({"i": 1, "r": value}))
                    }),
                ],
            )
            .await?;
        step.done(result_output(Value::String(results.to_string())))
            .await
    });
    let engine_task = engine.clone();
    let workflow_task = workflow;
    let started = tokio::spawn(async move {
        engine_task
            .start_run(
                "test-wf",
                message_input("x"),
                human(),
                start_opts(script, workflow_task, None),
            )
            .await
    });
    for _ in 0..50 {
        if pending.lock().await.len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(pending.lock().await.len(), 2);
    let mut waiting = pending.lock().await;
    let send_b = waiting.remove("b").unwrap();
    let send_a = waiting.remove("a").unwrap();
    drop(waiting);
    send_b.send(json!({"from": "b1"})).unwrap();
    send_a.send(json!({"from": "b0"})).unwrap();
    let result = started.await.unwrap().unwrap();
    assert_eq!(result.run.status, RunStatus::Done, "{:?}", result.run.error);
    let parsed: Value = serde_json::from_str(
        result
            .run
            .output
            .as_ref()
            .and_then(|value| value.get("result"))
            .and_then(Value::as_str)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        parsed,
        json!([
            {"i": 0, "r": {"from": "b0"}},
            {"i": 1, "r": {"from": "b1"}}
        ])
    );
}

#[tokio::test]
async fn replay_skips_completed_branch_steps() {
    let root = temp_root("par-replay");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let live = Arc::new(AtomicUsize::new(0));
    let live_h = live.clone();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            move |opts| {
                let live = live_h.clone();
                async move {
                    live.fetch_add(1, Ordering::SeqCst);
                    let branch = branch_digit(&opts.label);
                    Ok(json!({"result": format!("live-b{branch}")}))
                }
            },
        ))),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        let results = step
            .parallel(
                "fan",
                vec![
                    branch(|step| async move {
                        let agent = step
                            .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
                            .await?;
                        Ok(agent.get("result").cloned().unwrap_or(Value::Null))
                    }),
                    branch(|step| async move {
                        let agent = step
                            .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
                            .await?;
                        Ok(agent.get("result").cloned().unwrap_or(Value::Null))
                    }),
                ],
            )
            .await?;
        step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        let joined = results
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(",");
        step.done(result_output(Value::String(joined))).await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    assert_eq!(live.load(Ordering::SeqCst), 2);
    let resumed = engine
        .resume_run(
            &started.run.id,
            resume_opts(script, workflow, Some(bool_map("ok", true))),
        )
        .await
        .unwrap();
    assert_eq!(
        resumed.run.status,
        RunStatus::Done,
        "{:?}",
        resumed.run.error
    );
    assert_eq!(live.load(Ordering::SeqCst), 2);
    assert_eq!(
        resumed
            .run
            .output
            .as_ref()
            .and_then(|value| value.get("result")),
        Some(&Value::String("live-b0,live-b1".to_string()))
    );
}

#[tokio::test]
async fn restricts_human_parallel_and_done_inside_branches() {
    let root = temp_root("par-gate");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let human_script = run_script(|step, _ctx| async move {
        step.parallel(
            "fan",
            vec![branch(|step| async move {
                step.human("g", HumanStepOpts::fields(vec!["x".to_string()]))
                    .await?;
                Ok(json!(1))
            })],
        )
        .await?;
        step.done(result_output(Value::String("ok".to_string())))
            .await
    });
    let parallel_script = run_script(|step, _ctx| async move {
        step.parallel(
            "fan",
            vec![branch(|step| async move {
                step.parallel("inner", vec![branch(|_| async { Ok(json!(1)) })])
                    .await?;
                Ok(json!(1))
            })],
        )
        .await?;
        step.done(result_output(Value::String("ok".to_string())))
            .await
    });
    let done_script = run_script(|step, _ctx| async move {
        step.parallel(
            "fan",
            vec![branch(|step| async move {
                step.done(result_output(Value::String("nope".to_string())))
                    .await?;
                Ok(json!(1))
            })],
        )
        .await?;
        step.done(result_output(Value::String("ok".to_string())))
            .await
    });
    let cases = [
        (
            "human",
            human_script,
            "not allowed inside a step.parallel branch",
        ),
        ("parallel", parallel_script, "nested step.parallel"),
        ("done", done_script, "step.done() is not allowed"),
    ];
    for (name, script, needle) in cases {
        let result = engine
            .start_run(
                "test-wf",
                message_input("x"),
                human(),
                start_opts(script, workflow.clone(), Some(&format!("restrict-{name}"))),
            )
            .await
            .unwrap();
        assert_eq!(result.run.status, RunStatus::Failed, "{name}");
        let error = result.run.error.unwrap_or_default();
        assert!(error.contains(needle), "{name}: {error}");
    }
}

#[tokio::test]
async fn creates_branch_subdirs() {
    let root = temp_root("par-dirs");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_h = seen.clone();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_run(run_handler(move |opts| {
            let seen = seen_h.clone();
            async move {
                seen.lock().unwrap().push(opts.case_dir);
                Ok(json!({"ok": true}))
            }
        }))),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.parallel(
                        "fan",
                        vec![
                            branch(
                                |step| async move { step.run("w", RunStepOpts::script("a")).await },
                            ),
                            branch(
                                |step| async move { step.run("w", RunStepOpts::script("b")).await },
                            ),
                        ],
                    )
                    .await?;
                    step.done(result_output(Value::String("ok".to_string())))
                        .await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Done);
    let mut got = seen.lock().unwrap().clone();
    got.sort();
    let mut expect = vec![
        path_text(&node_join(&[result.case_dir.as_str(), "fan#1", "b0"])),
        path_text(&node_join(&[result.case_dir.as_str(), "fan#1", "b1"])),
    ];
    expect.sort();
    assert_eq!(got, expect);
    assert!(tokio::fs::try_exists(&got[0]).await.unwrap());
    assert!(tokio::fs::try_exists(&got[1]).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn journal_lines_stay_intact_under_parallel_writes() {
    let root = temp_root("par-stress");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_run(run_handler(|_opts| async {
            tokio::time::sleep(Duration::from_millis(0)).await;
            Ok(json!({"ok": true}))
        }))),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.parallel(
                        "fan",
                        vec![
                            branch(|step| async move {
                                for index in 0..5 {
                                    step.run(&format!("s{index}"), RunStepOpts::script("x"))
                                        .await?;
                                }
                                Ok(json!(0))
                            }),
                            branch(|step| async move {
                                for index in 0..5 {
                                    step.run(&format!("s{index}"), RunStepOpts::script("x"))
                                        .await?;
                                }
                                Ok(json!(1))
                            }),
                            branch(|step| async move {
                                for index in 0..5 {
                                    step.run(&format!("s{index}"), RunStepOpts::script("x"))
                                        .await?;
                                }
                                Ok(json!(2))
                            }),
                        ],
                    )
                    .await?;
                    step.done(result_output(Value::String("ok".to_string())))
                        .await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Done, "{:?}", result.run.error);
    let raw = tokio::fs::read_to_string(journal_path(Path::new(&result.case_dir)))
        .await
        .unwrap();
    let lines: Vec<_> = raw
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .collect();
    for line in &lines {
        serde_json::from_str::<Value>(line).unwrap();
    }
    assert!(lines.len() > 30, "{}", lines.len());
}

#[tokio::test]
async fn branch_agent_fields_do_not_merge() {
    let root = temp_root("par-nomerge");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            |_opts| async { Ok(json!({"result": "from-branch", "leaked": true})) },
        ))),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    let results = step
                        .parallel(
                            "fan",
                            vec![branch(|step| async move {
                                step.agent("w", AgentStepOpts::out(vec!["result".to_string()]))
                                    .await
                            })],
                        )
                        .await?;
                    let value = results
                        .as_array()
                        .and_then(|items| items.first())
                        .and_then(|item| item.get("result"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    step.done(result_output(value)).await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Done);
    let state = read_case(Path::new(&result.case_dir)).await.unwrap();
    assert_eq!(
        state.fields.get("result"),
        Some(&Value::String("from-branch".to_string()))
    );
    assert!(state.fields.get("leaked").is_none());
}

#[tokio::test]
async fn terminal_runs_ignore_late_writes() {
    let root = temp_root("harden");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.done(result_output(Value::String("ok".to_string())))
                        .await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Done);
    update_run(
        Path::new(&result.case_dir),
        RunPatch {
            status: Some(RunStatus::Running),
            ..RunPatch::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        read_case(Path::new(&result.case_dir))
            .await
            .unwrap()
            .run
            .status,
        RunStatus::Done
    );
}

#[tokio::test]
async fn resume_rejects_missing_gate_fields_then_succeeds() {
    let root = temp_root("gate-fields");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        let gate = step
            .human(
                "gate",
                HumanStepOpts::fields(vec!["approved".to_string()]).with_prompt("ok?"),
            )
            .await?;
        step.done(result_output(
            gate.get("approved").cloned().unwrap_or(Value::Null),
        ))
        .await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    let err = engine
        .resume_run(
            &started.run.id,
            resume_opts(script.clone(), workflow.clone(), Some(Map::new())),
        )
        .await
        .unwrap_err();
    assert_eq!(err.name(), "ContractValidationError");
    let resumed = engine
        .resume_run(
            &started.run.id,
            resume_opts(script, workflow, Some(bool_map("approved", true))),
        )
        .await
        .unwrap();
    assert_eq!(resumed.run.status, RunStatus::Done);
}

#[tokio::test]
async fn step_done_enforces_required_output_fields() {
    let root = temp_root("strict");
    let yaml = "id: strict-wf\nversion: \"1.0.0\"\nname: Strict\ninput:\n  - name: message\n    type: string\noutput:\n  - name: result\n    type: string\n";
    let (dir, workflow) = load_min(&root, "strict", Some(yaml)).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("strict-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "strict-wf",
            message_input("hi"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move { step.done(Map::new()).await }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Failed);
    assert!(
        result
            .run
            .error
            .unwrap_or_default()
            .contains("output field")
    );
}

#[tokio::test]
async fn continue_run_refuses_open_gate_and_does_not_double_append() {
    let root = temp_root("continue");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        let agent = step
            .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        step.done(result_output(
            agent.get("result").cloned().unwrap_or(Value::Null),
        ))
        .await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    let err = engine
        .continue_run(
            &started.run.id,
            resume_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("paused at a human gate"), "{err}");
    update_run(
        Path::new(&started.case_dir),
        RunPatch {
            status: Some(RunStatus::Running),
            ..RunPatch::default()
        },
    )
    .await
    .unwrap();
    let continued = engine
        .continue_run(&started.run.id, resume_opts(script, workflow, None))
        .await
        .unwrap();
    assert!(continued.suspended);
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    let opens = journal
        .iter()
        .filter(|entry| matches!(entry, JournalEntry::GateOpened { label, .. } if label == "gate"))
        .count();
    assert_eq!(opens, 1);
}

#[tokio::test]
async fn unknown_agent_name_fails_loud() {
    let root = temp_root("unknown-agent");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.agent(
                        "work",
                        AgentStepOpts::agent("nope", vec!["result".to_string()]),
                    )
                    .await?;
                    step.done(result_output(Value::String("x".to_string())))
                        .await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.run.status, RunStatus::Failed);
    assert!(
        result
            .run
            .error
            .unwrap_or_default()
            .contains("Unknown agent \"nope\"")
    );
}

#[tokio::test]
async fn frontmatter_crlf_bom_and_unterminated_and_padding() {
    let root = temp_root("fm");
    let (dir, _) = load_min(&root, "wf", None).await;
    tokio::fs::write(
        dir.join("agents").join("example.md"),
        "\u{feff}---\r\nmodel: crlf-model\r\n---\r\n\r\nPrompt body here.\r\n",
    )
    .await
    .unwrap();
    let loaded = load_workflow_dir(&dir).await.unwrap();
    assert_eq!(
        loaded
            .agents
            .get("example")
            .unwrap()
            .config
            .model
            .as_deref(),
        Some("crlf-model")
    );
    assert!(
        loaded
            .agents
            .get("example")
            .unwrap()
            .prompt
            .contains("Prompt body here.")
    );
    let (broken, _) = load_min(&root, "broken", None).await;
    tokio::fs::write(
        broken.join("agents").join("example.md"),
        "---\nmodel: broken\n\nNo closing fence, just prose.\n",
    )
    .await
    .unwrap();
    let err = load_workflow_dir(&broken).await.unwrap_err();
    assert!(
        err.to_string().contains("Unterminated frontmatter"),
        "{err}"
    );
    let (padded, _) = load_min(&root, "padded", None).await;
    tokio::fs::write(
        padded.join("agents").join("example.md"),
        "\n\n---\nmodel: padded-model\n---\n\nPadded prompt body.\n",
    )
    .await
    .unwrap();
    let loaded = load_workflow_dir(&padded).await.unwrap();
    assert_eq!(
        loaded
            .agents
            .get("example")
            .unwrap()
            .config
            .model
            .as_deref(),
        Some("padded-model")
    );
    assert!(
        loaded
            .agents
            .get("example")
            .unwrap()
            .prompt
            .contains("Padded prompt body.")
    );
}

fn gate_script() -> RunScript {
    run_script(|step, _ctx| async move {
        let agent = step
            .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        let gate = step
            .human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        let mut output = result_output(agent.get("result").cloned().unwrap_or(Value::Null));
        output.insert(
            "ok".to_string(),
            gate.get("ok").cloned().unwrap_or(Value::Null),
        );
        step.done(output).await
    })
}

async fn append_crashed_resolution(case_dir: &str) {
    let mut values = Map::new();
    values.insert("ok".to_string(), Value::Bool(true));
    append_journal(
        Path::new(case_dir),
        &JournalEntry::GateResolved {
            ts: "crash".to_string(),
            step_id: "gate#1".to_string(),
            label: "gate".to_string(),
            seq: 1,
            values,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn resume_recovers_crash_between_gate_resolved_and_status_flip() {
    let root = temp_root("resid");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let script = gate_script();
    let started = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    append_crashed_resolution(&started.case_dir).await;
    let resumed = engine
        .resume_run(&started.run.id, resume_opts(script, workflow, None))
        .await
        .unwrap();
    assert!(!resumed.suspended);
    assert_eq!(resumed.run.status, RunStatus::Done);
    assert_eq!(
        resumed
            .run
            .output
            .as_ref()
            .and_then(|value| value.get("ok")),
        Some(&Value::Bool(true))
    );
}

#[tokio::test]
async fn continue_recovers_the_same_crash_shape() {
    let root = temp_root("resid-continue");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let script = gate_script();
    let started = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    append_crashed_resolution(&started.case_dir).await;
    let continued = engine
        .continue_run(&started.run.id, resume_opts(script, workflow, None))
        .await
        .unwrap();
    assert!(!continued.suspended);
    assert_eq!(continued.run.status, RunStatus::Done);
}

#[tokio::test]
async fn kill_during_gate_reports_terminal_outcome() {
    let root = temp_root("kill-gate");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_run(run_handler(
            |opts| async move {
                update_run(
                    Path::new(&opts.case_dir),
                    RunPatch {
                        status: Some(RunStatus::Killed),
                        ..RunPatch::default()
                    },
                )
                .await?;
                Ok(json!({"ok": true}))
            },
        ))),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(
                run_script(|step, _ctx| async move {
                    step.run("pre", RunStepOpts::script("noop")).await?;
                    step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
                        .await?;
                    step.done(result_output(Value::String("x".to_string())))
                        .await
                }),
                workflow,
                None,
            ),
        )
        .await
        .unwrap();
    assert!(!result.suspended);
    assert_eq!(result.run.status, RunStatus::Killed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_resumes_let_exactly_one_win() {
    let root = temp_root("race");
    let (dir, workflow) = load_min(&root, "wf", None).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        let gate = step
            .human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        step.done(result_output(
            gate.get("ok").cloned().unwrap_or(Value::Null),
        ))
        .await
    });
    let started = engine
        .start_run(
            "test-wf",
            message_input("hi"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended);
    let left_engine = engine.clone();
    let right_engine = engine.clone();
    let left_script = script.clone();
    let right_script = script;
    let left_workflow = workflow.clone();
    let right_workflow = workflow;
    let left_id = started.run.id.clone();
    let right_id = started.run.id.clone();
    let left = tokio::spawn(async move {
        left_engine
            .resume_run(
                &left_id,
                resume_opts(left_script, left_workflow, Some(bool_map("ok", true))),
            )
            .await
    });
    let right = tokio::spawn(async move {
        right_engine
            .resume_run(
                &right_id,
                resume_opts(right_script, right_workflow, Some(bool_map("ok", true))),
            )
            .await
    });
    let (left, right) = tokio::join!(left, right);
    let outcomes = [left.unwrap(), right.unwrap()];
    let fulfilled = outcomes.iter().filter(|item| item.is_ok()).count();
    let rejected = outcomes.iter().filter(|item| item.is_err()).count();
    assert_eq!(fulfilled, 1);
    assert_eq!(rejected, 1);
    let journal = read_journal(Path::new(&started.case_dir)).await.unwrap();
    assert_eq!(
        journal
            .iter()
            .filter(|entry| entry.entry_type() == "gate_resolved")
            .count(),
        1
    );
    assert_eq!(
        journal
            .iter()
            .filter(|entry| matches!(
                entry,
                JournalEntry::RunFinished {
                    status: RunFinishedStatus::Done,
                    ..
                }
            ))
            .count(),
        1
    );
}

#[tokio::test]
async fn broken_run_script_marks_the_run_failed() {
    let root = temp_root("broken-script");
    let (dir, _) = load_min(&root, "wf", None).await;
    tokio::fs::write(dir.join("run.ts"), "this is not valid javascript {{{\n")
        .await
        .unwrap();
    let workflow = load_workflow_dir(&dir).await.unwrap();
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::new()),
        vec![("test-wf", dir.as_path())],
    );
    let result = engine
        .start_run(
            "test-wf",
            message_input("x"),
            human(),
            StartRunOptions {
                workflow: Some(workflow),
                ..StartRunOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result.run.status,
        RunStatus::Failed,
        "{:?}",
        result.run.error
    );
    assert!(!result.suspended);
}

#[tokio::test]
async fn parallel_budget_is_reseeded_on_resume() {
    let root = temp_root("budget-par");
    let yaml = "id: budget-par\nversion: \"1.0.0\"\nname: BudgetPar\ninput:\n  - name: message\n    type: string\noutput:\n  - name: result\n    type: string\n    required: false\nbudgets:\n  maxTokens: 250\n";
    let (dir, workflow) = load_min(&root, "wf", Some(yaml)).await;
    let engine = engine_for(
        &root.join("runs"),
        arc_exec(MockExecutorRegistry::with_agent(agent_handler(
            |opts| async move {
                (opts.report_usage)(StepUsage::tokens(100.0));
                Ok(json!({"result": "x"}))
            },
        ))),
        vec![("budget-par", dir.as_path())],
    );
    let script = run_script(|step, _ctx| async move {
        step.parallel(
            "fan",
            vec![
                branch(|step| async move {
                    let agent = step
                        .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
                        .await?;
                    Ok(agent.get("result").cloned().unwrap_or(Value::Null))
                }),
                branch(|step| async move {
                    let agent = step
                        .agent("work", AgentStepOpts::out(vec!["result".to_string()]))
                        .await?;
                    Ok(agent.get("result").cloned().unwrap_or(Value::Null))
                }),
            ],
        )
        .await?;
        step.human("gate", HumanStepOpts::fields(vec!["ok".to_string()]))
            .await?;
        step.agent("after", AgentStepOpts::out(vec!["result".to_string()]))
            .await?;
        step.done(result_output(Value::String("done".to_string())))
            .await
    });
    let started = engine
        .start_run(
            "budget-par",
            message_input("x"),
            human(),
            start_opts(script.clone(), workflow.clone(), None),
        )
        .await
        .unwrap();
    assert!(started.suspended, "{:?}", started.run.error);
    let resumed = engine
        .resume_run(
            &started.run.id,
            resume_opts(script, workflow, Some(bool_map("ok", true))),
        )
        .await
        .unwrap();
    assert_eq!(
        resumed.run.status,
        RunStatus::Failed,
        "{:?}",
        resumed.run.error
    );
    let error = resumed.run.error.unwrap_or_default();
    assert!(error.contains("maxTokens"), "{error}");
    assert!(error.contains("300"), "{error}");
}
