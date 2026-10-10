use std::sync::Arc;

use super::common::{ScriptShell, tool_after};
use hooks::{
    AutoAction, AutoActionConfig, AutoActionsConfig, HookPipeline, ShellExecutor, ShellOutput,
    create_auto_action_hooks, create_auto_format_hook, create_auto_git_check_hook,
    create_auto_lint_hook, create_auto_test_hook, create_custom_action_hook,
};
use serde_json::json;

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
        "npx prettier --write \"/opt/rivetos/src/index.ts\" 2>/dev/null"
    );
    assert_eq!(shell.calls()[0].1, None);
    assert_eq!(
        ctx.metadata.get("autoFormat"),
        Some(&json!({"file": "/opt/rivetos/src/index.ts", "status": "formatted"}))
    );

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
    assert_eq!(
        ctx.metadata.get("autoFormat"),
        Some(&json!({
            "file": "/src/test.ts",
            "status": "skipped",
            "reason": "prettier not available"
        }))
    );

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
        "npx eslint --fix \"/src/index.ts\" 2>/dev/null"
    );
    assert_eq!(
        ctx.metadata.get("autoLint"),
        Some(&json!({"file": "/src/index.ts", "status": "linted"}))
    );

    let shell = ScriptShell::sequence(vec![Ok(output(1, "", "Missing semicolon"))]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_lint_hook(config(shell)));
    let mut ctx = tool_after("file_write", json!({"path": "/src/index.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata.get("autoLint"),
        Some(&json!({
            "file": "/src/index.ts",
            "status": "issues",
            "output": "Missing semicolon"
        }))
    );

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
        "npx vitest run --related \"/opt/rivetos/packages/core/src/domain/hooks.ts\" --reporter=verbose 2>&1 | tail -20"
    );
    assert_eq!(
        ctx.metadata
            .get("autoTest")
            .and_then(|value| value.get("status")),
        Some(&json!("passed"))
    );

    let shell = ScriptShell::sequence(vec![Ok(output(1, "FAIL: expected true to be false", ""))]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_test_hook(config(shell)));
    let mut ctx = tool_after(
        "file_write",
        json!({"path": "/opt/rivetos/packages/core/src/test.ts"}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata
            .get("autoTest")
            .and_then(|value| value.get("status")),
        Some(&json!("failed"))
    );

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
    assert_eq!(
        ctx.metadata
            .get("autoGitCheck")
            .and_then(|value| value.get("status")),
        Some(&json!("passed"))
    );

    let shell = ScriptShell::sequence(vec![Ok(output(1, "error TS2345", ""))]);
    let pipeline = HookPipeline::new();
    pipeline.register(create_auto_git_check_hook(config(shell)));
    let mut ctx = tool_after(
        "shell",
        json!({"command": "git commit -m \"broken\""}),
        false,
    );
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata
            .get("autoGitCheck")
            .and_then(|value| value.get("status")),
        Some(&json!("issues"))
    );

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
    pipeline.register(create_custom_action_hook(
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
    ));
    let mut ctx = tool_after("file_write", json!({"path": "/test.ts"}), false);
    pipeline.run(&mut ctx).await;
    assert_eq!(shell.calls()[0].0, "echo /test.ts");
    assert_eq!(
        ctx.metadata
            .get("auto:my-action")
            .and_then(|value| value.get("status")),
        Some(&json!("success"))
    );

    let shell = ScriptShell::ok(0, "", "");
    let pipeline = HookPipeline::new();
    pipeline.register(create_custom_action_hook(
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
    ));
    let mut ctx = tool_after("file_write", json!({"path": "/test.md"}), false);
    pipeline.run(&mut ctx).await;
    assert!(shell.calls().is_empty());

    let shell = ScriptShell::fail("boom");
    let pipeline = HookPipeline::new();
    pipeline.register(create_custom_action_hook(
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
    ));
    let mut ctx = tool_after("file_write", json!({"path": "/test.ts"}), false);
    let result = pipeline.run(&mut ctx).await;
    assert!(!result.aborted);
    assert_eq!(
        ctx.metadata.get("auto:soft"),
        Some(&json!({"status": "error", "message": "boom"}))
    );

    let shell = ScriptShell::fail("boom");
    let pipeline = HookPipeline::new();
    pipeline.register(create_custom_action_hook(
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
    ));
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
    assert!(create_auto_action_hooks(base).is_empty());
    let all = create_auto_action_hooks(AutoActionsConfig {
        shell: shell.clone() as Arc<dyn ShellExecutor>,
        cwd: Some("/work".to_string()),
        auto_format: true,
        auto_lint: true,
        auto_test: true,
        auto_git_check: true,
        custom_actions: Vec::new(),
    });
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
    });
    assert_eq!(custom.len(), 2);
    assert_eq!(custom[0].id, "auto:a");
    assert_eq!(custom[1].priority, 70);
}
