use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};
use workflows::{
    AgentStepOpts, EngineConfig, ExecutorRegistry, HumanStepOpts, JournalEntry, MockCall,
    MockExecutorRegistry, ResumeRunOptions, RunFinishedStatus, RunStatus, RunStepOpts,
    StartRunOptions, StartedBy, StartedByType, WorkflowEngine, agent_handler, load_workflow_dir,
    read_journal, run_handler, run_script,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("wf-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hello_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workflows/hello-world")
}

async fn kind_count(calls: &Arc<tokio::sync::Mutex<Vec<MockCall>>>, kind: &str) -> usize {
    calls
        .lock()
        .await
        .iter()
        .filter(|call| call.kind == kind)
        .count()
}

#[tokio::test]
async fn loads_hello_world_manifest_and_greeter() {
    let loaded = load_workflow_dir(&hello_dir()).await.unwrap();
    assert_eq!(loaded.manifest.id, "hello-world");
    assert_eq!(loaded.manifest.version, "0.1.0");
    assert_eq!(
        loaded
            .manifest
            .budgets
            .as_ref()
            .and_then(|item| item.max_tokens),
        Some(20_000.0)
    );
    assert_eq!(
        loaded
            .manifest
            .input
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        vec!["name"]
    );
    let greeter = loaded.agents.get("greeter").unwrap();
    assert!(greeter.prompt.len() > 40);
    assert_eq!(greeter.config.max_turns.unwrap().as_f64(), 5.0);
}

#[tokio::test]
async fn hello_world_suspends_at_gate_and_replays() {
    let root = temp_root("hello");
    let workflow = load_workflow_dir(&hello_dir()).await.unwrap();
    let registry = MockExecutorRegistry::with_handlers(
        agent_handler(|_opts| async { Ok(json!({"greeting": "Hello, Ada — welcome aboard!"})) }),
        run_handler(|_opts| async { Ok(json!({"bytes": 6})) }),
    );
    let calls = registry.calls.clone();
    let executors: Arc<dyn ExecutorRegistry> = Arc::new(registry);
    let mut config = EngineConfig::new(executors);
    config.case_dir_root = Some(root);
    config.workflow_dirs = vec![("hello-world".to_string(), hello_dir())];
    let engine = WorkflowEngine::new(config);
    let script = run_script(|step, ctx| async move {
        let name = ctx.input.get("name").cloned().unwrap_or(Value::Null);
        let mut input = Map::new();
        input.insert("name".to_string(), name);
        step.run(
            "prepare",
            RunStepOpts::script("scripts/prepare.sh").with_input(input),
        )
        .await?;
        let greeted = step
            .agent(
                "greet",
                AgentStepOpts::agent("greeter", vec!["greeting".to_string()]),
            )
            .await?;
        step.human(
            "approve-gate",
            HumanStepOpts::fields(vec!["approved".to_string()]),
        )
        .await?;
        let mut output = Map::new();
        output.insert(
            "greeting".to_string(),
            greeted.get("greeting").cloned().unwrap_or(Value::Null),
        );
        step.done(output).await
    });
    let mut input = Map::new();
    input.insert("name".to_string(), Value::String("Ada".to_string()));
    let started = engine
        .start_run(
            "hello-world",
            input,
            StartedBy::with_id(StartedByType::Human, "tester"),
            StartRunOptions {
                run_script: Some(script.clone()),
                workflow: Some(workflow.clone()),
                ..StartRunOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(started.suspended);
    assert_eq!(started.run.status, RunStatus::PausedHuman);
    assert_eq!(started.suspension.as_ref().unwrap().label, "approve-gate");
    assert_eq!(kind_count(&calls, "run").await, 1);
    assert_eq!(kind_count(&calls, "agent").await, 1);
    let mut gate = Map::new();
    gate.insert("approved".to_string(), Value::Bool(true));
    let resumed = engine
        .resume_run(
            &started.run.id,
            ResumeRunOptions {
                gate_response: Some(gate),
                run_script: Some(script),
                workflow: Some(workflow),
            },
        )
        .await
        .unwrap();
    assert!(!resumed.suspended);
    assert_eq!(resumed.run.status, RunStatus::Done);
    let greeting = resumed
        .run
        .output
        .as_ref()
        .and_then(|value| value.get("greeting"))
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(greeting.contains("Ada"), "{greeting}");
    assert_eq!(kind_count(&calls, "run").await, 1);
    assert_eq!(kind_count(&calls, "agent").await, 1);
}

fn bridge_skip_reason(error: &str) -> bool {
    error.contains("node was not found on PATH")
        || error.contains("is not an executable node binary")
        || error.contains("cannot execute TypeScript")
        || error.contains("node --version")
}

fn json_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn journal_outline(entries: &[JournalEntry]) -> Vec<String> {
    entries.iter().map(journal_outline_entry).collect()
}

fn journal_outline_entry(entry: &JournalEntry) -> String {
    match entry {
        JournalEntry::RunStarted {
            workflow_id,
            version,
            input,
            started_by,
            parent,
            ..
        } => {
            let id = started_by.id.as_deref().unwrap_or("");
            let parent = if parent.is_some() { " has_parent" } else { "" };
            format!(
                "run_started {workflow_id} {version} {} {} {id}{parent}",
                json_text(input),
                started_by.started_type
            )
        }
        JournalEntry::StepStarted {
            step_id,
            label,
            seq,
            kind,
            ..
        } => format!("step_started {step_id} {label} {seq} {kind}"),
        JournalEntry::StepFinished {
            step_id,
            label,
            seq,
            kind,
            result,
            ..
        } => format!(
            "step_finished {step_id} {label} {seq} {kind} {}",
            json_text(result)
        ),
        JournalEntry::StepFailed { step_id, error, .. } => format!("step_failed {step_id} {error}"),
        JournalEntry::GateOpened {
            step_id,
            label,
            seq,
            prompt,
            fields,
            ..
        } => {
            let prompt = prompt.as_deref().unwrap_or("").replace('\n', "\\n");
            format!(
                "gate_opened {step_id} {label} {seq} {} {prompt}",
                fields.join(",")
            )
        }
        JournalEntry::GateResolved {
            step_id,
            label,
            seq,
            values,
            ..
        } => format!(
            "gate_resolved {step_id} {label} {seq} {}",
            json_text(values)
        ),
        JournalEntry::RunFinished {
            status,
            output,
            error,
            ..
        } => {
            let output = output
                .as_ref()
                .map(json_text)
                .unwrap_or_else(|| "none".to_string());
            let error = error.as_deref().unwrap_or("");
            format!("run_finished {status} {output} {error}")
        }
        JournalEntry::ManifestWarn {
            step_id, message, ..
        } => {
            format!("manifest_warn {step_id} {message}")
        }
    }
}

#[tokio::test]
async fn hello_world_run_ts_journal_matches_the_typescript_recipe() {
    let greeting = "Hello, Ada — welcome aboard!";
    let root = temp_root("hello-ts");
    let workflow = load_workflow_dir(&hello_dir()).await.unwrap();
    let registry = MockExecutorRegistry::with_handlers(
        agent_handler(|_opts| async { Ok(json!({"greeting": "Hello, Ada — welcome aboard!"})) }),
        run_handler(|_opts| async { Ok(json!({"bytes": 6})) }),
    );
    let calls = registry.calls.clone();
    let executors: Arc<dyn ExecutorRegistry> = Arc::new(registry);
    let mut config = EngineConfig::new(executors);
    config.case_dir_root = Some(root);
    config.workflow_dirs = vec![("hello-world".to_string(), hello_dir())];
    let engine = WorkflowEngine::new(config);
    let mut input = Map::new();
    input.insert("name".to_string(), Value::String("Ada".to_string()));
    let started = engine
        .start_run(
            "hello-world",
            input,
            StartedBy::with_id(StartedByType::Human, "tester"),
            StartRunOptions {
                workflow: Some(workflow.clone()),
                ..StartRunOptions::default()
            },
        )
        .await
        .unwrap();
    if started.run.status == RunStatus::Failed {
        let error = started.run.error.unwrap_or_default();
        if bridge_skip_reason(&error) {
            println!("skipping hello-world run.ts bridge test: {error}");
            return;
        }
        panic!("node bridge failed: {error}");
    }
    assert!(started.suspended, "{:?}", started.run.error);
    assert_eq!(started.run.status, RunStatus::PausedHuman);
    assert_eq!(started.suspension.as_ref().unwrap().label, "approve-gate");
    assert_eq!(kind_count(&calls, "run").await, 1);
    assert_eq!(kind_count(&calls, "agent").await, 1);
    let paused = read_journal(Path::new(&started.case_dir)).await.unwrap();
    let prompt = format!("Greeting ready: {greeting}\\nApprove?");
    let expected_paused = vec![
        format!(
            "run_started hello-world 0.1.0 {} human tester",
            json_text(&json!({"name": "Ada"}))
        ),
        "step_started prepare#1 prepare 1 run".to_string(),
        format!(
            "step_finished prepare#1 prepare 1 run {}",
            json_text(&json!({"bytes": 6}))
        ),
        "step_started greet#1 greet 1 agent".to_string(),
        format!(
            "step_finished greet#1 greet 1 agent {}",
            json_text(&json!({"greeting": greeting}))
        ),
        "step_started approve-gate#1 approve-gate 1 human".to_string(),
        format!("gate_opened approve-gate#1 approve-gate 1 approved {prompt}"),
    ];
    assert_eq!(journal_outline(&paused), expected_paused);
    let mut gate = Map::new();
    gate.insert("approved".to_string(), Value::Bool(true));
    let resumed = engine
        .resume_run(
            &started.run.id,
            ResumeRunOptions {
                gate_response: Some(gate),
                workflow: Some(workflow),
                ..ResumeRunOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(
        !resumed.suspended,
        "{}",
        resumed.run.error.unwrap_or_default()
    );
    assert_eq!(resumed.run.status, RunStatus::Done);
    assert_eq!(
        resumed
            .run
            .output
            .as_ref()
            .and_then(|value| value.get("greeting"))
            .and_then(Value::as_str),
        Some(greeting)
    );
    assert!(greeting.contains("Ada"));
    assert_eq!(kind_count(&calls, "run").await, 1);
    assert_eq!(kind_count(&calls, "agent").await, 1);
    let finished = read_journal(Path::new(&started.case_dir)).await.unwrap();
    let mut expected_done = expected_paused;
    expected_done.push(format!(
        "gate_resolved approve-gate#1 approve-gate 1 {}",
        json_text(&json!({"approved": true}))
    ));
    expected_done.push(format!(
        "step_finished done#1 done 1 done {}",
        json_text(&json!({"greeting": greeting}))
    ));
    expected_done.push(format!(
        "run_finished {} {} ",
        RunFinishedStatus::Done,
        json_text(&json!({"greeting": greeting}))
    ));
    assert_eq!(journal_outline(&finished), expected_done);
}
