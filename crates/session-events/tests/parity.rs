use serde_json::{Value, json};
use session_events::{
    ACTIVITIES, Activity, AgentEvent, AgentEventBody, DenState, EventType, JsNumber, LogEntry,
    LogWho, PROTOCOL_VERSION, RoomState, SessionInfo, Task, TokenUsage, initial_den_state,
    initial_room_state, list_sessions, parse_event, parse_event_str, reduce_den, reduce_room,
    snapshot_frame, tool_activity,
};

fn stamped(
    session: &str,
    body: AgentEventBody,
    ts: i64,
    name: Option<&str>,
    harness: Option<&str>,
) -> AgentEvent {
    let mut event = AgentEvent::new(session, body);
    event.ts = Some(JsNumber::from(ts));
    event.name = name.map(str::to_string);
    event.harness = harness.map(str::to_string);
    event
}

fn run(events: Vec<AgentEvent>) -> DenState {
    events
        .into_iter()
        .fold(initial_den_state(), |state, event| {
            reduce_den(state, &event)
        })
}

fn read_fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap()
}

fn assert_fixture(actual: &str, name: &str) {
    assert_eq!(read_fixture(name), format!("{actual}\n"), "{name}");
}

fn coding_session() -> Vec<AgentEvent> {
    vec![
        stamped(
            "s1",
            AgentEventBody::SessionStart {
                title: "fix the flaky test".to_string(),
            },
            1,
            Some("rivet-claude"),
            Some("claude-code"),
        ),
        stamped(
            "s1",
            AgentEventBody::MessageUser {
                text: "fix the flaky test in ci".to_string(),
            },
            2,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ThinkingDelta {
                text: "Looking at the CI logs first… ".to_string(),
            },
            3,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TaskPlan {
                tasks: vec![
                    "find flaky test".to_string(),
                    "fix it".to_string(),
                    "verify".to_string(),
                ],
            },
            4,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolStart {
                tool: "Grep".to_string(),
                activity: None,
                args: None,
            },
            5,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolEnd {
                tool: Some("Grep".to_string()),
            },
            6,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TaskCheck {
                index: JsNumber::from(0_i64),
            },
            7,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolStart {
                tool: "Edit".to_string(),
                activity: None,
                args: None,
            },
            8,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolEnd {
                tool: Some("Edit".to_string()),
            },
            9,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TaskCheck {
                index: JsNumber::from(1_i64),
            },
            10,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
            11,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TermLine {
                text: "$ npm test".to_string(),
            },
            12,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TermLine {
                text: "42 passing".to_string(),
            },
            13,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolEnd {
                tool: Some("Bash".to_string()),
            },
            14,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TaskCheck {
                index: JsNumber::from(2_i64),
            },
            15,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::MessageAgent {
                text: "Fixed — all 42 tests pass.".to_string(),
                usage: None,
                model: None,
                duration_ms: None,
            },
            16,
            None,
            None,
        ),
    ]
}

#[test]
fn protocol_version_and_activities() {
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(
        ACTIVITIES.map(|activity| activity.as_str()),
        [
            "idle",
            "thinking",
            "searching_web",
            "editing_code",
            "running_command",
            "writing_plan",
            "listening",
            "speaking",
            "sleeping",
        ]
    );
    assert_eq!(EventType::ALL.len(), 14);
    let room = initial_room_state();
    assert_eq!(room.activity, Activity::Idle);
    assert!(room.tool.is_none());
    assert!(!room.ended);
    assert!(room.log.is_empty());
    assert!(initial_den_state().rooms.is_empty());
    assert!(list_sessions(&initial_den_state()).is_empty());
    assert_eq!(
        serde_json::to_string(&room).unwrap(),
        r#"{"title":"","activity":"idle","tool":null,"tasks":[],"thought":"","lastMessage":"","log":[],"term":[],"ended":false}"#
    );
}

#[test]
fn parse_event_accepts_valid_v1_events() {
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "session.start", "title": "hi"}))
            .is_some()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "tool.start", "tool": "Bash"}))
            .is_some()
    );
    assert!(parse_event(&json!({"v": 1, "session": "s1", "type": "tool.end"})).is_some());
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "speech.stt", "active": true}))
            .is_some()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "task.plan", "tasks": ["a", "b"]}))
            .is_some()
    );
    assert!(parse_event(&json!({"v": 1, "session": "s1", "type": "turn.end"})).is_some());
}

#[test]
fn parse_event_rejects_malformed_events() {
    assert!(parse_event(&Value::Null).is_none());
    assert!(parse_event(&json!("x")).is_none());
    assert!(parse_event(&json!({"session": "s1", "type": "session.end"})).is_none());
    assert!(parse_event(&json!({"v": 2, "session": "s1", "type": "session.end"})).is_none());
    assert!(parse_event(&json!({"v": 1, "type": "session.end"})).is_none());
    assert!(parse_event(&json!({"v": 1, "session": "", "type": "session.end"})).is_none());
    assert!(parse_event(&json!({"v": 1, "session": "s1", "type": "nope"})).is_none());
    assert!(parse_event(&json!({"v": 1, "session": "s1", "type": "tool.start"})).is_none());
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "activity", "activity": "dancing"}))
            .is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "task.check", "index": -1})).is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "task.check", "index": 1.5}))
            .is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "task.plan", "tasks": ["a", 3]}))
            .is_none()
    );
}

#[test]
fn parse_event_rejects_wrong_typed_envelope_optionals() {
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "session.end", "ts": "abc"}))
            .is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "session.end", "name": 42})).is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "session.end", "harness": {}}))
            .is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "session.end", "harnessSession": 7}))
            .is_none()
    );
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "session.end", "ts": 5, "name": "n"}))
            .is_some()
    );
}

#[test]
fn parse_event_keeps_harness_session() {
    let event = parse_event(&json!({
        "v": 1,
        "session": "den-pty-1a2b",
        "type": "message.agent",
        "text": "done",
        "harness": "hermes",
        "harnessSession": "20260802_225647_6ad0b9"
    }))
    .unwrap();
    assert_eq!(
        event.harness_session.as_deref(),
        Some("20260802_225647_6ad0b9")
    );
    assert_eq!(event.harness.as_deref(), Some("hermes"));
}

#[test]
fn parse_event_keeps_message_agent_turn_stats() {
    let event = parse_event(&json!({
        "v": 1,
        "session": "s1",
        "type": "message.agent",
        "text": "done",
        "usage": {"promptTokens": 100, "completionTokens": 20, "cachedTokens": 80},
        "model": "claude-opus-4-8",
        "durationMs": 1500
    }))
    .unwrap();
    match event.body {
        AgentEventBody::MessageAgent {
            usage,
            model,
            duration_ms,
            ..
        } => {
            assert_eq!(
                usage,
                Some(TokenUsage {
                    prompt_tokens: JsNumber::from(100_i64),
                    completion_tokens: JsNumber::from(20_i64),
                    cached_tokens: JsNumber::from(80_i64),
                })
            );
            assert_eq!(model.as_deref(), Some("claude-opus-4-8"));
            assert_eq!(duration_ms, Some(JsNumber::from(1500_i64)));
        }
        _ => panic!("message.agent"),
    }
    assert!(
        parse_event(&json!({"v": 1, "session": "s1", "type": "message.agent", "text": "hi"}))
            .is_some()
    );
}

#[test]
fn parse_event_rejects_malformed_message_agent_turn_stats() {
    let base = json!({"v": 1, "session": "s1", "type": "message.agent", "text": "x"});
    let mut model = base.clone();
    model["model"] = json!(42);
    assert!(parse_event(&model).is_none());
    let mut duration = base.clone();
    duration["durationMs"] = json!("slow");
    assert!(parse_event(&duration).is_none());
    let mut negative = base.clone();
    negative["durationMs"] = json!(-5);
    assert!(parse_event(&negative).is_none());
    let mut missing = base.clone();
    missing["usage"] = json!({"promptTokens": 1, "completionTokens": 2});
    assert!(parse_event(&missing).is_none());
    let mut signed = base.clone();
    signed["usage"] = json!({"promptTokens": -1, "completionTokens": 2, "cachedTokens": 0});
    assert!(parse_event(&signed).is_none());
    let mut text = base;
    text["usage"] = json!("lots");
    assert!(parse_event(&text).is_none());
}

#[test]
fn parse_event_preserves_unknown_fields_and_unvalidated_args() {
    let raw = json!({"note": "x", "v": 1, "session": "s1", "type": "session.end", "b": 1, "a": 2});
    let event = parse_event(&raw).unwrap();
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","b":1,"a":2}"#
    );
    let started = parse_event(
        &json!({"v": 1, "session": "s1", "type": "tool.start", "tool": "Bash", "args": "nope"}),
    )
    .unwrap();
    match started.body {
        AgentEventBody::ToolStart { args, .. } => {
            assert_eq!(args, Some(Value::String("nope".to_string())));
        }
        _ => panic!("tool.start"),
    }
}

#[test]
fn tool_activity_maps_known_tools() {
    assert_eq!(tool_activity("WebSearch"), Activity::SearchingWeb);
    assert_eq!(
        tool_activity("mcp:rivetos:internet_search"),
        Activity::SearchingWeb
    );
    assert_eq!(tool_activity("WebFetch"), Activity::SearchingWeb);
    assert_eq!(tool_activity("web_search"), Activity::SearchingWeb);
    assert_eq!(tool_activity("Edit"), Activity::EditingCode);
    assert_eq!(tool_activity("Write"), Activity::EditingCode);
    assert_eq!(tool_activity("NotebookEdit"), Activity::EditingCode);
    assert_eq!(tool_activity("ApplyPatch"), Activity::EditingCode);
    assert_eq!(tool_activity("Read"), Activity::Thinking);
    assert_eq!(tool_activity("Grep"), Activity::Thinking);
    assert_eq!(tool_activity("Glob"), Activity::Thinking);
    assert_eq!(tool_activity("TaskCreate"), Activity::WritingPlan);
    assert_eq!(tool_activity("TaskUpdate"), Activity::WritingPlan);
    assert_eq!(tool_activity("ExitPlanMode"), Activity::WritingPlan);
    assert_eq!(tool_activity("EnterPlanMode"), Activity::WritingPlan);
    assert_eq!(tool_activity("Bash"), Activity::EditingCode);
    assert_eq!(tool_activity("run_terminal_cmd"), Activity::EditingCode);
    assert_eq!(tool_activity("shell"), Activity::EditingCode);
    assert_eq!(tool_activity("my_terminal_tool"), Activity::EditingCode);
    assert_eq!(
        tool_activity("mcp:whatever:frobnicate"),
        Activity::RunningCommand
    );
}

#[test]
fn reduce_room_tool_cycle_and_adapter_activity() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
        ),
    );
    assert_eq!(state.tool.as_deref(), Some("Bash"));
    assert_eq!(state.activity, Activity::EditingCode);
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::ToolEnd { tool: None }),
    );
    assert!(state.tool.is_none());
    assert_eq!(state.activity, Activity::Thinking);
    state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "CustomTool".to_string(),
                activity: Some(Activity::SearchingWeb),
                args: None,
            },
        ),
    );
    assert_eq!(state.activity, Activity::SearchingWeb);
}

#[test]
fn reduce_room_session_start_keeps_only_the_log() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::MessageUser {
                text: "hi".to_string(),
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::SessionStart {
                title: "round 2".to_string(),
            },
        ),
    );
    assert_eq!(state.log.len(), 1);
    assert_eq!(state.title, "round 2");
    assert!(state.tasks.is_empty());
    assert!(state.tool.is_none());
    assert_eq!(state.activity, Activity::Idle);
    assert!(!state.ended);
}

#[test]
fn reduce_room_thinking_window_trims_to_a_word_boundary() {
    let words = ["a", "bb", "ccc", "dddd", "eeeeeee", "ffffffffff", "ggggg"];
    let mut state = initial_room_state();
    for index in 0..120 {
        state = reduce_room(
            state,
            &AgentEvent::new(
                "s",
                AgentEventBody::ThinkingDelta {
                    text: format!("{} ", words[index % words.len()]),
                },
            ),
        );
    }
    assert!(state.thought.encode_utf16().count() <= 220);
    for word in state.thought.trim_end_matches(' ').split(' ') {
        assert!(words.contains(&word), "{word}");
    }
}

#[test]
fn reduce_room_spinner_lines_replace_the_bubble() {
    let text = format!("✳ {}", "z".repeat(300));
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new("s", AgentEventBody::ThinkingDelta { text: text.clone() }),
    );
    assert_eq!(state.thought, text);
    assert!(state.thought.encode_utf16().count() > 220);
    assert_eq!(state.activity, Activity::Thinking);
    assert!(state.tool.is_none());
    for prefix in ["✳", "✢", "✻", "✽", "·"] {
        let line = format!("{prefix} status");
        state = reduce_room(
            initial_room_state(),
            &AgentEvent::new("s", AgentEventBody::ThinkingDelta { text: line.clone() }),
        );
        assert_eq!(state.thought, line);
    }
    state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "✳status".to_string(),
            },
        ),
    );
    assert_eq!(state.thought, "✳status");
}

#[test]
fn reduce_room_windows_by_utf16_units_and_trims_only_when_full() {
    let text = "😀".repeat(111);
    let state = reduce_room(
        initial_room_state(),
        &AgentEvent::new("s", AgentEventBody::ThinkingDelta { text }),
    );
    assert_eq!(state.thought.encode_utf16().count(), 220);
    assert_eq!(state.thought.chars().count(), 110);
    let short = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "zz hello".to_string(),
            },
        ),
    );
    assert_eq!(short.thought, "zz hello");
    let head = "z".repeat(215);
    let full = format!("{head} word");
    assert_eq!(full.encode_utf16().count(), 220);
    let trimmed = reduce_room(
        initial_room_state(),
        &AgentEvent::new("s", AgentEventBody::ThinkingDelta { text: full }),
    );
    assert_eq!(trimmed.thought, "word");
}

#[test]
fn reduce_room_caps_log_and_term() {
    let mut state = initial_room_state();
    for index in 0..65 {
        state = reduce_room(
            state,
            &AgentEvent::new(
                "s",
                AgentEventBody::MessageUser {
                    text: index.to_string(),
                },
            ),
        );
    }
    assert_eq!(state.log.len(), 60);
    assert_eq!(state.log[0].text, "5");
    assert_eq!(state.log[59].text, "64");
    state = initial_room_state();
    for index in 0..8 {
        state = reduce_room(
            state,
            &AgentEvent::new(
                "s",
                AgentEventBody::TermLine {
                    text: index.to_string(),
                },
            ),
        );
    }
    assert_eq!(state.term, vec!["2", "3", "4", "5", "6", "7"]);
}

#[test]
fn reduce_room_activity_speech_and_plan_follow_the_arms() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "hello ".to_string(),
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::Activity {
                activity: Activity::SearchingWeb,
            },
        ),
    );
    assert_eq!(state.activity, Activity::SearchingWeb);
    assert!(state.tool.is_none());
    assert_eq!(state.thought, "");
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "hello ".to_string(),
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::Activity {
                activity: Activity::Thinking,
            },
        ),
    );
    assert_eq!(state.thought, "hello ");
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::TaskPlan {
                tasks: vec!["a".to_string()],
            },
        ),
    );
    assert_eq!(state.activity, Activity::WritingPlan);
    assert_eq!(state.thought, "hello ");
    state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::SpeechStt { active: false }),
    );
    assert_eq!(state.tool.as_deref(), Some("Bash"));
    assert_eq!(state.activity, Activity::Thinking);
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::SpeechStt { active: true }),
    );
    assert!(state.tool.is_none());
    assert_eq!(state.activity, Activity::Listening);
    assert_eq!(state.thought, "");
}

#[test]
fn reduce_room_turn_end_settles_to_idle() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::MessageAgent {
                text: "done!".to_string(),
                usage: None,
                model: None,
                duration_ms: None,
            },
        ),
    );
    assert_eq!(state.activity, Activity::Speaking);
    state = reduce_room(state, &AgentEvent::new("s", AgentEventBody::TurnEnd));
    assert_eq!(state.activity, Activity::Idle);
    assert!(!state.ended);
    assert_eq!(state.log.len(), 1);
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::MessageUser {
                text: "next".to_string(),
            },
        ),
    );
    assert_eq!(state.log.len(), 2);
}

#[test]
fn reduce_room_ignores_unknown_event_types() {
    let state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
        ),
    );
    let next = reduce_room(
        state.clone(),
        &AgentEvent::new(
            "s",
            AgentEventBody::Unknown {
                kind: "confetti.burst".to_string(),
            },
        ),
    );
    assert_eq!(next, state);
}

#[test]
fn reduce_room_ended_room_ignores_everything_but_session_start() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new("s", AgentEventBody::SessionEnd),
    );
    assert!(state.ended);
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::ToolEnd { tool: None }),
    );
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::SpeechStt { active: false }),
    );
    assert_eq!(state.activity, Activity::Sleeping);
    assert!(state.ended);
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::SessionStart {
                title: "back".to_string(),
            },
        ),
    );
    assert!(!state.ended);
    assert_eq!(state.title, "back");
}

#[test]
fn reduce_den_keeps_one_room_per_session() {
    let den = run(vec![
        stamped(
            "a",
            AgentEventBody::SessionStart {
                title: "A".to_string(),
            },
            100,
            Some("alpha"),
            None,
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart {
                title: "B".to_string(),
            },
            200,
            None,
            None,
        ),
        stamped(
            "a",
            AgentEventBody::ToolStart {
                tool: "Bash".to_string(),
                activity: None,
                args: None,
            },
            300,
            None,
            None,
        ),
    ]);
    assert_eq!(den.rooms.keys().collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(den.rooms.get("a").unwrap().activity, Activity::EditingCode);
    assert_eq!(den.rooms.get("b").unwrap().activity, Activity::Idle);
}

#[test]
fn list_sessions_orders_by_recency_and_keeps_name_and_harness() {
    let den = run(vec![
        stamped(
            "a",
            AgentEventBody::SessionStart {
                title: "A".to_string(),
            },
            100,
            Some("alpha"),
            Some("claude-code"),
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart {
                title: "B".to_string(),
            },
            200,
            None,
            None,
        ),
        stamped("a", AgentEventBody::ThinkingEnd, 300, None, None),
    ]);
    let list = list_sessions(&den);
    assert_eq!(
        list.iter().map(|info| info.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(list[0].name, "alpha");
    assert_eq!(list[0].harness.as_deref(), Some("claude-code"));
    assert_eq!(list[1].name, "b");
    assert!(list[1].harness.is_none());
}

#[test]
fn last_event_ts_is_monotonic_and_floors_a_negative_first_timestamp() {
    let den = run(vec![
        stamped(
            "a",
            AgentEventBody::SessionStart {
                title: "A".to_string(),
            },
            100,
            None,
            None,
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart {
                title: "B".to_string(),
            },
            200,
            None,
            None,
        ),
        stamped("a", AgentEventBody::ThinkingEnd, 300, None, None),
        stamped("a", AgentEventBody::ToolEnd { tool: None }, 150, None, None),
    ]);
    assert_eq!(
        den.sessions.get("a").unwrap().last_event_ts,
        Some(JsNumber::from(300_i64))
    );
    assert_eq!(
        list_sessions(&den)
            .iter()
            .map(|info| info.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    let mut negative = AgentEvent::new("c", AgentEventBody::SessionEnd);
    negative.ts = Some(JsNumber::from(-5_i64));
    let den = reduce_den(initial_den_state(), &negative);
    assert_eq!(
        den.sessions.get("c").unwrap().last_event_ts,
        Some(JsNumber::from(0_i64))
    );
    let mut blank = AgentEvent::new(
        "a",
        AgentEventBody::SessionStart {
            title: "A".to_string(),
        },
    );
    blank.name = Some("alpha".to_string());
    blank.harness = Some("claude-code".to_string());
    let den = reduce_den(initial_den_state(), &blank);
    let mut follow = AgentEvent::new("a", AgentEventBody::ThinkingEnd);
    follow.name = Some(String::new());
    follow.harness = Some(String::new());
    let den = reduce_den(den, &follow);
    assert_eq!(den.sessions.get("a").unwrap().name, "alpha");
    assert_eq!(den.sessions.get("a").unwrap().harness.as_deref(), Some(""));
    let tied = run(vec![
        stamped(
            "a",
            AgentEventBody::SessionStart {
                title: "A".to_string(),
            },
            5,
            None,
            None,
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart {
                title: "B".to_string(),
            },
            5,
            None,
            None,
        ),
    ]);
    assert_eq!(
        list_sessions(&tied)
            .iter()
            .map(|info| info.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[test]
fn golden_coding_session_matches_the_room_snapshot() {
    let den = run(coding_session());
    assert_eq!(
        den.rooms.get("s1").cloned().unwrap(),
        RoomState {
            title: "fix the flaky test".to_string(),
            activity: Activity::Speaking,
            tool: None,
            tasks: vec![
                Task {
                    label: "find flaky test".to_string(),
                    done: true,
                },
                Task {
                    label: "fix it".to_string(),
                    done: true,
                },
                Task {
                    label: "verify".to_string(),
                    done: true,
                },
            ],
            thought: String::new().into(),
            last_message: "Fixed — all 42 tests pass.".to_string(),
            log: vec![
                LogEntry {
                    who: LogWho::User,
                    text: "fix the flaky test in ci".to_string(),
                },
                LogEntry {
                    who: LogWho::Agent,
                    text: "Fixed — all 42 tests pass.".to_string(),
                },
            ],
            term: vec!["$ npm test".to_string(), "42 passing".to_string()],
            ended: false,
        }
    );
    assert_eq!(
        den.sessions.get("s1").cloned().unwrap(),
        SessionInfo {
            id: "s1".to_string(),
            name: "rivet-claude".to_string(),
            harness: Some("claude-code".to_string()),
            last_event_ts: Some(JsNumber::from(16_i64)),
        }
    );
    let frame = snapshot_frame(&den, None);
    assert_fixture(&serde_json::to_string(&frame).unwrap(), "snapshot.json");
    let text = read_fixture("snapshot.json");
    let parsed: session_events::SnapshotFrame =
        serde_json::from_str(text.trim_end_matches('\n')).unwrap();
    assert_eq!(
        serde_json::to_string(&parsed).unwrap(),
        text.trim_end_matches('\n')
    );
    let filtered = snapshot_frame(&den, Some("missing"));
    assert_eq!(
        filtered.rooms.get("missing").cloned().unwrap(),
        initial_room_state()
    );
    assert_eq!(filtered.sessions.len(), 1);
    let only = snapshot_frame(&den, Some("s1"));
    assert_eq!(only.rooms.keys().collect::<Vec<_>>(), vec!["s1"]);
    assert_eq!(only.sessions.len(), 1);
}

#[test]
fn golden_voice_interruption_ends_asleep() {
    let den = run(vec![
        stamped(
            "s2",
            AgentEventBody::SessionStart {
                title: "chatting".to_string(),
            },
            1,
            None,
            None,
        ),
        stamped(
            "s2",
            AgentEventBody::SpeechStt { active: true },
            2,
            None,
            None,
        ),
        stamped(
            "s2",
            AgentEventBody::SpeechStt { active: false },
            3,
            None,
            None,
        ),
        stamped(
            "s2",
            AgentEventBody::MessageAgent {
                text: "On it.".to_string(),
                usage: None,
                model: None,
                duration_ms: None,
            },
            4,
            None,
            None,
        ),
        stamped("s2", AgentEventBody::SessionEnd, 5, None, None),
    ]);
    let room = den.rooms.get("s2").unwrap();
    assert_eq!(room.activity, Activity::Sleeping);
    assert!(room.ended);
    assert_eq!(room.title, "chatting");
    assert_eq!(room.last_message, "On it.");
    assert_eq!(
        room.log,
        vec![LogEntry {
            who: LogWho::Agent,
            text: "On it.".to_string(),
        }]
    );
    assert!(room.tasks.is_empty());
    assert!(room.term.is_empty());
    assert_eq!(room.thought, "");
    assert!(room.tool.is_none());
    let info = den.sessions.get("s2").unwrap();
    assert_eq!(info.name, "s2");
    assert!(info.harness.is_none());
    assert_eq!(info.last_event_ts, Some(JsNumber::from(5_i64)));
}

#[test]
fn event_fixtures_roundtrip_bytes() {
    for kind in EventType::ALL {
        let name = format!("{}.json", kind.as_str());
        let text = read_fixture(&name);
        let body = text.strip_suffix('\n').unwrap_or(text.as_str());
        let value: Value = serde_json::from_str(body).unwrap();
        let event = parse_event(&value).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(serde_json::to_string(&event).unwrap(), body, "{name}");
        let again: AgentEvent = serde_json::from_str(body).unwrap();
        assert_eq!(serde_json::to_string(&again).unwrap(), body, "{name}");
    }
    let minimal = AgentEvent::new("s1", AgentEventBody::ToolEnd { tool: None });
    assert_eq!(
        serde_json::to_string(&minimal).unwrap(),
        r#"{"v":1,"session":"s1","type":"tool.end"}"#
    );
    let empty = snapshot_frame(&initial_den_state(), None);
    assert_eq!(
        serde_json::to_string(&empty).unwrap(),
        r#"{"type":"snapshot","v":1,"sessions":[],"rooms":{}}"#
    );
}

#[test]
fn accepted_event_keeps_nested_usage_extensions() {
    let raw = r#"{"v":1,"session":"s1","type":"message.agent","text":"hi","usage":{"promptTokens":1,"completionTokens":2,"cachedTokens":0,"providerDetail":"x"}}"#;
    let event = parse_event_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&event).unwrap(), raw);
}

#[test]
fn accepted_event_numbers_use_javascript_spelling() {
    let raw = r#"{"v":1,"session":"s1","type":"tool.start","tool":"Bash","args":{"timeout":1000.0,"wide":1.50,"n":9007199254740993,"z":-0,"exp":1e21},"extraNum":1000.0}"#;
    let expected = r#"{"v":1,"session":"s1","type":"tool.start","tool":"Bash","args":{"timeout":1000,"wide":1.5,"n":9007199254740992,"z":0,"exp":1e+21},"extraNum":1000}"#;
    let event = parse_event_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&event).unwrap(), expected);
}

#[test]
fn accepted_event_keeps_original_property_order() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#;
    let event = parse_event_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&event).unwrap(), raw);
    let indexed = r#"{"10":1,"note":"x","2":2,"v":1,"session":"s1","type":"session.end"}"#;
    let indexed_event = parse_event_str(indexed).unwrap();
    assert_eq!(
        serde_json::to_string(&indexed_event).unwrap(),
        r#"{"2":2,"10":1,"note":"x","v":1,"session":"s1","type":"session.end"}"#
    );
}

#[test]
fn session_maps_enumerate_array_indexes_before_insertion_order() {
    let den = run(vec![
        AgentEvent::new(
            "10",
            AgentEventBody::SessionStart {
                title: "10".to_string(),
            },
        ),
        AgentEvent::new(
            "2",
            AgentEventBody::SessionStart {
                title: "2".to_string(),
            },
        ),
        AgentEvent::new(
            "b",
            AgentEventBody::SessionStart {
                title: "b".to_string(),
            },
        ),
        AgentEvent::new(
            "a",
            AgentEventBody::SessionStart {
                title: "a".to_string(),
            },
        ),
    ]);
    assert_eq!(
        list_sessions(&den)
            .iter()
            .map(|info| info.id.as_str())
            .collect::<Vec<_>>(),
        vec!["2", "10", "b", "a"]
    );
    let frame = snapshot_frame(&den, None);
    let room = |title: &str| {
        format!(
            "{{\"title\":\"{title}\",\"activity\":\"idle\",\"tool\":null,\"tasks\":[],\"thought\":\"\",\"lastMessage\":\"\",\"log\":[],\"term\":[],\"ended\":false}}"
        )
    };
    let info = |id: &str| format!("{{\"id\":\"{id}\",\"name\":\"{id}\"}}");
    let expected = format!(
        "{{\"type\":\"snapshot\",\"v\":1,\"sessions\":[{},{},{},{}],\"rooms\":{{\"2\":{},\"10\":{},\"b\":{},\"a\":{}}}}}",
        info("2"),
        info("10"),
        info("b"),
        info("a"),
        room("2"),
        room("10"),
        room("b"),
        room("a"),
    );
    assert_eq!(serde_json::to_string(&frame).unwrap(), expected);
}

#[test]
fn thought_window_keeps_a_split_surrogate() {
    let letters = "a".repeat(219);
    let raw = format!(
        "{{\"v\":1,\"session\":\"s\",\"type\":\"thinking.delta\",\"text\":\"😀{letters}\"}}"
    );
    let event = parse_event_str(&raw).unwrap();
    let state = reduce_room(initial_room_state(), &event);
    let expected = format!(
        "{{\"title\":\"\",\"activity\":\"thinking\",\"tool\":null,\"tasks\":[],\"thought\":\"\\ude00{letters}\",\"lastMessage\":\"\",\"log\":[],\"term\":[],\"ended\":false}}"
    );
    assert_eq!(serde_json::to_string(&state).unwrap(), expected);
}

#[test]
fn session_filter_keeps_the_full_session_list() {
    let den = run(vec![
        stamped(
            "s1",
            AgentEventBody::SessionStart {
                title: "A".to_string(),
            },
            1,
            None,
            None,
        ),
        stamped(
            "s2",
            AgentEventBody::SessionStart {
                title: "B".to_string(),
            },
            2,
            None,
            None,
        ),
    ]);
    let filtered = snapshot_frame(&den, Some("s1"));
    assert_eq!(filtered.sessions.len(), 2);
    assert_eq!(filtered.rooms.keys().collect::<Vec<_>>(), vec!["s1"]);
    let missing = snapshot_frame(&den, Some("missing"));
    assert_eq!(missing.sessions.len(), 2);
    assert_eq!(missing.rooms.keys().collect::<Vec<_>>(), vec!["missing"]);
    assert_eq!(
        missing.rooms.get("missing").cloned().unwrap(),
        initial_room_state()
    );
}
