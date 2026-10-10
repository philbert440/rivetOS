use std::path::PathBuf;

use protocol::{MessageContent, MessageRole};
use workspace::{
    RECENT_ACTIVITY_HEADING, TurnAssemblyInput, VOICE_MODE_PROMPT, WorkspaceLoader,
    recent_activity_message,
};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/workspace")
}

fn loader() -> WorkspaceLoader {
    let path = fixture_dir().to_string_lossy().into_owned();
    let loader = WorkspaceLoader::with_unix_seconds(path, 1_791_647_112);
    loader.set_skill_catalog("## Available skills\n- **weather**: Check current weather");
    loader
}

#[tokio::test]
async fn assembled_system_prompt_matches_the_byte_fixture() {
    let loader = loader();
    loader.pin_file("src/index.ts").await.expect("pin");
    let turn = loader
        .assemble_turn(TurnAssemblyInput {
            agent_id: Some("opus"),
            user_id: Some("alice"),
            chat_type: None,
            extra_system_prompt: None,
            recent_context: Some("user looked at weather"),
        })
        .await;

    let expected = include_bytes!("fixtures/system-prompt.txt");
    assert_eq!(turn.system_prompt.as_bytes(), expected.as_slice());
    assert!(turn.system_prompt.contains("11:45:12\u{202f}AM"));
    assert!(!turn.system_prompt.contains("11:45:12 AM"));
    for marker in [
        "DAILY_NOTE_MARKER",
        "RETIRED_CORE",
        "RETIRED_USER",
        "RETIRED_WORKSPACE",
        "RETIRED_CAPABILITIES",
        "HEARTBEAT_OK",
        RECENT_ACTIVITY_HEADING,
    ] {
        assert!(
            !turn.system_prompt.contains(marker),
            "system prompt contains {marker}"
        );
    }
    assert_eq!(turn.daily_context.as_deref(), Some("DAILY_NOTE_MARKER"));

    let message = turn.recent_activity.expect("recent");
    assert_eq!(message.role, MessageRole::System);
    match message.content {
        MessageContent::Text(text) => {
            assert_eq!(
                text.as_bytes(),
                include_bytes!("fixtures/recent-activity.txt")
            );
        }
        MessageContent::Parts(_) => panic!("text content"),
    }
}

#[tokio::test]
async fn voice_turn_appends_voice_rules_then_trimmed_extra() {
    let loader = loader();
    loader.pin_file("src/index.ts").await.expect("pin");
    let turn = loader
        .assemble_turn(TurnAssemblyInput {
            agent_id: Some("opus"),
            user_id: Some("alice"),
            chat_type: Some("voice"),
            extra_system_prompt: Some("  be terse  "),
            recent_context: None,
        })
        .await;

    let mut expected =
        String::from_utf8(include_bytes!("fixtures/system-prompt.txt").to_vec()).expect("utf8");
    expected.push_str(VOICE_MODE_PROMPT);
    expected.push_str("\n\nbe terse");
    assert_eq!(turn.system_prompt, expected);
    assert_eq!(
        turn.system_prompt.as_bytes(),
        include_bytes!("fixtures/system-prompt-voice.txt")
    );
    assert!(turn.recent_activity.is_none());
    assert!(!turn.system_prompt.contains("DAILY_NOTE_MARKER"));
}

#[test]
fn recent_activity_fixture_is_the_history_message() {
    let message = recent_activity_message("user looked at weather").expect("message");
    match message.content {
        MessageContent::Text(text) => {
            assert_eq!(
                text.as_bytes(),
                include_bytes!("fixtures/recent-activity.txt")
            );
        }
        MessageContent::Parts(_) => panic!("text content"),
    }
}
