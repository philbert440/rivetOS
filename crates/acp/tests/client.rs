use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use std::time::Duration;

use acp::{
    AcpClient, AllowOncePolicy, FakeScript, PermissionChoice, PermissionDecision, PermissionPolicy,
    SessionEvent, spawn_fake,
};

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

fn script() -> FakeScript {
    FakeScript {
        thought: Some("plan".into()),
        tool_id: Some("t1".into()),
        tool_name: Some("bash".into()),
        plan: vec!["step one".into()],
        usage_used: Some(12),
        usage_size: Some(100),
        usage_cost: Some(0.5),
        ..FakeScript::default()
    }
}

#[tokio::test]
async fn prompt_returns_message_usage_and_events() {
    let (transport, task) = spawn_fake(script());
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    let info = client.initialize().await.unwrap();
    assert!(info.load_session);
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    assert_eq!(id, "sess-1");
    let output = client.prompt(id, "hi".into()).await.unwrap();
    assert_eq!(output.stop_reason, "end_turn");
    assert_eq!(output.text, "hello from the agent");
    assert!(
        output
            .events
            .iter()
            .any(|event| matches!(event, SessionEvent::AgentThought { text } if text == "plan"))
    );
    assert!(output.events.iter().any(|event| matches!(event, SessionEvent::AgentMessage { text } if text == "hello from the agent")));
    assert!(output.events.iter().any(
        |event| matches!(event, SessionEvent::ToolCall { name: Some(name), .. } if name == "bash")
    ));
    assert!(output.events.iter().any(|event| matches!(event, SessionEvent::Plan { entries } if entries == &["step one".to_string()])));
    assert!(output.events.iter().any(|event| matches!(event, SessionEvent::Usage { used: 12, size: 100, cost_amount: Some(cost), .. } if *cost == 0.5)));
    client.shutdown().await.unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn cancel_stops_a_waiting_prompt() {
    let (transport, task) = spawn_fake(FakeScript {
        wait_for_cancel: true,
        ..FakeScript::default()
    });
    let client = Arc::new(
        AcpClient::connect(transport, Arc::new(AllowOncePolicy))
            .await
            .unwrap(),
    );
    client.initialize().await.unwrap();
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    let prompting = {
        let client = Arc::clone(&client);
        let id = id.clone();
        tokio::spawn(async move { client.prompt(id, "hi".into()).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    client.cancel_session(&id).await.unwrap();
    let output = prompting.await.unwrap().unwrap();
    assert_eq!(output.stop_reason, "cancelled");
    drop(client);
    let _ = task.await;
}

#[tokio::test]
async fn permission_prefers_allow_once() {
    let policy = Arc::new(RecordPolicy {
        kinds: Mutex::new(Vec::new()),
        chosen: Mutex::new(None),
    });
    let (transport, task) = spawn_fake(FakeScript {
        request_permission: true,
        permission_allow_second: true,
        ..script()
    });
    let client = AcpClient::connect(transport, policy.clone()).await.unwrap();
    client.initialize().await.unwrap();
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    let output = client.prompt(id, "hi".into()).await.unwrap();
    assert_eq!(output.stop_reason, "end_turn");
    assert_eq!(output.text, "hello from the agent");
    assert_eq!(
        policy.kinds.lock().as_slice(),
        ["reject_once", "allow_once"]
    );
    assert_eq!(policy.chosen.lock().as_deref(), Some("yes"));
    client.shutdown().await.unwrap();
    let _ = task.await;
}

#[tokio::test]
async fn load_session_respects_advertise_and_failure() {
    let (transport, task) = spawn_fake(FakeScript {
        session_id: "sess-9".into(),
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    assert!(client.initialize().await.unwrap().load_session);
    let created = client.new_session(PathBuf::from("/work")).await.unwrap();
    assert_eq!(created, "sess-9");
    client
        .load_session("sess-9".into(), PathBuf::from("/work"))
        .await
        .unwrap();
    assert!(
        client
            .load_session("other".into(), PathBuf::from("/work"))
            .await
            .is_err()
    );
    client.shutdown().await.unwrap();
    let _ = task.await;

    let (transport, task) = spawn_fake(FakeScript {
        load_session: false,
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    assert!(!client.initialize().await.unwrap().load_session);
    client.shutdown().await.unwrap();
    let _ = task.await;

    let (transport, task) = spawn_fake(FakeScript {
        fail_load: true,
        session_id: "sess-9".into(),
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    client.initialize().await.unwrap();
    assert!(
        client
            .load_session("sess-9".into(), PathBuf::from("/work"))
            .await
            .is_err()
    );
    client.shutdown().await.unwrap();
    let _ = task.await;
}

#[tokio::test]
async fn prompt_error_keeps_text_and_usage_received_before_the_failure() {
    let (transport, task) = spawn_fake(FakeScript {
        fail_after_output: true,
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    client.initialize().await.unwrap();
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    let error = client.prompt(id, "hi".into()).await.unwrap_err();
    assert!(!error.to_string().is_empty());
    assert_eq!(error.text, "partial-text");
    assert!(error.events.iter().any(|event| {
        matches!(event, SessionEvent::AgentMessage { text } if text == "partial-text")
    }));
    assert!(error.events.iter().any(|event| {
        matches!(
            event,
            SessionEvent::Usage {
                cost_amount: Some(cost),
                ..
            } if *cost == 2.5
        )
    }));
    drop(client);
    let _ = task.await;
}

#[tokio::test]
async fn exit_mid_turn_is_an_error() {
    let (transport, task) = spawn_fake(FakeScript {
        exit_mid_turn: true,
        message: "partial".into(),
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    client.initialize().await.unwrap();
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    let error = client.prompt(id, "hi".into()).await.unwrap_err();
    assert!(!error.to_string().is_empty());
    drop(client);
    let _ = task.await;
}

#[tokio::test]
async fn prompt_keeps_every_update_past_the_channel_cap() {
    let (transport, task) = spawn_fake(FakeScript {
        chunk_count: Some(1025),
        usage_used: Some(3),
        usage_size: Some(9),
        usage_cost: Some(0.25),
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    client.initialize().await.unwrap();
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), client.prompt(id, "hi".into()))
        .await
        .expect("prompt flood")
        .unwrap();
    assert_eq!(output.text.len(), 1025);
    assert!(output.text.chars().all(|ch| ch == 'x'));
    assert!(output.events.iter().any(|event| matches!(
        event,
        SessionEvent::Usage {
            cost_amount: Some(cost),
            ..
        } if *cost == 0.25
    )));
    client.shutdown().await.unwrap();
    let _ = task.await;
}

#[tokio::test]
async fn load_keeps_every_replayed_update_past_the_channel_cap() {
    let (transport, task) = spawn_fake(FakeScript {
        load_chunks: Some(1025),
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, Arc::new(AllowOncePolicy))
        .await
        .unwrap();
    client.initialize().await.unwrap();
    let loaded = tokio::time::timeout(
        Duration::from_secs(10),
        client.load_session("sess-1".into(), PathBuf::from("/work")),
    )
    .await
    .expect("load flood")
    .unwrap();
    let texts: Vec<&str> = loaded
        .events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::AgentMessage { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts.len(), 1025);
    assert!(texts.iter().all(|text| *text == "y"));
    client.shutdown().await.unwrap();
    let _ = task.await;
}

#[tokio::test]
async fn permission_allow_always_is_chosen_after_reject() {
    let policy = Arc::new(RecordPolicy {
        kinds: Mutex::new(Vec::new()),
        chosen: Mutex::new(None),
    });
    let (transport, task) = spawn_fake(FakeScript {
        request_permission: true,
        permission_allow_always: true,
        ..FakeScript::default()
    });
    let client = AcpClient::connect(transport, policy.clone()).await.unwrap();
    client.initialize().await.unwrap();
    let id = client.new_session(PathBuf::from("/work")).await.unwrap();
    let output = client.prompt(id, "hi".into()).await.unwrap();
    assert_eq!(output.stop_reason, "end_turn");
    assert_eq!(
        policy.kinds.lock().as_slice(),
        ["reject_once", "allow_always"]
    );
    assert_eq!(policy.chosen.lock().as_deref(), Some("keep"));
    client.shutdown().await.unwrap();
    let _ = task.await;
}

#[test]
fn permission_without_an_allow_option_cancels() {
    let decision = AllowOncePolicy.decide(&[PermissionChoice {
        option_id: "no".into(),
        name: "Reject".into(),
        kind: "reject_once".into(),
    }]);
    assert_eq!(decision, PermissionDecision::Cancelled);
    let decision = AllowOncePolicy.decide(&[
        PermissionChoice {
            option_id: "keep".into(),
            name: "Allow always".into(),
            kind: "allow_always".into(),
        },
        PermissionChoice {
            option_id: "once".into(),
            name: "Allow".into(),
            kind: "allow_once".into(),
        },
    ]);
    assert_eq!(decision, PermissionDecision::Selected("once".into()));
}
