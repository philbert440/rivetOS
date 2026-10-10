use crate::common;

use std::time::Duration;

use rivetos::{
    ConversationKeyParts, HookEventOptions, IDLE_IN_TRANSACTION_TIMEOUT_MS, IngestOptions, MapEnv,
    OccurrenceKey, STATEMENT_TIMEOUT_MS, apply_capture_guards, content_tuple_hash,
    create_capture_pool, ingest_hook_event, ingest_transcript, is_task_id, parse_transcript,
    resolve_conversation_key, resolve_task_context, session_key_from_id,
};

const TASK_UUID: &str = "3f1b5f6a-9c1e-4a2b-8d7e-0123456789ab";
const FALLBACK: &str = "claude-code:-home-rivet/abc123";

fn parts<'a>(
    override_key: Option<&'a str>,
    hook_session_id: Option<&'a str>,
    transcript_session_id: Option<&'a str>,
) -> ConversationKeyParts<'a> {
    ConversationKeyParts {
        override_key,
        hook_session_id,
        transcript_session_id,
        fallback_key: FALLBACK,
    }
}

fn user_line(cwd: Option<&str>, text: &str) -> serde_json::Value {
    let mut value = serde_json::json!({
        "type": "user",
        "sessionId": "sess-1",
        "uuid": format!("u-{text}"),
        "timestamp": "2026-10-02T12:00:00.000Z",
        "message": {"role": "user", "content": text}
    });
    if let Some(cwd) = cwd {
        value["cwd"] = serde_json::Value::String(cwd.to_string());
    }
    value
}

fn attach(harness: &common::DenHarness, mut opts: IngestOptions) -> IngestOptions {
    opts.env = Some(harness.env.clone());
    opts.exchange = Some(harness.exchange.clone());
    opts.spool_dir = Some(harness.spool());
    opts.now_iso = Some(common::fixed_clock());
    opts
}

fn attach_hook(harness: &common::DenHarness, mut opts: HookEventOptions) -> HookEventOptions {
    opts.env = Some(harness.env.clone());
    opts.exchange = Some(harness.exchange.clone());
    opts.spool_dir = Some(harness.spool());
    opts.now_iso = Some(common::fixed_clock());
    opts
}

fn sample_lines() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "type": "user",
            "sessionId": "sess-1",
            "uuid": "u1",
            "timestamp": "2026-09-01T00:00:00.000Z",
            "message": {"role": "user", "content": "hello"}
        }),
        serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "uuid": "a1",
            "timestamp": "2026-09-01T00:00:01.000Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "hi"},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
                ]
            }
        }),
        serde_json::json!({
            "type": "user",
            "sessionId": "sess-1",
            "uuid": "u2",
            "timestamp": "2026-09-01T00:00:02.000Z",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}]
            }
        }),
        serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "timestamp": "2026-09-01T00:00:03.000Z",
            "message": {"role": "assistant", "content": "no uuid"}
        }),
    ]
}

fn read_call(id: Option<&str>, input: serde_json::Value) -> serde_json::Value {
    let mut tool = serde_json::json!({"type": "tool_use", "name": "Read", "input": input});
    if let Some(id) = id {
        tool["id"] = serde_json::Value::String(id.to_string());
    }
    serde_json::json!({
        "type": "assistant",
        "sessionId": "sess-1",
        "uuid": format!("a-{}", id.unwrap_or("none")),
        "message": {"role": "assistant", "content": [tool]}
    })
}

fn multi_read(ids: &[(&str, &str)]) -> serde_json::Value {
    let content = ids
        .iter()
        .map(|(id, path)| {
            serde_json::json!({
                "type": "tool_use",
                "id": id,
                "name": "Read",
                "input": {"file_path": path}
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "type": "assistant",
        "sessionId": "sess-1",
        "uuid": "a-multi",
        "message": {"role": "assistant", "content": content}
    })
}

async fn post_tool(file: &std::path::Path, harness: &common::DenHarness, stem: &str) {
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "PostToolUse",
        "session_id": "sess-1",
        "transcript_path": file,
        "tool_name": "Read",
        "tool_input": {"file_path": "a"},
        "tool_response": "ok"
    }));
    opts.idempotency_key = Some(stem.to_string());
    opts.poll_ms = Some(20);
    opts.poll_for_ms = Some(1_000);
    ingest_hook_event(attach_hook(harness, opts)).await.unwrap();
}

#[test]
fn resolve_conversation_key_precedence() {
    assert_eq!(
        resolve_conversation_key(parts(Some("task:t-42"), Some("sess-1"), Some("sess-2"))),
        "task:t-42"
    );
    assert_eq!(
        resolve_conversation_key(parts(None, Some("sess-1"), Some("sess-2"))),
        session_key_from_id("sess-1")
    );
    assert_eq!(
        resolve_conversation_key(parts(None, None, Some("sess-2"))),
        session_key_from_id("sess-2")
    );
    assert_eq!(resolve_conversation_key(parts(None, None, None)), FALLBACK);
    assert_eq!(
        resolve_conversation_key(parts(Some(""), Some("sess-1"), None)),
        session_key_from_id("sess-1")
    );
}

#[test]
fn resolve_task_context_from_env() {
    let task_only = MapEnv::from_pairs(&[("RIVETOS_TASK_ID", TASK_UUID)]);
    let ctx = resolve_task_context(&task_only);
    assert!(ctx.session_key_override.is_none());
    assert_eq!(ctx.task_id.as_deref(), Some(TASK_UUID));
    assert!(!ctx.legacy_task_key);

    let legacy_key = format!("task:{TASK_UUID}");
    let legacy = MapEnv::from_pairs(&[("RIVETOS_SESSION_KEY", legacy_key.as_str())]);
    let ctx = resolve_task_context(&legacy);
    assert_eq!(
        ctx.session_key_override.as_deref(),
        Some(legacy_key.as_str())
    );
    assert_eq!(ctx.task_id.as_deref(), Some(TASK_UUID));
    assert!(ctx.legacy_task_key);

    let both = MapEnv::from_pairs(&[
        (
            "RIVETOS_SESSION_KEY",
            "task:00000000-0000-4000-8000-000000000000",
        ),
        ("RIVETOS_TASK_ID", TASK_UUID),
    ]);
    let ctx = resolve_task_context(&both);
    assert_eq!(ctx.task_id.as_deref(), Some(TASK_UUID));
    assert!(ctx.legacy_task_key);

    let den = MapEnv::from_pairs(&[("RIVETOS_SESSION_KEY", "chat-20260808-abcd")]);
    let ctx = resolve_task_context(&den);
    assert_eq!(
        ctx.session_key_override.as_deref(),
        Some("chat-20260808-abcd")
    );
    assert!(ctx.task_id.is_none());
    assert!(!ctx.legacy_task_key);

    let plain = MapEnv::from_pairs(&[]);
    let ctx = resolve_task_context(&plain);
    assert!(ctx.session_key_override.is_none());
    assert!(ctx.task_id.is_none());
    assert!(!ctx.legacy_task_key);
    let empty = MapEnv::from_pairs(&[("RIVETOS_SESSION_KEY", ""), ("RIVETOS_TASK_ID", "")]);
    assert!(resolve_task_context(&empty).task_id.is_none());
}

#[test]
fn is_task_id_accepts_either_case_and_rejects_the_rest() {
    assert!(is_task_id(Some(TASK_UUID)));
    assert!(is_task_id(Some(&TASK_UUID.to_ascii_uppercase())));
    for bad in [
        None,
        Some(""),
        Some("task-env-check"),
        Some(&format!("task:{TASK_UUID}")),
        Some(&format!("{TASK_UUID} ")),
    ] {
        assert!(!is_task_id(bad));
    }
}

#[test]
fn capture_pool_connect_guards_skip_without_a_live_connection() {
    let pool = create_capture_pool("postgres://example.invalid:1/db");
    assert_eq!(
        pool.idle_in_transaction_session_timeout,
        IDLE_IN_TRANSACTION_TIMEOUT_MS
    );
    assert_eq!(pool.statement_timeout, STATEMENT_TIMEOUT_MS);
    let sqls = apply_capture_guards();
    assert!(
        sqls.iter()
            .any(|sql| sql.contains("idle_in_transaction_session_timeout"))
    );
    assert!(sqls.iter().any(|sql| sql.contains("statement_timeout")));
    assert_eq!(sqls[0], "SET idle_in_transaction_session_timeout = '30s'");
    assert_eq!(sqls[1], "SET statement_timeout = '60s'");
    let _live = std::env::var_os("RIVETOS_PG_URL");
}

#[tokio::test]
async fn pg_url_does_not_open_a_pool() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(harness.dir.path(), "sess.jsonl", &sample_lines());
    let mut opts = IngestOptions::new(&file);
    opts.pg_url = Some("postgres://example.invalid:1/db".to_string());
    let error = match ingest_transcript(opts).await {
        Ok(_result) => panic!("pg ingest returned a result"),
        Err(error) => error,
    };
    assert_eq!(error, "capture postgres pool is not ported");
    assert!(harness.bodies.lock().unwrap().is_empty());
}

#[test]
fn parse_transcript_cwd_rules() {
    let dir = tempfile::tempdir().unwrap();
    let file = common::write_jsonl(
        dir.path(),
        "s.jsonl",
        &[user_line(Some("/srv/code/rivetos"), "hello")],
    );
    let parsed = parse_transcript(&file).unwrap();
    assert_eq!(parsed.cwd.as_deref(), Some("/srv/code/rivetos"));
    assert!(parsed.pr_url.is_none());

    let file = common::write_jsonl(
        dir.path(),
        "move.jsonl",
        &[
            user_line(Some("/srv/code/a"), "one"),
            user_line(Some("/srv/code/b"), "two"),
        ],
    );
    assert_eq!(
        parse_transcript(&file).unwrap().cwd.as_deref(),
        Some("/srv/code/a")
    );

    let file = common::write_jsonl(
        dir.path(),
        "empty.jsonl",
        &[
            user_line(Some(""), "one"),
            user_line(Some("/srv/code/b"), "two"),
        ],
    );
    assert_eq!(
        parse_transcript(&file).unwrap().cwd.as_deref(),
        Some("/srv/code/b")
    );
    let file = common::write_jsonl(
        dir.path(),
        "spaces.jsonl",
        &[
            user_line(Some("   "), "one"),
            user_line(Some("/srv/code/c"), "two"),
        ],
    );
    assert_eq!(
        parse_transcript(&file).unwrap().cwd.as_deref(),
        Some("/srv/code/c")
    );

    let file = common::write_jsonl(dir.path(), "none.jsonl", &[user_line(None, "hello")]);
    assert!(parse_transcript(&file).unwrap().cwd.is_none());

    let file = common::write_jsonl(
        dir.path(),
        "pr.jsonl",
        &[
            serde_json::json!({"type": "pr-link", "prUrl": "https://example.com/pr/1", "cwd": "/srv/code/x"}),
            user_line(Some("/srv/code/y"), "hi"),
        ],
    );
    let parsed = parse_transcript(&file).unwrap();
    assert_eq!(parsed.pr_url.as_deref(), Some("https://example.com/pr/1"));
    assert_eq!(parsed.cwd.as_deref(), Some("/srv/code/x"));
}

#[tokio::test]
async fn stable_event_ids_and_jsonl_pointers() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(harness.dir.path(), "sess.jsonl", &sample_lines());
    let absolute = std::path::absolute(&file).unwrap();
    let mut first_opts = attach(&harness, IngestOptions::new(&file));
    first_opts.task_id = Some("cccccccc-3333-4333-8333-cccccccccccc".to_string());
    let first = ingest_transcript(first_opts).await.unwrap();
    let second = ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    assert_eq!(first.session_key, "claude-code:sess-1");
    assert_eq!(second.session_key, first.session_key);
    assert!(!first.created);
    assert_eq!(first.conversation_id, "conv-1");
    let hash = content_tuple_hash(&OccurrenceKey {
        role: "assistant".to_string(),
        content: "no uuid".to_string(),
        tool_name: None,
        tool_args: None,
    });
    let expected = vec![
        "claude-code:sess-1:a1".to_string(),
        format!("claude-code:sess-1:occ:{hash}:0"),
        "claude-code:sess-1:tool:toolu_1".to_string(),
        "claude-code:sess-1:u1".to_string(),
    ];
    let first_body = harness.body(0);
    let second_body = harness.body(1);
    let ids = common::msgs(&first_body)
        .iter()
        .map(|message| message["event_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    let second_ids = common::msgs(&second_body)
        .iter()
        .map(|message| message["event_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(ids, expected);
    assert_eq!(second_ids, ids);
    assert_eq!(
        first_body["task_id"],
        "cccccccc-3333-4333-8333-cccccccccccc"
    );
    assert!(first_body.get("finalize").is_none());
    assert!(second_body.get("task_id").is_none());
    let tool = &common::msgs(&first_body)[2];
    assert_eq!(tool["tool_name"], "Bash");
    assert_eq!(tool["tool_result"], "ok");
    assert_eq!(
        tool["metadata"]["session_jsonl_path"],
        absolute.display().to_string()
    );
    assert_eq!(tool["metadata"]["session_jsonl_line"], 2);
    assert_eq!(
        common::msgs(&first_body)[3]["metadata"]["session_jsonl_line"],
        0
    );
}

#[tokio::test]
async fn session_end_finalizes() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(harness.dir.path(), "sess.jsonl", &sample_lines());
    let mut opts = attach(&harness, IngestOptions::new(&file));
    opts.mark_inactive = true;
    opts.event = Some("SessionEnd".to_string());
    ingest_transcript(opts).await.unwrap();
    assert_eq!(harness.body(0)["finalize"], true);
}

#[tokio::test]
async fn unreadable_hook_uses_the_spool_stem_and_the_writer_cap() {
    let harness = common::DenHarness::new();
    let prompt = "p".repeat(16_001);
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": prompt
    }));
    opts.idempotency_key = Some("stem1".to_string());
    ingest_hook_event(attach_hook(&harness, opts))
        .await
        .unwrap();
    let body = harness.body(0);
    let message = &common::msgs(&body)[0];
    assert_eq!(body["session_key"], "claude-code:sess-1");
    assert_eq!(message["event_id"], "claude-code:sess-1:hook:stem1");
    assert_eq!(message["content"], "p".repeat(16_000));
    assert!(message["metadata"].get("session_jsonl_path").is_none());
    assert_eq!(message["metadata"]["source"], "hook-only");
    assert_eq!(message["metadata"]["full_content_length"], 16_001);
    assert_eq!(message["metadata"]["truncated"], true);
}

#[tokio::test]
async fn identical_user_turns_keep_distinct_ids() {
    let harness = common::DenHarness::new();
    let user = serde_json::json!({
        "type": "user",
        "sessionId": "sess-1",
        "message": {"role": "user", "content": "continue"}
    });
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[
            user.clone(),
            serde_json::json!({
                "type": "assistant",
                "sessionId": "sess-1",
                "uuid": "a1",
                "message": {"role": "assistant", "content": "ok"}
            }),
            user,
        ],
    );
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    let ids = common::msgs(&harness.body(0))
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["event_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    let (hash0, n0) = common::occ_tail(&ids[0]).unwrap();
    let (hash1, n1) = common::occ_tail(&ids[1]).unwrap();
    assert_eq!(n0, "0");
    assert_eq!(n1, "1");
    assert_eq!(hash0, hash1);
    let again = common::msgs(&harness.body(1))
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["event_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(again, ids);
}

#[tokio::test]
async fn hook_prompt_reconciles_in_either_order() {
    let write = |dir: &std::path::Path| {
        common::write_jsonl(
            dir,
            "sess.jsonl",
            &[
                serde_json::json!({
                    "type": "user",
                    "sessionId": "sess-1",
                    "uuid": "u1",
                    "message": {"role": "user", "content": "continue"}
                }),
                serde_json::json!({
                    "type": "assistant",
                    "sessionId": "sess-1",
                    "uuid": "a1",
                    "message": {"role": "assistant", "content": "ok"}
                }),
                serde_json::json!({
                    "type": "user",
                    "sessionId": "sess-1",
                    "uuid": "u2",
                    "message": {"role": "user", "content": "continue"}
                }),
            ],
        )
    };
    let harness = common::DenHarness::new();
    let file = write(harness.dir.path());
    let mut hook = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": "continue",
        "transcript_path": &file
    }));
    hook.idempotency_key = Some("stem-a".to_string());
    ingest_hook_event(attach_hook(&harness, hook))
        .await
        .unwrap();
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    let hook_id = harness.body(0)["messages"][0]["event_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(hook_id, "claude-code:sess-1:u2");
    assert_eq!(
        harness.body(0)["messages"][0]["metadata"]["source"],
        "claude-code-hook"
    );
    let transcript_body = harness.body(1);
    let last_user = common::msgs(&transcript_body)
        .iter()
        .rfind(|message| message["role"] == "user")
        .unwrap()["event_id"]
        .as_str()
        .unwrap();
    assert_eq!(last_user, hook_id);

    let harness = common::DenHarness::new();
    let file = write(harness.dir.path());
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    let mut hook = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": "continue",
        "transcript_path": &file
    }));
    hook.idempotency_key = Some("stem-b".to_string());
    ingest_hook_event(attach_hook(&harness, hook))
        .await
        .unwrap();
    let transcript_body = harness.body(0);
    let transcript_user = common::msgs(&transcript_body)
        .iter()
        .rfind(|message| message["role"] == "user")
        .unwrap()["event_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(harness.body(1)["messages"][0]["event_id"], transcript_user);
}

#[tokio::test]
async fn tools_without_ids_get_occurrence_ids() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "uuid": "a-tools",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "name": "Read", "input": {"path": "a"}},
                    {"type": "tool_use", "name": "Read", "input": {"path": "a"}}
                ]
            }
        })],
    );
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    let posted = harness.body(0);
    let messages = common::msgs(&posted);
    assert_eq!(messages.len(), 2);
    let id0 = messages[0]["event_id"].as_str().unwrap();
    let id1 = messages[1]["event_id"].as_str().unwrap();
    assert_eq!(common::occ_tail(id0).unwrap().1, "0");
    assert_eq!(common::occ_tail(id1).unwrap().1, "1");
    assert!(!id0.contains(":tool:"));
    assert_eq!(messages[0]["role"], "tool");
    assert_eq!(messages[0]["tool_name"], "Read");
    assert_eq!(messages[0]["content"], "[tool call] Read");
}

#[tokio::test]
async fn missing_tool_transcript_uses_an_occurrence_id() {
    let harness = common::DenHarness::new();
    let missing = harness.dir.path().join("missing-claude-transcript.jsonl");
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "PostToolUse",
        "session_id": "sess-1",
        "transcript_path": missing,
        "tool_name": "Bash",
        "tool_input": {"command": "ls"},
        "tool_response": "ok"
    }));
    opts.idempotency_key = Some("stem-missing".to_string());
    opts.poll_for_ms = Some(120);
    opts.poll_ms = Some(40);
    ingest_hook_event(attach_hook(&harness, opts))
        .await
        .unwrap();
    let hash = content_tuple_hash(&OccurrenceKey {
        role: "tool".to_string(),
        content: "[tool call] Bash".to_string(),
        tool_name: Some("Bash".to_string()),
        tool_args: Some(serde_json::json!({"command": "ls"})),
    });
    let posted = harness.body(0);
    let message = &common::msgs(&posted)[0];
    assert_eq!(
        message["event_id"],
        format!("claude-code:sess-1:occ:{hash}:0")
    );
    assert_eq!(message["metadata"]["source"], "claude-code-hook");
}

#[tokio::test]
async fn post_tool_use_before_stop_shares_the_native_tool_id() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[read_call(
            Some("toolu_1"),
            serde_json::json!({"file_path": "a"}),
        )],
    );
    post_tool(&file, &harness, "stem-tool-hook-first").await;
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    let hook_body = harness.body(0);
    let stop_body = harness.body(1);
    let hook_id = hook_body["messages"][0]["event_id"]
        .as_str()
        .unwrap()
        .to_string();
    let stop_id = common::msgs(&stop_body)
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap()["event_id"]
        .as_str()
        .unwrap();
    assert_eq!(hook_id, "claude-code:sess-1:tool:toolu_1");
    assert_eq!(stop_id, hook_id);
    assert_eq!(
        harness.body(0)["messages"][0]["metadata"]["source"],
        "claude-code-hook"
    );
}

#[tokio::test]
async fn stop_before_post_tool_use_shares_the_native_tool_id() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[read_call(
            Some("toolu_1"),
            serde_json::json!({"file_path": "a"}),
        )],
    );
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    post_tool(&file, &harness, "stem-tool-stop-first").await;
    let stop_id = common::msgs(&harness.body(0))
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap()["event_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(stop_id, "claude-code:sess-1:tool:toolu_1");
    assert_eq!(harness.body(1)["messages"][0]["event_id"], stop_id);
}

#[tokio::test]
async fn two_identical_reads_keep_their_own_native_ids() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[read_call(
            Some("toolu_1"),
            serde_json::json!({"file_path": "a"}),
        )],
    );
    post_tool(&file, &harness, "stem-read-1").await;
    common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[
            read_call(Some("toolu_1"), serde_json::json!({"file_path": "a"})),
            read_call(Some("toolu_2"), serde_json::json!({"file_path": "a"})),
        ],
    );
    post_tool(&file, &harness, "stem-read-2").await;
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    assert_eq!(
        harness.body(0)["messages"][0]["event_id"],
        "claude-code:sess-1:tool:toolu_1"
    );
    assert_eq!(
        harness.body(1)["messages"][0]["event_id"],
        "claude-code:sess-1:tool:toolu_2"
    );
    let tools = common::msgs(&harness.body(2))
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["event_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        tools,
        vec![
            "claude-code:sess-1:tool:toolu_1".to_string(),
            "claude-code:sess-1:tool:toolu_2".to_string()
        ]
    );
}

#[tokio::test]
async fn a_read_without_a_tool_use_id_uses_the_occurrence_id() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[read_call(None, serde_json::json!({"file_path": "a"}))],
    );
    post_tool(&file, &harness, "stem-read-occ").await;
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    let hook_body = harness.body(0);
    let stop_body = harness.body(1);
    let hook_id = hook_body["messages"][0]["event_id"].as_str().unwrap();
    assert_eq!(common::occ_tail(hook_id).unwrap().1, "0");
    assert!(!hook_id.contains(":tool:"));
    let stop_id = common::msgs(&stop_body)
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap()["event_id"]
        .as_str()
        .unwrap();
    assert_eq!(stop_id, hook_id);
}

#[tokio::test]
async fn waits_until_the_matching_prompt_appears() {
    let harness = common::DenHarness::new();
    let user = |uuid: &str, content: &str| {
        serde_json::json!({
            "type": "user",
            "sessionId": "sess-1",
            "uuid": uuid,
            "message": {"role": "user", "content": content}
        })
    };
    let assistant = |uuid: &str| {
        serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "uuid": uuid,
            "message": {"role": "assistant", "content": "ok"}
        })
    };
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[user("u0", "older"), assistant("a0")],
    );
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": "continue",
        "transcript_path": &file
    }));
    opts.idempotency_key = Some("stem-wait".to_string());
    opts.poll_ms = Some(20);
    opts.poll_for_ms = Some(1_000);
    let opts = attach_hook(&harness, opts);
    let pending = tokio::spawn(async move { ingest_hook_event(opts).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[
            user("u0", "older"),
            assistant("a0"),
            user("u2", "continue"),
            assistant("a2"),
        ],
    );
    pending.await.unwrap().unwrap();
    let posted = harness.body(0);
    let message = &common::msgs(&posted)[0];
    assert_eq!(message["event_id"], "claude-code:sess-1:u2");
    assert_eq!(message["metadata"]["source"], "claude-code-hook");
}

#[tokio::test]
async fn binds_a_prompt_when_the_assistant_is_already_present() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[
            serde_json::json!({
                "type": "user",
                "sessionId": "sess-1",
                "uuid": "u1",
                "message": {"role": "user", "content": "continue"}
            }),
            serde_json::json!({
                "type": "assistant",
                "sessionId": "sess-1",
                "uuid": "a-late",
                "message": {"role": "assistant", "content": "already moved on"}
            }),
        ],
    );
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": "continue",
        "transcript_path": file
    }));
    opts.idempotency_key = Some("stem-late".to_string());
    opts.poll_ms = Some(20);
    opts.poll_for_ms = Some(80);
    ingest_hook_event(attach_hook(&harness, opts))
        .await
        .unwrap();
    let posted = harness.body(0);
    let messages = common::msgs(&posted);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["event_id"], "claude-code:sess-1:u1");
    assert_eq!(messages[0]["metadata"]["source"], "claude-code-hook");
}

#[tokio::test]
async fn post_tool_use_then_stop_binds_t1_and_t2() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[multi_read(&[("t1", "a"), ("t2", "b")])],
    );
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "PostToolUse",
        "session_id": "sess-1",
        "transcript_path": &file,
        "tool_name": "Read",
        "tool_input": {"file_path": "a"},
        "tool_response": "ok"
    }));
    opts.idempotency_key = Some("multi-a".to_string());
    opts.poll_ms = Some(20);
    opts.poll_for_ms = Some(200);
    ingest_hook_event(attach_hook(&harness, opts))
        .await
        .unwrap();
    ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    assert_eq!(common::msgs(&harness.body(0)).len(), 1);
    assert_eq!(
        harness.body(0)["messages"][0]["event_id"],
        "claude-code:sess-1:tool:t1"
    );
    let tools = common::msgs(&harness.body(1))
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["event_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        tools,
        vec![
            "claude-code:sess-1:tool:t1".to_string(),
            "claude-code:sess-1:tool:t2".to_string()
        ]
    );
    let mut ids = harness
        .bodies
        .lock()
        .unwrap()
        .iter()
        .map(|body| serde_json::from_str::<serde_json::Value>(body).unwrap())
        .flat_map(|body| {
            common::msgs(&body)
                .iter()
                .map(|message| message["event_id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(
        ids,
        vec![
            "claude-code:sess-1:tool:t1".to_string(),
            "claude-code:sess-1:tool:t2".to_string()
        ]
    );
}

#[tokio::test]
async fn explicit_tool_use_ids_stay_on_their_own_rows() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[multi_read(&[("t1", "a"), ("t2", "a")])],
    );
    for id in ["t1", "t2"] {
        let mut opts = HookEventOptions::new(serde_json::json!({
            "hook_event_name": "PostToolUse",
            "session_id": "sess-1",
            "transcript_path": &file,
            "tool_name": "Read",
            "tool_input": {"file_path": "a"},
            "tool_response": "ok",
            "tool_use_id": id
        }));
        opts.idempotency_key = Some(format!("same-{id}"));
        opts.poll_ms = Some(20);
        opts.poll_for_ms = Some(200);
        ingest_hook_event(attach_hook(&harness, opts))
            .await
            .unwrap();
    }
    assert_eq!(
        harness.body(0)["messages"][0]["event_id"],
        "claude-code:sess-1:tool:t1"
    );
    assert_eq!(
        harness.body(1)["messages"][0]["event_id"],
        "claude-code:sess-1:tool:t2"
    );
}

#[tokio::test]
async fn a_payload_without_a_tool_use_id_binds_the_last_match() {
    let harness = common::DenHarness::new();
    let file = common::write_jsonl(
        harness.dir.path(),
        "sess.jsonl",
        &[
            multi_read(&[("t1", "a"), ("t2", "a")]),
            serde_json::json!({
                "type": "assistant",
                "sessionId": "sess-1",
                "uuid": "a-done",
                "message": {"role": "assistant", "content": "done"}
            }),
        ],
    );
    let mut opts = HookEventOptions::new(serde_json::json!({
        "hook_event_name": "PostToolUse",
        "session_id": "sess-1",
        "transcript_path": file,
        "tool_name": "Read",
        "tool_input": {"file_path": "a"},
        "tool_response": "ok"
    }));
    opts.idempotency_key = Some("no-id".to_string());
    opts.poll_ms = Some(20);
    opts.poll_for_ms = Some(200);
    ingest_hook_event(attach_hook(&harness, opts))
        .await
        .unwrap();
    let posted = harness.body(0);
    let messages = common::msgs(&posted);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["event_id"], "claude-code:sess-1:tool:t2");
    assert_eq!(messages[0]["metadata"]["source"], "claude-code-hook");
}

#[tokio::test]
async fn missing_transcript_is_skipped() {
    let harness = common::DenHarness::new();
    let opts = attach(
        &harness,
        IngestOptions::new(harness.dir.path().join("missing.jsonl")),
    );
    let result = ingest_transcript(opts).await.unwrap();
    assert_eq!(
        result.skipped.as_deref(),
        Some("transcript file does not exist")
    );
    assert_eq!(result.inserted, 0);
    assert!(harness.bodies.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_empty_transcript_skips() {
    let harness = common::DenHarness::new();
    let file = harness.dir.path().join("empty.jsonl");
    std::fs::write(&file, "\n").unwrap();
    let result = ingest_transcript(attach(&harness, IngestOptions::new(&file)))
        .await
        .unwrap();
    assert_eq!(result.skipped.as_deref(), Some("nothing to ingest"));
}
