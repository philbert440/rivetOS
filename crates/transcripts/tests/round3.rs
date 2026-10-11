#[path = "common/mod.rs"]
mod common;

use std::io::Write;

use serde_json::json;
use transcripts::{
    CaptureCursor, CaptureMessage, DEFAULT_TRANSCRIPT_MAX_BYTES, Store, TranscriptTail,
    claude_capture_text_for, codex_capture_text_for, cowork_capture_lines_for,
    cursor_capture_objects_for, grok_capture_updates_for, objects_from_text, pi_capture_text,
    pi_capture_text_for, qwen_capture_text_for, timeutil::iso_from_ms,
};

use common::{Tmp, sqlite, touch, write};

#[test]
fn cursor_numbers_emitted_pieces_and_stamps_the_file() {
    let tmp = Tmp::new("r3-cursor");
    let id = "44444444-4444-4444-8444-444444444444";
    let home = tmp.path().join("cursor");
    let file = home
        .join("projects/demo/agent-transcripts")
        .join(id)
        .join(format!("{id}.jsonl"));
    write(
        &file,
        "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"image\"},{\"type\":\"text\",\"text\":\"visible\"},{\"type\":\"tool_use\",\"input\":{\"path\":\"a\"}},{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"path\":\"a.txt\"}}]}}\n",
    );
    touch(&file, 1_700_000_000_000);
    let mut roots = tmp.roots();
    roots.cursor_home = Some(home);
    let store = Store::new(roots);
    let read = store.read_cursor(id);
    assert_eq!(read.messages.len(), 2);
    assert_eq!(
        read.messages[0].event_id.as_deref(),
        Some(format!("cursor:{id}:line:0:part:0").as_str())
    );
    assert_eq!(read.messages[0].content, "visible");
    assert_eq!(
        read.messages[1].event_id.as_deref(),
        Some(format!("cursor:{id}:line:0:part:1").as_str())
    );
    assert_eq!(read.messages[1].tool_name.as_deref(), Some("Read"));
    assert_eq!(read.messages[1].content, "Read");
    assert!(read.messages[1].tool_result.is_none());
    let extra = read.messages[0].extra.as_ref().expect("extra");
    assert_eq!(
        extra
            .get("session_jsonl_path")
            .and_then(|value| value.as_str()),
        Some(file.to_string_lossy().as_ref())
    );
    assert_eq!(
        extra
            .get("native_event_id")
            .and_then(|value| value.as_str()),
        Some("line:0:part:0")
    );
    assert_eq!(
        read.messages[0].created_at.as_deref(),
        Some(iso_from_ms(1_700_000_000_000).as_str())
    );
    let hinted = cursor_capture_objects_for(
        &objects_from_text("{\"role\":\"user\",\"message\":{\"content\":\"hi\"}}\n"),
        Some("sess-hint"),
    );
    assert_eq!(
        hinted[0].event_id.as_deref(),
        Some("cursor:sess-hint:line:0:part:0")
    );
    assert!(hinted[0].created_at.is_none());
    assert!(
        hinted[0]
            .extra
            .as_ref()
            .and_then(|extra| extra.get("session_jsonl_path"))
            .is_none()
    );
}

#[test]
fn over_cap_capture_uses_full_file_line_numbers() {
    let tmp = Tmp::new("r3-window");
    let id = "55555555-5555-4555-8555-555555555555";
    let home = tmp.path().join("cursor");
    let file = home
        .join("projects/demo/agent-transcripts")
        .join(id)
        .join(format!("{id}.jsonl"));
    let head =
        "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"head\"}]}}\n";
    let tail = "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"image\"},{\"type\":\"text\",\"text\":\"visible\"}]}}\n";
    let mut body = head.as_bytes().to_vec();
    body.extend(std::iter::repeat_n(
        b'x',
        DEFAULT_TRANSCRIPT_MAX_BYTES as usize + 64,
    ));
    body.push(b'\n');
    body.extend(tail.as_bytes());
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).expect("parents");
    }
    std::fs::write(&file, body).expect("write");
    touch(&file, 1_700_000_000_000);
    let mut roots = tmp.roots();
    roots.cursor_home = Some(home);
    let store = Store::new(roots);
    let read = store.read_cursor(id);
    assert!(read.truncated);
    assert_eq!(read.turns.len(), 1);
    assert_eq!(read.turns[0].text, "visible");
    assert_eq!(read.messages.len(), 2);
    assert_eq!(
        read.messages[0].event_id.as_deref(),
        Some(format!("cursor:{id}:line:0:part:0").as_str())
    );
    assert_eq!(read.messages[0].content, "head");
    assert_eq!(
        read.messages[1].event_id.as_deref(),
        Some(format!("cursor:{id}:line:2:part:0").as_str())
    );
    assert_eq!(read.messages[1].content, "visible");
    assert_eq!(
        read.messages[0].created_at.as_deref(),
        Some(iso_from_ms(1_700_000_000_000 - 2_000).as_str())
    );
    assert_eq!(
        read.messages[1].created_at.as_deref(),
        Some(iso_from_ms(1_700_000_000_000).as_str())
    );
}

#[test]
fn pi_session_and_tool_names_survive_the_next_chunk() {
    let tmp = Tmp::new("r3-pi");
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let path = tmp.path().join("pi.jsonl");
    write(&path, &format!("{}\n", json!({"type":"session","id": id})));
    let mut cursor = CaptureCursor::new();
    assert!(cursor.read(&path, "pi", None, false).is_empty());
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    writeln!(
        file,
        "{}",
        json!({"type":"message","id":"abcd1234","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}]}})
    )
    .expect("call");
    drop(file);
    let called = cursor.read(&path, "pi", Some("other-hint"), false);
    assert_eq!(
        called[0].event_id.as_deref(),
        Some(format!("pi:{id}:abcd1234:tool:t1").as_str())
    );
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    writeln!(
        file,
        "{}",
        json!({"type":"message","id":"ee55ff66","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"a.txt"}]}})
    )
    .expect("result");
    drop(file);
    let result = cursor.read(&path, "pi", Some("other-hint"), false);
    assert_eq!(
        result[0].event_id.as_deref(),
        Some(format!("pi:{id}:ee55ff66").as_str())
    );
    assert_eq!(result[0].content, "[tool-result] bash");
    assert_eq!(result[0].tool_name.as_deref(), Some("bash"));
    assert_eq!(result[0].tool_result.as_deref(), Some("a.txt"));
}

#[test]
fn pi_hint_fills_until_a_native_header_and_tool_text_is_extracted() {
    let hinted = pi_capture_text_for(
        &format!(
            "{}\n",
            json!({"type":"message","id":"abcd1234","message":{"role":"user","content":[{"type":"text","text":"hi"}]}})
        ),
        Some("hint-token"),
    );
    assert_eq!(
        hinted[0].event_id.as_deref(),
        Some("pi:hint-token:abcd1234")
    );
    let session = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let text = format!(
        "{}\n{}\n{}\n",
        json!({"type":"session","id": session}),
        json!({"type":"message","id":"cc33dd44","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}]}}),
        json!({"type":"message","id":"ee55ff66","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"a.txt"}]}})
    );
    let rows = pi_capture_text_for(&text, Some("hint-token"));
    let found = rows
        .iter()
        .find(|row| row.event_id.as_deref() == Some(format!("pi:{session}:ee55ff66").as_str()))
        .expect("result");
    assert_eq!(found.content, "[tool-result] bash");
    assert_eq!(found.tool_result.as_deref(), Some("a.txt"));
    let image = pi_capture_text(&format!(
        "{}\n",
        json!({"type":"message","id":"img","message":{"role":"toolResult","toolName":"bash","content":[{"type":"image"}]}})
    ));
    assert_eq!(image[0].content, "[tool-result] bash");
    assert!(image[0].tool_result.is_none());
    let object = pi_capture_text(&format!(
        "{}\n",
        json!({"type":"message","id":"obj","message":{"role":"toolResult","toolName":"bash","result":{"ok":true}}})
    ));
    assert_eq!(object[0].tool_result.as_deref(), Some("{\"ok\":true}"));
}

#[test]
fn shrink_resets_the_jsonl_cursor_and_a_same_size_rewrite_does_not() {
    let tmp = Tmp::new("r3-rewrite");
    let stem = "A".repeat(80);
    let file = tmp.path().join("t.jsonl");
    let first = format!(
        "{}\n{}\n",
        json!({"type":"user","message":{"content": stem}}),
        json!({"type":"user","message":{"content":"old"}})
    );
    let second = format!(
        "{}\n{}\n",
        json!({"type":"user","message":{"content": stem}}),
        json!({"type":"user","message":{"content":"new-body"}})
    );
    assert!(second.len() > first.len());
    assert_eq!(&first.as_bytes()[..64], &second.as_bytes()[..64]);
    std::fs::write(&file, first.as_bytes()).expect("write");
    let mut tail = TranscriptTail::new();
    let read = tail.read_new_jsonl(&file);
    assert_eq!(read.offset, first.len() as u64);
    std::fs::write(&file, second.as_bytes()).expect("rewrite");
    let again = tail.read_new_jsonl(&file);
    assert!(!again.text.contains(&stem), "{}", again.text);
    assert!(!again.text.contains("new-body"), "{}", again.text);
    let short = format!(
        "{}\n",
        json!({"type":"user","message":{"content":"shrunk"}})
    );
    assert!(short.len() < second.len());
    std::fs::write(&file, short.as_bytes()).expect("shrink");
    let shrunk = tail.read_new_jsonl(&file);
    assert!(shrunk.text.contains("shrunk"), "{}", shrunk.text);
    let mut cursor = CaptureCursor::new();
    let captured = cursor.read(&file, "claude", None, false);
    assert!(captured.iter().any(|row| row.content.contains("shrunk")));
    std::fs::write(&file, short.as_bytes()).expect("same");
    let quiet = cursor.read(&file, "claude", None, false);
    assert!(quiet.is_empty());
    let other = tmp.path().join("u.jsonl");
    let gone = tmp.path().join("gone.jsonl");
    std::fs::write(&other, short.as_bytes()).expect("other");
    std::fs::rename(&file, &gone).expect("rename away");
    std::fs::rename(&other, &file).expect("rename in");
    let renamed = cursor.read(&file, "claude", None, false);
    assert!(renamed.is_empty());
    let smaller = format!("{}\n", json!({"type":"user","message":{"content":"x"}}));
    assert!(smaller.len() < short.len());
    std::fs::write(&file, smaller.as_bytes()).expect("cursor shrink");
    let reset = cursor.read(&file, "claude", None, false);
    assert!(reset.iter().any(|row| row.content == "x"));
    let append_path = tmp.path().join("append.jsonl");
    std::fs::write(&append_path, first.as_bytes()).expect("append base");
    let mut append_tail = TranscriptTail::new();
    let _ = append_tail.read_new_jsonl(&append_path);
    let mut extra = std::fs::OpenOptions::new()
        .append(true)
        .open(&append_path)
        .expect("append");
    writeln!(
        extra,
        "{}",
        json!({"type":"user","message":{"content":"appended"}})
    )
    .expect("line");
    drop(extra);
    let more = append_tail.read_new_jsonl(&append_path);
    assert!(more.text.contains("appended"), "{}", more.text);
    assert!(!more.text.contains(&stem), "{}", more.text);
}

#[test]
fn session_hints_pass_through_capture_helpers() {
    let claude = claude_capture_text_for(
        &format!(
            "{}\n",
            json!({"type":"user","uuid":"abc","message":{"role":"user","content":"hi"}})
        ),
        Some("sess-hint"),
    );
    assert_eq!(claude[0].event_id.as_deref(), Some("abc"));
    assert_eq!(claude[0].session_id.as_deref(), Some("sess-hint"));
    let qwen_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let qwen = qwen_capture_text_for(
        &format!(
            "{}\n",
            json!({"type":"user","provenance":"real_user","uuid":"abc","message":{"parts":[{"text":"hi"}]}})
        ),
        Some(qwen_id),
    );
    assert_eq!(
        qwen[0].event_id.as_deref(),
        Some(format!("qwen-code:{qwen_id}:abc").as_str())
    );
    let codex_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let codex = codex_capture_text_for(
        &format!(
            "{}\n",
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}})
        ),
        Some(codex_id),
    );
    assert_eq!(codex[0].session_id.as_deref(), Some(codex_id));
    assert!(
        codex[0]
            .event_id
            .as_deref()
            .unwrap_or("")
            .contains(codex_id),
        "{:?}",
        codex[0].event_id
    );
    let grok = grok_capture_updates_for(
        &format!(
            "{}\n",
            json!({"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"},"_meta":{"promptIndex":0}},"_meta":{"eventId":"native-user","agentTimestampMs":1000}}})
        ),
        Some("sess"),
    );
    assert!(
        grok[0]
            .event_id
            .as_deref()
            .unwrap_or("")
            .starts_with("grok-build:sess:"),
        "{:?}",
        grok[0].event_id
    );
    let cowork = cowork_capture_lines_for(
        &[json!({"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}).to_string()],
        Some("cli-9"),
    );
    assert_eq!(cowork[0].session_id.as_deref(), Some("cli-9"));
}

#[test]
fn opencode_cursor_advances_across_a_skipped_part() {
    let tmp = Tmp::new("r3-opencode");
    let id = "ses_01K8ABCDEFGHIJKLMNOPQRSTUV";
    let db = tmp.path().join(".local/share/opencode/opencode.db");
    let user_data = json!({"role":"user"}).to_string();
    let sql = format!(
        "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('{id}', 'title', '/work', NULL, 1000, 5000);
         INSERT INTO message VALUES ('msg_user', '{id}', 1000, 1000, '{user_data}');
         INSERT INTO part VALUES
           ('prt_step', 'msg_user', '{id}', 100000, '{{\"type\":\"step-start\"}}'),
           ('prt_text', 'msg_user', '{id}', 50000, '{{\"type\":\"text\",\"text\":\"hello\"}}');"
    );
    sqlite(&db, &sql);
    let mut roots = tmp.roots();
    roots.cwd = std::path::PathBuf::from("/");
    let store = Store::new(roots);
    let read = store.read_opencode(id);
    assert_eq!(read.messages.len(), 1);
    assert_eq!(read.messages[0].content, "hello");
    assert!(
        read.seen_stamps.iter().any(|(part, _)| *part == 100_000),
        "{:?}",
        read.seen_stamps
    );
    let mut tail = TranscriptTail::new();
    let picked = tail.opencode_since(id, &read.messages, &read.seen_stamps);
    assert_eq!(picked, vec![0]);
    let mut later = CaptureMessage::new("user", "later");
    later.extra = Some(json!({"partTimeUpdated": 60_000, "messageTimeUpdated": 1}));
    assert!(tail.opencode_since(id, &[later], &[]).is_empty());
}
