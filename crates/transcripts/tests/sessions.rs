#[path = "common/mod.rs"]
mod common;

use std::path::Path;

use transcripts::identity::{
    REGISTRY_PROBE, TRANSCRIPT_PROBE, codex_native_id, hermes_announced_id, hermes_timestamp_id, kimi_session_id,
    opencode_native_id,
};
use transcripts::nest::DelegatedLink;
use transcripts::text::{is_bare_slash_command, strip_pasted_content_wrapper};
use transcripts::timeutil::parse_date_ms;
use transcripts::{
    DEFAULT_TRANSCRIPT_MAX_BYTES, Roots, Store, TranscriptTail, claude_turns_from_text, merge_transcript_window,
};
use transcripts::turn::Role;

use common::{Tmp, sqlite, touch, write};

const LIMIT: usize = 100;

fn store(roots: Roots) -> Store {
    Store::new(roots)
}

fn claude_line(text: &str) -> String {
    format!("{}\n", serde_json::json!({"type":"user","message":{"content": text}}))
}

#[test]
fn date_parse_matches_known_epoch() {
    assert_eq!(parse_date_ms("2023-11-14T22:13:20.000Z"), Some(1_700_000_000_000));
    assert_eq!(parse_date_ms("2023-11-14T22:14:20.000Z"), Some(1_700_000_060_000));
    assert!(parse_date_ms("2026-07-07T00:00:00.000Z").unwrap() > 1_700_000_000_000);
}

#[test]
fn probe_orders_are_both_exposed() {
    assert_eq!(
        TRANSCRIPT_PROBE,
        ["claude", "grok", "codex", "hermes", "kimi", "opencode", "pi", "qwen", "cursor", "cowork"]
    );
    assert_eq!(
        REGISTRY_PROBE,
        [
            "claude-code",
            "grok-build",
            "hermes",
            "kimi-code",
            "pi",
            "qwen-code",
            "cursor",
            "cowork",
            "opencode",
            "codex",
        ]
    );
    assert!(codex_native_id("11111111-1111-4111-8111-111111111111"));
    assert!(!codex_native_id("ses_abcdefghijklmnopqrst"));
    assert!(opencode_native_id("ses_abcdefghijklmnopqrst"));
    assert!(hermes_timestamp_id("20260707_120000_ab12cd"));
    assert!(hermes_announced_id("anything-else"));
    assert!(!hermes_announced_id("unknown-12"));
    assert!(!hermes_announced_id(""));
    assert!(kimi_session_id("session_11111111-1111-4111-8111-111111111111"));
    assert!(!kimi_session_id("11111111-1111-4111-8111-111111111111"));
}

#[test]
fn lists_claude_sessions_newest_first_with_titles() {
    let tmp = Tmp::new("claude");
    let base = tmp.path().join("claude");
    let a = base.join("projects/-home-rivet/11111111-1111-1111-1111-111111111111.jsonl");
    let b = base.join("projects/-rivet-shared/22222222-2222-2222-2222-222222222222.jsonl");
    write(&a, &format!("{}\n{}\n", serde_json::json!({"type":"session","mode":"interactive"}), serde_json::json!({"type":"user","message":{"content":"fix the flaky test"}})));
    write(&b, &format!("{}\n", serde_json::json!({"type":"user","message":{"content":[{"type":"text","text":"deploy the thing"}]}})));
    write(&base.join("projects/-home-rivet/notes.txt"), "ignore me");
    touch(&a, 1_000);
    touch(&b, 2_000);
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", base.to_string_lossy());
    let store = store(roots);
    let sessions = store.list(&["claude", "shell"], LIMIT, &[]);
    assert_eq!(
        sessions.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111"]
    );
    assert_eq!(sessions[0].command, "claude");
    assert_eq!(sessions[0].title, "deploy the thing");
    assert_eq!(sessions[1].title, "fix the flaky test");
    assert!(sessions[0].updated_at > sessions[1].updated_at);
}

#[test]
fn describe_claude_agrees_on_times() {
    let tmp = Tmp::new("claude-agree");
    let base = tmp.path().join("claude");
    let file = base.join("projects/-rivet/22222222-2222-2222-2222-222222222222.jsonl");
    write(&file, &format!("{}\n", serde_json::json!({"type":"user","message":{"content":"deploy the thing"}})));
    touch(&file, 2_000);
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", base.to_string_lossy());
    let store = store(roots);
    let id = "22222222-2222-2222-2222-222222222222";
    let listed = store.list(&["claude"], LIMIT, &[]).into_iter().find(|row| row.id == id).unwrap();
    let described = store.describe_claude(id, None).unwrap();
    assert_eq!(described.created_at, listed.created_at);
    assert_eq!(described.updated_at, listed.updated_at);
    assert_eq!(described.title, listed.title);
}

#[test]
fn describe_claude_rejects_unknown_and_unsafe() {
    let tmp = Tmp::new("claude-miss");
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", tmp.path().to_string_lossy());
    let store = store(roots);
    assert!(store.describe_claude("33333333-3333-3333-3333-333333333333", None).is_none());
    assert!(store.describe_claude("../escape", None).is_none());
    assert!(store.describe_claude("", None).is_none());
}

#[test]
fn nests_claude_subagents_and_keeps_parent_under_cap() {
    let tmp = Tmp::new("claude-sub");
    let base = tmp.path().join("claude");
    let slug = base.join("projects/-home-work");
    let parent = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let agent = "a906621c1fcf0c74a";
    let legacy = "aside_question-38babac48c0a60a1";
    let workflow = "wfagent1";
    let parent_file = slug.join(format!("{parent}.jsonl"));
    let other_file = slug.join(format!("{other}.jsonl"));
    let agent_file = slug.join(parent).join("subagents").join(format!("agent-{agent}.jsonl"));
    let legacy_file = slug.join(parent).join(format!("agent-{legacy}.jsonl"));
    let wf_file = slug.join(parent).join("subagents/workflows/run-1").join(format!("agent-{workflow}.jsonl"));
    write(&parent_file, &claude_line("parent task"));
    write(&other_file, &claude_line("other task"));
    write(
        &agent_file,
        &format!(
            "{}\n{}\n",
            serde_json::json!({"type":"user","isSidechain":true,"agentId":agent,"sessionId":parent,"message":{"role":"user","content":"look through the repo"}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"agentId":agent,"message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"found it"}]}})
        ),
    );
    write(&slug.join(parent).join("subagents").join(format!("agent-{agent}.meta.json")), "{\"agentType\":\"general-purpose\"}\n");
    write(&slug.join(parent).join("subagents/not-an-agent.jsonl"), "{}\n");
    write(
        &legacy_file,
        &format!(
            "{}\n{}\n",
            serde_json::json!({"type":"user","isSidechain":true,"agentType":"Explore","message":{"role":"user","content":"explore the tree"}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"explored"}]}})
        ),
    );
    write(
        &wf_file,
        &format!(
            "{}\n{}\n",
            serde_json::json!({"type":"user","isSidechain":true,"subagent_type":"Plan","message":{"role":"user","content":"draft a plan"}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"planned"}]}})
        ),
    );
    touch(&parent_file, 1_000);
    touch(&other_file, 5_000);
    touch(&wf_file, 7_000);
    touch(&legacy_file, 8_000);
    touch(&agent_file, 9_000);
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", base.to_string_lossy());
    let store = store(roots);
    let sessions = store.list(&["claude"], LIMIT, &[]);
    let agent_row = sessions.iter().find(|row| row.id == agent).unwrap();
    assert_eq!(agent_row.parent_session_id.as_deref(), Some(parent));
    assert_eq!(agent_row.agent_name.as_deref(), Some("general-purpose"));
    assert_eq!(agent_row.model.as_deref(), Some("claude-sonnet-4-6"));
    assert_eq!(agent_row.title, "look through the repo");
    let legacy_row = sessions.iter().find(|row| row.id == legacy).unwrap();
    assert_eq!(legacy_row.parent_session_id.as_deref(), Some(parent));
    assert_eq!(legacy_row.agent_name.as_deref(), Some("Explore"));
    assert_eq!(legacy_row.title, "explore the tree");
    let wf_row = sessions.iter().find(|row| row.id == workflow).unwrap();
    assert_eq!(wf_row.agent_name.as_deref(), Some("Plan"));
    assert_eq!(wf_row.title, "draft a plan");
    assert!(sessions.iter().find(|row| row.id == parent).unwrap().parent_session_id.is_none());
    assert!(sessions.iter().all(|row| row.id != "not-an-agent"));
    assert!(store.session_exists("claude", parent));
    assert!(!store.session_exists("claude", agent));
    let transcript = store.read_transcript(&format!("claude-code:{agent}"));
    assert_eq!(transcript.command, "claude");
    assert_eq!(transcript.turns.iter().map(|turn| turn.text.as_str()).collect::<Vec<_>>(), ["look through the repo", "found it"]);
    let capped = store.list(&["claude"], 1, &[]);
    let ids: Vec<_> = capped.iter().map(|row| row.id.as_str()).collect();
    assert!(ids.contains(&agent));
    assert!(ids.contains(&parent));
    assert!(!ids.contains(&other));
}

#[test]
fn same_claude_agent_under_two_parents() {
    let tmp = Tmp::new("claude-two");
    let base = tmp.path().join("claude");
    let slug = base.join("projects/-home-work");
    let parent_a = "11111111-1111-4111-8111-111111111111";
    let parent_b = "22222222-2222-4222-8222-222222222222";
    let agent = "a906621c1fcf0c74a";
    write(&slug.join(format!("{parent_a}.jsonl")), &claude_line("parent a"));
    write(&slug.join(format!("{parent_b}.jsonl")), &claude_line("parent b"));
    let file_a = slug.join(parent_a).join("subagents").join(format!("agent-{agent}.jsonl"));
    let file_b = slug.join(parent_b).join("subagents").join(format!("agent-{agent}.jsonl"));
    write(&file_a, &format!("{}\n", serde_json::json!({"type":"user","isSidechain":true,"agentId":agent,"sessionId":parent_a,"message":{"role":"user","content":"from parent a"}})));
    write(&file_b, &format!("{}\n", serde_json::json!({"type":"user","isSidechain":true,"agentId":agent,"sessionId":parent_b,"message":{"role":"user","content":"from parent b"}})));
    touch(&file_a, 1_000);
    touch(&file_b, 9_000);
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", base.to_string_lossy());
    let store = store(roots);
    let rows: Vec<_> = store.list(&["claude"], LIMIT, &[]).into_iter().filter(|row| row.id == agent).collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().find(|row| row.parent_session_id.as_deref() == Some(parent_a)).unwrap().title, "from parent a");
    assert_eq!(rows.iter().find(|row| row.parent_session_id.as_deref() == Some(parent_b)).unwrap().title, "from parent b");
    assert_eq!(store.describe_claude(agent, Some(parent_a)).unwrap().title, "from parent a");
    assert_eq!(store.describe_claude(agent, Some(parent_b)).unwrap().title, "from parent b");
    assert!(store.describe_claude(agent, None).is_none());
    assert_eq!(store.read_claude(agent, Some(parent_a)).turns[0].text, "from parent a");
    assert_eq!(store.read_claude(agent, Some(parent_b)).turns[0].text, "from parent b");
    assert!(store.read_claude(agent, None).turns.is_empty());
    assert!(store.read_claude(agent, None).command.is_empty());
}

#[test]
fn delegated_parent_outside_recency_cap() {
    let tmp = Tmp::new("claude-cap");
    let base = tmp.path().join("claude");
    let slug = base.join("projects/-home-work");
    let parent = "11111111-1111-4111-8111-111111111111";
    let child = "22222222-2222-4222-8222-222222222222";
    let newer = "33333333-3333-4333-8333-333333333333";
    let parent_file = slug.join(format!("{parent}.jsonl"));
    let child_file = slug.join(format!("{child}.jsonl"));
    let newer_file = slug.join(format!("{newer}.jsonl"));
    write(&parent_file, &claude_line("parent"));
    write(&child_file, &claude_line("delegated"));
    write(&newer_file, &claude_line("newer"));
    touch(&parent_file, 1_000);
    touch(&newer_file, 5_000);
    touch(&child_file, 9_000);
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", base.to_string_lossy());
    let store = store(roots);
    let link = DelegatedLink {
        task_id: "task-1".into(),
        spawned_session_id: child.into(),
        parent_session_id: Some(format!("claude-code:{parent}")),
        agent_name: Some("reviewer".into()),
        model: Some("opus".into()),
        ..DelegatedLink::default()
    };
    let capped = store.list(&["claude"], 1, &[link]);
    let ids: Vec<_> = capped.iter().map(|row| row.id.as_str()).collect();
    assert!(ids.contains(&child));
    assert!(ids.contains(&parent));
    assert!(!ids.contains(&newer));
    let child_row = capped.iter().find(|row| row.id == child).unwrap();
    assert_eq!(child_row.parent_session_id.as_deref(), Some(parent));
    assert_eq!(child_row.task_id.as_deref(), Some("task-1"));
    assert_eq!(child_row.title, "delegated");
    assert_eq!(child_row.agent_name.as_deref(), Some("reviewer"));
    assert_eq!(child_row.model.as_deref(), Some("opus"));
    assert_eq!(capped.iter().find(|row| row.id == parent).unwrap().title, "parent");
}

fn grok_summary(id: &str, title: &str, updated: &str, kind: Option<&str>) -> String {
    let mut value = serde_json::json!({"info":{"id": id}, "session_summary": title, "updated_at": updated});
    if let Some(kind) = kind {
        value["session_kind"] = serde_json::json!(kind);
    }
    format!("{value}\n")
}

fn grok_spawn(parent: &str, child: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "method": "_x.ai/session/update",
            "params": {"update": {
                "sessionUpdate": "subagent_spawned",
                "subagent_id": child,
                "parent_session_id": parent,
                "child_session_id": child
            }}
        })
    )
}

#[test]
fn lists_grok_merged_and_sorted_with_claude() {
    let tmp = Tmp::new("grok-merge");
    let claude = tmp.path().join("claude");
    let file = claude.join("projects/-home/22222222-2222-2222-2222-222222222222.jsonl");
    write(&file, &claude_line("deploy the thing"));
    touch(&file, 2_000);
    let grok = tmp.path().join("grok");
    let sess = grok.join("sessions/%2Fhome%2Frivet/aaaa-1111");
    write(&sess.join("summary.json"), &grok_summary("aaaa-1111", "plan the migration", "2026-07-07T00:00:00.000Z", None));
    write(&grok.join("sessions/%2Fhome%2Frivet/session_search.sqlite"), "x");
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", claude.to_string_lossy());
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let sessions = store(roots).list(&["claude", "grok"], LIMIT, &[]);
    assert_eq!(sessions[0].command, "grok");
    assert_eq!(sessions[0].id, "aaaa-1111");
    assert_eq!(sessions[0].title, "plan the migration");
    assert!(sessions.iter().any(|row| row.command == "claude"));
    assert!(sessions[0].updated_at > sessions.last().unwrap().updated_at);
}

#[test]
fn grok_created_at_agrees_between_list_and_describe() {
    let tmp = Tmp::new("grok-created");
    let id = "cccc-3333";
    let grok = tmp.path().join("grok");
    let body = format!(
        "{}\n",
        serde_json::json!({
            "info": {"id": id},
            "session_summary": "quantize the thing",
            "created_at": "2026-07-07T00:00:00.000Z",
            "updated_at": "2026-07-07T01:00:00.000Z"
        })
    );
    write(&grok.join("sessions/%2Fhome%2Frivet").join(id).join("summary.json"), &body);
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let store = store(roots);
    let listed = store.list(&["grok"], LIMIT, &[]).into_iter().next().unwrap();
    let described = store.describe_grok(id).unwrap();
    assert_eq!(listed.created_at, parse_date_ms("2026-07-07T00:00:00.000Z"));
    assert_eq!(described, listed);
}

#[test]
fn nests_grok_subagents_and_tails_a_later_spawn() {
    let tmp = Tmp::new("grok-nest");
    let grok = tmp.path().join("grok");
    let bucket = grok.join("sessions/%2Fhome%2Frivet");
    let parent = "11111111-1111-7111-8111-111111111111";
    let child = "22222222-2222-7222-8222-222222222222";
    let fork = "33333333-3333-7333-8333-333333333333";
    let headless = "44444444-4444-7444-8444-444444444444";
    write(&bucket.join(parent).join("summary.json"), &grok_summary(parent, "primary", "2026-07-01T00:00:00.000Z", None));
    write(&bucket.join(parent).join("updates.jsonl"), &grok_spawn(parent, child));
    let child_body = serde_json::json!({"info":{"id": child}, "session_summary":"review the store", "session_kind":"subagent", "agent_name":"general-purpose", "current_model_id":"grok-4.7", "updated_at":"2026-07-08T00:00:00.000Z"});
    write(&bucket.join(child).join("summary.json"), &format!("{child_body}\n"));
    write(&bucket.join(fork).join("summary.json"), &grok_summary(fork, "forked look", "2026-07-07T00:00:00.000Z", Some("subagent_fork")));
    write(&bucket.join(headless).join("summary.json"), &grok_summary(headless, "plan mode", "2026-07-09T00:00:00.000Z", Some("headless")));
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let store = store(roots);
    let listed = store.list(&["grok"], 2, &[]);
    assert!(listed.iter().find(|row| row.id == headless).unwrap().parent_session_id.is_none());
    let child_row = listed.iter().find(|row| row.id == child).unwrap();
    assert_eq!(child_row.parent_session_id.as_deref(), Some(parent));
    assert_eq!(child_row.agent_name.as_deref(), Some("general-purpose"));
    assert_eq!(child_row.model.as_deref(), Some("grok-4.7"));
    assert!(listed.iter().any(|row| row.id == parent));
    assert!(listed.iter().all(|row| row.id != fork));
    assert_eq!(store.describe_grok(child).unwrap(), child_row.clone());
    let updates = bucket.join(parent).join("updates.jsonl");
    let mut next = std::fs::read_to_string(&updates).unwrap();
    next.push_str(&grok_spawn(parent, fork));
    std::fs::write(&updates, next).unwrap();
    let again = store.list(&["grok"], 3, &[]);
    assert_eq!(again.iter().find(|row| row.id == fork).unwrap().parent_session_id.as_deref(), Some(parent));
    assert!(again.iter().find(|row| row.id == headless).unwrap().parent_session_id.is_none());
}

#[test]
fn grok_parent_survives_a_partial_code_point() {
    let tmp = Tmp::new("grok-partial");
    let grok = tmp.path().join("grok");
    let bucket = grok.join("sessions/%2Fhome%2Frivet");
    let parent = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    let child = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    let fork = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
    write(&bucket.join(parent).join("summary.json"), &grok_summary(parent, parent, "2026-07-08T00:00:00.000Z", None));
    write(&bucket.join(child).join("summary.json"), &grok_summary(child, child, "2026-07-08T00:00:00.000Z", Some("subagent")));
    write(&bucket.join(fork).join("summary.json"), &grok_summary(fork, fork, "2026-07-08T00:00:00.000Z", Some("subagent_fork")));
    let updates = bucket.join(parent).join("updates.jsonl");
    let mut bytes = grok_spawn(parent, child).into_bytes();
    bytes.extend_from_slice(&[0xe2, 0x9c]);
    if let Some(parent_dir) = updates.parent() {
        std::fs::create_dir_all(parent_dir).unwrap();
    }
    std::fs::write(&updates, &bytes).unwrap();
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let store = store(roots);
    let first = store.list(&["grok"], LIMIT, &[]);
    assert_eq!(first.iter().find(|row| row.id == child).unwrap().parent_session_id.as_deref(), Some(parent));
    let mut more = vec![0x93, 0x0a];
    more.extend(grok_spawn(parent, fork).into_bytes());
    let mut file = std::fs::OpenOptions::new().append(true).open(&updates).unwrap();
    std::io::Write::write_all(&mut file, &more).unwrap();
    drop(file);
    let second = store.list(&["grok"], LIMIT, &[]);
    assert_eq!(second.iter().find(|row| row.id == child).unwrap().parent_session_id.as_deref(), Some(parent));
    assert_eq!(second.iter().find(|row| row.id == fork).unwrap().parent_session_id.as_deref(), Some(parent));
}

#[test]
fn grok_malformed_parent_does_not_drop_rows() {
    let tmp = Tmp::new("grok-bad");
    let grok = tmp.path().join("grok");
    let bucket = grok.join("sessions/%2Fhome%2Frivet");
    let parent = "11111111-1111-7111-8111-111111111111";
    let good = "22222222-2222-7222-8222-222222222222";
    let bad = "33333333-3333-7333-8333-333333333333";
    let padded = "44444444-4444-7444-8444-444444444444";
    for (id, kind) in [(parent, None), (good, Some("subagent")), (bad, Some("subagent")), (padded, Some("subagent"))] {
        write(&bucket.join(id).join("summary.json"), &grok_summary(id, id, "2026-07-08T00:00:00.000Z", kind));
    }
    let body = format!(
        "{}{}{}",
        grok_spawn(parent, good),
        grok_spawn("not-a-uuid", bad),
        grok_spawn(&format!("  {parent}  "), padded)
    );
    write(&bucket.join(parent).join("updates.jsonl"), &body);
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let listed = store(roots).list(&["grok"], LIMIT, &[]);
    let mut ids: Vec<_> = listed.iter().map(|row| row.id.as_str()).collect();
    ids.sort_unstable();
    let mut expect = vec![bad, good, padded, parent];
    expect.sort_unstable();
    assert_eq!(ids, expect);
    assert_eq!(listed.iter().find(|row| row.id == good).unwrap().parent_session_id.as_deref(), Some(parent));
    assert_eq!(listed.iter().find(|row| row.id == padded).unwrap().parent_session_id.as_deref(), Some(parent));
    assert!(listed.iter().find(|row| row.id == bad).unwrap().parent_session_id.is_none());
}

#[test]
fn grok_replaced_updates_reread_from_byte_zero() {
    let tmp = Tmp::new("grok-rotate");
    let grok = tmp.path().join("grok");
    let bucket = grok.join("sessions/%2Fhome%2Frivet");
    let parent = "11111111-1111-7111-8111-111111111111";
    let child_a = "22222222-2222-7222-8222-222222222222";
    let child_b = "33333333-3333-7333-8333-333333333333";
    write(&bucket.join(parent).join("summary.json"), &grok_summary(parent, parent, "2026-07-08T00:00:00.000Z", None));
    write(&bucket.join(child_a).join("summary.json"), &grok_summary(child_a, child_a, "2026-07-08T00:00:00.000Z", Some("subagent")));
    write(&bucket.join(child_b).join("summary.json"), &grok_summary(child_b, child_b, "2026-07-08T00:00:00.000Z", Some("subagent")));
    let updates = bucket.join(parent).join("updates.jsonl");
    write(&updates, &grok_spawn(parent, child_a));
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let store = store(roots);
    let first = store.list(&["grok"], LIMIT, &[]);
    assert_eq!(first.iter().find(|row| row.id == child_a).unwrap().parent_session_id.as_deref(), Some(parent));
    let next = bucket.join(parent).join("updates.jsonl.next");
    write(&next, &grok_spawn(parent, child_b));
    std::fs::rename(&next, &updates).unwrap();
    let second = store.list(&["grok"], LIMIT, &[]);
    assert_eq!(second.iter().find(|row| row.id == child_b).unwrap().parent_session_id.as_deref(), Some(parent));
    assert!(second.iter().find(|row| row.id == child_a).unwrap().parent_session_id.is_none());
}

#[test]
fn describe_grok_follows_a_move_and_forgets_a_delete() {
    let tmp = Tmp::new("grok-move");
    let grok = tmp.path().join("grok");
    let id = "55555555-5555-7555-8555-555555555555";
    let from = grok.join("sessions/bucket-a").join(id);
    let to = grok.join("sessions/bucket-b").join(id);
    write(&from.join("summary.json"), &grok_summary(id, "before move", "2026-07-08T00:00:00.000Z", None));
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let store = store(roots);
    assert_eq!(store.describe_grok(id).unwrap().title, "before move");
    std::fs::create_dir_all(to.parent().unwrap()).unwrap();
    std::fs::rename(&from, &to).unwrap();
    write(&to.join("summary.json"), &grok_summary(id, "after move", "2026-07-08T01:00:00.000Z", None));
    assert_eq!(store.describe_grok(id).unwrap().title, "after move");
    std::fs::remove_dir_all(&to).unwrap();
    assert!(store.describe_grok(id).is_none());
}

#[test]
fn grok_exists_is_the_directory() {
    let tmp = Tmp::new("grok-exists");
    let grok = tmp.path().join("grok");
    std::fs::create_dir_all(grok.join("sessions/%2Fhome%2Frivet/dddd-4444")).unwrap();
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", grok.to_string_lossy());
    let store = store(roots);
    assert!(store.describe_grok("dddd-4444").is_none());
    assert!(store.session_exists("grok", "dddd-4444"));
    assert!(store.describe_grok("../../etc").is_none());
    assert!(store.describe_grok("").is_none());
}

#[test]
fn session_exists_rejects_path_ids() {
    let tmp = Tmp::new("pathish");
    let store = store(tmp.roots());
    for command in ["grok", "claude", "hermes"] {
        assert!(!store.session_exists(command, ""));
        assert!(!store.session_exists(command, ".."));
        assert!(!store.session_exists(command, "../../etc/passwd"));
        assert!(!store.session_exists(command, "a/b"));
    }
}

#[test]
fn lists_hermes_sessions_from_state_db() {
    let tmp = Tmp::new("hermes");
    let home = tmp.path().join("hermes");
    sqlite(
        &home.join("state.db"),
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
         CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);
         INSERT INTO sessions VALUES ('sess_a', 1000, 2000), ('sess_b', 3000, 5000);
         INSERT INTO messages VALUES ('sess_a','user','fix the parser',1000);
         INSERT INTO messages VALUES ('sess_b','user','ship the release',3000);",
    );
    let mut roots = tmp.roots();
    roots.set_env("HERMES_HOME", home.to_string_lossy());
    let store = store(roots);
    let sessions = store.list(&["hermes"], LIMIT, &[]);
    assert_eq!(
        sessions.iter().map(|row| format!("{}:{}", row.id, row.title)).collect::<Vec<_>>(),
        ["sess_b:ship the release", "sess_a:fix the parser"]
    );
    assert_eq!(sessions[0].command, "hermes");
    assert!(store.session_exists("hermes", "sess_a"));
    assert!(!store.session_exists("hermes", "nope"));
}

#[test]
fn hermes_strips_reasoning_box() {
    let tmp = Tmp::new("hermes-box");
    let home = tmp.path().join("hermes");
    let boxed = "┌─ Reasoning ──────────────────────────────────────────────────────────────────────────────────────┐\n│ thinking about the leak\n└──────────────────────────────────────────────────────────────────────────────────────────────────┘\n\nThe reply.";
    let sql = format!(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
         CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);
         INSERT INTO sessions VALUES ('sess_box', 1000, 2000);
         INSERT INTO messages VALUES ('sess_box','user','hi',1000);
         INSERT INTO messages VALUES ('sess_box','assistant','{}',1001);",
        boxed.replace('\'', "''")
    );
    sqlite(&home.join("state.db"), &sql);
    let mut roots = tmp.roots();
    roots.set_env("HERMES_HOME", home.to_string_lossy());
    let turns = store(roots).read_hermes("sess_box").turns;
    assert_eq!(turns.iter().map(|turn| turn.text.as_str()).collect::<Vec<_>>(), ["hi", "The reply."]);
}

#[test]
fn hermes_pairs_tools_and_stamps_complete() {
    let tmp = Tmp::new("hermes-tools");
    let home = tmp.path().join("hermes");
    let tools = serde_json::json!([{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.ts\"}"}}]).to_string();
    let sql = format!(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
         CREATE TABLE messages (
           session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT,
           tool_name TEXT, timestamp INTEGER, finish_reason TEXT, reasoning TEXT,
           reasoning_content TEXT, active INTEGER, compacted INTEGER
         );
         INSERT INTO sessions VALUES ('sess_tools', 1000, 2000);
         INSERT INTO messages VALUES ('sess_tools','user','read a.ts',NULL,NULL,NULL,1000,NULL,NULL,NULL,1,0);
         INSERT INTO messages VALUES ('sess_tools','assistant','','call_1','{}','read_file',1001,'tool_calls','looking it up',NULL,1,0);",
        tools.replace('\'', "''")
    );
    sqlite(&home.join("state.db"), &sql);
    let mut roots = tmp.roots();
    roots.set_env("HERMES_HOME", home.to_string_lossy());
    let store = store(roots);
    let running = store.read_hermes("sess_tools");
    let asst = running.turns.iter().find(|turn| turn.role == Role::Assistant).unwrap();
    assert!(asst.complete.is_none());
    assert_eq!(asst.stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(asst.thinking.as_deref(), Some("looking it up"));
    let tool = &asst.tools.as_ref().unwrap()[0];
    assert_eq!(tool.name, "read_file");
    assert_eq!(tool.status, transcripts::turn::ToolStatus::Running);
    assert_eq!(tool.id.as_deref(), Some("call_1"));
    let conn = rusqlite::Connection::open(home.join("state.db")).unwrap();
    conn.execute(
        "INSERT INTO messages VALUES ('sess_tools','tool','export const a = 1','call_1',NULL,'read_file',1002,NULL,NULL,NULL,1,0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages VALUES ('sess_tools','assistant','it exports a',NULL,NULL,NULL,1003,'stop',NULL,NULL,1,0)",
        [],
    )
    .unwrap();
    drop(conn);
    let full = store.read_hermes("sess_tools");
    let last = full.turns.last().unwrap();
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.text, "it exports a");
    assert_eq!(last.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(last.complete, Some(true));
    assert_eq!(last.tools.as_ref().unwrap()[0].status, transcripts::turn::ToolStatus::Done);
}

#[test]
fn kimi_lists_both_state_shapes() {
    let tmp = Tmp::new("kimi");
    let home = tmp.path().join("kimi");
    let v2 = "session_11111111-1111-4111-8111-111111111111";
    let v1 = "session_22222222-2222-4222-8222-222222222222";
    let untitled = "session_33333333-3333-4333-8333-333333333333";
    write(
        &home.join("sessions/wd_rivet_abc123").join(v2).join("state.json"),
        &serde_json::json!({"id": v2, "version": 2, "cwd": "/home/rivet", "createdAt": 1_700_000_000_000i64, "updatedAt": 1_700_000_200_000i64}).to_string(),
    );
    write(
        &home.join("sessions/wd_rivetos_def456").join(v1).join("state.json"),
        &serde_json::json!({"createdAt":"2023-11-14T22:13:20.000Z","updatedAt":"2023-11-14T22:14:20.000Z","title":"ship the release","workDir":"/rivet-shared","lastPrompt":"ship the release"}).to_string(),
    );
    let wire = format!(
        "{}\n{}\n{}\n",
        serde_json::json!({"type":"metadata"}),
        serde_json::json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"Auto permission mode is active."}],"origin":{"kind":"injection"}}}),
        serde_json::json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"review the harness driver"}],"origin":{"kind":"user"}}})
    );
    write(&home.join("sessions/wd_rivet_abc123").join(untitled).join("agents/main/wire.jsonl"), &wire);
    write(
        &home.join("sessions/wd_rivet_abc123").join(untitled).join("state.json"),
        &serde_json::json!({"id": untitled, "version": 2, "cwd": "/home/rivet", "createdAt": 1, "updatedAt": 2}).to_string(),
    );
    let mut roots = tmp.roots();
    roots.set_env("KIMI_CODE_HOME", home.to_string_lossy());
    let sessions = store(roots).list(&["kimi"], LIMIT, &[]);
    assert_eq!(sessions.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), [v2, v1, untitled]);
    assert_eq!(sessions[0].title, v2);
    assert_eq!(sessions[0].updated_at, 1_700_000_200_000);
    assert_eq!(sessions[0].created_at, Some(1_700_000_000_000));
    assert_eq!(sessions[1].title, "ship the release");
    assert_eq!(sessions[1].updated_at, 1_700_000_060_000);
    assert_eq!(sessions[1].created_at, Some(1_700_000_000_000));
    assert_eq!(sessions[2].title, "review the harness driver");
}

#[test]
fn kimi_exists_is_the_session_dir() {
    let tmp = Tmp::new("kimi-exists");
    let home = tmp.path().join("kimi");
    let id = "session_11111111-1111-4111-8111-111111111111";
    std::fs::create_dir_all(home.join("sessions/wd_x").join(id)).unwrap();
    let mut roots = tmp.roots();
    roots.set_env("KIMI_CODE_HOME", home.to_string_lossy());
    let store = store(roots);
    assert!(store.session_exists("kimi", id));
    assert!(!store.session_exists("kimi", "11111111-1111-4111-8111-111111111111"));
}

#[test]
fn empty_when_the_store_is_missing() {
    let tmp = Tmp::new("empty");
    let store = store(tmp.roots());
    assert!(store.list(&["hermes", "opencode", "claude", "nope"], LIMIT, &[]).is_empty());
    assert!(store.read_transcript("not-a-session").turns.is_empty());
}

#[test]
fn pi_reads_bucketed_and_flat_sessions() {
    let tmp = Tmp::new("pi");
    let id = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let home = tmp.path().join("pi-agent");
    let bucket = home.join("sessions/--home-rivet--");
    let file = bucket.join(format!("2026-07-07T00-00-00_{id}.jsonl"));
    write(&file, &format!("{}\n", serde_json::json!({"type":"message","message":{"role":"user","content":"pi hello"}})));
    let flat = home.join("sessions").join(format!("2026-07-08T00-00-00_{other}.jsonl"));
    write(&flat, &format!("{}\n", serde_json::json!({"type":"message","message":{"role":"user","content":"flat hello"}})));
    touch(&file, 1_000);
    touch(&flat, 5_000);
    let mut roots = tmp.roots();
    roots.pi_home = Some(home);
    let store = store(roots);
    let sessions = store.list(&["pi"], LIMIT, &[]);
    assert_eq!(sessions[0].id, other);
    assert_eq!(sessions[0].title, "flat hello");
    assert_eq!(store.read_pi(id).turns[0].text, "pi hello");
    assert!(store.session_exists("pi", id));
    assert!(store.describe_pi("missing").is_none());
}

#[test]
fn qwen_reads_encoded_cwd_and_skips_runtime() {
    let tmp = Tmp::new("qwen");
    let id = "11111111-1111-4111-8111-111111111111";
    let home = tmp.path().join("qwen");
    let file = home.join("projects").join(transcripts::encode_qwen_cwd("/home/rivet")).join("chats").join(format!("{id}.jsonl"));
    write(
        &file,
        &format!(
            "{}\n{}\n",
            serde_json::json!({"type":"user","provenance":"real_user","message":{"parts":[{"text":"qwen hello"}]}}),
            serde_json::json!({"cwd":"/home/rivet"})
        ),
    );
    write(&file.with_extension("runtime.json"), "{}\n");
    let mut roots = tmp.roots();
    roots.qwen_home = Some(home);
    let store = store(roots);
    let sessions = store.list(&["qwen"], LIMIT, &[]);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].title, "qwen hello");
    assert_eq!(store.qwen_session_cwd(id).as_deref(), Some("/home/rivet"));
    assert_eq!(store.read_qwen(id).command, "qwen");
}

#[test]
fn codex_lists_rollouts_and_reads_the_user_turn() {
    let tmp = Tmp::new("codex");
    let id = "11111111-1111-4111-8111-111111111111";
    let home = tmp.path().join("codex");
    let file = home.join("sessions/2026/07/07").join(format!("rollout-2026-07-07T00-00-00-{id}.jsonl"));
    write(
        &file,
        &format!(
            "{}\n",
            serde_json::json!({"timestamp":"2026-07-07T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex hello"}]}})
        ),
    );
    let mut roots = tmp.roots();
    roots.set_env("CODEX_HOME", home.to_string_lossy());
    let store = store(roots);
    let sessions = store.list(&["codex"], LIMIT, &[]);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, id);
    assert_eq!(sessions[0].title, "codex hello");
    assert!(store.session_exists("codex", id));
    let read = store.read_codex(id);
    assert_eq!(read.turns[0].text, "codex hello");
    let resolved = store.resolve(&format!("codex:{id}")).unwrap();
    assert!(resolved.path.ends_with(".jsonl"));
    assert!(store.list(&["codex"], LIMIT, &[]).iter().any(|row| row.id == id));
    let empty = Tmp::new("codex-empty");
    let mut roots = empty.roots();
    roots.set_env("CODEX_HOME", empty.path().join("none").to_string_lossy());
    assert!(store(roots).list(&["codex"], LIMIT, &[]).is_empty());
}

#[test]
fn opencode_lists_and_scopes_newest_after() {
    let tmp = Tmp::new("opencode");
    let db = tmp.path().join(".local/share/opencode/opencode.db");
    sqlite(
        &db,
        "CREATE TABLE session (id TEXT, title TEXT, model TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
         INSERT INTO session VALUES ('ses_aaaaaaaaaaaaaaaaaaaa','older','','/work', 1000, 1000);
         INSERT INTO session VALUES ('ses_bbbbbbbbbbbbbbbbbbbb','newer','{\"providerID\":\"openai\",\"id\":\"gpt\"}','/work', 5000, 9000);
         INSERT INTO session VALUES ('ses_cccccccccccccccccccc','elsewhere','','/other', 8000, 8000);",
    );
    let mut roots = tmp.roots();
    roots.cwd = Path::new("/").to_path_buf();
    let store = store(roots);
    let sessions = store.list(&["opencode"], LIMIT, &[]);
    assert_eq!(sessions[0].id, "ses_bbbbbbbbbbbbbbbbbbbb");
    assert_eq!(sessions[0].title, "newer");
    assert_eq!(sessions[0].model.as_deref(), Some("openai/gpt"));
    assert_eq!(store.describe_opencode("ses_bbbbbbbbbbbbbbbbbbbb").unwrap().title, "newer");
    assert!(store.session_exists("opencode", "ses_aaaaaaaaaaaaaaaaaaaa"));
    assert_eq!(store.newest_opencode_after("/work", 4000).as_deref(), Some("ses_bbbbbbbbbbbbbbbbbbbb"));
    assert!(store.newest_opencode_after("/missing", 0).is_none());
}

#[test]
fn cursor_lists_and_newest_after() {
    let tmp = Tmp::new("cursor");
    let id = "11111111-1111-4111-8111-111111111111";
    let older = "22222222-2222-4222-8222-222222222222";
    let home = tmp.path().join("cursor");
    let slug = transcripts::cursor_project_slug("/home/rivet", Path::new("/"));
    let file = home.join("projects").join(&slug).join("agent-transcripts").join(id).join(format!("{id}.jsonl"));
    let old = home.join("projects").join(&slug).join("agent-transcripts").join(older).join(format!("{older}.jsonl"));
    write(&file, &format!("{}\n", serde_json::json!({"role":"user","message":{"content":[{"type":"text","text":"cursor hello"}]}})));
    write(&old, &format!("{}\n", serde_json::json!({"role":"user","message":{"content":[{"type":"text","text":"older"}]}})));
    touch(&file, 9_000);
    touch(&old, 1_000);
    let mut roots = tmp.roots();
    roots.cursor_home = Some(home);
    roots.cwd = Path::new("/").to_path_buf();
    let store = store(roots);
    let sessions = store.list(&["cursor"], LIMIT, &[]);
    assert_eq!(sessions[0].id, id);
    assert_eq!(sessions[0].title, "cursor hello");
    assert_eq!(store.newest_cursor_after("/home/rivet", 5_000).as_deref(), Some(id));
    assert!(store.session_exists("cursor", id));
}

#[test]
fn cowork_exists_is_always_false_but_list_reads() {
    let tmp = Tmp::new("cowork");
    let id = "11111111-1111-4111-8111-111111111111";
    let root = tmp.path().join("claude-cfg");
    let meta = root.join("local-agent-mode-sessions/task-1/local_task.json");
    write(
        &meta,
        &serde_json::json!({"cliSessionId": id, "title": "cowork hello", "createdAt": 1000, "lastActivityAt": 2000, "cwd": "/work"}).to_string(),
    );
    let transcript = meta.parent().unwrap().join("local_task/.claude/projects/-work").join(format!("{id}.jsonl"));
    write(&transcript, &claude_line("from cowork"));
    let mut roots = tmp.roots();
    roots.cowork_roots = Some(vec![root]);
    let store = store(roots);
    assert!(!store.session_exists("cowork", id));
    let sessions = store.list(&["cowork"], LIMIT, &[]);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].title, "cowork hello");
    assert_eq!(store.read_transcript(&format!("cowork:{id}")).turns[0].text, "from cowork");
}

#[test]
fn canonical_id_does_not_fall_through() {
    let tmp = Tmp::new("fall");
    let claude = tmp.path().join("claude");
    let id = "11111111-1111-4111-8111-111111111111";
    write(&claude.join("projects/-home").join(format!("{id}.jsonl")), &claude_line("claude only"));
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", claude.to_string_lossy());
    let store = store(roots);
    let read = store.read_transcript(&format!("grok-build:{id}"));
    assert!(read.turns.is_empty());
    let claude_read = store.read_transcript(&format!("claude-code:{id}"));
    assert_eq!(claude_read.command, "claude");
    assert_eq!(claude_read.id, format!("claude-code:{id}"));
    assert_eq!(claude_read.turns[0].text, "claude only");
}

#[test]
fn truncated_window_drops_a_partial_first_line() {
    let tmp = Tmp::new("cap");
    let file = tmp.path().join("cap.jsonl");
    let kept = format!("{}\n", serde_json::json!({"type":"user","message":{"content":"kept"}}));
    let mut body = b"THIS IS A PARTIAL LINE THAT MUST BE DROPPED\n".to_vec();
    body.extend(kept.as_bytes());
    std::fs::write(&file, &body).unwrap();
    let mut roots = tmp.roots();
    roots.max_bytes = (body.len() as u64) - 10;
    let parsed = transcripts::jsonl::read_jsonl(&file, roots.max_bytes);
    assert!(parsed.truncated);
    assert!(parsed.text.starts_with('{'));
    let turns = claude_turns_from_text(&parsed.text);
    assert_eq!(turns[0].text, "kept");
}

#[test]
fn over_cap_file_is_truncated() {
    let tmp = Tmp::new("overcap");
    let file = tmp.path().join("over.jsonl");
    let line = format!("{}\n", serde_json::json!({"type":"user","message":{"content":"tail line"}}));
    let mut body = vec![b'x'; DEFAULT_TRANSCRIPT_MAX_BYTES as usize + 64];
    body.push(b'\n');
    body.extend(line.as_bytes());
    std::fs::write(&file, &body).unwrap();
    let parsed = transcripts::jsonl::read_jsonl(&file, DEFAULT_TRANSCRIPT_MAX_BYTES);
    assert!(parsed.truncated);
    assert!(parsed.objects.iter().any(|obj| obj.get("type").and_then(|value| value.as_str()) == Some("user")));
}

#[test]
fn non_utf8_byte_and_truncated_last_line_are_skipped() {
    let tmp = Tmp::new("bytes");
    let file = tmp.path().join("bad.jsonl");
    let mut body = format!("{}\n", serde_json::json!({"type":"user","message":{"content":"ok"}})).into_bytes();
    body.extend_from_slice(&[0xff, b'\n']);
    body.extend_from_slice(br#"{"type":"user","message":{"content":"cut"#);
    std::fs::write(&file, body).unwrap();
    let parsed = transcripts::jsonl::read_jsonl(&file, DEFAULT_TRANSCRIPT_MAX_BYTES);
    assert_eq!(parsed.objects.len(), 1);
    let mut tail = TranscriptTail::new();
    let first = tail.read_new_jsonl(&file);
    assert!(first.text.contains("ok"));
    assert!(first.offset > 0);
    let second = tail.read_new_jsonl(&file);
    assert!(second.text.is_empty());
}

#[test]
fn sqlite_cursor_returns_only_new_rows() {
    let mut tail = TranscriptTail::new();
    let rows = [(10, 1), (10, 2), (11, 1)];
    assert_eq!(tail.rows_after("hermes", &rows), vec![0, 1, 2]);
    assert!(tail.rows_after("hermes", &rows).is_empty());
    assert_eq!(tail.rows_after("hermes", &[(11, 1), (12, 1)]), vec![1]);
}

#[test]
fn merge_window_pins_the_overlap() {
    let older = vec![transcripts::turn::Turn::user("a"), transcripts::turn::Turn::user("b"), transcripts::turn::Turn::user("c")];
    let next = vec![transcripts::turn::Turn::user("b"), transcripts::turn::Turn::user("c"), transcripts::turn::Turn::user("d")];
    let merged = merge_transcript_window(&older, &next, true);
    assert_eq!(merged.iter().map(|turn| turn.text.as_str()).collect::<Vec<_>>(), ["a", "b", "c", "d"]);
    assert_eq!(merge_transcript_window(&older, &next, false).len(), 3);
}

#[test]
fn paste_wrapper_and_slash_command() {
    let wrapped = "<pasted_content id=\"a\">\nhello\n</pasted_content>";
    assert_eq!(strip_pasted_content_wrapper(wrapped).trim(), "hello");
    assert!(is_bare_slash_command("/compact"));
    assert!(is_bare_slash_command("/review the diff"));
    assert!(!is_bare_slash_command("not a command"));
    let turns = claude_turns_from_text(&format!("{}\n", serde_json::json!({"type":"user","message":{"content":"/compact"}})));
    assert!(turns.is_empty());
}
