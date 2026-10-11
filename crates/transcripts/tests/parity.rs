#[path = "common/mod.rs"]
mod common;

use serde_json::json;
use transcripts::turn::{LastBlock, Role, ToolStatus};
use transcripts::{
    CaptureMessage, DEFAULT_TRANSCRIPT_MAX_BYTES, Store, claude_capture_text,
    claude_turns_from_lines, codex_capture_text, codex_turns_from_lines, cowork_capture_lines,
    cursor_capture_objects, cursor_turns_from_objects, grok_capture_updates, grok_turns_from_lines,
    hermes_capture_rows, kimi_capture_text, kimi_turns_from_lines, objects_from_text,
    pi_capture_text, pi_turns_from_lines, qwen_capture_text,
};

use common::{Tmp, sqlite, touch, write};

const CLAUDE_SESSION: &str = include_str!("fixtures/claude/session.jsonl");
const CLAUDE_AGENT: &str = include_str!("fixtures/claude/agent-sample.jsonl");
const GROK_CHAT: &str = include_str!("fixtures/grok/chat_history.jsonl");
const GROK_UPDATES: &str = include_str!("fixtures/grok/updates.jsonl");
const KIMI_WIRE: &str = include_str!("fixtures/kimi/wire.jsonl");
const CODEX_ROLLOUT: &str = include_str!("fixtures/codex/rollout.jsonl");
const PI_SESSION: &str = include_str!("fixtures/pi/session.jsonl");
const QWEN_SESSION: &str = include_str!("fixtures/qwen/qwen-code-tool-turn.jsonl");
const CURSOR_SESSION: &str = include_str!("fixtures/cursor/transcript.jsonl");
const COWORK_SESSION: &str = include_str!("fixtures/cowork/transcript.jsonl");
const TRUNCATED_LAST: &str = include_str!("fixtures/edge/truncated-last.jsonl");

fn pairs(turns: &[transcripts::Turn]) -> Vec<(&str, &str)> {
    turns
        .iter()
        .map(|turn| {
            let role = match turn.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            (role, turn.text.as_str())
        })
        .collect()
}

fn captured(messages: &[CaptureMessage]) -> Vec<(&str, &str)> {
    messages
        .iter()
        .map(|message| (message.role.as_str(), message.content.as_str()))
        .collect()
}

fn lines_of(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect()
}

#[test]
fn claude_fixture_keeps_capture_rows_the_display_fold_drops() {
    let objects = objects_from_text(CLAUDE_SESSION);
    let turns = claude_turns_from_lines(&objects);
    assert_eq!(
        pairs(&turns),
        vec![
            ("user", "hello claude"),
            ("assistant", "hi there"),
            ("user", "second turn")
        ]
    );
    let assistant = &turns[1];
    assert_eq!(assistant.thinking.as_deref(), Some("x"));
    assert_eq!(assistant.last_block, Some(LastBlock::Thinking));
    assert_eq!(
        assistant.usage.as_ref().map(|row| (
            row.prompt_tokens,
            row.completion_tokens,
            row.cached_tokens
        )),
        Some((1250, 40, 200))
    );
    assert_eq!(
        captured(&claude_capture_text(CLAUDE_SESSION)),
        vec![
            ("user", "<user_info>noise</user_info>"),
            ("user", "hello claude"),
            ("assistant", "hi there"),
            ("user", "sidechain skip me"),
            ("user", "second turn"),
        ]
    );
}

#[test]
fn claude_subagent_file_is_describable_and_not_resumable() {
    let tmp = Tmp::new("parity-agent");
    let parent = "11111111-1111-4111-8111-111111111111";
    let agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let base = tmp.path().join("claude");
    let file = base
        .join("projects/-work")
        .join(parent)
        .join("subagents")
        .join(format!("agent-{agent}.jsonl"));
    write(&file, CLAUDE_AGENT);
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", base.to_string_lossy());
    let store = Store::new(roots);
    assert!(!store.session_exists("claude", agent));
    let described = store
        .describe_claude(agent, Some(parent))
        .expect("agent row");
    assert_eq!(described.parent_session_id.as_deref(), Some(parent));
    let read = store.read_claude(agent, Some(parent));
    assert_eq!(
        pairs(&read.turns),
        vec![("user", "parent stays"), ("user", "agent tail")]
    );
    let text = std::fs::read_to_string(&file).expect("agent text");
    assert_eq!(
        captured(&claude_capture_text(&text)),
        vec![("user", "parent stays"), ("user", "agent tail")]
    );
}

#[test]
fn grok_session_dir_splits_chat_history_and_updates() {
    let tmp = Tmp::new("parity-grok");
    let id = "00000000-0000-4000-8000-000000000041";
    let dir = tmp.path().join("grok/sessions/work").join(id);
    write(&dir.join("chat_history.jsonl"), GROK_CHAT);
    write(&dir.join("updates.jsonl"), GROK_UPDATES);
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", tmp.path().join("grok").to_string_lossy());
    let store = Store::new(roots);
    let read = store.read_grok(id);
    assert_eq!(
        pairs(&read.turns),
        vec![("user", "plan the migrate"), ("assistant", "ok, planning")]
    );
    let updates = std::fs::read_to_string(dir.join("updates.jsonl")).expect("updates");
    assert_eq!(
        captured(&read.messages),
        vec![
            ("user", "plan the migrate"),
            ("assistant", "[thinking] need a plan"),
            ("assistant", "ok, planning"),
        ]
    );
    assert_eq!(
        captured(&grok_capture_updates(&updates)),
        captured(&read.messages)
    );
    assert_eq!(
        pairs(&grok_turns_from_lines(&objects_from_text(GROK_CHAT))),
        pairs(&read.turns)
    );
}

#[test]
fn hermes_rotated_session_display_matches_capture_rows() {
    let tmp = Tmp::new("parity-hermes");
    let db = tmp.path().join("hermes/state.db");
    sqlite(
        &db,
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
         CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);
         INSERT INTO sessions VALUES ('sess_old', 1000, 2000), ('sess_new', 3000, NULL);
         INSERT INTO messages VALUES
           ('sess_old', 'user', 'ended turn', 1000),
           ('sess_new', 'user', 'rotated in', 3000),
           ('sess_new', 'assistant', 'still going', 3001);",
    );
    let mut roots = tmp.roots();
    roots.set_env("HERMES_HOME", tmp.path().join("hermes").to_string_lossy());
    let store = Store::new(roots);
    let listed = store.list(&["hermes"], 10, &[]);
    assert_eq!(
        listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["sess_new", "sess_old"]
    );
    assert_eq!(listed[1].title, "ended turn");
    let read = store.read_hermes("sess_new");
    assert_eq!(
        pairs(&read.turns),
        vec![("user", "rotated in"), ("assistant", "still going")]
    );
    let conn = transcripts::db::open_readonly(&db).expect("db");
    let rows = transcripts::db::query_maps(
        &conn,
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC",
        &[&"sess_new"],
    )
    .expect("rows");
    assert_eq!(
        captured(&hermes_capture_rows(&rows)),
        vec![("user", "rotated in"), ("assistant", "still going")]
    );
    assert_eq!(
        pairs(&store.read_hermes("sess_old").turns),
        vec![("user", "ended turn")]
    );
}

#[test]
fn kimi_wire_display_folds_what_capture_splits() {
    let tmp = Tmp::new("parity-kimi");
    let id = "session_00000000-0000-4000-8000-000000000042";
    let dir = tmp.path().join("kimi/sessions/wd").join(id);
    write(&dir.join("agents/main/wire.jsonl"), KIMI_WIRE);
    let mut roots = tmp.roots();
    roots.set_env("KIMI_CODE_HOME", tmp.path().join("kimi").to_string_lossy());
    let store = Store::new(roots);
    let read = store.read_kimi(id);
    assert_eq!(pairs(&read.turns), vec![("assistant", "looks good")]);
    assert_eq!(read.turns[0].thinking.as_deref(), Some("weighing it"));
    assert_eq!(read.turns[0].last_block, Some(LastBlock::Text));
    assert_eq!(
        captured(&kimi_capture_text(KIMI_WIRE)),
        vec![
            ("assistant", "[thinking] weighing it"),
            ("assistant", "looks good")
        ]
    );
    assert_eq!(
        pairs(&kimi_turns_from_lines(&objects_from_text(KIMI_WIRE))),
        pairs(&read.turns)
    );
}

#[test]
fn kimi_dir_without_state_exists_but_does_not_describe() {
    let tmp = Tmp::new("parity-kimi-fresh");
    let id = "session_00000000-0000-4000-8000-000000000099";
    let stamp = tmp.path().join("kimi/sessions/wd").join(id).join("keep");
    write(&stamp, "");
    touch(&stamp, 1_000);
    let mut roots = tmp.roots();
    roots.set_env("KIMI_CODE_HOME", tmp.path().join("kimi").to_string_lossy());
    let store = Store::new(roots);
    assert!(store.session_exists("kimi", id));
    assert!(store.describe_kimi(id).is_none());
    sqlite(&tmp.path().join("unused.db"), "CREATE TABLE t(id INTEGER);");
}

#[test]
fn codex_rollout_skips_the_developer_row_in_display_and_capture() {
    let tmp = Tmp::new("parity-codex");
    let id = "00000000-0000-4000-8000-000000000020";
    let file = tmp
        .path()
        .join("codex/sessions/2026/03/01")
        .join(format!("rollout-2026-03-01T00-00-00-{id}.jsonl"));
    write(&file, CODEX_ROLLOUT);
    let mut roots = tmp.roots();
    roots.set_env("CODEX_HOME", tmp.path().join("codex").to_string_lossy());
    let store = Store::new(roots);
    let read = store.read_codex(id);
    assert_eq!(
        pairs(&read.turns),
        vec![("user", "review the rollout parser"), ("assistant", "ok")]
    );
    assert_eq!(
        read.turns[1].thinking.as_deref(),
        Some("checking the items")
    );
    assert_eq!(read.turns[1].complete, Some(true));
    assert_eq!(
        captured(&codex_capture_text(CODEX_ROLLOUT)),
        vec![
            ("user", "review the rollout parser"),
            ("assistant", "[thinking] checking the items"),
            ("assistant", "ok"),
        ]
    );
    assert_eq!(
        pairs(&codex_turns_from_lines(&objects_from_text(CODEX_ROLLOUT))),
        pairs(&read.turns)
    );
}

#[test]
fn opencode_sql_display_and_joined_parts_capture() {
    let tmp = Tmp::new("parity-opencode");
    let id = "ses_01K8ABCDEFGHIJKLMNOPQRSTUV";
    let db = tmp.path().join(".local/share/opencode/opencode.db");
    let user_data = json!({"role":"user","time":{"created":1_700_000_000_100_i64}}).to_string();
    let asst_data = json!({"role":"assistant","modelID":"glm-5.3-flash","providerID":"zai","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":10,"write":0}},"time":{"created":1_700_000_000_200_i64,"completed":1_700_000_000_250_i64}}).to_string();
    let sql = format!(
        "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('{id}', 'review the opencode driver', '/work/app', NULL, 1700000000000, 1700000100000);
         INSERT INTO message VALUES ('msg_user', '{id}', 1700000000100, 1700000000100, '{user_data}'), ('msg_asst', '{id}', 1700000000200, 1700000000250, '{asst_data}');
         INSERT INTO part VALUES
           ('prt_1', 'msg_user', '{id}', 1700000000110, '{{\"type\":\"text\",\"text\":\"review the diff\",\"time\":{{\"end\":1}}}}'),
           ('prt_think', 'msg_asst', '{id}', 1700000000210, '{{\"type\":\"reasoning\",\"text\":\"weighing it\",\"time\":{{\"end\":1}}}}'),
           ('prt_tool', 'msg_asst', '{id}', 1700000000220, '{{\"type\":\"tool\",\"tool\":\"Bash\",\"state\":{{\"status\":\"completed\",\"input\":{{\"command\":\"git diff\"}},\"output\":\"\"}}}}'),
           ('prt_text', 'msg_asst', '{id}', 1700000000230, '{{\"type\":\"text\",\"text\":\"looks good\",\"time\":{{\"end\":1}}}}');"
    );
    sqlite(&db, &sql);
    let mut roots = tmp.roots();
    roots.cwd = std::path::PathBuf::from("/");
    let store = Store::new(roots);
    let read = store.read_opencode(id);
    assert_eq!(
        pairs(&read.turns),
        vec![("user", "review the diff"), ("assistant", "looks good")]
    );
    assert_eq!(read.turns[1].thinking.as_deref(), Some("weighing it"));
    assert_eq!(
        read.turns[1].usage.as_ref().map(|row| (
            row.prompt_tokens,
            row.completion_tokens,
            row.cached_tokens
        )),
        Some((110, 25, 10))
    );
    assert_eq!(
        captured(&read.messages),
        vec![
            ("user", "review the diff"),
            ("assistant", "[thinking] weighing it"),
            ("tool", "[tool-result] Bash"),
            ("assistant", "looks good"),
        ]
    );
    assert_eq!(read.messages[2].tool_name.as_deref(), Some("Bash"));
    assert_eq!(read.messages[2].tool_result.as_deref(), Some(""));
}

#[test]
fn pi_qwen_cursor_and_cowork_fixtures_share_one_parse() {
    let tmp = Tmp::new("parity-rest");
    let pi_id = "00000000-0000-4000-8000-000000000031";
    let qwen_id = "22222222-2222-4222-8222-222222222222";
    let cursor_id = "33333333-3333-4333-8333-333333333333";
    let cowork_id = "11111111-1111-4111-8111-111111111111";
    let pi_home = tmp.path().join("pi");
    let qwen_home = tmp.path().join("qwen");
    let cursor_home = tmp.path().join("cursor");
    let cowork_root = tmp.path().join("cowork");
    write(
        &pi_home
            .join("sessions/--work--")
            .join(format!("2026-01-01T00-00-00-000Z_{pi_id}.jsonl")),
        PI_SESSION,
    );
    write(
        &qwen_home
            .join("projects/demo/chats")
            .join(format!("{qwen_id}.jsonl")),
        QWEN_SESSION,
    );
    write(
        &cursor_home
            .join("projects/demo/agent-transcripts")
            .join(cursor_id)
            .join(format!("{cursor_id}.jsonl")),
        CURSOR_SESSION,
    );
    let meta = cowork_root.join("local-agent-mode-sessions/task-1/local_task.json");
    write(
        &meta,
        &json!({"cliSessionId": cowork_id, "title": "cowork hello", "createdAt": 1000, "lastActivityAt": 2000, "cwd": "/work"}).to_string(),
    );
    write(
        &meta
            .parent()
            .expect("meta dir")
            .join("local_task/.claude/projects/-work")
            .join(format!("{cowork_id}.jsonl")),
        COWORK_SESSION,
    );
    let mut roots = tmp.roots();
    roots.pi_home = Some(pi_home);
    roots.qwen_home = Some(qwen_home);
    roots.cursor_home = Some(cursor_home);
    roots.cowork_roots = Some(vec![cowork_root]);
    let store = Store::new(roots);
    let pi = store.read_pi(pi_id);
    assert_eq!(
        pairs(&pi.turns),
        vec![("user", "pi hello"), ("assistant", "pi reply")]
    );
    assert_eq!(
        captured(&pi_capture_text(PI_SESSION)),
        pairs(&pi_turns_from_lines(&objects_from_text(PI_SESSION)))
    );
    let qwen = store.read_qwen(qwen_id);
    assert_eq!(
        qwen.turns[0].text,
        "Use run_shell_command to run: echo tool-sample-ok."
    );
    let tool = qwen.turns[1]
        .tools
        .as_ref()
        .and_then(|tools| tools.first())
        .expect("qwen tool");
    assert_eq!(tool.name, "run_shell_command");
    assert_eq!(tool.status, ToolStatus::Done);
    assert_eq!(qwen.turns[2].text, "tool-sample-ok");
    let qwen_caps = qwen_capture_text(QWEN_SESSION);
    assert_eq!(qwen_caps[0].content, qwen.turns[0].text);
    assert_eq!(qwen_caps[1].role, "tool");
    assert_eq!(qwen_caps[1].tool_name.as_deref(), Some("run_shell_command"));
    assert_eq!(qwen_caps[2].content, "[tool-result] run_shell_command");
    assert_eq!(qwen_caps[2].tool_result.as_deref(), Some("tool-sample-ok"));
    assert_eq!(qwen_caps[3].content, "tool-sample-ok");
    let cursor = store.read_cursor(cursor_id);
    assert_eq!(
        pairs(&cursor.turns),
        vec![
            ("user", "add cursor to the hub"),
            ("assistant", "cursor reply")
        ]
    );
    assert_eq!(
        captured(&cursor_capture_objects(&objects_from_text(CURSOR_SESSION))),
        pairs(&cursor_turns_from_objects(&objects_from_text(
            CURSOR_SESSION
        )))
    );
    let cowork = store.read_transcript(&format!("cowork:{cowork_id}"));
    assert_eq!(
        pairs(&cowork.turns),
        vec![("user", "cowork hello"), ("assistant", "cowork reply")]
    );
    assert_eq!(
        captured(&cowork_capture_lines(&lines_of(COWORK_SESSION))),
        vec![("user", "cowork hello"), ("assistant", "cowork reply")]
    );
}

#[test]
fn edge_truncated_last_line_non_utf8_and_over_cap() {
    let objects = objects_from_text(TRUNCATED_LAST);
    assert_eq!(objects.len(), 1);
    assert_eq!(
        pairs(&claude_turns_from_lines(&objects)),
        vec![("user", "kept whole")]
    );
    assert_eq!(
        captured(&claude_capture_text(TRUNCATED_LAST)),
        vec![("user", "kept whole")]
    );

    let tmp = Tmp::new("parity-edge");
    let bad = tmp.path().join("bad.jsonl");
    let mut body = format!("{}\n", json!({"type":"user","message":{"content":"ok"}})).into_bytes();
    body.extend_from_slice(&[0xff, b'\n']);
    body.extend_from_slice(br#"{"type":"user","message":{"content":"cut"#);
    if let Some(parent) = bad.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(&bad, &body).expect("bytes");
    let parsed = transcripts::jsonl::read_jsonl(&bad, DEFAULT_TRANSCRIPT_MAX_BYTES);
    assert_eq!(parsed.objects.len(), 1);
    assert_eq!(
        pairs(&claude_turns_from_lines(&parsed.objects)),
        vec![("user", "ok")]
    );
    assert_eq!(
        captured(&claude_capture_text(&parsed.text)),
        vec![("user", "ok")]
    );

    let claude = tmp.path().join("claude");
    let id = "22222222-2222-4222-8222-222222222222";
    let over = claude.join("projects/-work").join(format!("{id}.jsonl"));
    let line = format!(
        "{}\n",
        json!({"type":"user","message":{"content":"tail line"}})
    );
    let mut fat = vec![b'x'; DEFAULT_TRANSCRIPT_MAX_BYTES as usize + 64];
    fat.push(b'\n');
    fat.extend(line.as_bytes());
    if let Some(parent) = over.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(&over, fat).expect("over cap");
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", claude.to_string_lossy());
    let store = Store::new(roots);
    let read = store.read_claude(id, None);
    assert!(read.truncated);
    assert_eq!(pairs(&read.turns), vec![("user", "tail line")]);
}
