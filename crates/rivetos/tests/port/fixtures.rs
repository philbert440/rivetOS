use crate::common;

use std::path::PathBuf;

use rivetos::{IngestOptions, ingest_transcript};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../capture/tests/fixtures")
}

#[test]
fn recorded_hook_fixtures_cover_every_event() {
    let dir = fixtures_dir();
    let expected = [
        ("user_prompt_submit.json", "UserPromptSubmit"),
        ("post_tool_use.json", "PostToolUse"),
        ("stop.json", "Stop"),
        ("subagent_stop.json", "SubagentStop"),
        ("session_end.json", "SessionEnd"),
    ];
    for (name, event) in expected {
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap();
        assert_eq!(value["hook_event_name"], event);
        assert_eq!(value["session_id"], "sess-1");
        assert!(
            value["transcript_path"]
                .as_str()
                .unwrap()
                .ends_with(".jsonl")
        );
    }
    let transcript = std::fs::read_to_string(dir.join("transcript.jsonl")).unwrap();
    let lines = transcript
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    assert_eq!(lines, 4);
}

#[tokio::test]
async fn transcript_fixture_posts_the_recorded_body() {
    let dir = std::path::absolute(fixtures_dir()).unwrap();
    let transcript = dir.join("transcript.jsonl");
    let harness = common::DenHarness::new();
    let mut opts = IngestOptions::new(&transcript);
    opts.env = Some(harness.env.clone());
    opts.exchange = Some(harness.exchange.clone());
    opts.spool_dir = Some(harness.spool());
    opts.now_iso = Some(common::fixed_clock());
    let result = ingest_transcript(opts).await.unwrap();
    assert_eq!(result.session_key, "claude-code:sess-1");
    assert_eq!(result.inserted, 4);
    assert!(!result.created);
    assert!(result.skipped.is_none());
    let raw = harness.bodies.lock().unwrap()[0].clone();
    let path = transcript.display().to_string();
    let normalized = raw.replace(&path, "__PATH__");
    let expected = std::fs::read_to_string(dir.join("expected_post.json")).unwrap();
    assert_eq!(normalized, expected.trim());
}
