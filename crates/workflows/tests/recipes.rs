use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};
use workflows::{
    AgentStepOpts, EngineConfig, ExecutorRegistry, HumanStepOpts, MockCall, MockExecutorRegistry,
    ResumeRunOptions, RunStatus, RunStepOpts, StartRunOptions, StartedBy, StartedByType,
    WorkflowEngine, agent_handler, load_workflow_dir, run_handler, run_script,
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
