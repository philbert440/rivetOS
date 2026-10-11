use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use protocol::host::MapEnv;
use serde_json::{Value, json};
use transcripts::Roots;
use transcripts::timeutil::iso_from_date_text;
use transcripts::value::slice_text;
use transcripts::{
    CaptureCursor, cowork_capture_lines, kimi_capture_text_for, pi_capture_text,
    summarize_turn_args,
};

struct Tmp(PathBuf);

impl Tmp {
    fn new(label: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("rr4a-{label}-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("tmpdir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parents");
    }
    std::fs::write(path, body).expect("write");
}

fn extra(row: &transcripts::CaptureMessage) -> Value {
    row.extra.clone().expect("extra")
}

#[test]
fn kimi_wire_event_id_matches_the_worker_content_hash() {
    let text = "{\"type\":\"context.append_loop_event\",\"time\":1000,\"event\":{\"type\":\"content.part\",\"uuid\":\"uuid\",\"part\":{\"type\":\"text\",\"text\":\"hello\"}}}\n";
    let rows = kimi_capture_text_for(text, Some("sid"));
    let material = "sid\u{0}assistant\u{0}hello\u{0}\u{0}\u{0}wire:content.part:uuid";
    assert_eq!(
        rows[0].event_id.as_deref(),
        Some(protocol::digest::sha256_hex(material.as_bytes()).as_str())
    );
    let repeat = format!(
        "{}{}",
        text,
        "{\"type\":\"context.append_loop_event\",\"time\":1001,\"event\":{\"type\":\"content.part\",\"uuid\":\"uuid\",\"part\":{\"type\":\"text\",\"text\":\"hello\"}}}\n"
    );
    let again = kimi_capture_text_for(&repeat, Some("sid"));
    let with_occurrence = format!("{material}\u{0}occurrence:1");
    assert_eq!(
        again[1].event_id.as_deref(),
        Some(protocol::digest::sha256_hex(with_occurrence.as_bytes()).as_str())
    );
    assert_ne!(again[1].event_id, again[0].event_id);
}

#[test]
fn cowork_uuidless_rows_use_occurrence_hashes() {
    let lines = vec![
        json!({"type":"user","message":{"role":"user","content":"hello"}}).to_string(),
        json!({"type":"user","message":{"role":"user","content":"hello"}}).to_string(),
    ];
    let rows = cowork_capture_lines(&lines);
    let fields = "user\u{0}hello\u{0}\u{0}";
    let hash = protocol::digest::sha256_hex(fields.as_bytes());
    assert_eq!(
        rows[0].event_id.as_deref(),
        Some(format!("cowork:unknown:occ:{hash}:0").as_str())
    );
    assert_eq!(
        rows[1].event_id.as_deref(),
        Some(format!("cowork:unknown:occ:{hash}:1").as_str())
    );
}

#[test]
fn cowork_idless_tool_gets_an_occurrence_id_not_the_line_uuid() {
    let lines = vec![json!({"type":"assistant","uuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}).to_string()];
    let rows = cowork_capture_lines(&lines);
    assert_eq!(rows.len(), 1);
    let fields = "tool\u{0}[tool call] Bash\u{0}Bash\u{0}{\"command\":\"ls\"}";
    let hash = protocol::digest::sha256_hex(fields.as_bytes());
    assert_eq!(
        rows[0].event_id.as_deref(),
        Some(format!("cowork:unknown:occ:{hash}:0").as_str())
    );
    assert!(rows[0].tool_result.is_none());
}

#[test]
fn pi_user_rows_follow_text_from_items() {
    let text = format!(
        "{}\n{}\n",
        json!({"type":"message","id":"a1","message":{"role":"user","content":"list the files"}}),
        json!({"type":"message","id":"a2","message":{"role":"user","content":[{"text":"typeless"},{"type":"text","text":"typed"}]}})
    );
    let rows = pi_capture_text(&text);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].role, "user");
    assert_eq!(rows[0].content, "list the files");
    assert_eq!(rows[1].content, "typeless\ntyped");
}

#[test]
fn pi_rows_parse_string_timestamps_and_carry_pointers_and_model() {
    let tmp = Tmp::new("r5-pi-pointer");
    let path = tmp.path().join("20260101T000000_s1.jsonl");
    write(
        &path,
        &format!(
            "{}\n{}\n",
            json!({"type":"model_change","provider":"deepseek","modelId":"deepseek-v4-flash"}),
            json!({"type":"message","id":"abcd1234","message":{"role":"user","timestamp":"2026-10-11T15:04:05-04:00","content":"list the files"}})
        ),
    );
    let mut cursor = CaptureCursor::new();
    let rows = cursor.read(
        &path,
        "pi",
        Some("00000000-0000-4000-8000-000000000001"),
        true,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].event_ts.as_deref(),
        Some("2026-10-11T19:04:05.000Z")
    );
    assert_eq!(
        rows[0].created_at.as_deref(),
        Some("2026-10-11T19:04:05.000Z")
    );
    let row_extra = extra(&rows[0]);
    assert_eq!(
        row_extra
            .get("session_jsonl_path")
            .and_then(Value::as_str)
            .map(|value| value.ends_with("20260101T000000_s1.jsonl")),
        Some(true)
    );
    assert_eq!(
        row_extra
            .get("sessionJsonlPath")
            .and_then(Value::as_str)
            .map(|value| value.ends_with(".jsonl")),
        Some(true)
    );
    assert_eq!(
        row_extra.get("session_jsonl_line").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        row_extra.get("sessionJsonlLine").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        row_extra.get("model").and_then(Value::as_str),
        Some("deepseek-v4-flash")
    );
    assert_eq!(
        row_extra.get("provider").and_then(Value::as_str),
        Some("deepseek")
    );
    let wire = serde_json::to_string(&rows[0]).expect("wire");
    assert!(
        wire.contains(
            "\"sourceEvent\":\"message:user\",\"source\":\"pi-session\",\"session_jsonl_path\":"
        ),
        "{wire}"
    );
    assert!(
        wire.contains("\"session_jsonl_line\":1,\"sessionJsonlLine\":1,\"model\":\"deepseek-v4-flash\",\"provider\":\"deepseek\""),
        "{wire}"
    );
}

#[test]
fn pi_rows_without_a_model_or_path_still_carry_the_line_pointer() {
    let text = format!(
        "{}\n",
        json!({"type":"message","id":"abcd1234","message":{"role":"user","content":"hi"}})
    );
    let rows = pi_capture_text(&text);
    let row_extra = extra(&rows[0]);
    assert!(row_extra.get("session_jsonl_path").is_none());
    assert_eq!(
        row_extra.get("session_jsonl_line").and_then(Value::as_u64),
        Some(0)
    );
    assert!(row_extra.get("model").is_none());
    assert!(row_extra.get("provider").is_none());
}

#[test]
fn pi_caps_tool_args_only_with_a_pointer() {
    let tmp = Tmp::new("r5-pi-args");
    let path = tmp.path().join("20260101T000000_s2.jsonl");
    write(
        &path,
        &format!(
            "{}\n",
            json!({"type":"message","id":"tool","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"a".repeat(16100)}}]}})
        ),
    );
    let mut cursor = CaptureCursor::new();
    let rows = cursor.read(
        &path,
        "pi",
        Some("00000000-0000-4000-8000-000000000002"),
        true,
    );
    assert_eq!(rows.len(), 1);
    let raw = format!("{{\"command\":\"{}\"}}", "a".repeat(16100));
    let stored = rows[0]
        .tool_args
        .as_ref()
        .and_then(Value::as_str)
        .expect("string args");
    assert_eq!(stored.len(), 16_000);
    assert!(stored.starts_with("{\"command\":\"aaaa"));
    let row_extra = extra(&rows[0]);
    assert_eq!(
        row_extra
            .get("full_tool_args_length")
            .and_then(Value::as_u64),
        Some(protocol::js::utf16_len(&raw) as u64)
    );
    assert_eq!(
        row_extra.get("truncated").and_then(Value::as_bool),
        Some(true)
    );
    let wire = serde_json::to_string(&rows[0]).expect("wire");
    assert!(wire.contains("\"full_tool_args_length\":16114"), "{wire}");

    let plain = pi_capture_text(&format!(
        "{}\n",
        json!({"type":"message","id":"tool","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"a".repeat(16100)}}]}})
    ));
    assert_eq!(
        plain[0]
            .tool_args
            .as_ref()
            .and_then(|value| value.get("command"))
            .and_then(Value::as_str)
            .map(str::len),
        Some(16_100)
    );
    assert!(extra(&plain[0]).get("truncated").is_none());
}

#[test]
fn pi_reasoning_clip_keeps_the_lone_surrogate_on_the_wire() {
    let tmp = Tmp::new("r5-pi-think");
    let path = tmp.path().join("20260101T000000_s3.jsonl");
    write(
        &path,
        &format!(
            "{}\n",
            json!({"type":"message","id":"think","message":{"role":"assistant","content":[{"type":"thinking","thinking":format!("{}{}", "a".repeat(15_999), "\u{1F600}")}]}})
        ),
    );
    let mut cursor = CaptureCursor::new();
    let rows = cursor.read(
        &path,
        "pi",
        Some("00000000-0000-4000-8000-000000000003"),
        true,
    );
    assert_eq!(rows.len(), 1);
    let row_extra = extra(&rows[0]);
    assert_eq!(
        row_extra
            .get("full_reasoning_length")
            .and_then(Value::as_u64),
        Some(16_001)
    );
    assert_eq!(
        row_extra.get("truncated").and_then(Value::as_bool),
        Some(true)
    );
    let wire = serde_json::to_string(&rows[0]).expect("wire");
    assert!(wire.contains("\\ud83d"), "{wire}");
    assert!(!wire.contains('\u{FFFD}'), "{wire}");
}

#[test]
fn utf16_clip_serializes_the_lone_surrogate() {
    let text = format!("{}{}", "a".repeat(199), "\u{1F600}");
    let sliced = slice_text(&text, 0, Some(200));
    assert_eq!(sliced.len(), 200);
    let wire = serde_json::to_string(&sliced).expect("wire");
    assert_eq!(wire, format!("\"{}\\ud83d\"", "a".repeat(199)));
}

#[test]
fn summarize_turn_args_keeps_the_surrogate_on_the_wire() {
    let raw = json!({"command": format!("{}{}", "a".repeat(199), "\u{1F600}")});
    let args = summarize_turn_args(&raw).expect("args");
    let wire = serde_json::to_string(&args).expect("wire");
    assert!(wire.ends_with("\\ud83d\u{2026}\"}"), "{wire}");
}

#[test]
fn string_timestamps_parse_and_re_emit_as_iso() {
    let mut env = MapEnv::new();
    env.set("TZ", "America/New_York");
    assert_eq!(
        iso_from_date_text("2026-10-11T15:04:05-04:00", &env).as_deref(),
        Some("2026-10-11T19:04:05.000Z")
    );
    assert_eq!(
        iso_from_date_text("2026-10-11T15:04:05", &env).as_deref(),
        Some("2026-10-11T19:04:05.000Z")
    );
    assert_eq!(
        iso_from_date_text("2026-10-11T19:22:20.500Z", &env).as_deref(),
        Some("2026-10-11T19:22:20.500Z")
    );
    assert_eq!(
        iso_from_date_text("not a date", &env).as_deref(),
        Some("not a date")
    );
    assert_eq!(iso_from_date_text("", &env), None);
}

#[test]
fn home_discovery_uses_the_shared_home_dir() {
    let mut env = MapEnv::new();
    env.set("HOME", "/home/user");
    assert_eq!(Roots::from_env(&env).home, PathBuf::from("/home/user"));
    let fallback = Roots::from_env(&MapEnv::new()).home;
    assert!(!fallback.as_os_str().is_empty());
    assert_ne!(fallback, PathBuf::from("/"));
}
