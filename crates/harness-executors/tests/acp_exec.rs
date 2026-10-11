use std::sync::{Arc, Mutex};
use std::time::Duration;

use acp::{AllowOncePolicy, FakeScript, PermissionChoice, PermissionDecision, PermissionPolicy};
use harness_executors::*;
use protocol::TaskVerdict;

struct RecordPolicy {
    kinds: Mutex<Vec<String>>,
    chosen: Mutex<Option<String>>,
}

impl PermissionPolicy for RecordPolicy {
    fn decide(&self, options: &[PermissionChoice]) -> PermissionDecision {
        *self.kinds.lock().unwrap() = options.iter().map(|option| option.kind.clone()).collect();
        let decision = AllowOncePolicy.decide(options);
        if let PermissionDecision::Selected(id) = &decision {
            *self.chosen.lock().unwrap() = Some(id.clone());
        }
        decision
    }
}

fn rich() -> FakeScript {
    FakeScript {
        session_id: "sess-9".into(),
        message: "hello from the agent".into(),
        thought: Some("think".into()),
        tool_id: Some("t1".into()),
        tool_name: Some("bash".into()),
        plan: vec!["do it".into()],
        usage_used: Some(40),
        usage_size: Some(200),
        usage_cost: Some(1.25),
        ..FakeScript::default()
    }
}

fn history_of() -> Arc<HistorySource> {
    Arc::new(HistorySource {
        get_task_history: Some(Arc::new(|_task, _limit| {
            Ok(vec![HistoryMessage {
                role: "assistant".into(),
                content: Some("what turn one already did".into()),
            }])
        })),
        get_session_history: None,
    })
}

#[test]
fn constructors_name_the_four_harnesses() {
    assert_eq!(grok_build_executor("grok").name(), "grok-build");
    assert_eq!(hermes_executor("hermes").name(), "hermes");
    assert_eq!(codex_executor("codex-acp").name(), "codex");
    assert_eq!(cursor_executor("agent").name(), "cursor");
    assert!(!grok_build_executor("grok").capabilities().effort_selection);
    assert_eq!(
        grok_build_executor("grok").capabilities().mcp_injection,
        "persistent-config"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn fake_agent_emits_text_usage_and_session() {
    let executor = AcpHarnessExecutor::fake("grok-build", rich());
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.summary, "hello from the agent");
    assert_eq!(result.usage.input_tokens, 40.0);
    assert_eq!(result.usage.output_tokens, 0.0);
    assert_eq!(result.usage.turns, 1);
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(1.25)));
    let texts: Vec<String> = events
        .iter()
        .filter_map(|event| {
            event.den_body().map(|body| match body {
                DenBody::MessageAgent { text } => text.clone(),
                DenBody::ThinkingDelta { text } => format!("think:{text}"),
                DenBody::ToolStart { tool } => {
                    format!("start:{}", tool.clone().unwrap_or_default())
                }
                DenBody::ToolEnd { tool } => format!("end:{}", tool.clone().unwrap_or_default()),
            })
        })
        .collect();
    assert!(texts.iter().any(|text| text == "hello from the agent"));
    assert!(texts.iter().any(|text| text == "think:think"));
    assert!(texts.iter().any(|text| text == "start:bash"));
    assert!(events.iter().any(|event| {
        event
            .log_message()
            .is_some_and(|message| message.contains("do it"))
    }));
    assert!(events.iter().any(TaskEvent::is_turn_start));
    assert!(events.iter().any(|event| matches!(event, TaskEvent::TurnEnd { harness_session_id: Some(id), .. } if id == "grok-build:sess-9")));
    assert!(handle.events.drain().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn kill_and_abort_resolve_killed() {
    let executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            wait_for_cancel: true,
            ..FakeScript::default()
        },
    );
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    tokio::time::sleep(Duration::from_millis(40)).await;
    handle.kill("conformance kill").await;
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Killed);
    let _ = handle.events.drain().await;

    let executor = AcpHarnessExecutor::fake(
        "codex",
        FakeScript {
            wait_for_cancel: true,
            ..FakeScript::default()
        },
    );
    let abort = AbortFlag::new();
    let handle = executor.start(TaskSpec::conformance("Say hello"), abort.clone());
    tokio::time::sleep(Duration::from_millis(40)).await;
    abort.abort("runner abort");
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Killed);
}

#[tokio::test(flavor = "current_thread")]
async fn exit_mid_turn_fails_without_rejecting() {
    let executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            exit_mid_turn: true,
            message: "partial".into(),
            ..FakeScript::default()
        },
    );
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert!(result.error.unwrap().contains("acp session ended"));
    let _ = handle.events.drain().await;
}

#[tokio::test(flavor = "current_thread")]
async fn missing_binary_fails() {
    let executor = AcpHarnessExecutor::command(
        "grok-build",
        "/nonexistent/rr4d-grok",
        vec!["agent".into(), "stdio".into()],
    );
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert!(result.error.unwrap().contains("Failed to spawn"));
}

#[tokio::test(flavor = "current_thread")]
async fn resume_loads_when_advertised() {
    let mut executor = AcpHarnessExecutor::fake(
        "grok-build",
        FakeScript {
            session_id: "sess-9".into(),
            ..rich()
        },
    );
    executor.resume_session_id = Some("sess-9".into());
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(events.iter().any(|event| matches!(event, TaskEvent::TurnEnd { harness_session_id: Some(id), .. } if id == "grok-build:sess-9")));
    assert!(events.iter().all(|event| {
        event
            .log_message()
            .is_none_or(|message| !message.contains("fresh session"))
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn resume_rejected_without_load_session_retries_fresh() {
    let mut executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            load_session: false,
            session_id: "sess-9".into(),
            ..FakeScript::default()
        },
    );
    executor.resume_session_id = Some("sess-9".into());
    executor.history = Some(history_of());
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.turns, 1);
    assert!(
        events.iter().any(|event| event
            .log_message()
            .is_some_and(|message| message.contains("refused to resume")
                && message.contains("fresh session")))
    );
    assert!(events.iter().any(|event| matches!(event, TaskEvent::TurnEnd { harness_session_id: Some(id), .. } if id == "hermes:sess-9")));
}

#[tokio::test(flavor = "current_thread")]
async fn resume_rejected_when_load_fails() {
    let mut executor = AcpHarnessExecutor::fake(
        "codex",
        FakeScript {
            fail_load: true,
            session_id: "sess-9".into(),
            ..FakeScript::default()
        },
    );
    executor.resume_session_id = Some("sess-9".into());
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(events.iter().any(|event| {
        event
            .log_message()
            .is_some_and(|message| message.contains("fresh session"))
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn permission_allow_once_finishes_the_turn() {
    let policy = Arc::new(RecordPolicy {
        kinds: Mutex::new(Vec::new()),
        chosen: Mutex::new(None),
    });
    let mut executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            request_permission: true,
            permission_allow_second: true,
            ..rich()
        },
    );
    executor.policy = policy.clone();
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.summary, "hello from the agent");
    assert_eq!(
        policy.kinds.lock().unwrap().as_slice(),
        ["reject_once", "allow_once"]
    );
    assert_eq!(policy.chosen.lock().unwrap().as_deref(), Some("yes"));
}
