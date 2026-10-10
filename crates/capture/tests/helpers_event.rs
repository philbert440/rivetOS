use std::collections::HashMap;

use capture::{
    CONTENT_LIMIT, EventIdParts, OccurrenceKey, as_string, cap_for_storage, content_tuple_hash,
    event_id_from_content, is_record, iso_from_unix_ms, load_env_file, occurrence_index, safe_json,
    sha256_hex,
};
use serde_json::{Value, json};

fn parts(
    session_key: &str,
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_args: Option<Value>,
) -> EventIdParts {
    EventIdParts {
        session_key: session_key.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        tool_name: tool_name.map(str::to_string),
        tool_args,
        occurrence: None,
    }
}

fn base() -> EventIdParts {
    parts(
        "claude-code:sess",
        "user",
        "hello",
        Some("Bash"),
        Some(json!({"command": "ls"})),
    )
}

fn row(role: &str, content: &str) -> OccurrenceKey {
    OccurrenceKey {
        role: role.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
    }
}

#[test]
fn helper_semantics() {
    assert!(is_record(&json!({})));
    for value in [Value::Null, json!([]), json!("x"), json!(1)] {
        assert!(!is_record(&value));
    }
    assert_eq!(as_string(&json!("")), None);
    assert_eq!(as_string(&json!(" ")), Some(" "));
    assert_eq!(as_string(&json!(1)), None);
    assert_eq!(safe_json(&json!({"a": 1})), "{\"a\":1}");
}

#[test]
fn caps_at_the_configured_limit() {
    let plain = cap_for_storage("abc", None);
    assert_eq!(plain.text, "abc");
    assert_eq!(plain.full_length, 3);
    assert!(!plain.truncated);
    let capped = cap_for_storage("abc", Some(2));
    assert_eq!(capped.text, "ab");
    assert_eq!(capped.full_length, 3);
    assert!(capped.truncated);
    let long = "x".repeat(16_001);
    assert_eq!(
        cap_for_storage(&long, None).text.chars().count(),
        CONTENT_LIMIT
    );
    let emoji = format!("{}😀", "z".repeat(15_999));
    let split = cap_for_storage(&emoji, Some(CONTENT_LIMIT));
    assert_eq!(split.text, "z".repeat(15_999));
    assert_eq!(split.full_length, 16_001);
    assert!(split.truncated);
}

#[test]
fn load_env_file_keeps_first_non_empty() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(".env");
    std::fs::write(
        &file,
        "# comment\nA=\"one\"\nB='two'\nA=ignored\nlower=no\nexport C=no\nEMPTY=\n",
    )
    .unwrap();
    let values = load_env_file(&file);
    let mut expect = HashMap::new();
    expect.insert("A".to_string(), "one".to_string());
    expect.insert("B".to_string(), "two".to_string());
    expect.insert("EMPTY".to_string(), String::new());
    assert_eq!(values.len(), expect.len());
    for (key, value) in expect {
        assert_eq!(values.get(&key).map(String::as_str), Some(value.as_str()));
    }
    assert!(load_env_file(dir.path().join("missing")).is_empty());
}

#[test]
fn iso_epoch_and_year_boundary() {
    assert_eq!(iso_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        iso_from_unix_ms(1_577_836_800_000),
        "2020-01-01T00:00:00.000Z"
    );
    assert_eq!(iso_from_unix_ms(-1), "1969-12-31T23:59:59.999Z");
}

#[test]
fn event_id_changes_with_each_field() {
    let id = event_id_from_content(&base());
    assert!(id.len() == 64 && id.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(event_id_from_content(&base()), id);
    let mut other = base();
    other.session_key = "other".to_string();
    assert_ne!(event_id_from_content(&other), id);
    other = base();
    other.role = "assistant".to_string();
    assert_ne!(event_id_from_content(&other), id);
    other = base();
    other.content = "hello!".to_string();
    assert_ne!(event_id_from_content(&other), id);
    other = base();
    other.tool_name = Some("Read".to_string());
    assert_ne!(event_id_from_content(&other), id);
    other = base();
    other.tool_args = Some(json!({"command": "pwd"}));
    assert_ne!(event_id_from_content(&other), id);
    other = base();
    other.tool_name = None;
    assert_ne!(event_id_from_content(&other), id);
    other = base();
    other.tool_args = None;
    assert_ne!(event_id_from_content(&other), id);
}

#[test]
fn occurrence_folds_into_the_hash() {
    let id = event_id_from_content(&base());
    let mut zero = base();
    zero.occurrence = Some(0);
    let mut one = base();
    one.occurrence = Some(1);
    let zero_id = event_id_from_content(&zero);
    let one_id = event_id_from_content(&one);
    assert_ne!(zero_id, id);
    assert_ne!(one_id, zero_id);
    assert_eq!(event_id_from_content(&one), one_id);
}

#[test]
fn tool_less_tuple_hash() {
    let key = OccurrenceKey {
        role: "user".to_string(),
        content: "ship it".to_string(),
        tool_name: None,
        tool_args: None,
    };
    assert_eq!(content_tuple_hash(&key), sha256_hex("user\0ship it\0\0"));
}

#[test]
fn content_tuple_omits_session_and_occurrence() {
    let key = OccurrenceKey {
        role: "user".to_string(),
        content: "hello".to_string(),
        tool_name: Some("Bash".to_string()),
        tool_args: Some(json!({"command": "ls"})),
    };
    let hash = content_tuple_hash(&key);
    assert!(hash.len() == 64 && hash.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_ne!(hash, event_id_from_content(&base()));
    let mut other = key.clone();
    other.content = "other".to_string();
    assert_ne!(content_tuple_hash(&other), hash);
}

#[test]
fn occurrence_index_counts_the_inclusive_prefix() {
    let same = row("user", "continue");
    let other = row("assistant", "ok");
    assert_eq!(occurrence_index(&[], &same), 0);
    assert_eq!(occurrence_index(std::slice::from_ref(&same), &same), 0);
    assert_eq!(
        occurrence_index(&[same.clone(), other, same.clone()], &same),
        1
    );
    assert_eq!(occurrence_index(&[row("user", "other")], &same), 0);
    let tool = OccurrenceKey {
        role: "tool".to_string(),
        content: "[tool call] Bash".to_string(),
        tool_name: Some("Bash".to_string()),
        tool_args: Some(json!({"command": "ls"})),
    };
    let mut other_tool = tool.clone();
    other_tool.tool_args = Some(json!({"command": "pwd"}));
    assert_eq!(
        occurrence_index(&[tool.clone(), other_tool.clone()], &other_tool),
        0
    );
    assert_eq!(occurrence_index(&[tool.clone(), tool.clone()], &tool), 1);
}
