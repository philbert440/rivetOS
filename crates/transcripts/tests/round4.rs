use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use transcripts::fsutil::set_mtime;
use transcripts::roots::Roots;
use transcripts::{CaptureCursor, Store, pi_capture_text, timeutil::iso_from_ms};

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

    fn roots(&self) -> Roots {
        Roots::isolated(&self.0)
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

fn touch(path: &Path, ms: u64) {
    assert!(set_mtime(path, ms), "mtime {}", path.display());
}

fn extra(row: &transcripts::CaptureMessage) -> &serde_json::Map<String, Value> {
    row.extra
        .as_ref()
        .and_then(Value::as_object)
        .expect("extra")
}

#[test]
fn pi_keeps_thinking_beside_text_and_gives_each_tool_its_own_id() {
    let text = format!(
        "{}\n",
        json!({"type":"message","id":"abcd1234","message":{"role":"assistant","stopReason":"toolUse","usage":{"input":3,"output":1,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":4},"content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"hello"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}},{"type":"toolUse","id":"t2","name":"read","arguments":{"path":"a"}}]}})
    );
    let rows = pi_capture_text(&text);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].role, "assistant");
    assert_eq!(rows[0].content, "hello");
    assert_eq!(rows[0].event_id.as_deref(), Some("pi:unknown:abcd1234"));
    let assistant = extra(&rows[0]);
    assert_eq!(
        assistant.get("sourceEvent").and_then(Value::as_str),
        Some("message:assistant")
    );
    assert_eq!(
        assistant.get("source").and_then(Value::as_str),
        Some("pi-session")
    );
    assert_eq!(
        assistant.get("partType").and_then(Value::as_str),
        Some("think")
    );
    assert_eq!(
        assistant.get("reasoning").and_then(Value::as_str),
        Some("plan")
    );
    assert!(assistant.get("truncated").is_none());
    assert!(assistant.get("full_reasoning_length").is_none());
    assert_eq!(
        assistant.get("stopReason").and_then(Value::as_str),
        Some("toolUse")
    );
    let usage = assistant
        .get("usage")
        .and_then(Value::as_object)
        .expect("usage");
    assert_eq!(usage.get("input").and_then(Value::as_i64), Some(3));
    assert_eq!(usage.get("output").and_then(Value::as_i64), Some(1));
    assert_eq!(usage.get("totalTokens").and_then(Value::as_i64), Some(4));
    assert_eq!(
        rows[1].event_id.as_deref(),
        Some("pi:unknown:abcd1234:tool:t1")
    );
    assert_eq!(rows[1].content, "[tool] bash");
    assert_eq!(rows[1].tool_name.as_deref(), Some("bash"));
    let first_tool = extra(&rows[1]);
    assert_eq!(
        first_tool.get("sourceEvent").and_then(Value::as_str),
        Some("message:toolCall")
    );
    assert_eq!(first_tool.get("callId").and_then(Value::as_str), Some("t1"));
    assert!(first_tool.get("usage").is_none());
    assert!(first_tool.get("stopReason").is_none());
    assert_eq!(
        rows[2].event_id.as_deref(),
        Some("pi:unknown:abcd1234:tool:t2")
    );
    assert_eq!(rows[2].content, "[tool] read");
    assert!(extra(&rows[2]).get("usage").is_none());
}

#[test]
fn pi_tool_only_usage_lands_on_the_first_call_and_a_missing_id_uses_tool() {
    let text = format!(
        "{}\n{}\n{}\n",
        json!({"type":"message","id":"onlytool","message":{"role":"assistant","stopReason":"toolUse","usage":{"input":5,"output":1},"content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{}},{"type":"tool_call","id":"t2","name":"read","arguments":{}}]}}),
        json!({"type":"message","id":"noid","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{}}]}}),
        json!({"type":"message","id":"emptyid","message":{"role":"assistant","content":[{"type":"toolCall","id":"","toolCallId":"","name":"bash","arguments":{}}]}})
    );
    let rows = pi_capture_text(&text);
    assert_eq!(
        rows[0].event_id.as_deref(),
        Some("pi:unknown:onlytool:tool:t1")
    );
    assert_eq!(
        extra(&rows[0])
            .get("usage")
            .and_then(Value::as_object)
            .and_then(|usage| usage.get("input"))
            .and_then(Value::as_i64),
        Some(5)
    );
    assert_eq!(
        extra(&rows[0]).get("stopReason").and_then(Value::as_str),
        Some("toolUse")
    );
    assert_eq!(
        rows[1].event_id.as_deref(),
        Some("pi:unknown:onlytool:tool:t2")
    );
    assert!(extra(&rows[1]).get("usage").is_none());
    assert_eq!(rows[2].event_id.as_deref(), Some("pi:unknown:noid:tool"));
    assert!(extra(&rows[2]).get("callId").is_none());
    assert_eq!(rows[3].event_id.as_deref(), Some("pi:unknown:emptyid:tool"));
}

#[test]
fn pi_thinking_only_keeps_empty_content_and_the_cap_needs_a_file_pointer() {
    let only = format!(
        "{}\n",
        json!({"type":"message","id":"think","message":{"role":"assistant","content":[{"type":"thinking","thinking":"only"}]}})
    );
    let rows = pi_capture_text(&only);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "");
    assert_eq!(
        extra(&rows[0]).get("reasoning").and_then(Value::as_str),
        Some("only")
    );
    assert!(!rows[0].content.contains("[thinking]"));
    let long = "a".repeat(16_001);
    let uncapped = format!(
        "{}\n",
        json!({"type":"message","id":"long","message":{"role":"assistant","content":[{"type":"thinking","thinking": long}]}})
    );
    let plain = pi_capture_text(&uncapped);
    assert_eq!(
        extra(&plain[0])
            .get("reasoning")
            .and_then(Value::as_str)
            .map(str::len),
        Some(16_001)
    );
    assert!(extra(&plain[0]).get("truncated").is_none());
    let tmp = Tmp::new("r4-pi-cap");
    let path = tmp.path().join("pi.jsonl");
    write(&path, &uncapped);
    let mut cursor = CaptureCursor::new();
    let capped = cursor.read(&path, "pi", None, false);
    let meta = extra(&capped[0]);
    assert_eq!(
        meta.get("reasoning").and_then(Value::as_str).map(str::len),
        Some(16_000)
    );
    assert_eq!(
        meta.get("full_reasoning_length").and_then(Value::as_u64),
        Some(16_001)
    );
    assert_eq!(meta.get("truncated").and_then(Value::as_bool), Some(true));
}

#[test]
fn cursor_store_ignores_a_trailing_partial_line() {
    let tmp = Tmp::new("r4-cursor-partial");
    let id = "66666666-6666-4666-8666-666666666666";
    let home = tmp.path().join("cursor");
    let file = home
        .join("projects/demo/agent-transcripts")
        .join(id)
        .join(format!("{id}.jsonl"));
    let mut body = String::new();
    body.push_str("{\"role\":\"user\",\"message\":{\"content\":\"first\"}}\n");
    body.push_str("{\"role\":\"assistant\",\"message\":{\"content\":\"second\"}}\n");
    body.push_str("{\"role\":\"user\",\"message\":{\"content\":\"partial\"}");
    write(&file, &body);
    touch(&file, 1_700_000_000_000);
    let mut roots = tmp.roots();
    roots.cursor_home = Some(home);
    let store = Store::new(roots);
    let read = store.read_cursor(id);
    assert_eq!(read.messages.len(), 2);
    assert_eq!(read.messages[0].content, "first");
    assert_eq!(read.messages[1].content, "second");
    assert!(read.messages.iter().all(|row| row.content != "partial"));
    assert_eq!(
        read.messages[0].created_at.as_deref(),
        Some(iso_from_ms(1_700_000_000_000 - 1_000).as_str())
    );
    assert_eq!(
        read.messages[1].created_at.as_deref(),
        Some(iso_from_ms(1_700_000_000_000).as_str())
    );
}
