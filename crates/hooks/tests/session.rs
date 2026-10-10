use std::sync::Arc;

use super::common::ScriptFiles;
use hooks::{
    HookContext, HookPipeline, SessionHooksConfig, SessionHooksContext, SessionTokenTotals,
    ShellError, ShellExecutor, create_auto_commit_hook, create_post_compact_hook,
    create_pre_compact_hook, create_session_hooks, create_session_start_hook,
    create_session_summary_hook,
};
use serde_json::json;

fn files_with_read(note: Result<Option<String>, hooks::FileError>) -> Arc<ScriptFiles> {
    let files = ScriptFiles::new();
    files
        .reads
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .push(note);
    files
}

fn context(
    shell: Option<Arc<dyn ShellExecutor>>,
    files: Option<Arc<ScriptFiles>>,
    workspace: Option<&str>,
) -> SessionHooksContext {
    SessionHooksContext {
        shell,
        file_writer: files.map(|files| files as Arc<dyn hooks::FileWriter>),
        workspace_dir: workspace.map(str::to_string),
    }
}

fn end_ctx() -> HookContext {
    let mut ctx = HookContext::session_end().with_agent("opus");
    ctx.turn_count = Some(5);
    ctx.total_tokens = Some(SessionTokenTotals {
        prompt: 1000,
        completion: 500,
    });
    ctx
}

#[tokio::test]
async fn session_start_records_metadata_and_daily_context() {
    let files = files_with_read(Ok(None));
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_start_hook(context(
        None,
        Some(files),
        Some("/home/user/workspace"),
    )));
    let mut ctx = HookContext::session_start();
    ctx.platform = Some("telegram".to_string());
    ctx.user_id = Some("user-1".to_string());
    ctx.timestamp = 1_700_000_000_000;
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata.get("sessionStartTime"),
        Some(&json!(1_700_000_000_000_i64))
    );
    assert_eq!(ctx.metadata.get("platform"), Some(&json!("telegram")));
    assert_eq!(ctx.metadata.get("userId"), Some(&json!("user-1")));
    assert!(ctx.metadata.get("dailyContext").is_none());

    let files = files_with_read(Ok(Some("# Today\n- Worked on hooks".to_string())));
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_start_hook(context(
        None,
        Some(Arc::clone(&files)),
        Some("/home/user/workspace"),
    )));
    let mut ctx = HookContext::session_start();
    pipeline.run(&mut ctx).await;
    assert!(
        ctx.metadata
            .get("dailyContext")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .contains("Worked on hooks")
    );

    let files = files_with_read(Err(hooks::FileError::new("missing")));
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_start_hook(context(
        None,
        Some(files),
        Some("/home/user/workspace"),
    )));
    let mut ctx = HookContext::session_start();
    pipeline.run(&mut ctx).await;
    assert!(ctx.metadata.get("dailyContext").is_none());

    let long = "é".repeat(2001);
    let files = files_with_read(Ok(Some(long)));
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_start_hook(context(
        None,
        Some(files),
        Some("/workspace"),
    )));
    let mut ctx = HookContext::session_start();
    pipeline.run(&mut ctx).await;
    let daily = ctx
        .metadata
        .get("dailyContext")
        .and_then(|value| value.as_str())
        .expect("daily");
    assert_eq!(hooks::utf16_len(daily), 2000);
}

#[tokio::test]
async fn session_summary_writes_the_daily_note_shape() {
    let files = ScriptFiles::new();
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_summary_hook(context(
        None,
        Some(Arc::clone(&files)),
        Some("/home/user/workspace"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert_eq!(ctx.metadata.get("summaryWritten"), Some(&json!(true)));
    let appended = files.appends();
    assert_eq!(appended.len(), 1);
    assert!(appended[0].0.contains("/memory/"));
    assert!(appended[0].0.ends_with(".md"));
    assert!(appended[0].1.contains("Session ended"));
    assert!(appended[0].1.contains("Agent: opus"));
    assert!(appended[0].1.contains("Turns: 5"));
    assert!(appended[0].1.contains("Tokens: 1,500 (1,000 in / 500 out)"));

    let files = ScriptFiles::new();
    *files
        .fail_append
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = Some("disk full".to_string());
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_summary_hook(context(
        None,
        Some(files),
        Some("/home/user/workspace"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert_eq!(ctx.metadata.get("summaryWritten"), Some(&json!(false)));

    let pipeline = HookPipeline::new();
    pipeline.register(create_session_summary_hook(context(
        None,
        None,
        Some("/test"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert!(ctx.metadata.get("summaryWritten").is_none());

    let files = ScriptFiles::new();
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_summary_hook(context(
        None,
        Some(files.clone()),
        Some("/home/user/workspace"),
    )));
    let mut ctx = HookContext::session_end();
    ctx.turn_count = Some(0);
    pipeline.run(&mut ctx).await;
    let text = files.appends()[0].1.clone();
    assert!(text.contains("Agent: unknown"));
    assert!(!text.contains("Turns:"));
    assert!(!text.contains("Tokens:"));
}

#[tokio::test]
async fn auto_commit_uses_the_typescript_git_commands() {
    let shell = super::common::ScriptShell::sequence(vec![
        Ok(hooks::ShellOutput {
            stdout: " M file.ts\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
        }),
        Ok(hooks::ShellOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        }),
        Ok(hooks::ShellOutput {
            stdout: "[main abc123] auto commit".to_string(),
            stderr: String::new(),
            exit_code: 0,
        }),
    ]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_commit_hook(context(
        Some(shell.clone()),
        None,
        Some("/home/user/workspace"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls().len(), 3);
    assert_eq!(shell.calls()[0].0, "git status --porcelain");
    assert_eq!(shell.calls()[0].1.as_deref(), Some("/home/user/workspace"));
    assert_eq!(shell.calls()[1].0, "git add -A");
    assert_eq!(
        shell.calls()[2].0,
        "git commit -m \"auto: session end (opus, 5 turns)\""
    );
    assert_eq!(
        ctx.metadata
            .get("autoCommit")
            .and_then(|value| value.get("status")),
        Some(&json!("committed"))
    );

    let shell = super::common::ScriptShell::ok(0, "   \n", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_commit_hook(context(
        Some(shell),
        None,
        Some("/home/user/workspace"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata.get("autoCommit"),
        Some(&json!({"status": "clean", "message": "No uncommitted changes"}))
    );

    let shell = super::common::ScriptShell::sequence(vec![
        Ok(hooks::ShellOutput {
            stdout: " M file.ts\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
        }),
        Ok(hooks::ShellOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        }),
        Ok(hooks::ShellOutput {
            stdout: String::new(),
            stderr: "error".to_string(),
            exit_code: 1,
        }),
    ]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_commit_hook(context(
        Some(shell),
        None,
        Some("/home/user/workspace"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata
            .get("autoCommit")
            .and_then(|value| value.get("status")),
        Some(&json!("failed"))
    );

    let shell = super::common::ScriptShell::fail("git missing");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_commit_hook(context(
        Some(shell),
        None,
        Some("/home/user/workspace"),
    )));
    let mut ctx = end_ctx();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata.get("autoCommit"),
        Some(&json!({"status": "error", "message": "git missing"}))
    );
    let _ = ShellError::new("git missing");
}

#[tokio::test]
async fn compaction_hooks_carry_the_snapshot_and_ratio() {
    let pipeline = HookPipeline::new();
    pipeline.register(create_pre_compact_hook());
    let mut ctx = HookContext::compact_before(150);
    ctx.timestamp = 99;
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata.get("preCompactSnapshot"),
        Some(&json!({"messageCount": 150, "timestamp": 99}))
    );

    let files = ScriptFiles::new();
    let pipeline = HookPipeline::new();
    pipeline.register(create_post_compact_hook(context(
        None,
        Some(files.clone()),
        Some("/home/user/workspace"),
    )));
    let mut ctx = HookContext::compact_after(10);
    ctx.summary = Some("Session discussed hooks and testing.".to_string());
    ctx.metadata.insert(
        "preCompactSnapshot".to_string(),
        json!({"messageCount": 100, "timestamp": 1}),
    );
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata.get("compactionResult"),
        Some(&json!({
            "originalMessages": 100,
            "remainingMessages": 10,
            "summaryGenerated": true,
            "compressionRatio": "90.0%"
        }))
    );
    let logged = files.appends()[0].1.clone();
    assert!(logged.contains("Compaction"));
    assert!(logged.contains("100"));
    assert!(logged.contains('→'));
    assert!(logged.contains("10"));
    assert!(logged.contains("Summary: yes"));

    let pipeline = HookPipeline::new();
    pipeline.register(create_post_compact_hook(context(
        None,
        Some(ScriptFiles::new()),
        Some("/home/user/workspace"),
    )));
    let mut ctx = HookContext::compact_after(10);
    ctx.summary = Some("Session discussed hooks and testing.".to_string());
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata
            .get("compactionResult")
            .and_then(|value| value.get("originalMessages")),
        Some(&json!("unknown"))
    );

    let files = ScriptFiles::new();
    let pipeline = HookPipeline::new();
    pipeline.register(create_pre_compact_hook());
    pipeline.register(create_post_compact_hook(context(
        None,
        Some(files),
        Some("/home/user/workspace"),
    )));
    let mut before = HookContext::compact_before(200);
    pipeline.run(&mut before).await;
    let mut after = HookContext::compact_after(15);
    after.summary = Some("kept".to_string());
    after.metadata = before.metadata.clone();
    pipeline.run(&mut after).await;
    assert_eq!(
        after.metadata.get("compactionResult"),
        Some(&json!({
            "originalMessages": 200,
            "remainingMessages": 15,
            "summaryGenerated": true,
            "compressionRatio": "92.5%"
        }))
    );
}

#[test]
fn create_session_hooks_defaults_and_flags() {
    let hooks = create_session_hooks(SessionHooksConfig {
        context: context(None, None, Some("/workspace")),
        session_start: None,
        session_summary: None,
        auto_commit: false,
        pre_compact: None,
        post_compact: None,
    });
    assert_eq!(hooks.len(), 4);
    let ids: Vec<_> = hooks.iter().map(|hook| hook.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "session:start-context",
            "session:end-summary",
            "compact:preserve-context",
            "compact:verify-context"
        ]
    );
    let enabled = create_session_hooks(SessionHooksConfig {
        context: context(None, None, None),
        session_start: None,
        session_summary: None,
        auto_commit: true,
        pre_compact: None,
        post_compact: None,
    });
    assert_eq!(enabled.len(), 5);
    assert!(
        enabled
            .iter()
            .any(|hook| hook.id == "session:end-autocommit")
    );
    let none = create_session_hooks(SessionHooksConfig {
        context: context(None, None, None),
        session_start: Some(false),
        session_summary: Some(false),
        auto_commit: false,
        pre_compact: Some(false),
        post_compact: Some(false),
    });
    assert!(none.is_empty());
}
