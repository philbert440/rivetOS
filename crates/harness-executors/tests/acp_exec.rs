#[path = "support.rs"]
mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use std::time::Duration;

use acp::{
    AllowOncePolicy, FakeScript, FakeUsage, PermissionChoice, PermissionDecision, PermissionPolicy,
};
use harness_executors::*;
use protocol::TaskVerdict;
use support::{Tmp, map_env, script_runner, write_exe};

struct RecordPolicy {
    kinds: Mutex<Vec<String>>,
    chosen: Mutex<Option<String>>,
}

impl PermissionPolicy for RecordPolicy {
    fn decide(&self, options: &[PermissionChoice]) -> PermissionDecision {
        *self.kinds.lock() = options.iter().map(|option| option.kind.clone()).collect();
        let decision = AllowOncePolicy.decide(options);
        if let PermissionDecision::Selected(id) = &decision {
            *self.chosen.lock() = Some(id.clone());
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
    assert_eq!(result.usage.input_tokens, 0.0);
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
        policy.kinds.lock().as_slice(),
        ["reject_once", "allow_once"]
    );
    assert_eq!(policy.chosen.lock().as_deref(), Some("yes"));
}

#[tokio::test(flavor = "current_thread")]
async fn permission_allow_always_beats_a_leading_reject() {
    let policy = Arc::new(RecordPolicy {
        kinds: Mutex::new(Vec::new()),
        chosen: Mutex::new(None),
    });
    let mut executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            request_permission: true,
            permission_allow_always: true,
            ..FakeScript::default()
        },
    );
    executor.policy = policy.clone();
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(
        policy.kinds.lock().as_slice(),
        ["reject_once", "allow_always"]
    );
    assert_eq!(policy.chosen.lock().as_deref(), Some("keep"));
}

#[tokio::test(flavor = "current_thread")]
async fn permission_reject_only_cancels() {
    let policy = Arc::new(RecordPolicy {
        kinds: Mutex::new(Vec::new()),
        chosen: Mutex::new(None),
    });
    let mut executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            request_permission: true,
            permission_reject_only: true,
            ..FakeScript::default()
        },
    );
    executor.policy = policy.clone();
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(policy.kinds.lock().as_slice(), ["reject_once"]);
    assert!(policy.chosen.lock().is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn tool_end_waits_for_a_terminal_status() {
    let executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            tool_id: Some("t1".into()),
            tool_name: Some("bash".into()),
            tool_statuses: vec!["pending".into(), "in_progress".into(), "completed".into()],
            message: "done".into(),
            ..FakeScript::default()
        },
    );
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    let tools: Vec<String> = events
        .iter()
        .filter_map(|event| {
            event.den_body().map(|body| match body {
                DenBody::ToolStart { tool } => {
                    format!("start:{}", tool.clone().unwrap_or_default())
                }
                DenBody::ToolEnd { tool } => format!("end:{}", tool.clone().unwrap_or_default()),
                _ => String::new(),
            })
        })
        .filter(|text| !text.is_empty())
        .collect();
    assert_eq!(
        tools,
        vec!["start:bash".to_string(), "end:bash".to_string()]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn usage_deltas_sum_across_turns_and_skip_occupancy() {
    let executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            usage_by_prompt: vec![
                FakeUsage {
                    used: 10,
                    size: 100,
                    amount: Some(1.0),
                    currency: Some("USD".into()),
                },
                FakeUsage {
                    used: 40,
                    size: 100,
                    amount: Some(1.5),
                    currency: Some("USD".into()),
                },
            ],
            ..FakeScript::default()
        },
    );
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    handle.push_steer_for_test("again");
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.turns, 2);
    assert_eq!(result.usage.input_tokens, 0.0);
    assert_eq!(result.usage.output_tokens, 0.0);
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(1.5)));
}

#[tokio::test(flavor = "current_thread")]
async fn load_replay_sets_the_usd_baseline_without_charging_it() {
    let mut executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            session_id: "sess-9".into(),
            load_usage: Some(FakeUsage {
                used: 80,
                size: 100,
                amount: Some(1.0),
                currency: Some("USD".into()),
            }),
            usage_used: Some(90),
            usage_size: Some(100),
            usage_cost: Some(1.5),
            usage_currency: Some("USD".into()),
            ..FakeScript::default()
        },
    );
    executor.resume_session_id = Some("sess-9".into());
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.input_tokens, 0.0);
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(0.5)));
}

#[tokio::test(flavor = "current_thread")]
async fn non_usd_cost_is_omitted() {
    let executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            usage_used: Some(12),
            usage_size: Some(40),
            usage_cost: Some(3.0),
            usage_currency: Some("EUR".into()),
            ..FakeScript::default()
        },
    );
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.input_tokens, 0.0);
    assert_eq!(result.usage.cost_usd, None);
}

#[tokio::test(flavor = "current_thread")]
async fn grok_authenticates_with_an_api_key_when_advertised() {
    let seen = Arc::new(Mutex::new(None));
    let mut executor = AcpHarnessExecutor::fake(
        "grok-build",
        FakeScript {
            auth_methods: vec!["xai.api_key".into(), "cached_token".into()],
            seen_auth: Arc::clone(&seen),
            ..FakeScript::default()
        },
    );
    executor.env = Arc::new(map_env(&[("XAI_API_KEY", "test-key")]));
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(seen.lock().as_deref(), Some("xai.api_key"));
}

#[tokio::test(flavor = "current_thread")]
async fn grok_uses_cached_login_without_an_api_key() {
    let seen = Arc::new(Mutex::new(None));
    let executor = AcpHarnessExecutor::fake(
        "grok-build",
        FakeScript {
            auth_methods: vec!["cached_token".into(), "xai.api_key".into()],
            seen_auth: Arc::clone(&seen),
            ..FakeScript::default()
        },
    );
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(seen.lock().as_deref(), Some("cached_token"));
}

#[tokio::test(flavor = "current_thread")]
async fn grok_skips_auth_when_neither_method_is_advertised() {
    let seen = Arc::new(Mutex::new(None));
    let mut executor = AcpHarnessExecutor::fake(
        "grok-build",
        FakeScript {
            auth_methods: vec!["other".into()],
            seen_auth: Arc::clone(&seen),
            ..FakeScript::default()
        },
    );
    executor.env = Arc::new(map_env(&[("XAI_API_KEY", "test-key")]));
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(seen.lock().is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn relative_cwd_is_absolute_before_session_new() {
    let seen = Arc::new(Mutex::new(None));
    let mut executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            seen_cwd: Arc::clone(&seen),
            ..FakeScript::default()
        },
    );
    executor.cwd = Some("rel-work".into());
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    let recorded = seen.lock().clone().unwrap();
    let path = Path::new(&recorded);
    assert!(path.is_absolute());
    assert!(path.ends_with("rel-work"));

    let seen = Arc::new(Mutex::new(None));
    let mut executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            seen_cwd: Arc::clone(&seen),
            ..FakeScript::default()
        },
    );
    executor.cwd = Some("rel-work".into());
    let mut spec = TaskSpec::conformance("Say hello");
    spec.working_dir = Some("/var/tmp/abs-rr4d".into());
    let result = executor.start(spec, AbortFlag::new()).result().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(seen.lock().as_deref(), Some("/var/tmp/abs-rr4d"));
}

#[tokio::test(flavor = "current_thread")]
async fn prompt_failure_keeps_partial_output_and_usage() {
    let release = Arc::new(AtomicBool::new(false));
    let executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            close_after_output: true,
            release_close: Arc::clone(&release),
            ..FakeScript::default()
        },
    );
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let mut seen = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = handle.events.recv().await.expect("events closed");
            let found = event.den_body().is_some_and(
                |body| matches!(body, DenBody::MessageAgent { text } if text == "partial-text"),
            );
            seen.push(event);
            if found {
                break;
            }
        }
    })
    .await
    .expect("updates were not received");
    release.store(true, Ordering::SeqCst);
    let result = tokio::time::timeout(Duration::from_secs(5), handle.result())
        .await
        .expect("result");
    seen.extend(handle.events.drain().await);
    let events = seen;
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert_eq!(result.output.as_deref(), Some("partial-text"));
    assert!(result.error.unwrap().contains("acp session ended"));
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(2.5)));
    assert!(events.iter().any(|event| {
        event.den_body().is_some_and(
            |body| matches!(body, DenBody::MessageAgent { text } if text == "partial-text"),
        )
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn later_turn_failure_replaces_previous_output() {
    let release = Arc::new(AtomicBool::new(false));
    let executor = AcpHarnessExecutor::fake(
        "cursor",
        FakeScript {
            message: "first-turn".into(),
            close_after_output: true,
            close_on_prompt: Some(1),
            release_close: Arc::clone(&release),
            usage_by_prompt: vec![FakeUsage {
                used: 3,
                size: 10,
                amount: Some(1.0),
                currency: Some("USD".into()),
            }],
            ..FakeScript::default()
        },
    );
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    handle.push_steer_for_test("again");
    let mut seen = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = handle.events.recv().await.expect("events closed");
            let found = event.den_body().is_some_and(
                |body| matches!(body, DenBody::MessageAgent { text } if text == "partial-text"),
            );
            seen.push(event);
            if found {
                break;
            }
        }
    })
    .await
    .expect("updates were not received");
    release.store(true, Ordering::SeqCst);
    let result = tokio::time::timeout(Duration::from_secs(5), handle.result())
        .await
        .expect("result");
    seen.extend(handle.events.drain().await);
    let events = seen;
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert_eq!(result.output.as_deref(), Some("partial-text"));
    assert_eq!(result.usage.turns, 2);
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(2.5)));
    assert!(events.iter().any(|event| {
        event.den_body().is_some_and(
            |body| matches!(body, DenBody::MessageAgent { text } if text == "partial-text"),
        )
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn resume_without_load_usage_does_not_charge_historical_cost() {
    let mut executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            session_id: "sess-9".into(),
            usage_by_prompt: vec![
                FakeUsage {
                    used: 10,
                    size: 100,
                    amount: Some(10.5),
                    currency: Some("USD".into()),
                },
                FakeUsage {
                    used: 12,
                    size: 100,
                    amount: Some(11.0),
                    currency: Some("USD".into()),
                },
            ],
            ..FakeScript::default()
        },
    );
    executor.resume_session_id = Some("sess-9".into());
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    handle.push_steer_for_test("again");
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.turns, 2);
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(0.5)));
}

#[tokio::test(flavor = "current_thread")]
async fn resume_unknown_charges_same_prompt_deltas() {
    let mut executor = AcpHarnessExecutor::fake(
        "hermes",
        FakeScript {
            session_id: "sess-9".into(),
            usage_steps: vec![vec![
                FakeUsage {
                    used: 10,
                    size: 100,
                    amount: Some(10.5),
                    currency: Some("USD".into()),
                },
                FakeUsage {
                    used: 12,
                    size: 100,
                    amount: Some(11.0),
                    currency: Some("USD".into()),
                },
            ]],
            ..FakeScript::default()
        },
    );
    executor.resume_session_id = Some("sess-9".into());
    let result = executor
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.turns, 1);
    assert_eq!(result.usage.cost_usd, Some(protocol::JsNumber::from(0.5)));
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_during_startup_kills_a_silent_child() {
    let tmp = Tmp::new();
    let binary = write_exe(
        &tmp.dir,
        "hang-acp",
        "#!/usr/bin/env bash\ntrap 'exit 0' TERM\ndir=$(dirname \"$0\")\nprintf '%s\\n' \"$$\" > \"$dir/ready.pid\"\nwhile true; do\n  sleep 0.1\ndone\n",
    );
    assert_eq!(binary, tmp.path("hang-acp"));
    let mut executor = AcpHarnessExecutor::command(
        "grok-build",
        script_runner().display().to_string(),
        Vec::new(),
    );
    executor.kill_grace = Duration::from_millis(200);
    executor.env = Arc::new(map_env(&[("RR4D_SCRIPT", binary.to_str().unwrap())]));
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let ready = tmp.path("ready.pid");
    let pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(&ready)
                && let Ok(pid) = text.trim().parse::<u32>()
                && pid > 0
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child did not signal readiness");
    handle.kill("startup").await;
    let result = tokio::time::timeout(Duration::from_secs(5), handle.result())
        .await
        .expect("startup cancel");
    assert_eq!(result.verdict, TaskVerdict::Killed);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !Path::new(&format!("/proc/{pid}")).exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child was not reaped");
}
