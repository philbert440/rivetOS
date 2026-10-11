#[path = "common/mod.rs"]
mod common;

use std::io::Write;

use serde_json::{Value, json};
use transcripts::{
    CaptureCursor, CaptureMessage, DEFAULT_TRANSCRIPT_MAX_BYTES, Store, TranscriptTail,
    capture_snapshot, kimi_capture_text_for,
};

use common::{Tmp, sqlite, touch, write};

fn grok_user(text: &str, ms: i64) -> String {
    format!(
        "{}\n",
        json!({
            "params": {
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": {"type": "text", "text": text},
                    "_meta": {"promptIndex": 0}
                },
                "_meta": {"eventId": "native-user", "agentTimestampMs": ms}
            }
        })
    )
}

fn grok_prompt() -> String {
    format!("{}\n", json!({"params": {"_meta": {"promptId": "p1"}}}))
}

fn grok_agent(text: &str, ms: i64) -> String {
    format!(
        "{}\n",
        json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": text}
                },
                "_meta": {"promptId": "p1", "eventId": "native-agent", "agentTimestampMs": ms}
            }
        })
    )
}

fn pad_line() -> String {
    let mut body = String::from("{\"pad\":\"");
    body.push_str(&"x".repeat(DEFAULT_TRANSCRIPT_MAX_BYTES as usize + 64));
    body.push_str("\"}\n");
    body
}

#[test]
fn grok_over_cap_ordinals_follow_the_whole_file() {
    let tmp = Tmp::new("r2-grok");
    let id = "00000000-0000-4000-8000-0000000000aa";
    let dir = tmp.path().join("grok/sessions/work").join(id);
    let history = dir.join("chat_history.jsonl");
    write(
        &history,
        &format!(
            "{}\n",
            json!({"type":"user","content":"<user_query>shown</user_query>"})
        ),
    );
    touch(&history, 1_700_000_000_000);
    let ms = 1_700_000_000_000_i64;
    let mut updates = grok_user("head", ms);
    updates.push_str(&grok_prompt());
    updates.push_str(&pad_line());
    updates.push_str(&grok_agent("tail", ms + 1_000));
    let updates_path = dir.join("updates.jsonl");
    write(&updates_path, &updates);
    let parsed = transcripts::jsonl::read_jsonl(&updates_path, DEFAULT_TRANSCRIPT_MAX_BYTES);
    assert!(parsed.truncated);
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", tmp.path().join("grok").to_string_lossy());
    let store = Store::new(roots);
    let read = store.read_grok(id);
    assert_eq!(read.turns[0].text, "shown");
    let ids: Vec<_> = read
        .messages
        .iter()
        .map(|message| message.event_id.clone().unwrap_or_default())
        .collect();
    assert_eq!(
        ids,
        vec![
            format!("grok-build:{id}:0"),
            format!("grok-build:{id}:10003"),
        ]
    );
    assert_eq!(read.messages[0].ordinal, Some(0));
    assert_eq!(read.messages[1].ordinal, Some(10_003));
    assert_eq!(
        read.messages[0].created_at.as_deref(),
        Some(transcripts::timeutil::iso_from_ms(ms).as_str())
    );
    let native = read.messages[0]
        .extra
        .as_ref()
        .and_then(|extra| extra.get("native_event_id"))
        .and_then(Value::as_str);
    assert_eq!(native, Some("native-user"));
    assert_eq!(
        read.messages[0]
            .extra
            .as_ref()
            .and_then(|extra| extra.get("source"))
            .and_then(Value::as_str),
        Some("grok-jsonl")
    );
    let snap = capture_snapshot(&updates_path, "grok", Some(id));
    assert_eq!(
        snap.iter()
            .map(|message| message.ordinal)
            .collect::<Vec<_>>(),
        read.messages
            .iter()
            .map(|message| message.ordinal)
            .collect::<Vec<_>>()
    );
}

#[test]
fn grok_two_chunks_match_one_shot_ordinals() {
    let tmp = Tmp::new("r2-grok-chunks");
    let path = tmp.path().join("updates.jsonl");
    let ms = 1_700_000_000_000_i64;
    write(
        &path,
        &format!("{}{}", grok_user("head", ms), grok_prompt()),
    );
    let mut cursor = CaptureCursor::new();
    let first = cursor.read(&path, "grok", Some("sess"), false);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    write!(file, "{}{}", pad_line(), grok_agent("tail", ms + 1_000)).expect("append body");
    drop(file);
    let second = cursor.read(&path, "grok", Some("sess"), false);
    let mut got = first;
    got.extend(second);
    let snap = capture_snapshot(&path, "grok", Some("sess"));
    let ordinals = |rows: &[CaptureMessage]| {
        rows.iter()
            .map(|message| message.ordinal)
            .collect::<Vec<_>>()
    };
    let events = |rows: &[CaptureMessage]| {
        rows.iter()
            .map(|message| message.event_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ordinals(&got), ordinals(&snap));
    assert_eq!(events(&got), events(&snap));
    assert_eq!(events(&snap)[0].as_deref(), Some("grok-build:sess:0"));
    assert_eq!(events(&snap)[1].as_deref(), Some("grok-build:sess:10003"));
}

#[test]
fn cursor_store_event_id_uses_the_session() {
    let tmp = Tmp::new("r2-cursor");
    let id = "33333333-3333-4333-8333-333333333333";
    let home = tmp.path().join("cursor");
    let file = home
        .join("projects/demo/agent-transcripts")
        .join(id)
        .join(format!("{id}.jsonl"));
    write(
        &file,
        "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"add cursor to the hub\"}]}}\n",
    );
    let mut roots = tmp.roots();
    roots.cursor_home = Some(home);
    let store = Store::new(roots);
    let read = store.read_cursor(id);
    assert_eq!(
        read.messages[0].event_id.as_deref(),
        Some(format!("cursor:{id}:line:0:part:0").as_str())
    );
    assert_eq!(read.messages[0].session_id.as_deref(), Some(id));
}

#[test]
fn kimi_hint_fills_a_wire_line_without_a_session() {
    let text = "{\"type\":\"context.append_loop_event\",\"time\":1000,\"event\":{\"type\":\"content.part\",\"uuid\":\"abc\",\"part\":{\"type\":\"text\",\"text\":\"hi\"}}}\n";
    let rows = kimi_capture_text_for(text, Some("session_hint"));
    let material = rows[0]
        .extra
        .as_ref()
        .and_then(|extra| extra.get("hashMaterial"))
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(
        material.starts_with("session_hint\u{0}assistant\u{0}hi\u{0}"),
        "{material}"
    );
    assert!(rows[0].event_id.is_none());
}

#[test]
fn cowork_later_chunk_attaches_the_tool_result() {
    let tmp = Tmp::new("r2-cowork");
    let path = tmp.path().join("cowork.jsonl");
    write(
        &path,
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}\n",
    );
    let mut cursor = CaptureCursor::new();
    let first = cursor.read(&path, "cowork", Some("cli-1"), true);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].event_id.as_deref(), Some("cowork:cli-1:tool:t1"));
    assert!(first[0].tool_result.is_none());
    assert_eq!(
        first[0]
            .extra
            .as_ref()
            .and_then(|extra| extra.get("pending_result"))
            .and_then(Value::as_bool),
        Some(true)
    );
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    writeln!(
        file,
        "{}",
        json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}})
    )
    .expect("result");
    drop(file);
    let second = cursor.read(&path, "cowork", Some("cli-1"), true);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].event_id.as_deref(), Some("cowork:cli-1:tool:t1"));
    assert_eq!(second[0].tool_name.as_deref(), Some("Bash"));
    assert_eq!(second[0].tool_result.as_deref(), Some("ok"));
    assert_eq!(second[0].session_id.as_deref(), Some("cli-1"));
    assert_eq!(
        second[0]
            .extra
            .as_ref()
            .and_then(|extra| extra.get("pending_result"))
            .and_then(Value::as_bool),
        Some(false)
    );
}

#[test]
fn opencode_messages_carry_model_metadata_and_two_cursors() {
    let tmp = Tmp::new("r2-opencode");
    let id = "ses_01K8ABCDEFGHIJKLMNOPQRSTUV";
    let db = tmp.path().join(".local/share/opencode/opencode.db");
    let user_data = json!({"role":"user"}).to_string();
    let asst_data = json!({"role":"assistant","modelID":"claude-sonnet","providerID":"anthropic","tokens":{"input":100},"cost":1}).to_string();
    let sql = format!(
        "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('{id}', 'title', '/work', NULL, 1000, 5000);
         INSERT INTO message VALUES ('msg_user', '{id}', 1100, 1100, '{user_data}'), ('msg_asst', '{id}', 1200, 1800, '{asst_data}');
         INSERT INTO part VALUES
           ('prt_user', 'msg_user', '{id}', 100000, '{{\"type\":\"text\",\"text\":\"hello\",\"time\":{{\"end\":1}}}}'),
           ('prt_text', 'msg_asst', '{id}', 140000, '{{\"type\":\"text\",\"text\":\"done\",\"time\":{{\"end\":1}}}}');"
    );
    sqlite(&db, &sql);
    let mut roots = tmp.roots();
    roots.cwd = std::path::PathBuf::from("/");
    let store = Store::new(roots);
    let read = store.read_opencode(id);
    assert_eq!(read.messages.len(), 2);
    let asst = &read.messages[1];
    let extra = asst.extra.as_ref().expect("extra");
    assert_eq!(
        extra.get("source").and_then(Value::as_str),
        Some("opencode-sqlite")
    );
    assert_eq!(
        extra.get("modelID").and_then(Value::as_str),
        Some("claude-sonnet")
    );
    assert_eq!(
        extra.get("providerID").and_then(Value::as_str),
        Some("anthropic")
    );
    assert_eq!(
        extra
            .get("tokens")
            .and_then(|value| value.get("input"))
            .and_then(Value::as_i64),
        Some(100)
    );
    assert_eq!(extra.get("cost").and_then(Value::as_i64), Some(1));
    assert_eq!(
        extra.get("messageId").and_then(Value::as_str),
        Some("msg_asst")
    );
    assert_eq!(
        extra.get("messageTimeUpdated").and_then(Value::as_i64),
        Some(1800)
    );
    assert_eq!(
        extra.get("partTimeUpdated").and_then(Value::as_i64),
        Some(140_000)
    );
    let mut tail = TranscriptTail::new();
    let picked = tail.opencode_since(id, &read.messages, &read.seen_stamps);
    assert_eq!(picked, vec![0, 1]);
    let again = tail.opencode_since(id, &read.messages, &read.seen_stamps);
    assert_eq!(again, vec![1]);
}

#[test]
fn codex_session_meta_survives_a_later_chunk() {
    let tmp = Tmp::new("r2-codex");
    let id = "00000000-0000-4000-8000-0000000000bb";
    let path = tmp.path().join("rollout.jsonl");
    write(
        &path,
        &format!("{}\n", json!({"type":"session_meta","payload":{"id": id}})),
    );
    let mut cursor = CaptureCursor::new();
    let _ = cursor.read(&path, "codex", None, false);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    writeln!(
        file,
        "{}",
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"later"}]}})
    )
    .expect("row");
    drop(file);
    let rows = cursor.read(&path, "codex", None, false);
    assert_eq!(rows[0].session_id.as_deref(), Some(id));
    assert_eq!(
        rows[0].event_id.as_deref(),
        Some(format!("codex:{id}:line:1").as_str())
    );
}
