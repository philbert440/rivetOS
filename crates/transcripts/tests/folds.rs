#[path = "common/mod.rs"]
mod common;

use serde_json::{Value, json};
use transcripts::turn::{LastBlock, Role, ToolStatus};
use transcripts::{
    Store, claude_turns_from_lines, extract_turn_text, grok_turns_from_lines,
    is_bare_slash_command, kimi_turns_from_lines, objects_from_text, strip_pasted_content_wrapper,
};

use common::{Tmp, sqlite, touch, write};

fn claude(value: Value) -> Vec<transcripts::turn::Turn> {
    let text = value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    claude_turns_from_lines(&objects_from_text(&text))
}

fn grok(value: Value) -> Vec<transcripts::turn::Turn> {
    let text = value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    grok_turns_from_lines(&objects_from_text(&text))
}

fn kimi(value: Value) -> Vec<transcripts::turn::Turn> {
    let text = value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    kimi_turns_from_lines(&objects_from_text(&text))
}

#[test]
fn truncated_parent_does_not_leak_a_sidechain_tail() {
    let tmp = Tmp::new("side-tail");
    let id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    let dir = tmp.path().join("projects/-home-rivet");
    let parent = json!({"type":"user","message":{"content":"parent stays"}}).to_string();
    let side = json!({"type":"user","isSidechain":true,"message":{"content":"sidechain leak"}})
        .to_string();
    write(
        &dir.join(format!("{id}.jsonl")),
        &format!("{parent}\n{side}\n"),
    );
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", tmp.path().to_string_lossy());
    roots.max_bytes = (side.len() + 2) as u64;
    let store = Store::new(roots);
    let read = store.read_transcript(id);
    assert!(read.truncated);
    assert!(read.turns.iter().all(|turn| turn.text != "sidechain leak"));
    let agent = "a906621c1fcf0c74a";
    let agent_line =
        json!({"type":"user","isSidechain":true,"message":{"content":"agent tail"}}).to_string();
    write(
        &dir.join(id)
            .join("subagents")
            .join(format!("agent-{agent}.jsonl")),
        &format!("{parent}\n{agent_line}\n"),
    );
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", tmp.path().to_string_lossy());
    roots.max_bytes = (agent_line.len() + 2) as u64;
    let agent_read = Store::new(roots).read_transcript(agent);
    assert!(agent_read.truncated);
    assert!(
        agent_read
            .turns
            .iter()
            .any(|turn| turn.text == "agent tail")
    );
}

#[test]
fn claude_read_skips_wrappers_and_folds_usage() {
    let lines = json!([
        {"type":"user","message":{"content":"<user_info>noise</user_info>"}},
        {"type":"user","message":{"content":"hello claude"}},
        {"type":"assistant","message":{"model":"claude-opus-4","content":[{"type":"text","text":"hi there"},{"type":"thinking","text":"x"}],"usage":{"input_tokens":1000,"output_tokens":40,"cache_read_input_tokens":200,"cache_creation_input_tokens":50}}},
        {"type":"user","isSidechain":true,"message":{"content":"sidechain skip me"}},
        {"type":"user","message":{"content":"second turn"}}
    ]);
    let turns = claude(lines);
    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.text.as_str())
            .collect::<Vec<_>>(),
        ["hello claude", "hi there", "second turn"]
    );
    assert_eq!(turns[1].thinking.as_deref(), Some("x"));
    assert_eq!(turns[1].last_block, Some(LastBlock::Thinking));
    assert_eq!(turns[1].model.as_deref(), Some("claude-opus-4"));
    let usage = turns[1].usage.as_ref().expect("usage");
    assert_eq!(usage.prompt_tokens, 1250);
    assert_eq!(usage.completion_tokens, 40);
    assert_eq!(usage.cached_tokens, 200);
    let folded = claude(json!([
        {"type":"user","message":{"content":"run the tests"}},
        {"type":"assistant","message":{"model":"claude-opus-4","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"npm test"}}],"usage":{"input_tokens":500,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}},
        {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]}},
        {"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Edit","input":{}}],"usage":{"input_tokens":600,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}},
        {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","is_error":true,"content":"boom"}]}},
        {"type":"assistant","message":{"content":[{"type":"text","text":"tests pass, edit failed"}],"usage":{"input_tokens":700,"output_tokens":25,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}},
        {"type":"user","message":{"content":"thanks"}}
    ]));
    assert_eq!(folded[0].text, "run the tests");
    assert_eq!(folded[1].text, "tests pass, edit failed");
    assert_eq!(folded[1].last_block, Some(LastBlock::Text));
    let tools = folded[1].tools.as_ref().expect("tools");
    assert_eq!(tools[0].name, "Bash");
    assert_eq!(tools[0].status, ToolStatus::Done);
    assert_eq!(tools[0].id.as_deref(), Some("tu_1"));
    assert_eq!(
        tools[0]
            .args
            .as_ref()
            .and_then(|row| row.get("command"))
            .and_then(protocol::js::JsValue::as_str),
        Some("npm test")
    );
    assert_eq!(tools[1].name, "Edit");
    assert_eq!(tools[1].status, ToolStatus::Error);
    assert_eq!(
        folded[1].usage.as_ref().map(|row| (
            row.prompt_tokens,
            row.completion_tokens,
            row.cached_tokens
        )),
        Some((700, 40, 0))
    );
    assert_eq!(folded[2].text, "thanks");
}

#[test]
fn claude_filters_meta_compact_and_slash_lines() {
    let turns = claude(json!([
        {"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued from a previous conversation"}},
        {"type":"user","message":{"content":"real question"}},
        {"type":"user","message":{"content":"<task-notification>\n<task-id>a1b2</task-id>\n</task-notification>"}},
        {"type":"user","isMeta":true,"message":{"content":"meta noise"}},
        {"type":"assistant","message":{"content":[{"type":"text","text":"real answer"}]}},
        {"type":"user","message":{"role":"user","content":"/compact"}},
        {"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>"}},
        {"type":"system","subtype":"local_command","content":"x"}
    ]));
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].text, "real question");
    assert_eq!(turns[1].text, "real answer");
    assert_eq!(turns[1].last_block, Some(LastBlock::Text));
}

#[test]
fn claude_compact_boundary_markers() {
    let marked = claude(json!([
        {"type":"user","message":{"role":"user","content":"big question"}},
        {"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","usage":{"input_tokens":900000,"output_tokens":5,"cache_read_input_tokens":0},"content":[{"type":"text","text":"big answer"}]}},
        {"type":"user","message":{"role":"user","content":"/compact"}},
        {"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"manual","preTokens":949579,"postTokens":19624}},
        {"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}
    ]));
    assert_eq!(
        marked.iter().map(|turn| turn.role).collect::<Vec<_>>(),
        [Role::User, Role::Assistant, Role::Assistant]
    );
    assert_eq!(
        marked[1].usage.as_ref().map(|row| row.prompt_tokens),
        Some(900_000)
    );
    assert_eq!(
        marked[2].text,
        "Conversation compacted (950k tokens → 20k tokens)"
    );
    assert_eq!(marked[2].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(marked[2].complete, Some(true));
    assert_eq!(marked[2].compact, Some(true));
    assert_eq!(
        marked[2].usage.as_ref().map(|row| row.prompt_tokens),
        Some(19_624)
    );
    let bare = claude(json!([
        {"type":"user","message":{"role":"user","content":"q"}},
        {"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"a"}]}},
        {"type":"system","subtype":"compact_boundary"}
    ]));
    assert_eq!(bare[2].text, "Conversation compacted");
    assert_eq!(bare[2].compact, Some(true));
    assert!(bare[2].usage.is_none());
    let mid = claude(json!([
        {"type":"user","message":{"role":"user","content":"do the thing"}},
        {"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","usage":{"input_tokens":800000,"output_tokens":5},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}},
        {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}},
        {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":800000,"postTokens":30000}},
        {"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}
    ]));
    assert_eq!(
        mid.iter().map(|turn| turn.role).collect::<Vec<_>>(),
        [Role::User, Role::Assistant]
    );
    assert!(mid[1].complete.is_none());
    assert!(mid[1].compact.is_none());
    assert_eq!(
        mid[1]
            .tools
            .as_ref()
            .and_then(|tools| tools.first())
            .map(|tool| tool.status),
        Some(ToolStatus::Done)
    );
    let after = claude(json!([
        {"type":"user","message":{"role":"user","content":"do the thing"}},
        {"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","usage":{"input_tokens":800000,"output_tokens":5},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}},
        {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}},
        {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":800000,"postTokens":30000}},
        {"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}},
        {"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","usage":{"input_tokens":31000,"output_tokens":7},"content":[{"type":"text","text":"done"}]}}
    ]));
    assert_eq!(after.len(), 2);
    assert_eq!(after[1].complete, Some(true));
    assert_eq!(
        after[1].usage.as_ref().map(|row| row.prompt_tokens),
        Some(31_000)
    );
    assert_eq!(after[1].text, "done");
    let before = claude(json!([
        {"type":"user","message":{"role":"user","content":"huge paste"}},
        {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":900000,"postTokens":40000}}
    ]));
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].text, "huge paste");
}

#[test]
fn slash_commands_and_paste_wrappers() {
    assert!(is_bare_slash_command("/compact"));
    assert!(is_bare_slash_command("/model haiku"));
    assert!(is_bare_slash_command("/exit"));
    assert!(!is_bare_slash_command("//not a command"));
    assert!(!is_bare_slash_command("/tmp/work is the runtime"));
    assert!(!is_bare_slash_command("see /compact for details"));
    assert!(!is_bare_slash_command("/compact\nthen more text"));
    assert_eq!(
        extract_turn_text(&json!("/tmp is full, clean it"), "user").as_deref(),
        Some("/tmp is full, clean it")
    );
    assert!(
        extract_turn_text(
            &json!("<environment_context>cwd</environment_context>"),
            "user"
        )
        .is_none()
    );
    assert!(
        extract_turn_text(
            &json!("<skills_instructions>x</skills_instructions>"),
            "user"
        )
        .is_none()
    );
    assert!(extract_turn_text(&json!("<multi_agent_foo>x</multi_agent_foo>"), "user").is_none());
    let wrapped =
        "\n\n<pasted_content id=\"08b5\">\nthere we go, working?\n</pasted_content id=\"08b5\">\n";
    assert_eq!(
        strip_pasted_content_wrapper(wrapped),
        "there we go, working?"
    );
    assert_eq!(
        strip_pasted_content_wrapper("there we go, working?"),
        "there we go, working?"
    );
    assert_eq!(
        strip_pasted_content_wrapper("a <pasted_content> b"),
        "a <pasted_content> b"
    );
    assert_eq!(
        strip_pasted_content_wrapper("see <pasted_content id=\"x\"> as the shape"),
        "see <pasted_content id=\"x\"> as the shape"
    );
    assert_eq!(
        strip_pasted_content_wrapper("<pasted_content id=\"a\">\nx\n</pasted_content id=\"b\">"),
        "<pasted_content id=\"a\">\nx\n</pasted_content id=\"b\">"
    );
    assert_eq!(
        strip_pasted_content_wrapper("<pasted_content id=\"a1\">\nhi\n</pasted_content>"),
        "hi"
    );
    assert_eq!(
        strip_pasted_content_wrapper(
            "note:\n<pasted_content id=\"x\">\n  indented\n</pasted_content id=\"x\">"
        ),
        "note:\n  indented"
    );
    assert_eq!(
        strip_pasted_content_wrapper(
            "<pasted_content id=\"a\">\none\n</pasted_content id=\"a\">\n<pasted_content id=\"b\">\ntwo\n</pasted_content id=\"b\">"
        ),
        "one\ntwo"
    );
    let turns = claude(json!([
        {"type":"user","message":{"role":"user","content": wrapped}},
        {"type":"assistant","message":{"role":"assistant","content":"Yep, I'm here."}}
    ]));
    assert_eq!(
        turns
            .iter()
            .find(|turn| turn.role == Role::User)
            .map(|turn| turn.text.as_str()),
        Some("there we go, working?")
    );
}

#[test]
fn claude_stop_reason_ask_and_bash_args() {
    let lines = json!([
        {"type":"user","message":{"content":"do the thing"}},
        {"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo 1"}}]}},
        {"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"echo 2"}}]}},
        {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"},{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}},
        {"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"next step"}]}},
        {"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t3","name":"Read","input":{"path":"x"}}]}},
        {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"ok"}]}},
        {"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"thinking","thinking":"done thinking"}]}},
        {"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"all done"}]}}
    ]);
    let array = lines.as_array().expect("array");
    let early = claude(Value::Array(array[..3].to_vec()));
    let early_asst = early
        .iter()
        .find(|turn| turn.role == Role::Assistant)
        .expect("asst");
    assert!(early_asst.complete.is_none());
    assert_eq!(early_asst.stop_reason.as_deref(), Some("tool_use"));
    let prefix = claude(Value::Array(array[..array.len() - 1].to_vec()));
    let prefix_asst = prefix
        .iter()
        .rev()
        .find(|turn| turn.role == Role::Assistant)
        .expect("prefix");
    assert!(prefix_asst.complete.is_none());
    assert_eq!(prefix_asst.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(prefix_asst.last_block, Some(LastBlock::Thinking));
    let full = claude(lines);
    let last = full.last().expect("last");
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(last.last_block, Some(LastBlock::Text));
    assert_eq!(last.complete, Some(true));
    assert_eq!(last.text, "all done");
    let questions = json!([{"question":"Which auth?","header":"Auth","multiSelect":false,"options":[{"label":"OAuth","description":"browser"},{"label":"API key","description":"token"}]}]);
    let ask = json!({"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"ask_1","name":"AskUserQuestion","input":{"questions": questions}}]}});
    let unanswered = claude(json!([{"type":"user","message":{"content":"ask me"}}, ask]));
    let tool = unanswered
        .iter()
        .find(|turn| turn.role == Role::Assistant)
        .and_then(|turn| turn.tools.as_ref())
        .and_then(|tools| tools.first())
        .expect("ask");
    assert_eq!(tool.id.as_deref(), Some("ask_1"));
    assert_eq!(
        tool.input
            .as_ref()
            .and_then(|value| value.pointer("/questions/0/options/1/label"))
            .and_then(Value::as_str),
        Some("API key")
    );
    assert!(
        unanswered
            .iter()
            .find(|turn| turn.role == Role::Assistant)
            .and_then(|turn| turn.complete)
            .is_none()
    );
    let answered = claude(json!([
        {"type":"user","message":{"content":"ask me"}},
        ask,
        {"type":"user","toolUseResult":{"answers":[{"question":0,"labels":["API key"]}]},"message":{"content":[{"type":"tool_result","tool_use_id":"ask_1","content":"Your questions have been answered: Auth: API key"}]}}
    ]));
    let after = answered
        .iter()
        .find(|turn| turn.role == Role::Assistant)
        .and_then(|turn| turn.tools.as_ref())
        .and_then(|tools| tools.first())
        .expect("after");
    assert_eq!(
        after.result_text.as_deref(),
        Some("Your questions have been answered: Auth: API key")
    );
    assert_eq!(after.status, ToolStatus::Done);
    assert!(
        answered
            .iter()
            .find(|turn| turn.role == Role::Assistant)
            .and_then(|turn| turn.complete)
            .is_none()
    );
    let bash = claude(json!([
        {"type":"user","message":{"content":"run"}},
        {"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"ls","files":["a","b"]}}]}}
    ]));
    let bash_tool = bash
        .iter()
        .find(|turn| turn.role == Role::Assistant)
        .and_then(|turn| turn.tools.as_ref())
        .and_then(|tools| tools.first())
        .expect("bash");
    assert_eq!(bash_tool.id.as_deref(), Some("b1"));
    assert_eq!(
        bash_tool
            .args
            .as_ref()
            .and_then(|row| row.get("command"))
            .and_then(protocol::js::JsValue::as_str),
        Some("ls")
    );
    assert!(
        bash_tool
            .args
            .as_ref()
            .is_some_and(|row| row.get("files").is_none())
    );
    assert!(bash_tool.input.is_none());
}

#[test]
fn grok_chat_history_and_tool_fold() {
    let tmp = Tmp::new("grok-tx");
    let id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let sess = tmp.path().join("sessions/%2Fhome%2Frivet").join(id);
    write(
        &sess.join("chat_history.jsonl"),
        &format!(
            "{}\n{}\n{}\n",
            json!({"type":"user","content":"<user_info>env</user_info>"}),
            json!({"type":"user","content":"<user_query>plan the migrate</user_query>"}),
            json!({"type":"assistant","content":"ok, planning"})
        ),
    );
    let mut roots = tmp.roots();
    roots.set_env("GROK_HOME", tmp.path().to_string_lossy());
    let read = Store::new(roots).read_transcript(id);
    assert_eq!(read.command, "grok");
    assert_eq!(read.turns[0].text, "plan the migrate");
    assert_eq!(read.turns[1].text, "ok, planning");
    assert_eq!(read.turns[1].last_block, Some(LastBlock::Text));
    assert_eq!(read.turns[1].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(read.turns[1].complete, Some(true));
    let lines = json!([
        {"type":"system","content":"boot"},
        {"type":"user","content":[{"type":"text","text":"read the file"}],"prompt_index":0},
        {"type":"user","content":[{"type":"text","text":"ignore me"}],"synthetic_reason":"system_reminder","prompt_index":0},
        {"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"need the contents"}],"encrypted_content":"enc","status":"completed"},
        {"type":"assistant","content":"opening it","tool_calls":[{"id":"call-abc-0","name":"read_file","arguments":"{\"target_file\":\"src/a.ts\"}"}],"model_id":"grok-4.6"},
        {"type":"tool_result","tool_call_id":"call-abc-0","content":"export const a = 1"},
        {"type":"assistant","content":"it exports a","model_id":"grok-4.6"}
    ]);
    let array = lines.as_array().expect("array");
    let mid = grok(Value::Array(array[..5].to_vec()));
    let mid_asst = mid
        .iter()
        .find(|turn| turn.role == Role::Assistant)
        .expect("mid");
    assert!(mid_asst.complete.is_none());
    assert_eq!(mid_asst.stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(mid_asst.thinking.as_deref(), Some("need the contents"));
    let tool = mid_asst
        .tools
        .as_ref()
        .and_then(|tools| tools.first())
        .expect("tool");
    assert_eq!(tool.name, "read_file");
    assert_eq!(tool.status, ToolStatus::Running);
    assert_eq!(tool.id.as_deref(), Some("call-abc-0"));
    let paired = grok(Value::Array(array[..6].to_vec()));
    assert_eq!(
        paired
            .iter()
            .find(|turn| turn.role == Role::Assistant)
            .and_then(|turn| turn.tools.as_ref())
            .and_then(|tools| tools.first())
            .map(|tool| tool.status),
        Some(ToolStatus::Done)
    );
    let full = grok(lines);
    let last = full.last().expect("last");
    assert_eq!(last.text, "opening it\n\nit exports a");
    assert_eq!(last.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(last.complete, Some(true));
    assert_eq!(last.model.as_deref(), Some("grok-4.6"));
    assert!(full.iter().all(|turn| turn.text != "ignore me"));
}

#[test]
fn canonical_reads_do_not_cross_stores() {
    let tmp = Tmp::new("canon-both");
    let id = "cafe1111-0000-4000-8000-000000000002";
    let claude_base = tmp.path().join("claude");
    let grok_base = tmp.path().join("grok");
    write(
        &claude_base
            .join("projects/-home-rivet")
            .join(format!("{id}.jsonl")),
        &format!(
            "{}\n",
            json!({"type":"user","message":{"content":"claude turn"}})
        ),
    );
    write(
        &grok_base
            .join("sessions/cwd")
            .join(id)
            .join("chat_history.jsonl"),
        &format!("{}\n", json!({"role":"user","content":"grok turn"})),
    );
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", claude_base.to_string_lossy());
    roots.set_env("GROK_HOME", grok_base.to_string_lossy());
    let store = Store::new(roots);
    assert_eq!(store.read_transcript(id).command, "claude");
    let canonical = store.read_transcript(&format!("claude-code:{id}"));
    assert_eq!(canonical.id, format!("claude-code:{id}"));
    assert_eq!(canonical.turns[0].text, "claude turn");
    let grok_read = store.read_transcript(&format!("grok-build:{id}"));
    assert_eq!(grok_read.command, "grok");
    assert_eq!(grok_read.turns[0].text, "grok turn");
    let hermes = store.read_transcript(&format!("hermes:{id}"));
    assert!(hermes.turns.is_empty());
    assert!(hermes.command.is_empty());
    assert_eq!(
        store.resolve(&format!("claude-code:{id}")).unwrap().command,
        "claude"
    );
    assert_eq!(
        store.resolve(&format!("grok-build:{id}")).unwrap().command,
        "grok"
    );
    assert!(store.resolve(&format!("hermes:{id}")).is_none());
    assert_eq!(store.read_grok(id).turns[0].text, "grok turn");
    assert_eq!(store.read_claude(id, None).turns[0].text, "claude turn");
    let unknown = store.read_transcript("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
    assert!(unknown.command.is_empty());
    assert!(unknown.turns.is_empty());
    let path_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    write(
        &claude_base
            .join("projects/-home-rivet")
            .join(format!("{path_id}.jsonl")),
        &format!(
            "{}\n",
            json!({"type":"user","message":{"content":"canonical read"}})
        ),
    );
    let path_form = store.read_transcript(&format!("claude-code:-home-rivet/{path_id}"));
    assert_eq!(path_form.turns[0].text, "canonical read");
    let bare = store.resolve(path_id).unwrap();
    let canon = store.resolve(&format!("claude-code:{path_id}")).unwrap();
    assert_eq!(bare.path, canon.path);
    assert!(store.read_grok(path_id).turns.is_empty());
}

#[test]
fn kimi_wire_fold_completion_and_deep_title() {
    let step = json!({"turnId":"0","step":1,"stepUuid":"s1"});
    let mut think = json!({"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"weighing it"}}});
    think["event"]["turnId"] = step["turnId"].clone();
    think["event"]["step"] = step["step"].clone();
    think["event"]["stepUuid"] = step["stepUuid"].clone();
    let turns = kimi(json!([
        {"type":"metadata","protocol_version":"1.5"},
        {"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"review the diff"}],"origin":{"kind":"user"}}},
        {"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>todo</system-reminder>"}],"origin":{"kind":"injection"}}},
        {"type":"llm.request","model":"kimi-k2","kind":"chat"},
        {"type":"context.append_loop_event","event":{"type":"step.begin","turnId":"0","step":1,"stepUuid":"s1"}},
        think,
        {"type":"context.append_loop_event","event":{"type":"tool.call","turnId":"0","step":1,"stepUuid":"s1","toolCallId":"Bash_0","name":"Bash","args":{"command":"git diff","timeout":30}}},
        {"type":"context.append_loop_event","event":{"type":"tool.call","turnId":"0","step":1,"stepUuid":"s1","toolCallId":"Read_0","name":"Read","args":{"path":"/tmp/x"}}},
        {"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"Bash_0","result":{"output":"boom","isError":true}}},
        {"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"Read_0","result":{"output":"file"}}},
        {"type":"context.append_loop_event","event":{"type":"content.part","turnId":"0","step":1,"stepUuid":"s1","part":{"type":"text","text":"looks good"}}},
        {"type":"context.append_loop_event","event":{"type":"step.end","turnId":"0","step":1,"stepUuid":"s1","usage":{"inputOther":100,"inputCacheRead":20,"inputCacheCreation":5,"output":40}}}
    ]));
    assert_eq!(turns[0].text, "review the diff");
    let last = turns.last().expect("last");
    assert_eq!(last.text, "looks good");
    assert_eq!(last.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(last.complete, Some(true));
    assert_eq!(last.thinking.as_deref(), Some("weighing it"));
    assert_eq!(last.model.as_deref(), Some("kimi-k2"));
    let tools = last.tools.as_ref().expect("tools");
    assert_eq!(tools[0].status, ToolStatus::Error);
    assert_eq!(tools[1].status, ToolStatus::Done);
    assert_eq!(
        last.usage.as_ref().map(|row| (
            row.prompt_tokens,
            row.completion_tokens,
            row.cached_tokens
        )),
        Some((125, 40, 20))
    );
    let ev = |event: Value| {
        let mut row = json!({"type":"context.append_loop_event","event":{"stepId":"s1"}});
        if let (Some(dst), Some(src)) = (row["event"].as_object_mut(), event.as_object()) {
            for (key, value) in src {
                dst.insert(key.clone(), value.clone());
            }
        }
        row
    };
    let user = json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"run it"}],"origin":{"kind":"user"}}});
    let tool_step = vec![
        json!({"type":"llm.request","model":"kimi-k2","kind":"chat"}),
        ev(json!({"type":"step.begin"})),
        ev(json!({"type":"content.part","part":{"type":"think","think":"plan"}})),
        ev(json!({"type":"tool.call","toolCallId":"Bash_0","name":"Bash","args":{"command":"ls"}})),
        ev(
            json!({"type":"step.end","usage":{"inputOther":10,"inputCacheRead":0,"inputCacheCreation":0,"output":5}}),
        ),
    ];
    let mut mid_rows = vec![user.clone()];
    mid_rows.extend(tool_step.iter().cloned());
    let mid = kimi(Value::Array(mid_rows));
    let mid_turn = mid.last().expect("mid");
    assert_eq!(mid_turn.stop_reason.as_deref(), Some("tool_use"));
    assert!(mid_turn.complete.is_none());
    assert_eq!(
        mid_turn
            .tools
            .as_ref()
            .and_then(|tools| tools.first())
            .map(|tool| tool.status),
        Some(ToolStatus::Running)
    );
    let mut done_rows = vec![user];
    done_rows.extend(tool_step);
    done_rows.push(ev(
        json!({"type":"tool.result","toolCallId":"Bash_0","result":{"isError":false}}),
    ));
    done_rows.push(json!({"type":"llm.request","model":"kimi-k2","kind":"chat"}));
    done_rows.push(ev(json!({"type":"step.begin"})));
    done_rows.push(ev(
        json!({"type":"content.part","part":{"type":"text","text":"done"}}),
    ));
    done_rows.push(ev(json!({"type":"step.end","usage":{"inputOther":10,"inputCacheRead":0,"inputCacheCreation":0,"output":5}})));
    let done = kimi(Value::Array(done_rows));
    let done_last = done.last().expect("done");
    assert_eq!(
        done_last
            .tools
            .as_ref()
            .and_then(|tools| tools.first())
            .map(|tool| tool.status),
        Some(ToolStatus::Done)
    );
    assert_eq!(done_last.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(done_last.complete, Some(true));
    let tmp = Tmp::new("kimi-deep");
    let id = "session_55555555-5555-4555-8555-555555555555";
    let dir = tmp.path().join("sessions/wd_rivet_abc123").join(id);
    write(
        &dir.join("state.json"),
        &json!({"id": id, "version": 2, "createdAt": 9, "updatedAt": 9}).to_string(),
    );
    let wire = format!(
        "{}\n{}\n{}\n",
        json!({"type":"config.update","systemPrompt": "x".repeat(200_000)}),
        json!({"type":"turn.prompt","input":[{"type":"text","text": "y".repeat(50_000)}]}),
        json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"deep opening turn"}],"origin":{"kind":"user"}}})
    );
    write(&dir.join("agents/main/wire.jsonl"), &wire);
    let mut roots = tmp.roots();
    roots.set_env("KIMI_CODE_HOME", tmp.path().to_string_lossy());
    let store = Store::new(roots);
    assert_eq!(store.describe_kimi(id).unwrap().title, "deep opening turn");
    write(
        &tmp.path().join("session_index.jsonl"),
        &format!(
            "{}\n",
            json!({"sessionId": id, "sessionDir": dir, "workDir": "/work"})
        ),
    );
    assert_eq!(store.describe_kimi(id).unwrap().title, "deep opening turn");
    write(
        &tmp.path().join("session_index.jsonl"),
        &format!(
            "{}\n",
            json!({"sessionId": id, "sessionDir": tmp.path().join("sessions/wd_rivet_abc123")})
        ),
    );
    assert_eq!(store.describe_kimi(id).unwrap().title, "deep opening turn");
    assert!(store.read_kimi("session_gone").turns.is_empty());
    assert!(store.read_kimi("session_gone").command.is_empty());
}

#[test]
fn codex_two_files_newest_first_and_room_lookup_stays_empty() {
    let tmp = Tmp::new("codex-two");
    let id = "00000000-0000-4000-8000-000000000020";
    let id2 = "00000000-0000-4000-8000-000000000031";
    let home = tmp.path().join("codex");
    let newer = home
        .join("sessions/2026/09/07")
        .join(format!("rollout-2020-01-01T00-00-00-{id}.jsonl"));
    let older = home
        .join("sessions/2026/09/06")
        .join(format!("rollout-2026-09-06T01-00-00-{id2}.jsonl"));
    write(
        &newer,
        &format!(
            "{}\n{}\n{}\n{}\n",
            json!({"type":"session_meta","payload":{"id": id}}),
            json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<environment_context>skip</environment_context>"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review the rollout parser"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}})
        ),
    );
    write(
        &older,
        &format!(
            "{}\n",
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"older session"}]}})
        ),
    );
    touch(&newer, 2_000_000_000_000);
    touch(&older, 1_000_000_000_000);
    let mut roots = tmp.roots();
    roots.set_env("CODEX_HOME", home.to_string_lossy());
    let store = Store::new(roots);
    let sessions = store.list(&["codex"], 50, &[]);
    assert_eq!(
        sessions
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        [id, id2]
    );
    assert_eq!(sessions[0].title, "review the rollout parser");
    assert_eq!(sessions[1].title, "older session");
    assert_eq!(store.describe_codex(id).unwrap().title, sessions[0].title);
    assert!(
        store
            .describe_codex("00000000-0000-4000-8000-000000000000")
            .is_none()
    );
    assert!(store.describe_codex("../../etc/passwd").is_none());
    assert!(store.session_exists("codex", id));
    assert!(!store.session_exists("codex", "not-a-uuid"));
    let read = store.read_codex(id);
    assert_eq!(read.turns[0].text, "review the rollout parser");
    assert_eq!(read.turns[1].text, "ok");
    assert_eq!(read.turns[1].complete, Some(true));
    let resolved = store.resolve(&format!("codex:{id}")).unwrap();
    assert!(resolved.path.contains(id));
    assert!(resolved.path.contains("rollout-"));
    assert!(
        store.read_codex(id2).turns.is_empty()
            || store.read_codex(id2).turns[0].text == "older session"
    );
    assert!(store.read_transcript(&format!("codex:{id2}")).command == "codex");
    assert!(
        store
            .read_transcript(&format!("grok-build:{id2}"))
            .turns
            .is_empty()
    );
}

#[test]
fn opencode_fold_matches_message_and_part_rows() {
    let tmp = Tmp::new("opencode-fold");
    let id = "ses_01K8ABCDEFGHIJKLMNOPQRSTUV";
    let id2 = "ses_01K8QRSTUVWXYZABCDEFGHIJKL";
    let db = tmp.path().join(".local/share/opencode/opencode.db");
    let user_data = json!({"role":"user","time":{"created":1_700_000_000_100_i64},"agent":"build","model":{"providerID":"zai","modelID":"glm-5.3-flash"}}).to_string();
    let asst_data = json!({"parentID":"msg_user","role":"assistant","mode":"build","agent":"build","modelID":"glm-5.3-flash","providerID":"zai","tokens":{"total":130,"input":100,"output":20,"reasoning":5,"cache":{"write":0,"read":10}},"time":{"created":1_700_000_000_200_i64,"completed":1_700_000_000_250_i64}}).to_string();
    let model = json!({"id":"glm-5.3-flash","providerID":"zai","variant":"default"}).to_string();
    let sql = format!(
        "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('{id}', 'review the opencode driver', '/work/app', '{model}', 1700000000000, 1700000100000), ('{id2}', 'second session', '/work/app', NULL, 1700000200000, 1700000300000);
         INSERT INTO message VALUES ('msg_user', '{id}', 1700000000100, 1700000000100, '{user_data}'), ('msg_asst', '{id}', 1700000000200, 1700000000250, '{asst_data}');
         INSERT INTO part VALUES
           ('prt_1', 'msg_user', '{id}', 1700000000110, '{{\"type\":\"text\",\"text\":\"review the diff\"}}'),
           ('prt_think', 'msg_asst', '{id}', 1700000000210, '{{\"type\":\"reasoning\",\"text\":\"weighing it\"}}'),
           ('prt_tool', 'msg_asst', '{id}', 1700000000220, '{{\"type\":\"tool\",\"tool\":\"Bash\",\"state\":{{\"status\":\"completed\",\"input\":{{\"command\":\"git diff\"}},\"output\":\"\",\"title\":\"git diff\"}}}}'),
           ('prt_text', 'msg_asst', '{id}', 1700000000230, '{{\"type\":\"text\",\"text\":\"looks good\"}}');"
    );
    sqlite(&db, &sql);
    let mut roots = tmp.roots();
    roots.cwd = std::path::PathBuf::from("/");
    let store = Store::new(roots);
    let listed = store.list(&["opencode"], 50, &[]);
    assert_eq!(
        listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [id2, id]
    );
    assert_eq!(listed[1].title, "review the opencode driver");
    assert_eq!(listed[1].model.as_deref(), Some("zai/glm-5.3-flash"));
    assert_eq!(listed[1].updated_at, 1_700_000_100_000);
    assert_eq!(store.describe_opencode(id).unwrap().title, listed[1].title);
    assert!(store.describe_opencode("ses_nope").is_none());
    assert_eq!(
        store
            .newest_opencode_after("/work/app", 1_700_000_000_000)
            .as_deref(),
        Some(id2)
    );
    assert_eq!(
        store
            .newest_opencode_after("/work/app", 1_700_000_015_000)
            .as_deref(),
        Some(id2)
    );
    assert!(
        store
            .newest_opencode_after("/work/app", 1_700_000_200_001)
            .is_none()
    );
    assert!(store.newest_opencode_after("/work/other", 0).is_none());
    assert!(store.session_exists("opencode", id));
    assert!(!store.session_exists("opencode", "ses_deadbeefdeadbeef"));
    let read = store.read_opencode(id);
    assert_eq!(read.turns[0].text, "review the diff");
    let asst = &read.turns[1];
    assert_eq!(asst.text, "looks good");
    assert_eq!(asst.thinking.as_deref(), Some("weighing it"));
    assert_eq!(asst.model.as_deref(), Some("zai/glm-5.3-flash"));
    assert_eq!(asst.complete, Some(true));
    assert_eq!(asst.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(asst.last_block, Some(LastBlock::Text));
    assert_eq!(
        asst.usage.as_ref().map(|row| (
            row.prompt_tokens,
            row.completion_tokens,
            row.cached_tokens
        )),
        Some((110, 25, 10))
    );
    let tool = asst
        .tools
        .as_ref()
        .and_then(|tools| tools.first())
        .expect("tool");
    assert_eq!(tool.name, "Bash");
    assert_eq!(tool.status, ToolStatus::Done);
    assert_eq!(tool.id.as_deref(), Some("prt_tool"));
    assert_eq!(
        tool.args
            .as_ref()
            .and_then(|row| row.get("command"))
            .and_then(protocol::js::JsValue::as_str),
        Some("git diff")
    );
    let resolved = store.resolve(&format!("opencode:{id}")).unwrap();
    assert!(resolved.path.ends_with("opencode.db"));
    let watches = resolved.watch_paths.expect("watches");
    assert_eq!(
        watches,
        vec![
            resolved.path.clone(),
            format!("{}-wal", resolved.path),
            format!("{}-shm", resolved.path)
        ]
    );
    assert!(store.read_opencode("ses_gonegonegone").turns.is_empty());
}

#[test]
fn pi_keeps_the_newest_file_per_uuid_and_honors_limit() {
    let tmp = Tmp::new("pi-newest");
    let id = "00000000-0000-4000-8000-000000000031";
    let other = "15cb936c-3364-49d6-8769-21f0c635f160";
    let home = tmp.path().join("pi");
    let older = home
        .join("sessions/--home-rivet--")
        .join(format!("2026-09-11T10-00-00-000Z_{id}.jsonl"));
    let newer = home
        .join("sessions/--srv-work--")
        .join(format!("2026-09-11T18-00-00-000Z_{id}.jsonl"));
    let other_file = home
        .join("sessions/--srv-work--")
        .join(format!("2026-09-11T12-00-00-000Z_{other}.jsonl"));
    write(
        &older,
        &format!(
            "{}\n",
            json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"old cwd"}]}})
        ),
    );
    write(
        &newer,
        &format!(
            "{}\n",
            json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"new cwd"}]}})
        ),
    );
    write(
        &other_file,
        &format!(
            "{}\n",
            json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"other session"}]}})
        ),
    );
    touch(&older, 1_700_000_000_000);
    touch(&newer, 1_700_000_800_000);
    touch(&other_file, 1_700_000_400_000);
    let mut roots = tmp.roots();
    roots.pi_home = Some(home.clone());
    let store = Store::new(roots);
    let sessions = store.list(&["pi"], 50, &[]);
    assert_eq!(sessions.len(), 2);
    assert_eq!(store.read_pi(id).turns[0].text, "new cwd");
    assert_eq!(
        store.resolve(&format!("pi:{id}")).unwrap().path,
        newer.to_string_lossy()
    );
    let limited = store.list(&["pi"], 1, &[]);
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].id, id);
    let missing = "11111111-1111-4111-8111-111111111199";
    assert!(!store.session_exists("pi", missing));
    assert!(store.describe_pi(missing).is_none());
    let gone = store.read_pi(missing);
    assert!(gone.command.is_empty());
    assert!(gone.turns.is_empty());
}

#[test]
fn qwen_missing_jsonl_is_absent() {
    let tmp = Tmp::new("qwen-miss");
    let mut roots = tmp.roots();
    roots.qwen_home = Some(tmp.path().join("qwen"));
    let store = Store::new(roots);
    let id = "15cb936c-3364-49d6-8769-21f0c635f160";
    assert!(!store.session_exists("qwen", id));
    assert!(store.describe_qwen(id).is_none());
    let gone = store.read_qwen(id);
    assert!(gone.command.is_empty());
    assert!(gone.turns.is_empty());
    let stamp = tmp.path().join("stamp");
    write(&stamp, "x");
    touch(&stamp, 1_000);
    sqlite(&tmp.path().join("unused.db"), "create table t(id integer);");
}
