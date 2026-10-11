#[path = "support.rs"]
mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use harness_executors::*;
use protocol::{ArtifactKind, TaskVerdict};
use serde_json::{Value, json};
use support::{Tmp, map_env, script_runner, write_exe};

const KIMI_SESSION: &str = "session_11111111-2222-3333-4444-555555555555";
const PI_SESSION: &str = "00000000-0000-4000-8000-000000000030";
const QWEN_SESSION: &str = "00000000-0000-4000-8000-000000000049";
const OPENCODE_SESSION: &str = "ses_11111111111111111111111111";
const FAR: i64 = 9_000_000_000_000;

struct Fake {
    tmp: Tmp,
    binary: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_stdout(dir: &Path, lines: &[Value]) -> PathBuf {
    let path = dir.join("stdout.txt");
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    std::fs::write(&path, text).unwrap();
    path
}

fn write_raw(dir: &Path, raw: &str) -> PathBuf {
    let path = dir.join("stdout.txt");
    std::fs::write(&path, raw).unwrap();
    path
}

struct Script {
    stdin_guard: bool,
    on_flag: Option<(&'static str, String, i32, bool)>,
    stderr: Option<String>,
    exit_code: i32,
    slow: bool,
    extra: String,
}

fn install_script(fake: &Fake, name: &str, script: Script, stdout: &Path) -> PathBuf {
    let mut body = record_header(&fake.tmp.dir);
    if script.stdin_guard {
        body.push_str(
            "if [ -p /dev/stdin ]; then\n  printf '%s\\n' 'stdin was a pipe' >&2\n  exit 99\nfi\n",
        );
    }
    if script.slow {
        body.push_str("exec sleep 60\n");
    } else {
        let stderr_line = script
            .stderr
            .as_ref()
            .map(|stderr| format!("printf '%s\\n' {} >&2\n", quote(stderr)))
            .unwrap_or_default();
        if let Some((flag, text, code, to_stdout)) = &script.on_flag {
            let redir = if *to_stdout { "" } else { " >&2" };
            body.push_str(&format!(
                "for a in \"$@\"; do\n  if [ \"$a\" = {flag} ]; then\n    printf '%s\\n' {text}{redir}\n    {stderr_line}exit {code}\n  fi\ndone\n",
                flag = quote(flag),
                text = quote(text),
                redir = redir,
                stderr_line = stderr_line,
                code = code,
            ));
        }
        body.push_str(&script.extra);
        body.push_str(&stderr_line);
        body.push_str(&format!(
            "cat {stdout}\nexit {code}\n",
            stdout = quote(&stdout.display().to_string()),
            code = script.exit_code
        ));
    }
    write_exe(&fake.tmp.dir, name, &body)
}

fn fresh(name: &str) -> Fake {
    let tmp = Tmp::new();
    let home = tmp.path(name);
    let cwd = tmp.path("work");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    Fake {
        tmp,
        binary: PathBuf::new(),
        home,
        cwd,
    }
}

fn invocations(dir: &Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(dir.join("args.txt")).unwrap_or_default();
    let mut out = Vec::new();
    for line in text.split('\n') {
        if line == "--invocation--" {
            out.push(Vec::new());
        } else if !line.is_empty() && !out.is_empty() {
            out.last_mut().unwrap().push(line.to_string());
        }
    }
    out
}

fn invocation_texts(dir: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(dir.join("args.txt")).unwrap_or_default();
    text.split("--invocation--\n")
        .skip(1)
        .map(|chunk| chunk.trim_end_matches('\n').to_string())
        .collect()
}

fn env_file(dir: &Path) -> std::collections::BTreeMap<String, String> {
    let text = std::fs::read_to_string(dir.join("env.txt")).unwrap_or_default();
    let mut out = std::collections::BTreeMap::new();
    for line in text.split('\n') {
        if let Some((key, value)) = line.split_once('=') {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

fn record_header(dir: &Path) -> String {
    format!(
        "#!/usr/bin/env bash\nprintf '%s\\n' '--invocation--' \"$@\" >> '{}'\nenv > '{}'\n",
        dir.join("args.txt").display(),
        dir.join("env.txt").display(),
    )
}

fn den_texts(events: &[TaskEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event.den_body() {
            Some(DenBody::MessageAgent { text }) => Some(text.clone()),
            Some(DenBody::ThinkingDelta { text }) => Some(format!("think:{text}")),
            Some(DenBody::ToolStart { tool }) => {
                Some(format!("start:{}", tool.clone().unwrap_or_default()))
            }
            Some(DenBody::ToolEnd { tool }) => {
                Some(format!("end:{}", tool.clone().unwrap_or_default()))
            }
            None => None,
        })
        .collect()
}

fn turn_ids(events: &[TaskEvent]) -> Vec<Option<String>> {
    events
        .iter()
        .filter_map(|event| match event {
            TaskEvent::TurnEnd {
                harness_session_id, ..
            } => Some(harness_session_id.clone()),
            _ => None,
        })
        .collect()
}

fn env_of(script: &Path) -> Arc<MapEnv> {
    Arc::new(map_env(&[
        ("RIVETOS_SESSION_KEY", "chat-20260809-dead"),
        ("RR4D_SCRIPT", script.to_str().unwrap()),
    ]))
}

fn spec_in(fake: &Fake, goal: &str) -> TaskSpec {
    let mut spec = TaskSpec::conformance(goal);
    spec.working_dir = Some(fake.cwd.display().to_string());
    spec
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1).cloned())
}

fn history_of() -> Arc<HistorySource> {
    Arc::new(HistorySource {
        get_task_history: Some(Arc::new(|_task, _limit| {
            Ok(vec![HistoryMessage {
                role: "assistant".into(),
                content: Some("what turn one already did".into()),
            }])
        })),
        get_session_history: None,
    })
}

fn fence_text() -> String {
    format!(
        "Work complete.\n\n```TASK_RESULT\n{json}\n```",
        json = json!({
            "verdict": "completed",
            "summary": "Fixed the widget",
            "artifacts": [{ "kind": "commit", "ref": "abc123", "note": "the fix" }]
        })
    )
}

fn assert_fence(result: &protocol::TaskResult) {
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.summary, "Fixed the widget");
    assert_eq!(result.artifacts.len(), 1);
    assert_eq!(result.artifacts[0].kind(), Some(ArtifactKind::Commit));
    assert_eq!(result.artifacts[0].r#ref(), Some("abc123"));
    assert_eq!(
        result.artifacts[0]
            .note()
            .and_then(protocol::js::JsValue::as_str),
        Some("the fix")
    );
}

fn kimi_lines(text: &str, session: &str) -> Vec<Value> {
    vec![
        json!({"role": "meta", "type": "system.version", "version": "0.34.0"}),
        json!({"role": "assistant", "tool_calls": [{"type": "function", "id": "Bash_0", "function": {"name": "Bash", "arguments": "{\"command\":\"ls\"}"}}]}),
        json!({"role": "tool", "tool_call_id": "Bash_0", "content": "a\nb\n"}),
        json!({"role": "assistant", "content": text}),
        json!({"role": "meta", "type": "session.resume_hint", "session_id": session, "command": format!("kimi -r {session}")}),
    ]
}

fn kimi_wire() -> String {
    format!(
        "{{\"type\":\"metadata\"}}\n{{\"type\":\"usage.record\",\"usage\":{{\"inputOther\":100,\"output\":25,\"inputCacheRead\":10,\"inputCacheCreation\":0}},\"usageScope\":\"turn\",\"time\":{FAR}}}\n{{\"type\":\"usage.record\",\"usage\":{{\"inputOther\":40,\"output\":5,\"inputCacheRead\":0,\"inputCacheCreation\":0}},\"usageScope\":\"turn\",\"time\":{FAR}}}\n{{\"type\":\"usage.record\",\"usage\":{{\"inputOther\":99999,\"output\":99999,\"inputCacheRead\":0,\"inputCacheCreation\":0}},\"usageScope\":\"session\",\"time\":{FAR}}}\n{{\"type\":\"turn.ended\",\"turnId\":0,\"reason\":\"completed\",\"durationMs\":42,\"time\":{FAR}}}\n"
    )
}

fn prepare_kimi(
    lines: &[Value],
    on_resume: bool,
    stderr: Option<&str>,
    exit_code: i32,
    slow: bool,
) -> (Fake, KimiCodeExecutor) {
    let mut fake = fresh("kimi-home");
    let stdout = write_stdout(&fake.tmp.dir, lines);
    let session = fake
        .home
        .join("sessions")
        .join("wd_fake_000000000000")
        .join(KIMI_SESSION);
    let wire = session.join("agents").join("main").join("wire.jsonl");
    let wire_src = fake.tmp.path("wire.jsonl");
    std::fs::write(&wire_src, kimi_wire()).unwrap();
    let extra = format!(
        "mkdir -p {dir}\ncp {src} {dst}\nprintf '%s\\n' {row} >> {index}\n",
        dir = quote(&wire.parent().unwrap().display().to_string()),
        src = quote(&wire_src.display().to_string()),
        dst = quote(&wire.display().to_string()),
        row = quote(&format!(
            "{{\"sessionId\":\"{KIMI_SESSION}\",\"sessionDir\":\"{}\",\"workDir\":\"{}\"}}",
            session.display(),
            fake.cwd.display()
        )),
        index = quote(&fake.home.join("session_index.jsonl").display().to_string()),
    );
    let on_flag = on_resume.then(|| {
        (
            "-S",
            format!("Session \"{KIMI_SESSION}\" not found."),
            1,
            false,
        )
    });
    fake.binary = install_script(
        &fake,
        "kimi",
        Script {
            stdin_guard: false,
            on_flag,
            stderr: stderr.map(str::to_string),
            exit_code,
            slow,
            extra,
        },
        &stdout,
    );
    let mut executor = KimiCodeExecutor::new(script_runner().display().to_string());
    executor.cwd = Some(fake.cwd.display().to_string());
    executor.kimi_home = Some(fake.home.display().to_string());
    executor.kill_grace = Duration::from_millis(200);
    executor.env = env_of(&fake.binary);
    (fake, executor)
}

fn pi_lines(text: &str, session: &str) -> Vec<Value> {
    let head = text.chars().next().unwrap_or(' ').to_string();
    let rest: String = text.chars().skip(1).collect();
    let usage = json!({"input": 100, "output": 25, "cacheRead": 10, "cacheWrite": 0});
    let final_message = json!({
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "usage": usage,
        "stopReason": "stop"
    });
    let mut lines = vec![
        json!({"type": "session", "id": session}),
        json!({"type": "agent_start"}),
        json!({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "delta": "plan"}}),
        json!({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_start", "id": "Bash_0", "name": "Bash"}}),
        json!({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_end", "id": "Bash_0", "name": "Bash"}}),
        json!({"type": "message_end", "message": {"role": "toolResult", "toolCallId": "Bash_0", "toolName": "Bash", "content": [{"type": "text", "text": "a"}]}}),
        json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": head}}),
    ];
    if !rest.is_empty() {
        lines.push(json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": rest}}));
    }
    lines.push(json!({"type": "message_end", "message": final_message}));
    lines.push(json!({"type": "turn_end", "message": {"role": "assistant", "usage": usage, "stopReason": "stop"}}));
    lines.push(json!({"type": "agent_end"}));
    lines
}

fn prepare_pi(
    lines: &[Value],
    on_resume: bool,
    stderr: Option<&str>,
    exit_code: i32,
    slow: bool,
) -> (Fake, PiExecutor) {
    let mut fake = fresh("pi-home");
    let stdout = write_stdout(&fake.tmp.dir, lines);
    let on_flag = on_resume.then(|| {
        (
            "--session",
            format!("Session \"{PI_SESSION}\" not found."),
            1,
            false,
        )
    });
    fake.binary = install_script(
        &fake,
        "pi",
        Script {
            stdin_guard: true,
            on_flag,
            stderr: stderr.map(str::to_string),
            exit_code,
            slow,
            extra: String::new(),
        },
        &stdout,
    );
    let mut executor = PiExecutor::new(script_runner().display().to_string());
    executor.cwd = Some(fake.cwd.display().to_string());
    executor.pi_home = Some(fake.home.display().to_string());
    executor.kill_grace = Duration::from_millis(200);
    executor.env = env_of(&fake.binary);
    (fake, executor)
}

fn qwen_lines(text: &str, session: &str) -> Vec<Value> {
    let head = text.chars().next().unwrap_or(' ').to_string();
    let rest: String = text.chars().skip(1).collect();
    let usage = json!({"input_tokens": 100, "output_tokens": 25, "cache_read_input_tokens": 10, "total_tokens": 135});
    let mut lines = vec![
        json!({"type": "system", "subtype": "init", "session_id": session}),
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "plan"}}}),
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "plan"}], "usage": {"input_tokens": 0, "output_tokens": 0}}}),
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": head}}}),
    ];
    if !rest.is_empty() {
        lines.push(json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": rest}}}));
    }
    lines.push(json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}], "usage": usage}}));
    lines.push(json!({"type": "result", "subtype": "success", "is_error": false, "usage": usage}));
    lines
}

fn qwen_tool_lines(session: &str, text: &str) -> Vec<Value> {
    vec![
        json!({"type": "system", "subtype": "init", "session_id": session}),
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "call_1", "name": "run_shell_command"}], "usage": {"input_tokens": 10, "output_tokens": 1}}}),
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_1"}]}}),
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}}),
        json!({"type": "result", "subtype": "success", "is_error": false}),
    ]
}

fn prepare_qwen(
    lines: &[Value],
    on_resume: Option<(String, i32)>,
    stderr: Option<&str>,
    exit_code: i32,
    slow: bool,
) -> (Fake, QwenCodeExecutor) {
    let mut fake = fresh("qwen-home");
    let stdout = write_stdout(&fake.tmp.dir, lines);
    let on_flag = on_resume.map(|(text, code)| ("--resume", text, code, true));
    fake.binary = install_script(
        &fake,
        "qwen",
        Script {
            stdin_guard: true,
            on_flag,
            stderr: stderr.map(str::to_string),
            exit_code,
            slow,
            extra: String::new(),
        },
        &stdout,
    );
    let mut executor = QwenCodeExecutor::new(script_runner().display().to_string());
    executor.cwd = Some(fake.cwd.display().to_string());
    executor.qwen_home = Some(fake.home.display().to_string());
    executor.kill_grace = Duration::from_millis(200);
    executor.env = env_of(&fake.binary);
    (fake, executor)
}

fn opencode_lines(text: &str, session: &str) -> Vec<Value> {
    vec![
        json!({"type": "step_start", "sessionID": session}),
        json!({"type": "tool", "sessionID": session, "part": {"type": "tool", "tool": "bash", "state": {"status": "running"}}}),
        json!({"type": "tool", "sessionID": session, "part": {"type": "tool", "tool": "bash", "state": {"status": "completed"}}}),
        json!({"type": "text", "sessionID": session, "part": {"type": "text", "text": text}}),
        json!({"type": "step_finish", "sessionID": session, "part": {"type": "step_finish"}}),
    ]
}

fn seed_opencode(home: &Path, cwd: &str, session: &str) {
    let dir = effective_opencode_home(home);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = rusqlite::Connection::open(opencode_db_path(&dir)).unwrap();
    conn.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session (id, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4)",
        (session, cwd, FAR, FAR),
    )
    .unwrap();
    let insert = |id: &str, role: &str, input: i64, cache: i64, output: i64| {
        let data = json!({
            "role": role,
            "tokens": {"input": input, "output": output, "reasoning": 0, "cache": {"read": cache, "write": 0}},
            "time": {"created": FAR, "completed": FAR}
        })
        .to_string();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            (id, session, FAR, data),
        )
        .unwrap();
    };
    insert("msg_a", "assistant", 100, 10, 25);
    insert("msg_b", "assistant", 40, 0, 5);
    insert("msg_user", "user", 99999, 0, 99999);
}

fn prepare_opencode(
    lines: &[Value],
    on_resume: Option<&str>,
    stderr: Option<&str>,
    exit_code: i32,
    slow: bool,
) -> (Fake, OpencodeExecutor) {
    let mut fake = fresh("opencode-home");
    let stdout = write_stdout(&fake.tmp.dir, lines);
    let on_flag = on_resume.map(|text| ("--session", text.to_string(), 1, false));
    fake.binary = install_script(
        &fake,
        "opencode",
        Script {
            stdin_guard: false,
            on_flag,
            stderr: stderr.map(str::to_string),
            exit_code,
            slow,
            extra: String::new(),
        },
        &stdout,
    );
    let mut executor = OpencodeExecutor::new(script_runner().display().to_string());
    executor.cwd = Some(fake.cwd.display().to_string());
    executor.opencode_home = Some(fake.home.display().to_string());
    executor.kill_grace = Duration::from_millis(200);
    executor.env = env_of(&fake.binary);
    (fake, executor)
}

async fn conformance_success(executor: &dyn HarnessExecutor, spec: TaskSpec) {
    let handle = executor.start(spec, AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(result.usage.turns != 0);
    assert!(events.iter().any(TaskEvent::is_turn_start));
    assert!(events.iter().any(TaskEvent::is_turn_end));
    assert!(handle.events.drain().await.is_empty());
}

async fn conformance_error(executor: &dyn HarnessExecutor, spec: TaskSpec) {
    let handle = executor.start(spec, AbortFlag::new());
    let result = handle.result().await;
    let _ = handle.events.drain().await;
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert!(result.error.is_some());
}

async fn conformance_kill(executor: &dyn HarnessExecutor, spec: TaskSpec) {
    let handle = executor.start(spec, AbortFlag::new());
    tokio::time::sleep(Duration::from_millis(40)).await;
    handle.kill("conformance kill").await;
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Killed);
    let _ = handle.events.drain().await;
}

async fn conformance_abort(executor: &dyn HarnessExecutor, spec: TaskSpec) {
    let abort = AbortFlag::new();
    let handle = executor.start(spec, abort.clone());
    tokio::time::sleep(Duration::from_millis(40)).await;
    abort.abort("runner abort");
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Killed);
}

#[test]
fn argv_executors_name_their_capabilities() {
    let (_, kimi) = prepare_kimi(
        &kimi_lines("All done.", KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    assert_eq!(kimi.name(), "kimi-code");
    assert_eq!(KIMI_HARNESS_ID, "kimi-code");
    let caps = kimi.capabilities();
    assert!(
        caps.steerable
            && caps.multi_turn
            && caps.structured_stream
            && caps.usage_in_result
            && caps.session_id_capture
    );
    assert!(!caps.slash_commands && caps.effort_selection);
    assert_eq!(caps.mcp_injection, "persistent-config");
    let (_, pi) = prepare_pi(&pi_lines("All done.", PI_SESSION), false, None, 0, false);
    assert_eq!(pi.name(), "pi");
    assert!(pi.capabilities().effort_selection);
    let (_, qwen) = prepare_qwen(&qwen_lines("All done.", QWEN_SESSION), None, None, 0, false);
    assert_eq!(qwen.name(), "qwen-code");
    assert_eq!(QWEN_CODE_HARNESS_ID, "qwen-code");
    assert!(!qwen.capabilities().effort_selection);
    let (_, opencode) = prepare_opencode(
        &opencode_lines("All done.", OPENCODE_SESSION),
        None,
        None,
        0,
        false,
    );
    assert_eq!(opencode.name(), "opencode");
    assert_eq!(OPENCODE_HARNESS_ID, "opencode");
    assert!(opencode.capabilities().effort_selection);
}

#[tokio::test(flavor = "current_thread")]
async fn kimi_reconciles_wire_usage_and_den_events() {
    let (fake, executor) = prepare_kimi(
        &kimi_lines("All done.", KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let den = den_texts(&events);
    assert!(den.iter().any(|text| text == "All done."));
    assert!(den.iter().any(|text| text == "start:Bash"));
    assert!(den.iter().any(|text| text == "end:Bash"));
    assert_eq!(
        turn_ids(&events),
        vec![Some(format!("kimi-code:{KIMI_SESSION}"))]
    );
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.usage.input_tokens, 150.0);
    assert_eq!(result.usage.output_tokens, 30.0);
    assert_eq!(result.usage.total_tokens, 180.0);
    assert_eq!(result.usage.turns, 1);
    assert!(result.usage.cost_usd.is_none());
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, TaskEvent::Cost { .. }))
    );
    assert!(handle.events.drain().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn kimi_env_flags_scaffold_and_steer() {
    let (fake, executor) = prepare_kimi(
        &kimi_lines("All done.", KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    let mut spec = spec_in(&fake, "/goal ship the widget");
    spec.task_id = "task-env-check".into();
    spec.model = Some("kimi-k3".into());
    spec.effort = Some("high".into());
    spec.acceptance_criteria = vec![AcceptanceCriterion {
        id: "c1".into(),
        description: "widget ships".into(),
    }];
    let handle = executor.start(spec, AbortFlag::new());
    handle.steer("and one more thing").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(result.usage.turns, 2);
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 2);
    assert!(
        !calls[0]
            .iter()
            .any(|arg| arg == "-S" || arg == "--auto" || arg == "--yolo")
    );
    assert_eq!(flag(&calls[0], "-m").as_deref(), Some("kimi-k3"));
    assert_eq!(
        flag(&calls[0], "--output-format").as_deref(),
        Some("stream-json")
    );
    assert_eq!(flag(&calls[0], "-p").as_deref(), Some("## Task Context"));
    assert_eq!(flag(&calls[1], "-S").as_deref(), Some(KIMI_SESSION));
    let recorded = invocation_texts(&fake.tmp.dir);
    assert!(recorded[0].contains("[c1] widget ships"));
    assert!(recorded[0].contains("TASK_RESULT"));
    assert!(recorded[0].contains("/goal ship the widget"));
    let child = env_file(&fake.tmp.dir);
    assert_eq!(
        child.get("RIVETOS_TASK_ID").map(String::as_str),
        Some("task-env-check")
    );
    assert!(!child.contains_key("RIVETOS_SESSION_KEY"));
    assert_eq!(
        child.get("RIVETOS_DEN_HOOK_DISABLED").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        child.get("KIMI_CODE_HOME").map(String::as_str),
        Some(fake.home.to_str().unwrap())
    );
    assert_eq!(
        child.get("KIMI_MODEL_THINKING_EFFORT").map(String::as_str),
        Some("high")
    );
    assert_eq!(
        turn_ids(&events),
        vec![
            Some(format!("kimi-code:{KIMI_SESSION}")),
            Some(format!("kimi-code:{KIMI_SESSION}"))
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn kimi_resume_reject_renders_history() {
    let (fake, mut executor) =
        prepare_kimi(&kimi_lines("done", KIMI_SESSION), true, None, 0, false);
    executor.history = Some(history_of());
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 3);
    assert!(calls[1].iter().any(|arg| arg == "-S"));
    assert!(!calls[2].iter().any(|arg| arg == "-S"));
    assert!(invocation_texts(&fake.tmp.dir)[2].contains("what turn one already did"));
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(events.iter().any(|event| {
        event
            .log_message()
            .is_some_and(|message| message.contains("fresh session"))
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn kimi_fence_prose_and_failures() {
    let (fake, executor) = prepare_kimi(
        &kimi_lines(&fence_text(), KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    assert_fence(
        &executor
            .start(spec_in(&fake, "Say hello"), AbortFlag::new())
            .result()
            .await,
    );
    let (fake, executor) = prepare_kimi(
        &kimi_lines("Just prose.", KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    let prose = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(prose.verdict, TaskVerdict::Completed);
    assert_eq!(prose.summary, "Just prose.");
    let (fake, executor) = prepare_kimi(&[], false, Some("error: model alias unknown"), 1, false);
    let failed = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(failed.verdict, TaskVerdict::Failed);
    let error = failed.error.unwrap();
    assert!(error.contains("exited 1"));
    assert!(error.contains("model alias unknown"));
    let (fake, executor) = prepare_kimi(&[], false, None, 0, false);
    let _ = write_raw(&fake.tmp.dir, "not json at all\n{\"role\": 42\n");
    let missing = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(missing.verdict, TaskVerdict::Failed);
    assert!(
        missing
            .error
            .unwrap()
            .contains("without a session resume_hint")
    );
    let missing_bin = KimiCodeExecutor::new("/nonexistent/kimi-nope");
    let spawned = missing_bin
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(spawned.verdict, TaskVerdict::Failed);
    assert!(spawned.error.unwrap().contains("Failed to spawn"));
    let (fake, mut executor) = prepare_kimi(
        &kimi_lines("All done.", KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    let empty = fake.tmp.path("empty-home");
    std::fs::create_dir_all(&empty).unwrap();
    executor.kimi_home = Some(empty.display().to_string());
    let zero = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(zero.verdict, TaskVerdict::Completed);
    assert_eq!(zero.usage.total_tokens, 0.0);
}

#[tokio::test(flavor = "current_thread")]
async fn kimi_fence_keeps_extra_artifact_and_criterion_fields() {
    let raw = r#"{"verdict":"completed","summary":"Fixed the widget","artifacts":[{"kind":"commit","ref":"abc123","note":1,"checksum":"zz"}],"criteriaSelfReport":[{"id":"c1","met":true,"evidence":"ran tests","extra":"kept"}]}"#;
    let text = format!("Work complete.\n\n```TASK_RESULT\n{raw}\n```");
    let (fake, executor) = prepare_kimi(&kimi_lines(&text, KIMI_SESSION), false, None, 0, false);
    let result = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert_eq!(result.summary, "Fixed the widget");
    assert_eq!(result.artifacts[0].kind(), Some(ArtifactKind::Commit));
    assert_eq!(result.artifacts[0].r#ref(), Some("abc123"));
    assert_eq!(
        result.artifacts[0]
            .note()
            .and_then(protocol::js::JsValue::as_i64),
        Some(1)
    );
    let criteria = result.criteria_self_report.as_ref().unwrap();
    assert_eq!(criteria[0].id(), Some("c1"));
    assert_eq!(criteria[0].met(), Some(true));
    assert_eq!(
        criteria[0]
            .evidence()
            .and_then(protocol::js::JsValue::as_str),
        Some("ran tests")
    );
    let artifacts = serde_json::to_string(&result.artifacts).unwrap();
    let reported = serde_json::to_string(&result.criteria_self_report).unwrap();
    assert!(artifacts.contains(r#""ref":"abc123""#), "{artifacts}");
    assert!(artifacts.contains(r#""note":1,"#), "{artifacts}");
    assert!(artifacts.contains(r#""checksum":"zz""#), "{artifacts}");
    assert!(reported.contains(r#""evidence":"ran tests""#), "{reported}");
    assert!(reported.contains(r#""extra":"kept""#), "{reported}");
}

#[tokio::test(flavor = "current_thread")]
async fn kimi_conformance() {
    let (fake, executor) = prepare_kimi(
        &kimi_lines("All done.", KIMI_SESSION),
        false,
        None,
        0,
        false,
    );
    conformance_success(&executor, spec_in(&fake, "Say hello")).await;
    conformance_error(
        &KimiCodeExecutor::new("/nonexistent/kimi-nope"),
        TaskSpec::conformance("Say hello"),
    )
    .await;
    let (fake, executor) = prepare_kimi(&[], false, None, 0, true);
    conformance_kill(&executor, spec_in(&fake, "Say hello")).await;
    let (fake, executor) = prepare_kimi(&[], false, None, 0, true);
    conformance_abort(&executor, spec_in(&fake, "Say hello")).await;
}

#[tokio::test(flavor = "current_thread")]
async fn pi_stream_env_scaffold_and_steer() {
    let (fake, executor) = prepare_pi(&pi_lines("All done.", PI_SESSION), false, None, 0, false);
    let mut spec = spec_in(&fake, "/goal ship the widget");
    spec.task_id = "task-env-check".into();
    spec.model = Some("glm-4.5".into());
    spec.effort = Some("high".into());
    spec.acceptance_criteria = vec![AcceptanceCriterion {
        id: "c1".into(),
        description: "widget ships".into(),
    }];
    let handle = executor.start(spec, AbortFlag::new());
    handle.steer("and one more thing").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let den = den_texts(&events);
    let agent: String = den
        .iter()
        .filter(|text| {
            !text.starts_with("think:") && !text.starts_with("start:") && !text.starts_with("end:")
        })
        .map(String::as_str)
        .collect();
    assert_eq!(agent, "All done.All done.");
    assert!(den.iter().any(|text| text == "think:plan"));
    assert!(den.iter().any(|text| text == "start:Bash"));
    assert!(den.iter().any(|text| text == "end:Bash"));
    assert_eq!(result.usage.input_tokens, 220.0);
    assert_eq!(result.usage.output_tokens, 50.0);
    assert_eq!(result.usage.total_tokens, 270.0);
    assert!(result.usage.cost_usd.is_none());
    assert_eq!(result.usage.turns, 2);
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 2);
    assert!(!calls[0].iter().any(|arg| arg == "--session"
        || arg == "--session-id"
        || arg == "--auto"
        || arg == "--yolo"));
    assert!(calls[0].iter().any(|arg| arg == "--print"));
    assert_eq!(flag(&calls[0], "--mode").as_deref(), Some("json"));
    assert_eq!(flag(&calls[0], "--model").as_deref(), Some("glm-4.5"));
    assert_eq!(flag(&calls[0], "--thinking").as_deref(), Some("high"));
    assert_eq!(
        flag(&calls[0], "--append-system-prompt").as_deref(),
        Some("## Task Context")
    );
    let session_dir = fake.home.join("sessions").display().to_string();
    assert_eq!(
        flag(&calls[0], "--session-dir").as_deref(),
        Some(session_dir.as_str())
    );
    assert!(calls[0].iter().any(|arg| arg == "--"));
    assert_eq!(flag(&calls[1], "--session").as_deref(), Some(PI_SESSION));
    let recorded = invocation_texts(&fake.tmp.dir)[0].clone();
    assert!(recorded.contains("[c1] widget ships"));
    assert!(recorded.contains("TASK_RESULT"));
    assert!(recorded.contains("/goal ship the widget"));
    let child = env_file(&fake.tmp.dir);
    assert_eq!(
        child.get("RIVETOS_TASK_ID").map(String::as_str),
        Some("task-env-check")
    );
    assert!(!child.contains_key("RIVETOS_SESSION_KEY"));
    assert_eq!(
        child.get("RIVETOS_DEN_HOOK_DISABLED").map(String::as_str),
        Some("1")
    );
    assert!(!child.contains_key("PI_HOME"));
    assert_eq!(
        turn_ids(&events),
        vec![
            Some(format!("pi:{PI_SESSION}")),
            Some(format!("pi:{PI_SESSION}"))
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn pi_resume_reject_fence_and_failures() {
    let (fake, mut executor) = prepare_pi(&pi_lines("done", PI_SESSION), true, None, 0, false);
    executor.history = Some(history_of());
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 3);
    assert!(calls[1].iter().any(|arg| arg == "--session"));
    assert!(!calls[2].iter().any(|arg| arg == "--session"));
    assert!(invocation_texts(&fake.tmp.dir)[2].contains("what turn one already did"));
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(events.iter().any(|event| {
        event
            .log_message()
            .is_some_and(|message| message.contains("fresh session"))
    }));
    let (fake, executor) = prepare_pi(&pi_lines(&fence_text(), PI_SESSION), false, None, 0, false);
    assert_fence(
        &executor
            .start(spec_in(&fake, "Say hello"), AbortFlag::new())
            .result()
            .await,
    );
    let (fake, executor) = prepare_pi(&pi_lines("Just prose.", PI_SESSION), false, None, 0, false);
    let prose = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(prose.summary, "Just prose.");
    let (fake, executor) = prepare_pi(&[], false, Some("error: model alias unknown"), 1, false);
    let failed = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert!(failed.error.unwrap().contains("model alias unknown"));
    let (fake, executor) = prepare_pi(&[], false, None, 0, false);
    let _ = write_raw(&fake.tmp.dir, "not json at all\n{\"role\": 42\n");
    let missing = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert!(missing.error.unwrap().contains("without a terminal event"));
    let aborted = vec![
        json!({"type": "session", "id": PI_SESSION}),
        json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "nope"}], "stopReason": "aborted"}}),
        json!({"type": "turn_end", "message": {"role": "assistant", "stopReason": "aborted"}}),
        json!({"type": "agent_settled"}),
    ];
    let (fake, executor) = prepare_pi(&aborted, false, None, 0, false);
    let stopped = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(stopped.verdict, TaskVerdict::Failed);
    assert!(stopped.error.unwrap().contains("stopReason: aborted"));
    let missing_bin = PiExecutor::new("/nonexistent/pi-nope");
    let spawned = missing_bin
        .start(TaskSpec::conformance("Say hello"), AbortFlag::new())
        .result()
        .await;
    assert!(spawned.error.unwrap().contains("Failed to spawn"));
    let zeros = vec![
        json!({"type": "session", "id": PI_SESSION}),
        json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "All done."}], "usage": {"input": 0, "output": 0}, "stopReason": "stop"}}),
        json!({"type": "agent_end"}),
    ];
    let (fake, mut executor) = prepare_pi(&zeros, false, None, 0, false);
    executor.pi_home = Some(fake.tmp.path("empty-pi").display().to_string());
    std::fs::create_dir_all(executor.pi_home.as_ref().unwrap()).unwrap();
    let zero = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(zero.verdict, TaskVerdict::Completed);
    assert_eq!(zero.usage.total_tokens, 0.0);
}

#[tokio::test(flavor = "current_thread")]
async fn pi_conformance() {
    let (fake, executor) = prepare_pi(&pi_lines("All done.", PI_SESSION), false, None, 0, false);
    conformance_success(&executor, spec_in(&fake, "Say hello")).await;
    conformance_error(
        &PiExecutor::new("/nonexistent/pi-nope"),
        TaskSpec::conformance("Say hello"),
    )
    .await;
    let (fake, executor) = prepare_pi(&[], false, None, 0, true);
    conformance_kill(&executor, spec_in(&fake, "Say hello")).await;
    let (fake, executor) = prepare_pi(&[], false, None, 0, true);
    conformance_abort(&executor, spec_in(&fake, "Say hello")).await;
}

#[tokio::test(flavor = "current_thread")]
async fn qwen_stream_env_tools_and_steer() {
    let (fake, executor) =
        prepare_qwen(&qwen_lines("All done.", QWEN_SESSION), None, None, 0, false);
    let mut spec = spec_in(&fake, "/goal ship the widget");
    spec.task_id = "task-env-check".into();
    spec.model = Some("qwen-27b".into());
    spec.acceptance_criteria = vec![AcceptanceCriterion {
        id: "c1".into(),
        description: "widget ships".into(),
    }];
    let handle = executor.start(spec, AbortFlag::new());
    handle.steer("and one more thing").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let den = den_texts(&events);
    let agent: String = den
        .iter()
        .filter(|text| {
            !text.starts_with("think:") && !text.starts_with("start:") && !text.starts_with("end:")
        })
        .map(String::as_str)
        .collect();
    assert_eq!(agent, "All done.All done.");
    assert!(den.iter().any(|text| text == "think:plan"));
    assert_eq!(result.usage.input_tokens, 200.0);
    assert_eq!(result.usage.output_tokens, 50.0);
    assert_eq!(result.usage.total_tokens, 250.0);
    assert_eq!(result.usage.turns, 2);
    assert!(result.usage.cost_usd.is_none());
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0][0], "-p");
    assert!(calls[0].iter().any(|arg| arg == "--session-id"));
    assert!(
        !calls[0]
            .iter()
            .any(|arg| arg == "--resume" || arg == "--thinking" || arg == "--effort")
    );
    assert_eq!(flag(&calls[0], "-m").as_deref(), Some("qwen-27b"));
    assert_eq!(
        flag(&calls[0], "--output-format").as_deref(),
        Some("stream-json")
    );
    assert_eq!(flag(&calls[0], "--approval-mode").as_deref(), Some("yolo"));
    assert!(
        calls[0]
            .iter()
            .any(|arg| arg == "--include-partial-messages")
    );
    assert!(calls[0].iter().any(|arg| arg == "--append-system-prompt"));
    assert_eq!(flag(&calls[1], "--resume").as_deref(), Some(QWEN_SESSION));
    let recorded = invocation_texts(&fake.tmp.dir)[0].clone();
    assert!(recorded.contains("## Task Context"));
    assert!(recorded.contains(&format!("Working directory: {}", fake.cwd.display())));
    assert!(recorded.contains("[c1] widget ships"));
    assert!(recorded.contains("TASK_RESULT"));
    assert!(recorded.contains("/goal ship the widget"));
    let child = env_file(&fake.tmp.dir);
    assert_eq!(
        child.get("RIVETOS_TASK_ID").map(String::as_str),
        Some("task-env-check")
    );
    assert!(!child.contains_key("RIVETOS_SESSION_KEY"));
    assert_eq!(
        child
            .get("QWEN_CODE_SUPPRESS_YOLO_WARNING")
            .map(String::as_str),
        Some("1")
    );
    assert!(!child.contains_key("RIVETOS_DEN_HOOK_DISABLED"));
    let (fake, executor) = prepare_qwen(
        &qwen_tool_lines(QWEN_SESSION, "tool-sample-ok"),
        None,
        None,
        0,
        false,
    );
    let tool_events = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .events
        .drain()
        .await;
    let tools = den_texts(&tool_events);
    assert!(tools.iter().any(|text| text == "start:run_shell_command"));
    assert!(tools.iter().any(|text| text == "end:run_shell_command"));
    assert!(tools.iter().any(|text| text.contains("tool-sample-ok")));
}

#[tokio::test(flavor = "current_thread")]
async fn qwen_resume_reject_and_non_retry() {
    let reject = format!("No saved session found with ID {QWEN_SESSION}");
    let (fake, mut executor) = prepare_qwen(
        &qwen_lines("done", QWEN_SESSION),
        Some((reject, 0)),
        None,
        0,
        false,
    );
    executor.history = Some(history_of());
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 3);
    assert!(calls[1].iter().any(|arg| arg == "--resume"));
    assert!(calls[2].iter().any(|arg| arg == "--session-id"));
    assert!(!calls[2].iter().any(|arg| arg == "--resume"));
    assert_ne!(
        flag(&calls[0], "--session-id"),
        flag(&calls[2], "--session-id")
    );
    assert!(invocation_texts(&fake.tmp.dir)[2].contains("what turn one already did"));
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(events.iter().any(|event| {
        event
            .log_message()
            .is_some_and(|message| message.contains("fresh session"))
    }));
    let (fake, executor) = prepare_qwen(
        &qwen_lines("done", QWEN_SESSION),
        Some(("error: provider auth failed".into(), 1)),
        None,
        0,
        false,
    );
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 2);
    assert!(calls[1].iter().any(|arg| arg == "--resume"));
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert!(result.error.unwrap().contains("exited 1"));
    assert!(events.iter().all(|event| {
        event
            .log_message()
            .is_none_or(|message| !message.contains("fresh session"))
    }));
    let (fake, executor) = prepare_qwen(
        &qwen_lines("done", QWEN_SESSION),
        Some((String::new(), 0)),
        Some("error: empty stream"),
        0,
        false,
    );
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    assert_eq!(invocations(&fake.tmp.dir).len(), 2);
    assert_eq!(result.verdict, TaskVerdict::Failed);
    let error = result.error.unwrap();
    assert!(error.contains("without a terminal event"));
    assert!(error.contains("empty stream"));
    assert!(events.iter().all(|event| {
        event
            .log_message()
            .is_none_or(|message| !message.contains("fresh session"))
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn qwen_fence_and_conformance() {
    let (fake, executor) = prepare_qwen(
        &qwen_lines(&fence_text(), QWEN_SESSION),
        None,
        None,
        0,
        false,
    );
    assert_fence(
        &executor
            .start(spec_in(&fake, "Say hello"), AbortFlag::new())
            .result()
            .await,
    );
    let (fake, executor) = prepare_qwen(
        &qwen_lines("Just prose.", QWEN_SESSION),
        None,
        None,
        0,
        false,
    );
    let prose = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(prose.summary, "Just prose.");
    let missing_bin = QwenCodeExecutor::new("/nonexistent/qwen-nope");
    conformance_error(&missing_bin, TaskSpec::conformance("Say hello")).await;
    let (fake, executor) =
        prepare_qwen(&qwen_lines("All done.", QWEN_SESSION), None, None, 0, false);
    conformance_success(&executor, spec_in(&fake, "Say hello")).await;
    let (fake, executor) = prepare_qwen(&[], None, None, 0, true);
    conformance_kill(&executor, spec_in(&fake, "Say hello")).await;
    let (fake, executor) = prepare_qwen(&[], None, None, 0, true);
    conformance_abort(&executor, spec_in(&fake, "Say hello")).await;
}

#[tokio::test(flavor = "current_thread")]
async fn opencode_disk_usage_env_and_steer() {
    let (fake, executor) = prepare_opencode(
        &opencode_lines("All done.", OPENCODE_SESSION),
        None,
        None,
        0,
        false,
    );
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        OPENCODE_SESSION,
    );
    let mut spec = spec_in(&fake, "/goal ship the widget");
    spec.task_id = "task-env-check".into();
    spec.model = Some("zai/glm-5.3-flash".into());
    spec.acceptance_criteria = vec![AcceptanceCriterion {
        id: "c1".into(),
        description: "widget ships".into(),
    }];
    let handle = executor.start(spec, AbortFlag::new());
    handle.steer("and one more thing").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let den = den_texts(&events);
    assert!(den.iter().any(|text| text == "All done."));
    assert!(den.iter().any(|text| text == "start:bash"));
    assert!(den.iter().any(|text| text == "end:bash"));
    assert_eq!(result.usage.input_tokens, 300.0);
    assert_eq!(result.usage.output_tokens, 60.0);
    assert_eq!(result.usage.total_tokens, 360.0);
    assert_eq!(result.usage.turns, 2);
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0][0], "run");
    assert!(
        !calls[0]
            .iter()
            .any(|arg| arg == "--session" || arg == "--continue")
    );
    assert_eq!(
        flag(&calls[0], "--model").as_deref(),
        Some("zai/glm-5.3-flash")
    );
    assert_eq!(flag(&calls[0], "--format").as_deref(), Some("json"));
    assert_eq!(
        flag(&calls[1], "--session").as_deref(),
        Some(OPENCODE_SESSION)
    );
    let recorded = invocation_texts(&fake.tmp.dir)[0].clone();
    assert!(recorded.contains("## Task Context"));
    assert!(recorded.contains("[c1] widget ships"));
    assert!(recorded.contains("TASK_RESULT"));
    assert!(recorded.contains("/goal ship the widget"));
    let child = env_file(&fake.tmp.dir);
    assert_eq!(
        child.get("RIVETOS_TASK_ID").map(String::as_str),
        Some("task-env-check")
    );
    assert!(!child.contains_key("RIVETOS_SESSION_KEY"));
    assert_eq!(
        child.get("RIVETOS_DEN_HOOK_DISABLED").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        child.get("XDG_DATA_HOME").map(String::as_str),
        Some(fake.home.to_str().unwrap())
    );
    let expected_id = format!("opencode:{OPENCODE_SESSION}");
    assert_eq!(turn_ids(&events)[0].as_deref(), Some(expected_id.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn opencode_prefers_stream_id_and_resume_rules() {
    let stream = "ses_streamstreamstreamstrea";
    let (fake, executor) = prepare_opencode(&opencode_lines("done", stream), None, None, 0, false);
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        "ses_storestorestorestoresto",
    );
    let events = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .events
        .drain()
        .await;
    assert_eq!(turn_ids(&events), vec![Some(format!("opencode:{stream}"))]);
    let (fake, executor) = prepare_opencode(
        &opencode_lines("done", OPENCODE_SESSION),
        Some("error: provider auth failed"),
        None,
        0,
        false,
    );
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        OPENCODE_SESSION,
    );
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 2);
    assert!(calls[1].iter().any(|arg| arg == "--session"));
    assert_eq!(result.verdict, TaskVerdict::Failed);
    assert!(result.error.unwrap().contains("provider auth failed"));
    let (fake, mut executor) = prepare_opencode(
        &opencode_lines("done", OPENCODE_SESSION),
        Some(&format!("Session \"{OPENCODE_SESSION}\" not found.")),
        None,
        0,
        false,
    );
    executor.history = Some(history_of());
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        OPENCODE_SESSION,
    );
    let handle = executor.start(spec_in(&fake, "Say hello"), AbortFlag::new());
    handle.steer("carry on").await.unwrap();
    let result = handle.result().await;
    let events = handle.events.drain().await;
    let calls = invocations(&fake.tmp.dir);
    assert_eq!(calls.len(), 3);
    assert!(calls[1].iter().any(|arg| arg == "--session"));
    assert!(!calls[2].iter().any(|arg| arg == "--session"));
    assert!(invocation_texts(&fake.tmp.dir)[2].contains("what turn one already did"));
    assert_eq!(result.verdict, TaskVerdict::Completed);
    assert!(events.iter().any(|event| {
        event
            .log_message()
            .is_some_and(|message| message.contains("fresh session"))
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn opencode_fence_stream_usage_and_conformance() {
    let (fake, executor) = prepare_opencode(
        &opencode_lines(&fence_text(), OPENCODE_SESSION),
        None,
        None,
        0,
        false,
    );
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        OPENCODE_SESSION,
    );
    assert_fence(
        &executor
            .start(spec_in(&fake, "Say hello"), AbortFlag::new())
            .result()
            .await,
    );
    let (fake, executor) = prepare_opencode(
        &opencode_lines("Just prose.", OPENCODE_SESSION),
        None,
        None,
        0,
        false,
    );
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        OPENCODE_SESSION,
    );
    let prose = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(prose.summary, "Just prose.");
    let (fake, executor) =
        prepare_opencode(&[], None, Some("error: model alias unknown"), 1, false);
    let failed = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert!(failed.error.unwrap().contains("model alias unknown"));
    let (fake, executor) = prepare_opencode(&[], None, None, 0, false);
    let _ = write_raw(&fake.tmp.dir, "not json at all\n{\"role\": 42\n");
    let missing = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert!(missing.error.unwrap().contains("without a session id"));
    let text_only = vec![
        json!({"type": "text", "sessionID": OPENCODE_SESSION, "part": {"type": "text", "text": "All done."}}),
    ];
    let (fake, mut executor) = prepare_opencode(&text_only, None, None, 0, false);
    executor.opencode_home = Some(fake.tmp.path("empty-oc").display().to_string());
    let zero = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(zero.verdict, TaskVerdict::Completed);
    assert_eq!(zero.usage.total_tokens, 0.0);
    let streamed = vec![
        json!({"type": "text", "sessionID": OPENCODE_SESSION, "part": {"type": "text", "text": "All done."}}),
        json!({"type": "step_finish", "sessionID": OPENCODE_SESSION, "part": {"type": "step_finish", "tokens": {"input": 100, "output": 25, "reasoning": 0, "cache": {"read": 10, "write": 0}}}}),
    ];
    let (fake, mut executor) = prepare_opencode(&streamed, None, None, 0, false);
    executor.opencode_home = Some(fake.tmp.path("empty-oc2").display().to_string());
    let stream = executor
        .start(spec_in(&fake, "Say hello"), AbortFlag::new())
        .result()
        .await;
    assert_eq!(stream.verdict, TaskVerdict::Completed);
    assert_eq!(stream.usage.input_tokens, 110.0);
    assert_eq!(stream.usage.output_tokens, 25.0);
    conformance_error(
        &OpencodeExecutor::new("/nonexistent/opencode-nope"),
        TaskSpec::conformance("Say hello"),
    )
    .await;
    let (fake, executor) = prepare_opencode(
        &opencode_lines("All done.", OPENCODE_SESSION),
        None,
        None,
        0,
        false,
    );
    seed_opencode(
        &fake.home,
        &fake.cwd.display().to_string(),
        OPENCODE_SESSION,
    );
    conformance_success(&executor, spec_in(&fake, "Say hello")).await;
    let (fake, executor) = prepare_opencode(&[], None, None, 0, true);
    conformance_kill(&executor, spec_in(&fake, "Say hello")).await;
    let (fake, executor) = prepare_opencode(&[], None, None, 0, true);
    conformance_abort(&executor, spec_in(&fake, "Say hello")).await;
}
