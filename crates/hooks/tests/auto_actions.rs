use std::path::Path;
use std::sync::Arc;

use super::common::{ScriptShell, tool_after};
use hooks::{
    AutoAction, AutoActionConfig, AutoActionsConfig, HookPipeline, ProcessShell, ShellExecutor,
    ShellOutput, create_auto_action_hooks, create_auto_format_hook, create_auto_git_check_hook,
    create_auto_lint_hook, create_auto_test_hook, create_custom_action_hook,
};
use protocol::js::JsValue;
use serde_json::{Value, json};

fn same_json(value: Option<&JsValue>, expected: Value) -> bool {
    value.is_some_and(|got| *got == expected)
}

fn config(shell: Arc<ScriptShell>) -> AutoActionConfig {
    AutoActionConfig {
        shell: shell as Arc<dyn ShellExecutor>,
        cwd: None,
    }
}

fn output(exit_code: i64, stdout: &str, stderr: &str) -> ShellOutput {
    ShellOutput {
        stdout: stdout.to_string(),
        stderr: stderr.to_string(),
        exit_code,
    }
}

#[tokio::test]
async fn auto_format_matches_prettier_commands_and_soft_fail() {
    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell.clone())));
    let mut ctx = tool_after(
        "file_write",
        json!({"path": "/opt/rivetos/src/index.ts"}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert_eq!(
        shell.calls()[0].0,
        "npx prettier --write '/opt/rivetos/src/index.ts' 2>/dev/null"
    );
    assert_eq!(shell.calls()[0].1, None);
    assert!(same_json(
        ctx.metadata.get("autoFormat"),
        json!({"file": "/opt/rivetos/src/index.ts", "status": "formatted"})
    ));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    let mut cwd_config = config(shell.clone());
    cwd_config.cwd = Some("/work".to_string());
    pipeline.register(create_auto_format_hook(cwd_config));
    let mut ctx = tool_after("file_edit", json!({"path": "/config.json"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].1.as_deref(), Some("/work"));
    assert!(shell.calls()[0].0.contains("prettier"));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell.clone())));
    let mut ctx = tool_after(
        "file_write",
        json!({"path": "/opt/rivetos/image.png"}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell.clone())));
    let mut ctx = tool_after("file_write", json!({"path": "/src/test.ts"}), true);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());

    let shell = ScriptShell::fail("command not found");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell)));
    let mut ctx = tool_after("file_write", json!({"path": "/src/test.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert!(same_json(
        ctx.metadata.get("autoFormat"),
        json!({
            "file": "/src/test.ts",
            "status": "skipped",
            "reason": "prettier not available"
        })
    ));

    let shell = ScriptShell::ok(2, "", "nope");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell.clone())));
    let mut ctx = tool_after("file_write", json!({"path": "/src/test.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().len() == 1);
    assert!(ctx.metadata.get("autoFormat").is_none());

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell.clone())));
    let mut ctx = tool_after("shell", json!({"path": "/src/test.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());
}

#[tokio::test]
async fn auto_lint_reports_issues_and_skips_css() {
    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_lint_hook(config(shell.clone())));
    let mut ctx = tool_after("file_write", json!({"path": "/src/index.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(
        shell.calls()[0].0,
        "npx eslint --fix '/src/index.ts' 2>/dev/null"
    );
    assert!(same_json(
        ctx.metadata.get("autoLint"),
        json!({"file": "/src/index.ts", "status": "linted"})
    ));

    let shell = ScriptShell::sequence(vec![Ok(output(1, "", "Missing semicolon"))]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_lint_hook(config(shell)));
    let mut ctx = tool_after("file_write", json!({"path": "/src/index.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert!(same_json(
        ctx.metadata.get("autoLint"),
        json!({
            "file": "/src/index.ts",
            "status": "issues",
            "output": "Missing semicolon"
        })
    ));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_lint_hook(config(shell.clone())));
    let mut ctx = tool_after("file_write", json!({"path": "/src/style.css"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());
}

#[tokio::test]
async fn auto_test_runs_related_tests_and_skips_specs() {
    let shell = ScriptShell::ok(0, "Tests: 3 passed", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_test_hook(config(shell.clone())));
    let mut ctx = tool_after(
        "file_write",
        json!({"path": "/opt/rivetos/packages/core/src/domain/hooks.ts"}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert_eq!(
        shell.calls()[0].0,
        "npx vitest run --related '/opt/rivetos/packages/core/src/domain/hooks.ts' --reporter=verbose 2>&1 | tail -20"
    );
    assert!(same_json(
        ctx.metadata
            .get("autoTest")
            .and_then(|value| value.get("status")),
        json!("passed")
    ));

    let shell = ScriptShell::sequence(vec![Ok(output(1, "FAIL: expected true to be false", ""))]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_test_hook(config(shell)));
    let mut ctx = tool_after(
        "file_write",
        json!({"path": "/opt/rivetos/packages/core/src/test.ts"}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert!(same_json(
        ctx.metadata
            .get("autoTest")
            .and_then(|value| value.get("status")),
        json!("failed")
    ));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_test_hook(config(shell.clone())));
    let mut ctx = tool_after(
        "file_write",
        json!({"path": "/packages/core/src/domain/hooks.test.ts"}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());
    let mut readme = tool_after("file_write", json!({"path": "/README.md"}), false);
    pipeline.run(&mut readme).await;
    assert!(shell.calls().is_empty());
}

#[tokio::test]
async fn auto_git_check_runs_tsc_after_commit() {
    let shell = ScriptShell::ok(0, "No errors", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_git_check_hook(config(shell.clone())));
    let mut ctx = tool_after("shell", json!({"command": "git commit -m \"test\""}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, "npx tsc --noEmit 2>&1 | tail -10");
    assert!(same_json(
        ctx.metadata
            .get("autoGitCheck")
            .and_then(|value| value.get("status")),
        json!("passed")
    ));

    let shell = ScriptShell::sequence(vec![Ok(output(1, "error TS2345", ""))]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_git_check_hook(config(shell)));
    let mut ctx = tool_after(
        "shell",
        json!({"command": "git commit -m \"broken\""}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert!(same_json(
        ctx.metadata
            .get("autoGitCheck")
            .and_then(|value| value.get("status")),
        json!("issues")
    ));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_git_check_hook(config(shell.clone())));
    let mut ctx = tool_after("shell", json!({"command": "git push origin main"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());
}

#[tokio::test]
async fn custom_actions_interpolate_filter_and_soft_fail() {
    let shell = ScriptShell::ok(0, "ok", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "my-action".to_string(),
                description: "test action".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "echo {{file}}".to_string(),
                timeout_ms: Some(5),
                soft_fail: false,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "/test.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, "echo '/test.ts'");
    assert!(same_json(
        ctx.metadata
            .get("auto:my-action")
            .and_then(|value| value.get("status")),
        json!("success")
    ));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "ts-only".to_string(),
                description: "ts only".to_string(),
                tools: None,
                file_pattern: Some(r"\.ts$".to_string()),
                file_pattern_flags: None,
                command: "echo {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: false,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "/test.md"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());

    let shell = ScriptShell::fail("boom");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "soft".to_string(),
                description: "soft fail".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "exit 1".to_string(),
                timeout_ms: Some(1),
                soft_fail: true,
            },
            config(shell),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "/test.ts"}), false);
    let result = pipeline.run(&mut ctx).await;
    assert!(!result.aborted);
    assert!(same_json(
        ctx.metadata.get("auto:soft"),
        json!({"status": "error", "message": "boom"})
    ));

    let shell = ScriptShell::fail("boom");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "hard".to_string(),
                description: "hard fail".to_string(),
                tools: Some(vec!["file_write".to_string()]),
                file_pattern: None,
                file_pattern_flags: None,
                command: "echo {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: false,
            },
            config(shell),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "/tmp/$&"}), false);
    let result = pipeline.run(&mut ctx).await;
    assert!(result.aborted);
    assert_eq!(result.errors[0].error.message, "boom");
}

#[test]
fn create_auto_action_hooks_is_opt_in() {
    let shell = ScriptShell::ok(0, "", "");
    let base = AutoActionsConfig {
        shell: shell.clone() as Arc<dyn ShellExecutor>,
        cwd: None,
        auto_format: false,
        auto_lint: false,
        auto_test: false,
        auto_git_check: false,
        custom_actions: Vec::new(),
    };
    assert!(create_auto_action_hooks(base).expect("hooks").is_empty());
    let all = create_auto_action_hooks(AutoActionsConfig {
        shell: shell.clone() as Arc<dyn ShellExecutor>,
        cwd: Some("/work".to_string()),
        auto_format: true,
        auto_lint: true,
        auto_test: true,
        auto_git_check: true,
        custom_actions: Vec::new(),
    })
    .expect("hooks");
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].id, "auto:format");
    assert_eq!(all[0].priority, 60);
    assert_eq!(all[1].priority, 61);
    assert_eq!(all[2].priority, 65);
    assert_eq!(all[3].id, "auto:git-check");
    let custom = create_auto_action_hooks(AutoActionsConfig {
        shell: shell as Arc<dyn ShellExecutor>,
        cwd: None,
        auto_format: false,
        auto_lint: false,
        auto_test: false,
        auto_git_check: false,
        custom_actions: vec![
            AutoAction {
                id: "a".to_string(),
                description: "a".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "echo a".to_string(),
                timeout_ms: None,
                soft_fail: false,
            },
            AutoAction {
                id: "b".to_string(),
                description: "b".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "echo b".to_string(),
                timeout_ms: None,
                soft_fail: false,
            },
        ],
    })
    .expect("hooks");
    assert_eq!(custom.len(), 2);
    assert_eq!(custom[0].id, "auto:a");
    assert_eq!(custom[1].priority, 70);
    let rejected = create_auto_action_hooks(AutoActionsConfig {
        shell: ScriptShell::ok(0, "", "") as Arc<dyn ShellExecutor>,
        cwd: None,
        auto_format: false,
        auto_lint: false,
        auto_test: false,
        auto_git_check: false,
        custom_actions: vec![AutoAction {
            id: "bad".to_string(),
            description: "bad".to_string(),
            tools: None,
            file_pattern: Some("*.ts".to_string()),
            file_pattern_flags: None,
            command: "echo {{file}}".to_string(),
            timeout_ms: None,
            soft_fail: false,
        }],
    });
    match rejected {
        Err(err) => assert_eq!(
            err.message,
            "Invalid regular expression: /*.ts/: Nothing to repeat"
        ),
        Ok(_) => panic!("invalid filePattern must fail registration"),
    }
}

#[tokio::test]
async fn global_file_pattern_remembers_last_index() {
    let shell = ScriptShell::sequence(vec![
        Ok(output(0, "ok", "")),
        Ok(output(0, "ok", "")),
        Ok(output(0, "ok", "")),
    ]);
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "global".to_string(),
                description: "global".to_string(),
                tools: None,
                file_pattern: Some(r"\.ts$".to_string()),
                file_pattern_flags: Some("g".to_string()),
                command: "echo {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut first = tool_after("file_write", json!({"path": "a.ts"}), false);
    pipeline.run(&mut first).await;
    assert_eq!(shell.calls().len(), 1);
    let mut second = tool_after("file_write", json!({"path": "a.ts"}), false);
    pipeline.run(&mut second).await;
    assert_eq!(shell.calls().len(), 1);
    let mut third = tool_after("file_write", json!({"path": "a.ts"}), false);
    pipeline.run(&mut third).await;
    assert_eq!(shell.calls().len(), 2);
}

#[tokio::test]
async fn sticky_file_pattern_matches_only_at_last_index() {
    let shell = ScriptShell::ok(0, "ok", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "sticky".to_string(),
                description: "sticky".to_string(),
                tools: None,
                file_pattern: Some(r"\.ts$".to_string()),
                file_pattern_flags: Some("y".to_string()),
                command: "echo {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "a.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());
}

#[tokio::test]
async fn action_output_tail_keeps_a_split_surrogate() {
    let stdout = format!("😀{}", "a".repeat(299));
    let shell = ScriptShell::ok(0, &stdout, "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "tail".to_string(),
                description: "tail".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "echo {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "a.ts"}), false);
    pipeline.run(&mut ctx).await;
    let stored = ctx
        .metadata
        .get("auto:tail")
        .and_then(|value| value.get("output"))
        .expect("output");
    let protocol::js::JsValue::String(text) = stored else {
        panic!("output is a string");
    };
    assert_eq!(text.units().len(), 300);
    assert_eq!(text.units()[0], 0xDE00);
    let wire = protocol::js::stringify(&protocol::js::JsValue::String(text.clone()));
    let parsed = protocol::js::parse(&wire).expect("parse");
    assert_eq!(parsed, protocol::js::JsValue::String(text.clone()));
}

#[tokio::test]
async fn hostile_filenames_stay_quoted_and_do_not_execute() {
    let hostile = r#"/src/o's.$(touch dollar).`touch tick`."; touch quote; ".ts"#;
    let quoted = r#"'/src/o'\''s.$(touch dollar).`touch tick`."; touch quote; ".ts'"#;
    let newline = "/tmp/o's.$(touch nl)\n`touch nl2`\n\"; touch quote;\"";
    let newline_quoted = "'/tmp/o'\\''s.$(touch nl)\n`touch nl2`\n\"; touch quote;\"'";

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_format_hook(config(shell.clone())));
    let mut ctx = tool_after("file_write", json!({"path": hostile}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(
        shell.calls()[0].0,
        format!("npx prettier --write {quoted} 2>/dev/null")
    );

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_lint_hook(config(shell.clone())));
    let mut ctx = tool_after("file_edit", json!({"file": hostile}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(
        shell.calls()[0].0,
        format!("npx eslint --fix {quoted} 2>/dev/null")
    );

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_test_hook(config(shell.clone())));
    let mut ctx = tool_after("file_write", json!({"filename": hostile}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(
        shell.calls()[0].0,
        format!("npx vitest run --related {quoted} --reporter=verbose 2>&1 | tail -20")
    );

    let git = "git commit\n$(touch dollar)`touch tick`\"; touch quote; \"o's";
    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_git_check_hook(config(shell.clone())));
    let mut ctx = tool_after("shell", json!({"command": git}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, "npx tsc --noEmit 2>&1 | tail -10");
    assert_eq!(shell.calls().len(), 1);

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "copy".to_string(),
                description: "two substitutions".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "cp {{file}} {{file}}.bak".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "/test.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, "cp '/test.ts' '/test.ts'.bak");

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "dollar".to_string(),
                description: "literal dollar patterns".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "echo {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": "/tmp/$&"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, "echo '/tmp/$&'");

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "quoted".to_string(),
                description: "hostile substitution".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "printf '%s' {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": hostile}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, format!("printf '%s' {quoted}"));

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "newline".to_string(),
                description: "newline substitution".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "printf '%s' {{file}}".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            config(shell.clone()),
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": newline}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, format!("printf '%s' {newline_quoted}"));

    let dir = super::common::make_temp().await;
    let cwd = dir.to_str().expect("temp dir is utf-8");
    prove_inert(&dir, &format!("printf '%s' {quoted}"), hostile).await;
    prove_inert(&dir, &format!("printf '%s' {newline_quoted}"), newline).await;
    let live = Arc::new(ProcessShell::new(&dir));
    let pipeline = HookPipeline::new();
    pipeline.register(
        create_custom_action_hook(
            AutoAction {
                id: "capture".to_string(),
                description: "capture the filename".to_string(),
                tools: None,
                file_pattern: None,
                file_pattern_flags: None,
                command: "printf '%s' {{file}} > got.txt".to_string(),
                timeout_ms: None,
                soft_fail: true,
            },
            AutoActionConfig {
                shell: live.clone() as Arc<dyn ShellExecutor>,
                cwd: Some(cwd.to_string()),
            },
        )
        .expect("hook"),
    );
    let mut ctx = tool_after("file_write", json!({"path": hostile}), false);
    pipeline.run(&mut ctx).await;
    let got = tokio::fs::read_to_string(dir.join("got.txt"))
        .await
        .expect("captured filename");
    assert_eq!(got, hostile);
    for marker in ["dollar", "tick", "quote", "nl", "nl2"] {
        assert!(
            !dir.join(marker).exists(),
            "{marker} was executed from a filename"
        );
    }
}

async fn prove_inert(dir: &Path, command: &str, hostile: &str) {
    let shell = ProcessShell::new(dir);
    let ran = shell
        .exec(command, Some(dir.to_str().expect("utf-8")))
        .await;
    let ran = ran.expect("shell");
    assert_eq!(ran.exit_code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, hostile);
}
