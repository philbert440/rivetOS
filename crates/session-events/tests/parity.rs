use serde_json::{Value, json};
use session_events::{
    ACTIVITIES, Activity, AgentEvent, AgentEventBody, DenState, EventType, JsNumber, JsString,
    LogEntry, LogWho, PROTOCOL_VERSION, RoomState, SessionInfo, SnapshotFrame, Task, TokenUsage,
    initial_den_state, initial_room_state, list_sessions, parse_event, parse_event_str, reduce_den,
    reduce_room, snapshot_frame, tool_activity,
};

fn stamped(
    session: &str,
    body: AgentEventBody,
    ts: i64,
    name: Option<&str>,
    harness: Option<&str>,
) -> AgentEvent {
    AgentEvent::new(session, body).stamped(ts, name, harness)
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
                title: "fix the flaky test".into(),
            },
            1,
            Some("rivet-claude"),
            Some("claude-code"),
        ),
        stamped(
            "s1",
            AgentEventBody::MessageUser {
                text: "fix the flaky test in ci".into(),
            },
            2,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ThinkingDelta {
                text: "Looking at the CI logs first… ".into(),
            },
            3,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TaskPlan {
                tasks: vec!["find flaky test".into(), "fix it".into(), "verify".into()],
            },
            4,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolStart {
                tool: "Grep".into(),
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
                tool: Some("Grep".into()),
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
                tool: "Edit".into(),
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
                tool: Some("Edit".into()),
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
                tool: "Bash".into(),
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
                text: "$ npm test".into(),
            },
            12,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::TermLine {
                text: "42 passing".into(),
            },
            13,
            None,
            None,
        ),
        stamped(
            "s1",
            AgentEventBody::ToolEnd {
                tool: Some("Bash".into()),
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
                text: "Fixed — all 42 tests pass.".into(),
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
    assert_eq!(event.harness_session(), Some("20260802_225647_6ad0b9"));
    assert_eq!(event.harness(), Some("hermes"));
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
    match event.body() {
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
    match started.body() {
        AgentEventBody::ToolStart { args, .. } => {
            assert_eq!(args, Some(Value::String("nope".into())));
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
                tool: "Bash".into(),
                activity: None,
                args: None,
            },
        ),
    );
    assert_eq!(state.tool.as_ref().map(JsString::to_utf8), Some("Bash"));
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
                tool: "CustomTool".into(),
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
        &AgentEvent::new("s", AgentEventBody::MessageUser { text: "hi".into() }),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".into(),
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
                title: "round 2".into(),
            },
        ),
    );
    assert_eq!(state.log.len(), 1);
    assert_eq!(state.title.to_utf8(), "round 2");
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
                    text: format!("{} ", words[index % words.len()]).into(),
                },
            ),
        );
    }
    assert!(state.thought.units().len() <= 220);
    for word in state.thought.to_utf8().trim_end_matches(' ').split(' ') {
        assert!(words.contains(&word), "{word}");
    }
}

#[test]
fn reduce_room_spinner_lines_replace_the_bubble() {
    let text = format!("✳ {}", "z".repeat(300));
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: text.as_str().into(),
            },
        ),
    );
    assert_eq!(state.thought.to_utf8(), text);
    assert!(state.thought.units().len() > 220);
    assert_eq!(state.activity, Activity::Thinking);
    assert!(state.tool.is_none());
    for prefix in ["✳", "✢", "✻", "✽", "·"] {
        let line = format!("{prefix} status");
        state = reduce_room(
            initial_room_state(),
            &AgentEvent::new(
                "s",
                AgentEventBody::ThinkingDelta {
                    text: line.as_str().into(),
                },
            ),
        );
        assert_eq!(state.thought.to_utf8(), line);
    }
    state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "✳status".into(),
            },
        ),
    );
    assert_eq!(state.thought.to_utf8(), "✳status");
}

#[test]
fn reduce_room_windows_by_utf16_units_and_trims_only_when_full() {
    let text = "😀".repeat(111);
    let state = reduce_room(
        initial_room_state(),
        &AgentEvent::new("s", AgentEventBody::ThinkingDelta { text: text.into() }),
    );
    assert_eq!(state.thought.units().len(), 220);
    assert_eq!(state.thought.to_utf8().chars().count(), 110);
    let short = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "zz hello".into(),
            },
        ),
    );
    assert_eq!(short.thought.to_utf8(), "zz hello");
    let head = "z".repeat(215);
    let full = format!("{head} word");
    assert_eq!(full.encode_utf16().count(), 220);
    let trimmed = reduce_room(
        initial_room_state(),
        &AgentEvent::new("s", AgentEventBody::ThinkingDelta { text: full.into() }),
    );
    assert_eq!(trimmed.thought.to_utf8(), "word");
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
                    text: index.to_string().into(),
                },
            ),
        );
    }
    assert_eq!(state.log.len(), 60);
    assert_eq!(state.log[0].text.to_utf8(), "5");
    assert_eq!(state.log[59].text.to_utf8(), "64");
    state = initial_room_state();
    for index in 0..8 {
        state = reduce_room(
            state,
            &AgentEvent::new(
                "s",
                AgentEventBody::TermLine {
                    text: index.to_string().into(),
                },
            ),
        );
    }
    assert_eq!(
        state.term.iter().map(JsString::to_utf8).collect::<Vec<_>>(),
        vec!["2", "3", "4", "5", "6", "7"]
    );
}

#[test]
fn reduce_room_activity_speech_and_plan_follow_the_arms() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".into(),
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
                text: "hello ".into(),
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
    assert_eq!(state.thought.to_utf8(), "");
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "hello ".into(),
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
    assert_eq!(state.thought.to_utf8(), "hello ");
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::TaskPlan {
                tasks: vec!["a".into()],
            },
        ),
    );
    assert_eq!(state.activity, Activity::WritingPlan);
    assert_eq!(state.thought.to_utf8(), "hello ");
    state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ToolStart {
                tool: "Bash".into(),
                activity: None,
                args: None,
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::SpeechStt { active: false }),
    );
    assert_eq!(state.tool.as_ref().map(JsString::to_utf8), Some("Bash"));
    assert_eq!(state.activity, Activity::Thinking);
    state = reduce_room(
        state,
        &AgentEvent::new("s", AgentEventBody::SpeechStt { active: true }),
    );
    assert!(state.tool.is_none());
    assert_eq!(state.activity, Activity::Listening);
    assert_eq!(state.thought.to_utf8(), "");
}

#[test]
fn reduce_room_turn_end_settles_to_idle() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::MessageAgent {
                text: "done!".into(),
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
                text: "next".into(),
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
                tool: "Bash".into(),
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
                kind: "confetti.burst".into(),
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
                title: "back".into(),
            },
        ),
    );
    assert!(!state.ended);
    assert_eq!(state.title.to_utf8(), "back");
}

#[test]
fn reduce_den_keeps_one_room_per_session() {
    let den = run(vec![
        stamped(
            "a",
            AgentEventBody::SessionStart { title: "A".into() },
            100,
            Some("alpha"),
            None,
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart { title: "B".into() },
            200,
            None,
            None,
        ),
        stamped(
            "a",
            AgentEventBody::ToolStart {
                tool: "Bash".into(),
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
            AgentEventBody::SessionStart { title: "A".into() },
            100,
            Some("alpha"),
            Some("claude-code"),
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart { title: "B".into() },
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
            AgentEventBody::SessionStart { title: "A".into() },
            100,
            None,
            None,
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart { title: "B".into() },
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
    let negative =
        AgentEvent::new("c", AgentEventBody::SessionEnd).with_ts(Some(JsNumber::from(-5_i64)));
    let den = reduce_den(initial_den_state(), &negative);
    assert_eq!(
        den.sessions.get("c").unwrap().last_event_ts,
        Some(JsNumber::from(0_i64))
    );
    let blank = AgentEvent::new("a", AgentEventBody::SessionStart { title: "A".into() })
        .with_name(Some("alpha"))
        .with_harness(Some("claude-code"));
    let den = reduce_den(initial_den_state(), &blank);
    let follow = AgentEvent::new("a", AgentEventBody::ThinkingEnd)
        .with_name(Some(""))
        .with_harness(Some(""));
    let den = reduce_den(den, &follow);
    assert_eq!(den.sessions.get("a").unwrap().name, "alpha");
    assert_eq!(den.sessions.get("a").unwrap().harness.as_deref(), Some(""));
    let tied = run(vec![
        stamped(
            "a",
            AgentEventBody::SessionStart { title: "A".into() },
            5,
            None,
            None,
        ),
        stamped(
            "b",
            AgentEventBody::SessionStart { title: "B".into() },
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
            title: "fix the flaky test".into(),
            activity: Activity::Speaking,
            tool: None,
            tasks: vec![
                Task {
                    label: "find flaky test".into(),
                    done: true,
                },
                Task {
                    label: "fix it".into(),
                    done: true,
                },
                Task {
                    label: "verify".into(),
                    done: true,
                },
            ],
            thought: String::new().into(),
            last_message: "Fixed — all 42 tests pass.".into(),
            log: vec![
                LogEntry {
                    who: LogWho::User,
                    text: "fix the flaky test in ci".into(),
                },
                LogEntry {
                    who: LogWho::Agent,
                    text: "Fixed — all 42 tests pass.".into(),
                },
            ],
            term: vec!["$ npm test".into(), "42 passing".into()],
            ended: false,
        }
    );
    assert_eq!(
        den.sessions.get("s1").cloned().unwrap(),
        SessionInfo {
            id: "s1".into(),
            name: "rivet-claude".into(),
            harness: Some("claude-code".into()),
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
                title: "chatting".into(),
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
                text: "On it.".into(),
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
    assert_eq!(room.title.to_utf8(), "chatting");
    assert_eq!(room.last_message.to_utf8(), "On it.");
    assert_eq!(
        room.log,
        vec![LogEntry {
            who: LogWho::Agent,
            text: "On it.".into(),
        }]
    );
    assert!(room.tasks.is_empty());
    assert!(room.term.is_empty());
    assert_eq!(room.thought.to_utf8(), "");
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
        AgentEvent::new("10", AgentEventBody::SessionStart { title: "10".into() }),
        AgentEvent::new("2", AgentEventBody::SessionStart { title: "2".into() }),
        AgentEvent::new("b", AgentEventBody::SessionStart { title: "b".into() }),
        AgentEvent::new("a", AgentEventBody::SessionStart { title: "a".into() }),
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
            AgentEventBody::SessionStart { title: "A".into() },
            1,
            None,
            None,
        ),
        stamped(
            "s2",
            AgentEventBody::SessionStart { title: "B".into() },
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

#[test]
fn stamped_event_serializes_metadata_and_keeps_extensions() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#;
    let event = parse_event_str(raw)
        .unwrap()
        .stamped(9_i64, Some("n"), Some("claude-code"));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","ts":9,"name":"n","harness":"claude-code"}"#
    );
    assert_eq!(event.ts(), Some(JsNumber::from(9_i64)));
    assert_eq!(event.name(), Some("n"));
    assert_eq!(event.harness(), Some("claude-code"));
    let cleared = event.stamped(4_i64, None, None);
    assert_eq!(
        serde_json::to_string(&cleared).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","ts":4}"#
    );
    assert_eq!(cleared.name(), None);
    assert_eq!(cleared.harness(), None);
}

#[test]
fn with_session_serializes_the_updated_session() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#;
    let event = parse_event_str(raw).unwrap().with_session("room");
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"room","type":"session.end"}"#
    );
    assert_eq!(event.session(), "room");
    let den = reduce_den(initial_den_state(), &event);
    assert!(den.rooms.get("room").is_some());
    assert!(den.rooms.get("s1").is_none());
}

#[test]
fn with_name_serializes_the_updated_name() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end","name":"old"}"#;
    let event = parse_event_str(raw).unwrap().with_name(Some("next"));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","name":"next"}"#
    );
    assert_eq!(event.name(), Some("next"));
    let cleared = event.with_name(None);
    assert_eq!(
        serde_json::to_string(&cleared).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#
    );
    assert_eq!(cleared.name(), None);
}

#[test]
fn with_harness_serializes_the_updated_harness() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#;
    let event = parse_event_str(raw)
        .unwrap()
        .with_harness(Some("grok-build"));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","harness":"grok-build"}"#
    );
    assert_eq!(event.harness(), Some("grok-build"));
    let cleared = event.with_harness(None);
    assert_eq!(serde_json::to_string(&cleared).unwrap(), raw);
    assert_eq!(cleared.harness(), None);
}

#[test]
fn with_harness_session_serializes_the_updated_harness_session() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#;
    let event = parse_event_str(raw)
        .unwrap()
        .with_harness_session(Some("abc"));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","harnessSession":"abc"}"#
    );
    assert_eq!(event.harness_session(), Some("abc"));
    let cleared = event.with_harness_session(None);
    assert_eq!(serde_json::to_string(&cleared).unwrap(), raw);
    assert_eq!(cleared.harness_session(), None);
}

#[test]
fn with_ts_serializes_the_updated_timestamp() {
    let raw = r#"{"note":"x","v":1,"session":"s1","type":"session.end","ts":1}"#;
    let event = parse_event_str(raw)
        .unwrap()
        .with_ts(Some(JsNumber::from(-5_i64)));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end","ts":-5}"#
    );
    assert_eq!(event.ts(), Some(JsNumber::from(-5_i64)));
    let cleared = event.with_ts(None);
    assert_eq!(
        serde_json::to_string(&cleared).unwrap(),
        r#"{"note":"x","v":1,"session":"s1","type":"session.end"}"#
    );
    assert_eq!(cleared.ts(), None);
}

#[test]
fn long_thinking_delta_windows_the_tail() {
    let mut state = reduce_room(
        initial_room_state(),
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "b".repeat(100).into(),
            },
        ),
    );
    state = reduce_room(
        state,
        &AgentEvent::new(
            "s",
            AgentEventBody::ThinkingDelta {
                text: "a".repeat(200_000).into(),
            },
        ),
    );
    assert_eq!(state.thought.units().len(), 220);
    assert_eq!(state.thought.to_utf8(), "a".repeat(220));
}

#[test]
fn thought_state_round_trips_a_split_surrogate() {
    let letters = "a".repeat(219);
    let raw = format!(
        "{{\"v\":1,\"session\":\"s\",\"type\":\"thinking.delta\",\"text\":\"😀{letters}\"}}"
    );
    let event = parse_event_str(&raw).unwrap();
    let state = reduce_room(initial_room_state(), &event);
    let json = serde_json::to_string(&state).unwrap();
    let parsed: RoomState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, state);
    assert_eq!(parsed.thought.units().first().copied(), Some(0xDE00));
    let den = reduce_den(initial_den_state(), &event);
    let den_json = serde_json::to_string(&den).unwrap();
    let den_parsed: DenState = serde_json::from_str(&den_json).unwrap();
    assert_eq!(den_parsed, den);
    let frame = snapshot_frame(&den, None);
    let frame_json = serde_json::to_string(&frame).unwrap();
    let frame_parsed: SnapshotFrame = serde_json::from_str(&frame_json).unwrap();
    assert_eq!(serde_json::to_string(&frame_parsed).unwrap(), frame_json);
    assert_eq!(
        frame_parsed.rooms.get("s").unwrap().thought.units(),
        state.thought.units()
    );
}

#[test]
fn hook_truncated_text_keeps_a_lone_surrogate_in_the_snapshot() {
    let title = format!("{}\\ud83d", "a".repeat(47));
    let label = format!("{}\\ud83d", "b".repeat(59));
    let term = format!("{}\\ud83d", "c".repeat(79));
    let user = format!("{}\\ud83d", "d".repeat(1999));
    let agent = format!("{}\\ud83d", "e".repeat(1999));
    let events = [
        format!("{{\"v\":1,\"session\":\"s\",\"type\":\"session.start\",\"title\":\"{title}\"}}"),
        format!("{{\"v\":1,\"session\":\"s\",\"type\":\"task.plan\",\"tasks\":[\"{label}\"]}}"),
        format!("{{\"v\":1,\"session\":\"s\",\"type\":\"term.line\",\"text\":\"{term}\"}}"),
        format!("{{\"v\":1,\"session\":\"s\",\"type\":\"message.user\",\"text\":\"{user}\"}}"),
        format!("{{\"v\":1,\"session\":\"s\",\"type\":\"message.agent\",\"text\":\"{agent}\"}}"),
    ];
    let mut state = initial_room_state();
    let mut den = initial_den_state();
    for raw in &events {
        let event = parse_event_str(raw).unwrap();
        state = reduce_room(state, &event);
        den = reduce_den(den, &event);
    }
    let json = serde_json::to_string(&state).unwrap();
    assert!(json.contains(&format!("\"title\":\"{title}\"")), "{json}");
    assert!(json.contains(&format!("\"label\":\"{label}\"")), "{json}");
    assert!(json.contains(&format!("\"{term}\"")), "{json}");
    assert!(json.contains(&format!("\"text\":\"{user}\"")), "{json}");
    assert!(json.contains(&format!("\"text\":\"{agent}\"")), "{json}");
    assert!(
        json.contains(&format!("\"lastMessage\":\"{agent}\"")),
        "{json}"
    );
    assert!(!json.contains("\\ufffd"), "{json}");
    assert_eq!(state.title.units().last().copied(), Some(0xD83D));
    assert_eq!(state.tasks[0].label.units().last().copied(), Some(0xD83D));
    assert_eq!(state.term[0].units().last().copied(), Some(0xD83D));
    assert_eq!(state.log[0].text.units().last().copied(), Some(0xD83D));
    assert_eq!(state.log[1].text.units().last().copied(), Some(0xD83D));
    assert_eq!(state.last_message.units().last().copied(), Some(0xD83D));
    let parsed: RoomState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, state);
    let frame = snapshot_frame(&den, None);
    let frame_json = serde_json::to_string(&frame).unwrap();
    assert!(!frame_json.contains("\\ufffd"), "{frame_json}");
    let frame_parsed: SnapshotFrame = serde_json::from_str(&frame_json).unwrap();
    assert_eq!(serde_json::to_string(&frame_parsed).unwrap(), frame_json);
    assert_eq!(
        frame_parsed.rooms.get("s").unwrap().last_message.units(),
        state.last_message.units()
    );
}
