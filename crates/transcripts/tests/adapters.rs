#[path = "common/mod.rs"]
mod common;

use std::collections::HashMap;
use std::fs;

use transcripts::turn::{LastBlock, Role, Tool, ToolStatus, Turn, Usage};
use transcripts::{
    adapter_for_command, codex_reject_approval, codex_turns_from_lines, create_turn_tracker, cursor_turns_from_objects,
    kimi_deltas_from_turns, kimi_turns_from_lines, kimi_turns_from_text, opencode_turns_from_messages, pi_turns_from_lines,
    qwen_turns_from_lines, qwen_turns_from_text,
};

use common::{obj, objs};

fn tool(name: &str, status: ToolStatus, id: Option<&str>, args: serde_json::Value) -> Tool {
    Tool {
        name: name.into(),
        status,
        args: args.as_object().cloned(),
        id: id.map(str::to_string),
        input: None,
        result_text: None,
    }
}

#[test]
fn adapter_roster_matches_commands() {
    assert!(adapter_for_command("claude").expect("claude").capabilities.live_turn);
    for command in ["grok", "hermes", "kimi", "codex", "opencode"] {
        assert!(adapter_for_command(command).expect(command).capabilities.live_turn);
    }
    let pairs = [
        ("claude", "claude-code"),
        ("grok", "grok-build"),
        ("kimi", "kimi-code"),
        ("hermes", "hermes"),
        ("codex", "codex"),
        ("opencode", "opencode"),
        ("pi", "pi"),
        ("qwen", "qwen-code"),
        ("cursor", "cursor"),
        ("cowork", "cowork"),
    ];
    for (command, id) in pairs {
        assert_eq!(adapter_for_command(command).expect(command).id, id);
    }
    assert!(adapter_for_command("unknown").is_none());
    assert!(adapter_for_command("").is_none());
    assert!(adapter_for_command("claude-code").is_none());
    let qwen = adapter_for_command("qwen").expect("qwen");
    assert!(qwen.prompt_tool_names.is_empty());
    assert!(qwen.capabilities.live_turn);
    assert!(!qwen.capabilities.prompts);
    assert!(!qwen.capabilities.approvals);
    assert!(!adapter_for_command("codex").expect("codex").capabilities.approvals);
    let err = codex_reject_approval().expect_err("reject");
    assert_eq!(err.code(), "capability_unsupported");
}

#[test]
fn codex_pairs_calls_and_keeps_commentary_in_flight() {
    let mut lines = objs(serde_json::json!([
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"check it"}]}},
        {"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking now."}]}}
    ]));
    assert!(codex_turns_from_lines(&lines)[1].complete.is_none());
    lines.extend(objs(serde_json::json!([
        {"type":"response_item","payload":{"type":"custom_tool_call","id":"item-1","call_id":"call-1","name":"exec","input":"text(1)"}},
        {"type":"response_item","payload":{"type":"custom_tool_call_output","id":"result-1","call_id":"call-1","output":"1"}},
        {"type":"response_item","payload":{"type":"function_call","id":"item-2","call_id":"call-2","name":"shell","arguments":"{\"command\":\"pwd\"}"}},
        {"type":"response_item","payload":{"type":"function_call_output","call_id":"call-2","output":"/tmp"}}
    ])));
    let pending = &codex_turns_from_lines(&lines)[1];
    assert_eq!(
        pending.tools,
        Some(vec![
            tool("exec", ToolStatus::Done, Some("call-1"), serde_json::json!({"input":"text(1)"})),
            tool("shell", ToolStatus::Done, Some("call-2"), serde_json::json!({"command":"pwd"})),
        ])
    );
    assert!(pending.complete.is_none());
    assert!(pending.stop_reason.is_none());
    lines.push(obj(serde_json::json!({"type":"event_msg","payload":{"type":"task_complete"}})));
    assert_eq!(codex_turns_from_lines(&lines)[1].complete, Some(true));
}

#[test]
fn codex_folds_one_turn_and_drops_injections() {
    let turns = codex_turns_from_lines(&objs(serde_json::json!([
        {"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000020"}},
        {"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<environment_context>cwd=/tmp</environment_context>"}]}},
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<skills_instructions>never show this</skills_instructions>"}]}},
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<multi_agent_foo>also skip</multi_agent_foo>"}]}},
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"list the files"}]}},
        {"type":"event_msg","payload":{"type":"task_started"}},
        {"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"I should list"}]}},
        {"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_1","name":"shell","input":"{\"command\":\"ls\",\"extra\":{\"nested\":true}}"}},
        {"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_1","call_id":"ctc_1","output":"a.txt"}},
        {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"here they are"}]}},
        {"type":"token_usage_record","payload":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":5}},
        {"type":"event_msg","payload":{"type":"task_complete"}},
        {"type":"turn_context","payload":{}}
    ])));
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0], Turn::user("list the files"));
    assert_eq!(turns[1].role, Role::Assistant);
    assert_eq!(turns[1].text, "here they are");
    assert_eq!(turns[1].thinking.as_deref(), Some("I should list"));
    assert_eq!(
        turns[1].tools,
        Some(vec![tool("shell", ToolStatus::Done, Some("ctc_1"), serde_json::json!({"command":"ls"}))])
    );
    assert_eq!(
        turns[1].usage,
        Some(Usage { prompt_tokens: 100, completion_tokens: 35, cached_tokens: 20 })
    );
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(turns[1].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(turns[1].last_block, Some(LastBlock::Text));
}

#[test]
fn codex_running_tool_and_error_field() {
    let mid = codex_turns_from_lines(&objs(serde_json::json!([
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"run it"}]}},
        {"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_err","name":"shell","input":{"command":"false"}}}
    ])));
    assert_eq!(mid.len(), 2);
    assert!(mid[1].complete.is_none());
    assert_eq!(mid[1].stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(mid[1].tools.as_ref().expect("tools")[0].id.as_deref(), Some("ctc_err"));
    assert_eq!(mid[1].tools.as_ref().expect("tools")[0].status, ToolStatus::Running);
    let failed = codex_turns_from_lines(&objs(serde_json::json!([
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"run it"}]}},
        {"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_err","name":"shell","input":{"command":"false"}}},
        {"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_err","call_id":"ctc_err","output":"exit 1","error":"command failed"}},
        {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"it failed"}]}}
    ])));
    assert_eq!(failed[1].tools.as_ref().expect("tools")[0].status, ToolStatus::Error);
    assert_eq!(failed[1].complete, Some(true));
}

#[test]
fn codex_keeps_final_completion_when_commentary_follows() {
    let turns = codex_turns_from_lines(&objs(serde_json::json!([
        {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"run it"}]}},
        {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}},
        {"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"extra context"}]}}
    ])));
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(turns[1].stop_reason.as_deref(), Some("end_turn"));
}

#[test]
fn codex_developer_only_is_empty() {
    let turns = codex_turns_from_lines(&objs(serde_json::json!([
        {"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"system"}]}},
        {"type":"event_msg","payload":{"type":"token_count"}}
    ])));
    assert!(turns.is_empty());
}

#[test]
fn cursor_keeps_send_message_body() {
    let turns = cursor_turns_from_objects(&objs(serde_json::json!([
        {"role":"user","message":{"content":[{"type":"text","text":"add cursor to the hub"}]}},
        {"role":"assistant","message":{"content":[
            {"type":"text","text":"I will add it."},
            {"type":"tool_use","name":"SendMessage","input":{"content":"Cursor is in the harness list."}}
        ]}}
    ])));
    assert_eq!(turns[0].role, Role::User);
    assert_eq!(turns[0].text, "add cursor to the hub");
    assert_eq!(turns[0].last_block, Some(LastBlock::Text));
    assert_eq!(turns[1].text, "I will add it.\nCursor is in the harness list.");
    assert_eq!(turns[1].last_block, Some(LastBlock::ToolUse));
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(
        turns[1].tools,
        Some(vec![tool(
            "SendMessage",
            ToolStatus::Done,
            None,
            serde_json::json!({"content":"Cursor is in the harness list."})
        )])
    );
}

#[test]
fn cursor_tools_are_done() {
    let turns = cursor_turns_from_objects(&objs(serde_json::json!([
        {"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"git status","description":"status"}}]}}
    ])));
    let tool = &turns[0].tools.as_ref().expect("tools")[0];
    assert_eq!(tool.name, "Shell");
    assert_eq!(tool.status, ToolStatus::Done);
    assert!(turns[0].text.is_empty());
}

#[test]
fn pi_completes_tools_and_reads_usage() {
    let turns = pi_turns_from_lines(&objs(serde_json::json!([
        {"type":"message","message":{"role":"user","content":[{"type":"text","text":"ls"}]}},
        {"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"Bash_0","name":"Bash","arguments":{"command":"ls"}}]}},
        {"type":"message","message":{"role":"toolResult","toolCallId":"Bash_0","toolName":"Bash","content":[{"type":"text","text":"a\nb\n"}]}},
        {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1516,"output":10,"cacheRead":4,"cacheWrite":2,"reasoning":0,"totalTokens":1526}}}
    ])));
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0].role, Role::User);
    assert_eq!(turns[0].text, "ls");
    assert_eq!(
        turns[1].tools,
        Some(vec![tool("Bash", ToolStatus::Done, Some("Bash_0"), serde_json::json!({"command":"ls"}))])
    );
    assert_eq!(turns[2].text, "done");
    assert_eq!(
        turns[2].usage,
        Some(Usage { prompt_tokens: 1522, completion_tokens: 10, cached_tokens: 6 })
    );
}

#[test]
fn pi_tool_result_is_not_a_turn() {
    let turns = pi_turns_from_lines(&objs(serde_json::json!([
        {"type":"message","message":{"role":"toolResult","toolCallId":"x","toolName":"Bash","content":[{"type":"text","text":"nope"}]}}
    ])));
    assert!(turns.is_empty());
}

#[test]
fn pi_snake_case_usage() {
    let turns = pi_turns_from_lines(&objs(serde_json::json!([
        {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":4,"cache_read_tokens":1}}}
    ])));
    assert_eq!(
        turns[0].usage,
        Some(Usage { prompt_tokens: 11, completion_tokens: 4, cached_tokens: 1 })
    );
}

#[test]
fn qwen_folds_real_user_and_skips_system() {
    let turns = qwen_turns_from_lines(&objs(serde_json::json!([
        {"type":"user","provenance":"real_user","cwd":"/home/example/proj","message":{"role":"user","parts":[{"text":"reply with the single word pong"}]}},
        {"type":"system","provenance":"system","subtype":"attribution_snapshot","systemPayload":{"snapshot":{"type":"attribution-snapshot"}}},
        {"type":"assistant","provenance":"assistant_output","model":"qwen-27b","message":{"role":"model","parts":[{"text":"The user is asking for a response with just the single word \"pong\".","thought":true},{"text":"\n\npong"}]},"usageMetadata":{"promptTokenCount":26724,"candidatesTokenCount":78,"thoughtsTokenCount":78,"totalTokenCount":26802,"cachedContentTokenCount":0}}
    ])));
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0], Turn::user("reply with the single word pong"));
    assert_eq!(turns[1].text, "pong");
    assert_eq!(
        turns[1].thinking.as_deref(),
        Some("The user is asking for a response with just the single word \"pong\".")
    );
    assert_eq!(turns[1].model.as_deref(), Some("qwen-27b"));
    assert_eq!(turns[1].last_block, Some(LastBlock::Text));
    assert_eq!(turns[1].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(
        turns[1].usage,
        Some(Usage { prompt_tokens: 26724, completion_tokens: 78, cached_tokens: 0 })
    );
}

#[test]
fn qwen_skips_non_real_user() {
    let turns = qwen_turns_from_lines(&objs(serde_json::json!([
        {"type":"user","provenance":"tool_result","message":{"role":"user","parts":[{"text":"should not appear"}]}}
    ])));
    assert!(turns.is_empty());
}

#[test]
fn qwen_completes_function_calls() {
    let turns = qwen_turns_from_lines(&objs(serde_json::json!([
        {"type":"user","provenance":"real_user","message":{"role":"user","parts":[{"text":"Use the run_shell_command tool to run: echo tool-sample-ok."}]}},
        {"type":"assistant","model":"qwen-27b","message":{"role":"model","parts":[{"text":"Looking up the deferred tool.","thought":true},{"functionCall":{"id":"call_bda5b2b65280477f9794028f","name":"tool_search","args":{"query":"select:run_shell_command"}}}]},"usageMetadata":{"promptTokenCount":24330,"candidatesTokenCount":237,"thoughtsTokenCount":220,"cachedContentTokenCount":0}},
        {"type":"tool_result","message":{"role":"user","parts":[{"functionResponse":{"id":"call_bda5b2b65280477f9794028f","name":"tool_search","response":{"output":"Loaded 1 tool(s)"}}}]}},
        {"type":"assistant","model":"qwen-27b","message":{"role":"model","parts":[{"text":"Running the command.","thought":true},{"functionCall":{"id":"call_6ef8c237955540faabb31812","name":"run_shell_command","args":{"command":"echo tool-sample-ok","description":"Print a sample marker"}}}]},"usageMetadata":{"promptTokenCount":26222,"candidatesTokenCount":101,"thoughtsTokenCount":61,"cachedContentTokenCount":0}},
        {"type":"tool_result","message":{"role":"user","parts":[{"functionResponse":{"id":"call_6ef8c237955540faabb31812","name":"run_shell_command","response":{"output":"Output: tool-sample-ok\nExit Code: 0"}}}]}},
        {"type":"assistant","model":"qwen-27b","message":{"role":"model","parts":[{"text":"The output is tool-sample-ok.","thought":true},{"text":"\n\ntool-sample-ok"}]},"usageMetadata":{"promptTokenCount":26388,"candidatesTokenCount":22,"thoughtsTokenCount":17,"cachedContentTokenCount":0}}
    ])));
    assert_eq!(turns.len(), 4);
    assert_eq!(turns[0].text, "Use the run_shell_command tool to run: echo tool-sample-ok.");
    assert_eq!(
        turns[1].tools,
        Some(vec![tool(
            "tool_search",
            ToolStatus::Done,
            Some("call_bda5b2b65280477f9794028f"),
            serde_json::json!({"query":"select:run_shell_command"})
        )])
    );
    assert!(turns[1].complete.is_none());
    assert_eq!(turns[1].stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(
        turns[2].tools,
        Some(vec![tool(
            "run_shell_command",
            ToolStatus::Done,
            Some("call_6ef8c237955540faabb31812"),
            serde_json::json!({"command":"echo tool-sample-ok","description":"Print a sample marker"})
        )])
    );
    assert!(turns[2].complete.is_none());
    assert_eq!(turns[3].text, "tool-sample-ok");
    assert_eq!(turns[3].complete, Some(true));
    assert_eq!(
        turns[3].usage,
        Some(Usage { prompt_tokens: 26388, completion_tokens: 22, cached_tokens: 0 })
    );
}

#[test]
fn qwen_fixture_final_turn_is_idle() {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/qwen/qwen-code-tool-turn.jsonl"
    ))
    .expect("fixture");
    let lines: Vec<String> = raw.split('\n').filter(|line| !line.trim().is_empty()).map(str::to_string).collect();
    let turns = qwen_turns_from_text(&lines);
    let last = turns.last().expect("last");
    assert_eq!(last.role, Role::Assistant);
    assert_eq!(last.text, "tool-sample-ok");
    assert_eq!(last.complete, Some(true));
    let adapter = adapter_for_command("qwen").expect("qwen");
    let mut tracker = create_turn_tracker(&adapter);
    tracker.apply(&turns);
    assert_eq!(tracker.in_flight(), Some(false));
    let one = obj(serde_json::json!({"type":"user","provenance":"real_user","message":{"role":"user","parts":[{"text":"hi"}]}}));
    let parsed = qwen_turns_from_lines(std::slice::from_ref(&one));
    let from_text = qwen_turns_from_text(&[serde_json::to_string(&one).expect("json")]);
    assert_eq!(parsed, vec![Turn::user("hi")]);
    assert_eq!(from_text, parsed);
}

#[test]
fn qwen_following_user_closes_assistant() {
    let turns = qwen_turns_from_lines(&objs(serde_json::json!([
        {"type":"user","provenance":"real_user","message":{"role":"user","parts":[{"text":"first"}]}},
        {"type":"assistant","message":{"role":"model","parts":[{"functionCall":{"id":"c1","name":"read_file","args":{"path":"/x"}}}]}},
        {"type":"user","provenance":"real_user","message":{"role":"user","parts":[{"text":"second"}]}}
    ])));
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[1].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(turns[2], Turn::user("second"));
}

#[test]
fn qwen_tool_result_alone_is_empty() {
    let turns = qwen_turns_from_lines(&objs(serde_json::json!([
        {"type":"tool_result","message":{"role":"user","parts":[{"functionResponse":{"id":"x","name":"run_shell_command","response":{"output":"nope"}}}]}}
    ])));
    assert!(turns.is_empty());
}

#[test]
fn qwen_cache_is_not_added_to_prompt() {
    let turns = qwen_turns_from_lines(&objs(serde_json::json!([
        {"type":"assistant","model":"qwen-27b","message":{"role":"model","parts":[{"text":"ok"}]},"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":4,"cachedContentTokenCount":20,"thoughtsTokenCount":3}}
    ])));
    assert_eq!(
        turns[0].usage,
        Some(Usage { prompt_tokens: 100, completion_tokens: 4, cached_tokens: 20 })
    );
}

fn kimi_user() -> serde_json::Value {
    serde_json::json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"review the diff"}],"origin":{"kind":"user"}}})
}

fn ev(event: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"type":"context.append_loop_event","event":event})
}

#[test]
fn kimi_folds_step_end_usage() {
    let turns = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        {"type":"llm.request","model":"kimi-k2","kind":"chat"},
        ev(serde_json::json!({"type":"step.begin"})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"weighing it"}})),
        ev(serde_json::json!({"type":"tool.call","toolCallId":"Bash_0","name":"Bash","args":{"command":"git diff"}})),
        ev(serde_json::json!({"type":"tool.result","toolCallId":"Bash_0","result":{"isError":true}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks good"}})),
        ev(serde_json::json!({"type":"step.end","usage":{"inputOther":100,"inputCacheRead":20,"inputCacheCreation":5,"output":40}}))
    ])));
    assert_eq!(turns[0], Turn::user("review the diff"));
    assert_eq!(turns[1].text, "looks good");
    assert_eq!(turns[1].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(turns[1].last_block, Some(LastBlock::Text));
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(turns[1].thinking.as_deref(), Some("weighing it"));
    assert_eq!(
        turns[1].tools,
        Some(vec![tool("Bash", ToolStatus::Error, Some("Bash_0"), serde_json::json!({"command":"git diff"}))])
    );
    assert_eq!(
        turns[1].usage,
        Some(Usage { prompt_tokens: 125, completion_tokens: 40, cached_tokens: 20 })
    );
    assert_eq!(turns[1].model.as_deref(), Some("kimi-k2"));
}

#[test]
fn kimi_deltas_match_the_adapter_cases() {
    let next = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"plan"}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"done"}}))
    ])));
    assert!(kimi_deltas_from_turns(None, &next).is_empty());
    assert!(kimi_deltas_from_turns(Some(&[]), &next).is_empty());

    let start = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"weighing "}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks "}}))
    ])));
    let grew_think = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"weighing "}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"it"}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks "}}))
    ])));
    let d = kimi_deltas_from_turns(Some(&start), &grew_think);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].kind, "reasoning");
    assert_eq!(d[0].text, "it");
    let grew_text = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"weighing "}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":"it"}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks "}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"good"}}))
    ])));
    let d = kimi_deltas_from_turns(Some(&grew_think), &grew_text);
    assert_eq!(d[0].kind, "assistant");
    assert_eq!(d[0].text, "\n\ngood");

    let asst = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"done"}}))
    ])));
    let mut plus_user = asst.clone();
    plus_user.push(Turn::user("again"));
    assert!(kimi_deltas_from_turns(Some(&asst), &plus_user).is_empty());
    assert!(kimi_deltas_from_turns(Some(&asst), &asst[..1]).is_empty());

    let partial = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks"}}))
    ])));
    let finished = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks"}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"good"}})),
        {"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"again"}],"origin":{"kind":"user"}}}
    ])));
    assert_eq!(finished.iter().map(|turn| turn.role).collect::<Vec<_>>(), vec![Role::User, Role::Assistant, Role::User]);
    let d = kimi_deltas_from_turns(Some(&partial), &finished);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].text, "\n\ngood");
    let both = kimi_turns_from_lines(&objs(serde_json::json!([
        kimi_user(),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"looks"}})),
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"good"}})),
        {"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"again"}],"origin":{"kind":"user"}}},
        ev(serde_json::json!({"type":"content.part","part":{"type":"text","text":"on it"}}))
    ])));
    let d = kimi_deltas_from_turns(Some(&partial), &both);
    assert_eq!(d.len(), 2);
    assert_eq!(d[0].text, "\n\ngood");
    assert_eq!(d[1].text, "on it");
}

#[test]
fn kimi_diffs_thinking_past_the_display_cap() {
    let cap = transcripts::turn::THINKING_TAIL_CHARS;
    let parse = |think: String| {
        kimi_turns_from_lines(&objs(serde_json::json!([
            kimi_user(),
            ev(serde_json::json!({"type":"content.part","part":{"type":"think","think":think}}))
        ])))
    };
    let raw_a = "a".repeat(cap);
    let raw_b = format!("{raw_a}X");
    let raw_c = format!("{raw_b}{}", "Y".repeat(80));
    let raw_d = format!("{raw_c}Z");
    let a = parse(raw_a.clone());
    let b = parse(raw_b);
    let c = parse(raw_c.clone());
    let d = parse(raw_d.clone());
    assert_eq!(a[1].thinking.as_deref(), Some(raw_a.as_str()));
    assert!(b[1].thinking.as_deref().unwrap_or("").starts_with('…'));
    assert_eq!(b[1].thinking.as_deref().unwrap_or("").encode_utf16().count(), 1 + cap);
    let tail = transcripts::value::js_slice(&raw_c, -(cap as isize), None);
    assert_eq!(c[1].thinking.as_deref(), Some(format!("…{tail}").as_str()));
    assert!(kimi_deltas_from_turns(None, &a).is_empty());
    let d1 = kimi_deltas_from_turns(Some(&a), &b);
    let d2 = kimi_deltas_from_turns(Some(&b), &c);
    let d3 = kimi_deltas_from_turns(Some(&c), &d);
    assert_eq!(d1[0].text, "X");
    assert_eq!(d2[0].text, "Y".repeat(80));
    assert_eq!(d3[0].text, "Z");
    let emitted = format!("{}{}{}", d1[0].text, d2[0].text, d3[0].text);
    assert_eq!(emitted, raw_d[raw_a.len()..]);
    assert!(!emitted.contains('…'));
}

#[test]
fn kimi_wire_growth_emits_only_new_suffixes() {
    let raw = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/kimi/kimi-wire-live.jsonl"
    ))
    .expect("fixture");
    let mut lines: Vec<String> = raw.split('\n').map(str::to_string).collect();
    let seeded = kimi_turns_from_text(&lines);
    assert!(kimi_deltas_from_turns(None, &seeded).is_empty());
    assert_eq!(seeded[1].thinking.as_deref(), Some("weighing "));
    assert_eq!(seeded[1].text, "looks");
    lines.push(serde_json::json!({"type":"context.append_loop_event","event":{"type":"content.part","turnId":"0","step":1,"part":{"type":"think","think":"it"}}}).to_string());
    let grew = kimi_turns_from_text(&lines);
    let d = kimi_deltas_from_turns(Some(&seeded), &grew);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].kind, "reasoning");
    assert_eq!(d[0].text, "it");
    lines.push(serde_json::json!({"type":"context.append_loop_event","event":{"type":"content.part","turnId":"0","step":1,"part":{"type":"text","text":"good"}}}).to_string());
    let more = kimi_turns_from_text(&lines);
    let d2 = kimi_deltas_from_turns(Some(&grew), &more);
    assert_eq!(d2[0].kind, "assistant");
    assert_eq!(d2[0].text, "\n\ngood");
}

#[test]
fn opencode_finished_message_and_running_tool() {
    let mut parts = HashMap::new();
    parts.insert(
        "a".into(),
        vec![
            obj(serde_json::json!({"type":"tool","tool":"Bash","id":"t1","state":{"status":"completed","input":{"command":"ls"}}})),
            obj(serde_json::json!({"type":"text","text":"done"})),
            obj(serde_json::json!({"type":"step_finish"})),
        ],
    );
    let turns = opencode_turns_from_messages(
        &objs(serde_json::json!([
            {"id":"u","role":"user","content":"hi"},
            {"id":"a","role":"assistant","modelID":"glm-5.3-flash","providerID":"zai","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":10,"write":0}},"time":{"created":1,"completed":2}}
        ])),
        &parts,
    );
    assert_eq!(turns[0], Turn::user("hi"));
    assert_eq!(turns[1].text, "done");
    assert_eq!(turns[1].model.as_deref(), Some("zai/glm-5.3-flash"));
    assert_eq!(turns[1].complete, Some(true));
    assert_eq!(turns[1].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(turns[1].last_block, Some(LastBlock::Text));
    assert_eq!(
        turns[1].usage,
        Some(Usage { prompt_tokens: 110, completion_tokens: 25, cached_tokens: 10 })
    );
    assert_eq!(
        turns[1].tools,
        Some(vec![tool("Bash", ToolStatus::Done, Some("t1"), serde_json::json!({"command":"ls"}))])
    );

    let mut running = HashMap::new();
    running.insert(
        "a".into(),
        vec![obj(serde_json::json!({"type":"tool","tool":"Bash","id":"t1","state":{"status":"running","input":{"command":"ls"}}}))],
    );
    let turns = opencode_turns_from_messages(
        &objs(serde_json::json!([
            {"id":"u","role":"user","content":"hi"},
            {"id":"a","role":"assistant"}
        ])),
        &running,
    );
    assert!(turns[1].complete.is_none());
    assert_eq!(turns[1].stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(turns[1].last_block, Some(LastBlock::ToolUse));
}

#[test]
fn opencode_tracker_completes_only_after_the_answer() {
    let adapter = adapter_for_command("opencode").expect("opencode");
    let mut tracker = create_turn_tracker(&adapter);
    let user = vec![Turn::user("hi")];
    assert_eq!(tracker.apply(&user).status.expect("status").status, "working");
    let mut tool_turn = Turn::assistant();
    tool_turn.text.clear();
    tool_turn.last_block = Some(LastBlock::ToolUse);
    tool_turn.stop_reason = Some("tool_use".into());
    tool_turn.tools = Some(vec![Tool {
        name: "Bash".into(),
        status: ToolStatus::Running,
        args: None,
        id: Some("t1".into()),
        input: None,
        result_text: None,
    }]);
    let tool = vec![Turn::user("hi"), tool_turn];
    assert!(tracker.apply(&tool).turn_completed.is_none());
    assert_eq!(tracker.in_flight(), Some(true));
    let mut parts = HashMap::new();
    parts.insert(
        "a".into(),
        vec![
            obj(serde_json::json!({"type":"tool","tool":"Bash","id":"t1","state":{"status":"completed","input":{"command":"ls"}}})),
            obj(serde_json::json!({"type":"text","text":"ok"})),
            obj(serde_json::json!({"type":"step-finish"})),
        ],
    );
    let done = opencode_turns_from_messages(
        &objs(serde_json::json!([
            {"id":"u","role":"user","content":"hi"},
            {"id":"a","role":"assistant","tokens":{"input":10,"output":2,"cache":{"read":0,"write":0}},"time":{"completed":2}}
        ])),
        &parts,
    );
    let edge = tracker.apply(&done);
    assert_eq!(edge.turn_completed, Some(true));
    assert_eq!(edge.status.expect("status").status, "idle");
    assert_eq!(tracker.in_flight(), Some(false));
}
