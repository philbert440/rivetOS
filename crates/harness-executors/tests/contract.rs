#[path = "support.rs"]
mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use harness_executors::*;
use parking_lot::Mutex;
use protocol::digest::sha256_hex;
use protocol::{HARNESS_IDS, TaskVerdict};
use support::{Tmp, map_env, write_exe};

fn path_env() -> std::collections::BTreeMap<String, String> {
    let mut env = std::collections::BTreeMap::new();
    if let Ok(path) = std::env::var("PATH") {
        env.insert("PATH".to_string(), path);
    }
    env
}

struct Named {
    name: &'static str,
}

impl HarnessExecutor for Named {
    fn name(&self) -> &str {
        self.name
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::argv(true)
    }

    fn start(&self, _spec: TaskSpec, _abort: AbortFlag) -> TaskHandle {
        let (handle, parts) = open_handle(None);
        publish(
            &parts,
            protocol::TaskResult {
                verdict: TaskVerdict::Completed,
                summary: String::new(),
                output: None,
                artifacts: Vec::new(),
                criteria_self_report: None,
                usage: empty_usage(),
                error: None,
            },
        );
        handle
    }
}

#[test]
fn targets_accept_every_harness_id() {
    for id in HARNESS_IDS {
        assert!(is_harness_executor_target(id));
    }
    assert!(!is_harness_executor_target("claude-cli"));
}

#[test]
fn canonicalizes_claude_cli() {
    let resolved = canonicalize_executor_target(Some("claude-cli"));
    assert_eq!(resolved.target.as_deref(), Some("claude-code"));
    assert_eq!(resolved.deprecated_alias.as_deref(), Some("claude-cli"));
    assert_eq!(
        DEPRECATED_EXECUTOR_TARGETS,
        &[("claude-cli", "claude-code")]
    );
    assert_eq!(
        canonicalize_executor_target(Some("claude-code"))
            .target
            .as_deref(),
        Some("claude-code")
    );
    assert!(
        canonicalize_executor_target(Some("claude-code"))
            .deprecated_alias
            .is_none()
    );
    assert_eq!(
        canonicalize_executor_target(Some("something-else"))
            .target
            .as_deref(),
        Some("something-else")
    );
    assert!(canonicalize_executor_target(None).target.is_none());
}

#[test]
fn registry_resolves_legacy_target_and_warns_once() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_cb = Arc::clone(&seen);
    let registry = create_executor_registry(Some(Arc::new(move |alias, canonical| {
        seen_cb
            .lock()
            .push((alias.to_string(), canonical.to_string()));
    })));
    let executor = Arc::new(Named {
        name: "claude-code",
    });
    registry.register("harness-session", executor, Some("claude-code"));
    assert!(
        registry
            .resolve("harness-session", Some("claude-cli"))
            .is_some()
    );
    for _ in 0..4 {
        let _ = registry.resolve("harness-session", Some("claude-cli"));
    }
    assert_eq!(seen.lock().len(), 1);
    registry.register(
        "harness-session",
        Arc::new(Named {
            name: "claude-code",
        }),
        Some("claude-cli"),
    );
    assert_eq!(
        registry
            .entries()
            .iter()
            .map(|entry| entry.key.clone())
            .collect::<Vec<_>>(),
        vec!["harness-session:claude-code".to_string()]
    );
}

#[test]
fn non_harness_kinds_do_not_alias() {
    let seen = Arc::new(Mutex::new(0u32));
    let seen_cb = Arc::clone(&seen);
    let registry = create_executor_registry(Some(Arc::new(move |_, _| {
        *seen_cb.lock() += 1;
    })));
    registry.register(
        "mesh",
        Arc::new(Named { name: "mesh-thing" }),
        Some("claude-cli"),
    );
    assert!(registry.resolve("mesh", Some("claude-cli")).is_some());
    assert!(registry.resolve("mesh", Some("claude-code")).is_none());
    assert_eq!(*seen.lock(), 0);
}

#[test]
fn coverage_ignores_kind_level_fallback() {
    let registry = create_executor_registry(None);
    registry.register(
        "harness-session",
        Arc::new(Named { name: "kind-level" }),
        None,
    );
    registry.register(
        "harness-session",
        Arc::new(Named {
            name: "claude-code",
        }),
        Some("claude-code"),
    );
    registry.register(
        "harness-session",
        create_not_implemented_harness_executor("kimi-code", "no spawn machinery"),
        Some("kimi-code"),
    );
    let rows = registry.harnesses();
    assert_eq!(rows.len(), HARNESS_IDS.len());
    assert!(
        rows.iter()
            .any(|row| row.harness_id == "claude-code" && row.implemented)
    );
    assert!(
        rows.iter()
            .any(|row| row.harness_id == "kimi-code" && row.registered && !row.implemented)
    );
    assert!(
        rows.iter()
            .any(|row| row.harness_id == "opencode" && !row.registered)
    );
    let covered = harness_executor_coverage(|_| None);
    assert_eq!(
        covered
            .iter()
            .map(|row| row.harness_id.as_str())
            .collect::<Vec<_>>(),
        HARNESS_IDS
    );
}

#[tokio::test]
async fn rejecting_executor_is_cowork_capture_only() {
    let executor =
        create_not_implemented_harness_executor("cowork", &harness_executor_gap("cowork"));
    assert!(is_not_implemented_harness_executor(executor.as_ref()));
    assert_eq!(executor.name(), "cowork");
    assert!(!executor.capabilities().steerable);
    assert_eq!(executor.capabilities().mcp_injection, "none");
    let handle = executor.start(TaskSpec::conformance("Say hello"), AbortFlag::new());
    let result = handle.result().await;
    assert_eq!(result.verdict, TaskVerdict::Failed);
    let error = result.error.unwrap();
    assert!(error.starts_with("capability_unsupported: "));
    assert!(result.summary.contains("cowork"));
    assert!(result.summary.contains("capture-only"));
    assert_eq!(result.usage.turns, 0);
    let events = handle.events.drain().await;
    assert_eq!(events.len(), 1);
    assert!(events[0].log_message().unwrap().contains("capture-only"));
    handle.kill("no-op").await;
    let again = handle.steer("carry on").await.unwrap_err();
    assert_eq!(again.code, "capability_unsupported");
    assert_eq!(again.harness_id.as_deref(), Some("cowork"));
    assert!(!again.retryable);
}

#[test]
fn post_acp_gaps_keep_only_cowork_prose() {
    assert!(harness_executor_gap("cowork").contains("capture-only"));
    assert!(harness_executor_gap("cowork").len() > 40);
    for id in [
        "grok-build",
        "hermes",
        "codex",
        "cursor",
        "claude-code",
        "kimi-code",
        "opencode",
        "pi",
        "qwen-code",
    ] {
        assert!(harness_executor_gap(id).contains("no task executor is wired"));
    }
    let error = harness_executor_unsupported("hermes", "no driver yet");
    assert_eq!(error.code, "capability_unsupported");
    assert_eq!(
        error.context.get("executor").and_then(|v| v.as_str()),
        Some("harness-session")
    );
    assert_eq!(
        error.context.get("executorTarget").and_then(|v| v.as_str()),
        Some("hermes")
    );
    assert_eq!(
        error.context.get("harnessId").and_then(|v| v.as_str()),
        Some("hermes")
    );
    let probe = "the `claude` binary is not resolvable on this node (tried \"claude\")";
    let executor = create_not_implemented_harness_executor("claude-code", probe);
    assert_eq!(
        not_implemented_harness_reason(executor.as_ref()).as_deref(),
        Some(probe)
    );
}

#[tokio::test]
async fn install_registers_probe_failures_and_a_live_binary() {
    let tmp = Tmp::new();
    let kimi = write_exe(&tmp.dir, "kimi", "#!/usr/bin/env bash\nexit 0\n");
    let mut bins = HarnessBinaries::default();
    let missing = "/nonexistent/rr4d-missing";
    bins.claude = missing.to_string();
    bins.kimi = kimi.display().to_string();
    bins.opencode = missing.to_string();
    bins.pi = missing.to_string();
    bins.qwen = missing.to_string();
    bins.grok = missing.to_string();
    bins.hermes = missing.to_string();
    bins.codex_acp = missing.to_string();
    bins.cursor = missing.to_string();
    let registry = create_executor_registry(None);
    let env = Arc::new(map_env(&[]));
    install_headless_executors(&registry, env, &bins, &HeadlessConfig::default()).await;
    let kimi_exec = registry
        .resolve("harness-session", Some("kimi-code"))
        .unwrap();
    assert!(!kimi_exec.is_not_implemented());
    assert_eq!(kimi_exec.name(), "kimi-code");
    let claude = registry
        .resolve("harness-session", Some("claude-code"))
        .unwrap();
    assert!(
        not_implemented_harness_reason(claude.as_ref())
            .unwrap()
            .contains("not resolvable")
    );
    let grok = registry
        .resolve("harness-session", Some("grok-build"))
        .unwrap();
    assert!(
        not_implemented_harness_reason(grok.as_ref())
            .unwrap()
            .contains("`grok`")
    );
    let codex = registry.resolve("harness-session", Some("codex")).unwrap();
    assert!(
        not_implemented_harness_reason(codex.as_ref())
            .unwrap()
            .contains("codex-acp")
    );
    let cursor = registry.resolve("harness-session", Some("cursor")).unwrap();
    assert!(
        not_implemented_harness_reason(cursor.as_ref())
            .unwrap()
            .contains("`agent`")
    );
    let cowork = registry.resolve("harness-session", Some("cowork")).unwrap();
    assert!(
        not_implemented_harness_reason(cowork.as_ref())
            .unwrap()
            .contains("capture-only")
    );
}

#[test]
fn argv_clamp_env_and_resume_patterns() {
    assert_eq!(
        build_kimi_args(
            &KimiFlags {
                model_id: None,
                resume_session_id: None
            },
            "do the thing"
        ),
        vec!["--output-format", "stream-json", "-p", "do the thing"]
    );
    let resumed = build_kimi_args(
        &KimiFlags {
            model_id: Some("kimi-k3".into()),
            resume_session_id: Some("session_abc".into()),
        },
        "go on",
    );
    assert_eq!(&resumed[..4], ["-S", "session_abc", "-m", "kimi-k3"]);
    assert!(
        !resumed
            .iter()
            .any(|arg| arg == "--auto" || arg == "--yolo" || arg == "--session-id")
    );
    assert_eq!(clamp_prompt("  hello  "), "hello");
    assert_eq!(clamp_prompt("   "), EMPTY_PROMPT_PLACEHOLDER);
    let clamped = clamp_prompt(&"y".repeat(PROMPT_MAX_BYTES * 2));
    assert!(clamped.len() < 131_072);
    assert!(clamped.contains("prompt truncated by RivetOS"));
    let cjk = "漢".repeat(PROMPT_MAX_BYTES);
    assert!(cjk.len() * 3 > 131_072);
    let clamped_cjk = clamp_prompt(&cjk);
    assert!(clamped_cjk.len() < 131_072);
    assert!(!clamp_prompt(&format!("x{cjk}")).contains('\u{FFFD}'));
    let base = map_env(&[
        ("KIMI_MODEL_OUTPUT_FORMAT", "text"),
        ("KIMI_CODE_LEGACY_FLAG", "1"),
        ("RIVETOS_SESSION_KEY", "inherited"),
    ]);
    let child = build_kimi_child_env(
        &base,
        &[
            ("RIVETOS_TASK_ID".into(), Some("t1".into())),
            ("RIVETOS_SESSION_KEY".into(), None),
        ],
    );
    assert_eq!(child.get("RIVETOS_TASK_ID").map(String::as_str), Some("t1"));
    assert!(!child.contains_key("RIVETOS_SESSION_KEY"));
    assert!(!child.contains_key("KIMI_MODEL_OUTPUT_FORMAT"));
    assert!(!child.contains_key("KIMI_CODE_LEGACY_FLAG"));
    assert!(kimi_resume_rejected("Session \"session_abc\" not found."));
    assert!(kimi_resume_rejected(
        "Session \"session_abc\" was created under a different directory."
    ));
    assert!(!kimi_resume_rejected("error: provider auth failed"));
    assert_eq!(KILL_GRACE_MS, 10_000);
    assert_eq!(STDOUT_CAP, 64 * 1024);

    let fresh = build_opencode_args(
        &OpencodeFlags {
            model_id: None,
            effort: None,
            resume_session_id: None,
        },
        "do the thing",
    );
    assert_eq!(&fresh[..3], ["run", "--format", "json"]);
    assert_eq!(fresh.last().map(String::as_str), Some("do the thing"));
    let varied = build_opencode_args(
        &OpencodeFlags {
            model_id: Some("m".into()),
            effort: Some("high".into()),
            resume_session_id: Some("ses_a".into()),
        },
        "go",
    );
    assert!(varied.windows(2).any(|pair| pair == ["--variant", "high"]));
    assert!(varied.windows(2).any(|pair| pair == ["--session", "ses_a"]));
    assert!(
        build_opencode_args(
            &OpencodeFlags {
                model_id: None,
                effort: Some("medium".into()),
                resume_session_id: None
            },
            "x",
        )
        .iter()
        .all(|arg| arg != "--variant")
    );
    assert_eq!(variant_for_effort(Some("xhigh")).as_deref(), Some("max"));
    assert_eq!(
        variant_for_effort(Some("minimal")).as_deref(),
        Some("minimal")
    );
    assert!(variant_for_effort(Some("nope")).is_none());
    assert!(opencode_resume_rejected("No session found"));
    assert!(!opencode_resume_rejected("provider auth failed"));

    let pi = build_pi_args(
        &PiFlags {
            model_id: None,
            resume_session_id: Some("old".into()),
            pin_session_id: Some("pin".into()),
            session_dir: Some("/tmp/sessions".into()),
            thinking: Some("high".into()),
            append_system_prompt: Some("scaffold".into()),
        },
        "-leading",
    );
    assert_eq!(&pi[..3], ["--print", "--mode", "json"]);
    assert!(pi.windows(2).any(|pair| pair == ["--session-id", "pin"]));
    assert!(!pi.iter().any(|arg| arg == "--session"));
    assert_eq!(pi[pi.len() - 2], "--");
    assert_eq!(pi.last().map(String::as_str), Some("-leading"));
    assert!(pi_resume_rejected("session not found"));
    assert!(!pi.iter().any(|arg| arg == "--yolo"));

    let qwen = build_qwen_args(
        &QwenFlags {
            model_id: Some("q".into()),
            resume_session_id: Some("old".into()),
            pin_session_id: Some("11111111-2222-3333-4444-555555555555".into()),
            append_system_prompt: Some("scaffold".into()),
            max_session_turns: Some(4),
        },
        "-p-looking",
    );
    assert_eq!(qwen[0], "-p");
    assert!(qwen.iter().any(|arg| arg == "--approval-mode"));
    assert!(
        qwen.windows(2)
            .any(|pair| pair == ["--session-id", "11111111-2222-3333-4444-555555555555"])
    );
    assert!(!qwen.iter().any(|arg| arg == "--resume"));
    assert!(
        qwen.windows(2)
            .any(|pair| pair == ["--max-session-turns", "4"])
    );
    assert!(qwen_resume_rejected("No saved session found with ID abc"));
    assert!(!qwen_resume_rejected("no session found"));
    let qwen_env = build_qwen_child_env(
        &map_env(&[("QWEN_CODE_SUPPRESS_YOLO_WARNING", "0")]),
        &[("QWEN_CODE_SUPPRESS_YOLO_WARNING".into(), None)],
    );
    assert!(!qwen_env.contains_key("QWEN_CODE_SUPPRESS_YOLO_WARNING"));
    let preset = build_qwen_child_env(&map_env(&[]), &[]);
    assert_eq!(
        preset
            .get("QWEN_CODE_SUPPRESS_YOLO_WARNING")
            .map(String::as_str),
        Some("1")
    );
}

#[test]
fn prompts_scaffold_and_canonical_ids() {
    let prompt = build_turn_prompt("## Task Context", "", "/goal do a thing");
    assert!(prompt.starts_with("## Task Context"));
    assert!(prompt.contains("## This turn\n/goal do a thing"));
    let with_history = build_turn_prompt(
        "S",
        "### Prior conversation (task resumed — do NOT redo completed work)\n[user]\nq",
        "go on",
    );
    assert!(with_history.contains("Prior conversation"));
    let mut spec = TaskSpec::conformance("ship");
    spec.resolved_context = "some context".into();
    spec.acceptance_criteria = vec![AcceptanceCriterion {
        id: "c1".into(),
        description: "it works".into(),
    }];
    spec.system_prompt_append = Some("extra instruction".into());
    let scaffold = build_task_scaffold(&spec, Some("/work"));
    assert!(scaffold.contains("some context"));
    assert!(scaffold.contains("[c1] it works"));
    assert!(scaffold.contains("extra instruction"));
    assert!(scaffold.contains("TASK_RESULT"));
    assert!(scaffold.contains("Working directory: /work"));
    let rendered = render_resume_transcript(&[
        HistoryMessage {
            role: "user".into(),
            content: Some("q1".into()),
        },
        HistoryMessage {
            role: "tool".into(),
            content: Some("noise".into()),
        },
        HistoryMessage {
            role: "assistant".into(),
            content: Some("a1".into()),
        },
    ]);
    assert!(rendered.contains("[user]\nq1"));
    assert!(rendered.contains("[assistant]\na1"));
    assert!(!rendered.contains("noise"));
    let big = "x".repeat(2_500);
    let history: Vec<_> = (0..20)
        .map(|i| HistoryMessage {
            role: if i % 2 == 0 {
                "user".into()
            } else {
                "assistant".into()
            },
            content: Some(format!("{i}-{big}")),
        })
        .collect();
    let dropped = render_resume_transcript(&history);
    assert!(dropped.len() < 30_000);
    assert!(dropped.contains("earlier message(s) omitted"));
    assert!(dropped.contains("19-"));
    assert!(!dropped.contains("[user]\n0-"));
    assert_eq!(
        render_resume_transcript(&[HistoryMessage {
            role: "tool".into(),
            content: Some("x".into())
        }]),
        ""
    );
    assert_eq!(
        canonical_kimi_session_id(Some("session_abc")).as_deref(),
        Some("kimi-code:session_abc")
    );
    assert_eq!(
        canonical_kimi_session_id(Some("kimi-code:session_abc")).as_deref(),
        Some("kimi-code:session_abc")
    );
    assert_eq!(
        canonical_kimi_session_id(Some(" padded ")).as_deref(),
        Some(" padded ")
    );
    assert!(canonical_kimi_session_id(Some("")).is_none());
    assert!(canonical_kimi_session_id(None).is_none());
    assert_eq!(
        canonical_opencode_session_id(Some("opencode:ses_a")).as_deref(),
        Some("opencode:ses_a")
    );
    assert_eq!(
        canonical_pi_session_id(Some("abc")).as_deref(),
        Some("pi:abc")
    );
    assert_eq!(
        canonical_qwen_session_id(Some("abc")).as_deref(),
        Some("qwen-code:abc")
    );
}

#[test]
fn homes_buckets_and_reconcile() {
    let env = map_env(&[("KIMI_CODE_HOME", "/somewhere/else")]);
    assert_eq!(kimi_home(&env), Path::new("/somewhere/else"));
    let bare = map_env(&[]);
    assert!(kimi_home(&bare).ends_with(".kimi-code"));
    assert_eq!(work_dir_hash("/tmp"), &sha256_hex(b"/tmp")[..12]);
    assert_eq!(encode_qwen_bucket("/home/rivet"), "-home-rivet");
    assert_eq!(encode_qwen_bucket("/home/rivet/"), "-home-rivet");
    assert_eq!(encode_qwen_bucket("/home/rivet/x"), "-home-rivet-x");
    assert!(pi_home().ends_with(".pi/agent"));
    assert!(qwen_home().ends_with(".qwen"));
    assert!(default_workspace_dir().ends_with(".rivetos/workspace"));
    assert!(opencode_home(&map_env(&[("XDG_DATA_HOME", "/xdg")])).ends_with("xdg/opencode"));
    assert_eq!(
        xdg_data_home_for(Path::new("/data/opencode")),
        Path::new("/data")
    );
    assert_eq!(
        effective_opencode_home(Path::new("/data/opencode")),
        Path::new("/data/opencode")
    );
    assert_eq!(
        effective_opencode_home(Path::new("/data/custom")),
        Path::new("/data/custom/opencode")
    );

    let tmp = Tmp::new();
    let home = tmp.path("kimi-home");
    let cwd = "/work/e";
    let suffix = work_dir_hash(cwd);
    let bucket = home.join("sessions").join(format!("wd_slug_{suffix}"));
    let session = bucket.join("session_e");
    let wire = session.join("agents").join("main").join("wire.jsonl");
    std::fs::create_dir_all(wire.parent().unwrap()).unwrap();
    std::fs::create_dir_all(session.join("agents").join("agent-0")).unwrap();
    assert_eq!(
        find_bucket_dir(&home.join("sessions"), cwd).as_ref(),
        Some(&bucket)
    );
    let usage = |time: i64, input: i64, output: i64, cache: i64| {
        format!(
            r#"{{"type":"usage.record","usage":{{"inputOther":{input},"output":{output},"inputCacheRead":{cache},"inputCacheCreation":0}},"usageScope":"turn","time":{time}}}"#
        )
    };
    let mut main = String::new();
    main.push_str("{\"type\":\"metadata\"}\n");
    main.push_str(&usage(1000, 100, 10, 5));
    main.push('\n');
    main.push_str(&usage(2000, 200, 20, 0));
    main.push('\n');
    main.push_str("{\"type\":\"usage.record\",\"usage\":{\"inputOther\":9999,\"output\":9999},\"usageScope\":\"session\",\"time\":2000}\n");
    main.push_str("{\"type\":\"turn.ended\",\"turnId\":1,\"reason\":\"completed\",\"durationMs\":1234,\"time\":2100}\n");
    std::fs::write(&wire, main).unwrap();
    std::fs::write(
        session.join("agents").join("agent-0").join("wire.jsonl"),
        format!("{}\n", usage(2050, 50, 5, 0)),
    )
    .unwrap();
    std::fs::write(
        home.join("session_index.jsonl"),
        format!(
            "{{\"sessionId\":\"session_e\",\"sessionDir\":\"{}\",\"workDir\":\"{cwd}\"}}\n",
            session.display()
        ),
    )
    .unwrap();
    assert_eq!(
        resolve_session_dir(&home, cwd, "session_e").as_ref(),
        Some(&session)
    );
    assert!(resolve_session_dir(&home, cwd, "missing").is_none());
    let facts = reconcile_turn(&session, 1500);
    assert_eq!(facts.input_tokens, 250.0);
    assert_eq!(facts.output_tokens, 25.0);
    assert_eq!(facts.total_tokens, 275.0);
    assert_eq!(facts.usage_records, 2);
    assert_eq!(facts.files, 2);
    assert_eq!(
        facts.turn_ended.as_ref().map(|ended| ended.reason.as_str()),
        Some("completed")
    );
    let torn = tmp.path("torn");
    let torn_wire = torn.join("agents").join("main").join("wire.jsonl");
    std::fs::create_dir_all(torn_wire.parent().unwrap()).unwrap();
    std::fs::write(
        &torn_wire,
        format!(
            "{}\n{{\"type\":\"turn.ended\",\"reason\":\"cancel",
            usage(3000, 100, 10, 5)
        ),
    )
    .unwrap();
    let torn_facts = reconcile_turn(&torn, 0);
    assert_eq!(torn_facts.malformed, 1);
    assert_eq!(torn_facts.total_tokens, 115.0);
    assert!(torn_facts.turn_ended.is_none());
    let missing = reconcile_turn(Path::new("/nonexistent/session"), 0);
    assert_eq!(missing.total_tokens, 0.0);
    assert_eq!(missing.files, 0);
    assert!(wire_files_for(Path::new("/nonexistent/session")).is_empty());

    let pi_id = "11111111-2222-4333-8444-555555555555";
    assert!(is_pi_native_id(pi_id));
    let pi_home_dir = tmp.path("pi-home");
    let pi_file = pi_sessions_root(&pi_home_dir)
        .join("--work-e--")
        .join(format!("1_{pi_id}.jsonl"));
    std::fs::create_dir_all(pi_file.parent().unwrap()).unwrap();
    std::fs::write(
        &pi_file,
        "{\"type\":\"message\",\"timestamp\":1000,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"old\"}],\"usage\":{\"input\":100,\"output\":10},\"stopReason\":\"stop\"}}\n{\"type\":\"message\",\"timestamp\":2000,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"new\"}],\"usage\":{\"input\":200,\"output\":20,\"cacheRead\":0},\"stopReason\":\"end_turn\"}}\n",
    )
    .unwrap();
    assert_eq!(
        find_pi_session_file(&pi_home_dir, "/work/e", pi_id).as_ref(),
        Some(&pi_file)
    );
    let pi_facts = reconcile_pi_turn(&pi_file, 1500);
    assert_eq!(pi_facts.input_tokens, 200.0);
    assert_eq!(pi_facts.output_tokens, 20.0);
    assert_eq!(pi_facts.usage_records, 1);
    assert!(is_fatal_pi_stop_reason(Some("error")));
    assert!(!is_fatal_pi_stop_reason(Some("stop")));

    let qwen_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    assert!(is_qwen_native_id(qwen_id));
    let qwen_home_dir = tmp.path("qwen-home");
    let qwen_file = qwen_home_dir
        .join("projects")
        .join(encode_qwen_bucket("/work/e"))
        .join("chats")
        .join(format!("{qwen_id}.jsonl"));
    std::fs::create_dir_all(qwen_file.parent().unwrap()).unwrap();
    std::fs::write(
        &qwen_file,
        "{\"type\":\"assistant\",\"timestamp\":2000,\"message\":{\"role\":\"assistant\",\"content\":[{\"text\":\"hi\"}]},\"usageMetadata\":{\"promptTokenCount\":100,\"candidatesTokenCount\":4,\"cachedContentTokenCount\":40}}\n",
    )
    .unwrap();
    std::fs::write(
        qwen_file.with_file_name(format!("{qwen_id}.runtime.json")),
        "{}\n",
    )
    .unwrap();
    assert_eq!(
        find_qwen_session_file(&qwen_home_dir, "/work/e", qwen_id).as_ref(),
        Some(&qwen_file)
    );
    assert_eq!(
        list_qwen_session_ids(&qwen_home_dir),
        vec![qwen_id.to_string()]
    );
    let qwen_facts = reconcile_qwen_turn(&qwen_file, 0);
    assert_eq!(qwen_facts.input_tokens, 100.0);
    assert_eq!(qwen_facts.output_tokens, 4.0);
    assert_eq!(qwen_facts.cache_read, 40.0);
    assert_eq!(qwen_facts.total_tokens, 104.0);
    assert!(!is_fatal_qwen_result(
        serde_json::json!({"type":"result","subtype":"success"})
            .as_object()
            .unwrap()
    ));
    assert!(is_fatal_qwen_result(
        serde_json::json!({"type":"result","subtype":"error"})
            .as_object()
            .unwrap()
    ));
}

#[test]
fn opencode_parse_and_sqlite_reconcile() {
    let text = parse_opencode_event(&serde_json::json!({"type": "text", "text": "hello"})).unwrap();
    assert_eq!(text.kind, "text");
    assert_eq!(text.text, "hello");
    let start = parse_opencode_event(
        &serde_json::json!({"type":"tool","tool":"bash","state":{"status":"running"}}),
    )
    .unwrap();
    assert_eq!(start.kind, "tool-start");
    let end = parse_opencode_event(
        &serde_json::json!({"type":"tool","tool":"bash","state":{"status":"completed"}}),
    )
    .unwrap();
    assert_eq!(end.kind, "tool-end");
    let usage = parse_opencode_event(&serde_json::json!({"role":"assistant","tokens":{"input":100,"output":20,"reasoning":3,"cache":{"read":10,"write":2}}})).unwrap();
    assert_eq!(usage.kind, "usage");
    assert_eq!(usage.input_tokens, 112.0);
    assert_eq!(usage.output_tokens, 23.0);
    let step = parse_opencode_event(&serde_json::json!({"type":"step_finish","sessionID":"ses_aaaaaaaaaaaaaaaaaaaa","part":{"type":"step_finish","tokens":{"input":100,"output":25,"reasoning":0,"cache":{"read":10,"write":0}}}})).unwrap();
    assert_eq!(step.session_id.as_deref(), Some("ses_aaaaaaaaaaaaaaaaaaaa"));
    assert_eq!(step.input_tokens, 110.0);
    let error =
        parse_opencode_event(&serde_json::json!({"type":"error","error":{"message":"boom"}}))
            .unwrap();
    assert_eq!(error.error.as_deref(), Some("boom"));
    assert_eq!(
        parse_opencode_event(&serde_json::json!({"type":"nope"}))
            .unwrap()
            .kind,
        "other"
    );
    assert!(parse_opencode_event(&serde_json::json!("x")).is_none());

    let tmp = Tmp::new();
    let home = tmp.path("oc");
    std::fs::create_dir_all(&home).unwrap();
    let db_path = opencode_db_path(&home);
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
    )
    .unwrap();
    let sid = "ses_eeeeeeeeeeeeeeeeeeee";
    conn.execute(
        "INSERT INTO session (id, directory, time_created, time_updated) VALUES (?1, ?2, ?3, ?4)",
        (sid, "/work/e", 1000_i64, 2050_i64),
    )
    .unwrap();
    let insert = |id: &str, time: i64, data: &str| {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            (id, sid, time, data),
        )
        .unwrap();
    };
    insert(
        "msg_old",
        1000,
        r#"{"role":"assistant","tokens":{"input":100,"output":10,"reasoning":0,"cache":{"read":5,"write":0}},"time":{"created":1000,"completed":1000}}"#,
    );
    insert(
        "msg_a",
        2000,
        r#"{"role":"assistant","tokens":{"input":200,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":2000,"completed":2000}}"#,
    );
    insert(
        "msg_user",
        2000,
        r#"{"role":"user","tokens":{"input":9999,"output":9999,"cache":{"read":0,"write":0}},"time":{"created":2000,"completed":2000}}"#,
    );
    insert(
        "msg_b",
        2050,
        r#"{"role":"assistant","tokens":{"input":50,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":2050,"completed":2050}}"#,
    );
    drop(conn);
    let facts = reconcile_opencode_turn(&home, sid, 1500);
    assert_eq!(facts.input_tokens, 250.0);
    assert_eq!(facts.output_tokens, 25.0);
    assert_eq!(facts.total_tokens, 275.0);
    assert_eq!(facts.usage_records, 2);
    assert_eq!(facts.files, 4);
    let none = reconcile_opencode_turn(Path::new("/nonexistent/home"), "ses_nope", 0);
    assert_eq!(none.total_tokens, 0.0);
    assert_eq!(
        newest_opencode_session_after(&home, "/work/e", 500).as_deref(),
        Some(sid)
    );
    assert!(newest_opencode_session_after(&home, "/work/e", 5000).is_none());
}

#[tokio::test]
async fn spawn_wait_exit_survives_signal_and_early_close() {
    let tmp = Tmp::new();
    let slow = write_exe(&tmp.dir, "slow", "#!/usr/bin/env bash\nexec sleep 60\n");
    let env = path_env();
    let spawned = spawn_child(SpawnRequest {
        binary: slow.to_str().unwrap(),
        args: &[],
        cwd: None,
        env: &env,
        stdin: StdinMode::Ignore,
        kill_grace: Duration::from_millis(50),
        capture_stdout: false,
    })
    .await
    .unwrap();
    spawned.kill();
    assert_eq!(spawned.wait_exit().await, None);
    let quick = write_exe(&tmp.dir, "quick", "#!/usr/bin/env bash\nexit 7\n");
    let spawned = spawn_child(SpawnRequest {
        binary: quick.to_str().unwrap(),
        args: &[],
        cwd: None,
        env: &env,
        stdin: StdinMode::PipeEof,
        kill_grace: Duration::from_millis(50),
        capture_stdout: false,
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(spawned.wait_exit().await, Some(7));
    assert_eq!(spawned.wait_exit().await, Some(7));
}

#[tokio::test]
async fn stdout_capture_stops_on_a_utf8_boundary() {
    let tmp = Tmp::new();
    let binary = write_exe(
        &tmp.dir,
        "wide",
        "#!/usr/bin/env bash\nline=$(printf '%.0s漢' {1..1000})\ni=0\nwhile [ \"$i\" -lt 30 ]; do\n  printf '%s\\n' \"$line\"\n  i=$((i+1))\ndone\n",
    );
    let env = path_env();
    let mut spawned = spawn_child(SpawnRequest {
        binary: binary.to_str().unwrap(),
        args: &[],
        cwd: None,
        env: &env,
        stdin: StdinMode::Ignore,
        kill_grace: Duration::from_millis(50),
        capture_stdout: true,
    })
    .await
    .unwrap();
    while spawned.next_line().await.is_some() {}
    let text = spawned.stdout_text();
    assert!(text.len() <= STDOUT_CAP);
    assert!(text.len() + 3 > STDOUT_CAP);
    assert!(text.chars().all(|ch| ch == '漢' || ch == '\n'));
}

#[tokio::test]
async fn spawn_records_the_clock_before_the_child_starts() {
    let tmp = Tmp::new();
    let binary = write_exe(
        &tmp.dir,
        "stamp",
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$(date +%s%3N)\"\n",
    );
    let env = path_env();
    let mut spawned = spawn_child(SpawnRequest {
        binary: binary.to_str().unwrap(),
        args: &[],
        cwd: None,
        env: &env,
        stdin: StdinMode::Ignore,
        kill_grace: Duration::from_millis(50),
        capture_stdout: false,
    })
    .await
    .unwrap();
    let started = spawned.started_at_ms;
    let line = spawned.next_line().await.unwrap();
    let child_ms: i64 = line.trim().parse().unwrap();
    assert!(started <= child_ms);
}

#[tokio::test]
async fn install_applies_non_default_config_to_a_resolved_kimi() {
    let tmp = Tmp::new();
    let kimi = write_exe(
        &tmp.dir,
        "kimi",
        "#!/usr/bin/env bash\nif [ \"$1\" = \"--version\" ]; then\n  exit 0\nfi\nout=\"$(dirname \"$0\")/recorded.txt\"\n{\n  printf 'pwd=%s\\n' \"$(pwd)\"\n  printf 'effort=%s\\n' \"${KIMI_MODEL_THINKING_EFFORT-}\"\n  printf '%s\\n' \"$@\"\n} > \"$out\"\nprintf '%s\\n' '{\"role\":\"assistant\",\"content\":\"ok\"}'\nprintf '%s\\n' '{\"role\":\"meta\",\"type\":\"session.resume_hint\",\"session_id\":\"sess-installed\",\"command\":\"kimi -r sess-installed\"}'\n",
    );
    let cwd = tmp.path("work");
    let home = tmp.path("home");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let mut bins = HarnessBinaries::default();
    let missing = "/nonexistent/rr4d-missing";
    bins.claude = missing.to_string();
    bins.kimi = kimi.display().to_string();
    bins.opencode = missing.to_string();
    bins.pi = missing.to_string();
    bins.qwen = missing.to_string();
    bins.grok = missing.to_string();
    bins.hermes = missing.to_string();
    bins.codex_acp = missing.to_string();
    bins.cursor = missing.to_string();
    let history = Arc::new(HistorySource {
        get_task_history: Some(Arc::new(|_task, _limit| {
            Ok(vec![HistoryMessage {
                role: "assistant".into(),
                content: Some("earlier-turn-marker".into()),
            }])
        })),
        get_session_history: None,
    });
    let registry = create_executor_registry(None);
    install_headless_executors(
        &registry,
        Arc::new(map_env(&[])),
        &bins,
        &HeadlessConfig {
            model: Some("kimi-k2".into()),
            effort: Some("high".into()),
            cwd: Some(cwd.display().to_string()),
            home: Some(home.display().to_string()),
            history: Some(history),
        },
    )
    .await;
    let executor = registry
        .resolve("harness-session", Some("kimi-code"))
        .unwrap();
    let mut spec = TaskSpec::conformance("Say hello");
    spec.resume_message = Some("continue please".into());
    let result = executor.start(spec, AbortFlag::new()).result().await;
    assert_eq!(result.verdict, TaskVerdict::Completed);
    let recorded = std::fs::read_to_string(tmp.path("recorded.txt")).unwrap();
    assert!(recorded.contains("pwd="));
    assert!(recorded.contains(&cwd.display().to_string()));
    assert!(recorded.contains("effort=high"));
    assert!(recorded.contains("-m\nkimi-k2\n") || recorded.contains("-m"));
    assert!(recorded.contains("kimi-k2"));
    assert!(recorded.contains("earlier-turn-marker"));
}
