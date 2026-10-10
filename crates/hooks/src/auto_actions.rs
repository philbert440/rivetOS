use std::sync::{Arc, OnceLock};

use protocol::HookEventName;
use regress::Regex;
use serde_json::{Map, Value};

use crate::context::HookContext;
use crate::handler::{HookErrorMode, HookFailure, HookHandler, HookSignal};
use crate::js_text::{js_replace_all, js_slice, js_string, js_truthy};
use crate::pipeline::HookRegistration;
use crate::regex_util::{compile_regex, compile_static, is_match};
use crate::shell::{ShellError, ShellExecutor, ShellOutput};

#[derive(Clone)]
pub struct AutoActionConfig {
    pub shell: Arc<dyn ShellExecutor>,
    pub cwd: Option<String>,
}

pub struct AutoAction {
    pub id: String,
    pub description: String,
    pub tools: Option<Vec<String>>,
    pub file_pattern: Option<String>,
    pub file_pattern_flags: Option<String>,
    pub command: String,
    pub timeout_ms: Option<u64>,
    pub soft_fail: bool,
}

pub struct AutoActionsConfig {
    pub shell: Arc<dyn ShellExecutor>,
    pub cwd: Option<String>,
    pub auto_format: bool,
    pub auto_lint: bool,
    pub auto_test: bool,
    pub auto_git_check: bool,
    pub custom_actions: Vec<AutoAction>,
}

pub fn create_auto_format_hook(config: AutoActionConfig) -> HookRegistration {
    auto_registration(
        "auto:format",
        60,
        Some(vec!["file_write".to_string(), "file_edit".to_string()]),
        HookErrorMode::Continue,
        "Auto-formats files after edits using prettier",
        move |ctx| {
            let config = config.clone();
            Box::pin(async move { run_format(ctx, &config).await })
        },
    )
}

pub fn create_auto_lint_hook(config: AutoActionConfig) -> HookRegistration {
    auto_registration(
        "auto:lint",
        61,
        Some(vec!["file_write".to_string(), "file_edit".to_string()]),
        HookErrorMode::Continue,
        "Auto-lints files after edits using eslint --fix",
        move |ctx| {
            let config = config.clone();
            Box::pin(async move { run_lint(ctx, &config).await })
        },
    )
}

pub fn create_auto_test_hook(config: AutoActionConfig) -> HookRegistration {
    auto_registration(
        "auto:test",
        65,
        Some(vec!["file_write".to_string(), "file_edit".to_string()]),
        HookErrorMode::Continue,
        "Runs related tests after source file changes",
        move |ctx| {
            let config = config.clone();
            Box::pin(async move { run_test(ctx, &config).await })
        },
    )
}

pub fn create_auto_git_check_hook(config: AutoActionConfig) -> HookRegistration {
    auto_registration(
        "auto:git-check",
        65,
        Some(vec!["shell".to_string()]),
        HookErrorMode::Continue,
        "Runs type-check after git commits",
        move |ctx| {
            let config = config.clone();
            Box::pin(async move { run_git_check(ctx, &config).await })
        },
    )
}

pub fn create_custom_action_hook(action: AutoAction, config: AutoActionConfig) -> HookRegistration {
    let id = format!("auto:{}", action.id);
    let description = action.description.clone();
    let tools = action.tools.clone();
    let on_error = if action.soft_fail {
        HookErrorMode::Continue
    } else {
        HookErrorMode::Abort
    };
    let pattern = action.file_pattern.as_ref().and_then(|source| {
        compile_regex(
            source,
            action.file_pattern_flags.as_deref().unwrap_or(""),
        )
        .ok()
    });
    auto_registration(
        &id,
        70,
        tools,
        on_error,
        &description,
        move |ctx| {
            if ctx.is_error == Some(true) {
                return Box::pin(async { Ok(HookSignal::Continue) });
            }
            let selected = file_value(ctx.args.as_ref()).cloned();
            if let (Some(regex), Some(value)) = (pattern.as_ref(), selected.as_ref()) {
                if js_truthy(value) && !is_match(regex, &js_string(value)) {
                    return Box::pin(async { Ok(HookSignal::Continue) });
                }
            }
            let replacement = selected.as_ref().map(js_string).unwrap_or_default();
            let command = js_replace_all(&action.command, "{{file}}", &replacement);
            let action_id = action.id.clone();
            let soft_fail = action.soft_fail;
            let config = config.clone();
            Box::pin(async move { finish_custom(ctx, &action_id, &command, soft_fail, &config).await })
        },
    )
}

pub fn create_auto_action_hooks(config: AutoActionsConfig) -> Vec<HookRegistration> {
    let base = AutoActionConfig {
        shell: config.shell,
        cwd: config.cwd,
    };
    let mut hooks = Vec::new();
    if config.auto_format {
        hooks.push(create_auto_format_hook(base.clone()));
    }
    if config.auto_lint {
        hooks.push(create_auto_lint_hook(base.clone()));
    }
    if config.auto_test {
        hooks.push(create_auto_test_hook(base.clone()));
    }
    if config.auto_git_check {
        hooks.push(create_auto_git_check_hook(base.clone()));
    }
    for action in config.custom_actions {
        hooks.push(create_custom_action_hook(action, base.clone()));
    }
    hooks
}

fn auto_registration<F>(
    id: &str,
    priority: i64,
    tool_filter: Option<Vec<String>>,
    on_error: HookErrorMode,
    description: &str,
    function: F,
) -> HookRegistration
where
    F: for<'a> Fn(&'a mut HookContext) -> crate::handler::BoxFuture<'a, Result<HookSignal, HookFailure>>
        + Send
        + Sync
        + 'static,
{
    HookRegistration {
        id: id.to_string(),
        event: HookEventName::ToolAfter,
        handler: HookHandler::from_future(function),
        priority,
        on_error,
        agent_filter: None,
        tool_filter,
        description: Some(description.to_string()),
        enabled: true,
    }
}

async fn run_format(
    ctx: &mut HookContext,
    config: &AutoActionConfig,
) -> Result<HookSignal, HookFailure> {
    if ctx.is_error == Some(true) {
        return Ok(HookSignal::Continue);
    }
    let Some(file_path) = truthy_file_path(ctx.args.as_ref()) else {
        return Ok(HookSignal::Continue);
    };
    if !pattern_matches(format_pattern(), &file_path) {
        return Ok(HookSignal::Continue);
    }
    let command = format!("npx prettier --write \"{file_path}\" 2>/dev/null");
    match exec_shell(config, &command).await {
        Ok(result) if result.exit_code == 0 => {
            ctx.metadata.insert(
                "autoFormat".to_string(),
                serde_json::json!({ "file": file_path, "status": "formatted" }),
            );
        }
        Ok(_) => {}
        Err(_) => {
            ctx.metadata.insert(
                "autoFormat".to_string(),
                serde_json::json!({
                    "file": file_path,
                    "status": "skipped",
                    "reason": "prettier not available",
                }),
            );
        }
    }
    Ok(HookSignal::Continue)
}

async fn run_lint(
    ctx: &mut HookContext,
    config: &AutoActionConfig,
) -> Result<HookSignal, HookFailure> {
    if ctx.is_error == Some(true) {
        return Ok(HookSignal::Continue);
    }
    let Some(file_path) = truthy_file_path(ctx.args.as_ref()) else {
        return Ok(HookSignal::Continue);
    };
    if !pattern_matches(lint_pattern(), &file_path) {
        return Ok(HookSignal::Continue);
    }
    let command = format!("npx eslint --fix \"{file_path}\" 2>/dev/null");
    match exec_shell(config, &command).await {
        Ok(result) if result.exit_code == 0 => {
            ctx.metadata.insert(
                "autoLint".to_string(),
                serde_json::json!({ "file": file_path, "status": "linted" }),
            );
        }
        Ok(result) => {
            ctx.metadata.insert(
                "autoLint".to_string(),
                serde_json::json!({
                    "file": file_path,
                    "status": "issues",
                    "output": js_slice(&result.stderr, 0, Some(500)),
                }),
            );
        }
        Err(_) => {
            ctx.metadata.insert(
                "autoLint".to_string(),
                serde_json::json!({
                    "file": file_path,
                    "status": "skipped",
                    "reason": "eslint not available",
                }),
            );
        }
    }
    Ok(HookSignal::Continue)
}

async fn run_test(
    ctx: &mut HookContext,
    config: &AutoActionConfig,
) -> Result<HookSignal, HookFailure> {
    if ctx.is_error == Some(true) {
        return Ok(HookSignal::Continue);
    }
    let Some(file_path) = truthy_file_path(ctx.args.as_ref()) else {
        return Ok(HookSignal::Continue);
    };
    if !pattern_matches(source_pattern(), &file_path) || pattern_matches(test_file_pattern(), &file_path)
    {
        return Ok(HookSignal::Continue);
    }
    let command = format!(
        "npx vitest run --related \"{file_path}\" --reporter=verbose 2>&1 | tail -20"
    );
    match exec_shell(config, &command).await {
        Ok(result) => {
            let status = if result.exit_code == 0 { "passed" } else { "failed" };
            ctx.metadata.insert(
                "autoTest".to_string(),
                serde_json::json!({
                    "file": file_path,
                    "status": status,
                    "output": js_slice(&result.stdout, -500, None),
                }),
            );
        }
        Err(_) => {
            ctx.metadata.insert(
                "autoTest".to_string(),
                serde_json::json!({
                    "file": file_path,
                    "status": "skipped",
                    "reason": "test runner not available",
                }),
            );
        }
    }
    Ok(HookSignal::Continue)
}

async fn run_git_check(
    ctx: &mut HookContext,
    config: &AutoActionConfig,
) -> Result<HookSignal, HookFailure> {
    if ctx.is_error == Some(true) {
        return Ok(HookSignal::Continue);
    }
    let command_text = string_arg(ctx.args.as_ref(), "command");
    if !command_text.contains("git commit") {
        return Ok(HookSignal::Continue);
    }
    match exec_shell(config, "npx tsc --noEmit 2>&1 | tail -10").await {
        Ok(result) => {
            let status = if result.exit_code == 0 { "passed" } else { "issues" };
            ctx.metadata.insert(
                "autoGitCheck".to_string(),
                serde_json::json!({
                    "status": status,
                    "output": js_slice(&result.stdout, -300, None),
                }),
            );
        }
        Err(_) => {
            ctx.metadata.insert(
                "autoGitCheck".to_string(),
                serde_json::json!({
                    "status": "skipped",
                    "reason": "tsc not available",
                }),
            );
        }
    }
    Ok(HookSignal::Continue)
}

async fn finish_custom(
    ctx: &mut HookContext,
    action_id: &str,
    command: &str,
    soft_fail: bool,
    config: &AutoActionConfig,
) -> Result<HookSignal, HookFailure> {
    let key = format!("auto:{action_id}");
    match exec_shell(config, command).await {
        Ok(result) => {
            let status = if result.exit_code == 0 {
                "success"
            } else {
                "failed"
            };
            ctx.metadata.insert(
                key,
                serde_json::json!({
                    "status": status,
                    "output": js_slice(&result.stdout, -300, None),
                }),
            );
            Ok(HookSignal::Continue)
        }
        Err(err) => {
            let message = err.message.clone();
            ctx.metadata.insert(
                key,
                serde_json::json!({
                    "status": "error",
                    "message": message,
                }),
            );
            if soft_fail {
                Ok(HookSignal::Continue)
            } else {
                Err(HookFailure::new(err.message))
            }
        }
    }
}

async fn exec_shell(config: &AutoActionConfig, command: &str) -> Result<ShellOutput, ShellError> {
    config.shell.exec(command, config.cwd.as_deref()).await
}

fn truthy_file_path(args: Option<&Map<String, Value>>) -> Option<String> {
    let value = file_value(args)?;
    if js_truthy(value) {
        Some(js_string(value))
    } else {
        None
    }
}

fn file_value(args: Option<&Map<String, Value>>) -> Option<&Value> {
    let args = args?;
    for key in ["path", "file", "filename"] {
        if let Some(value) = args.get(key) {
            if !value.is_null() {
                return Some(value);
            }
        }
    }
    None
}

fn string_arg(args: Option<&Map<String, Value>>, key: &str) -> String {
    match args.and_then(|map| map.get(key)) {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn pattern_matches(pattern: Option<&Regex>, text: &str) -> bool {
    pattern.is_some_and(|regex| is_match(regex, text))
}

fn format_pattern() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    compile_static(
        &CELL,
        r"\.(ts|tsx|js|jsx|json|css|scss|md|yaml|yml|html)$",
        "i",
    )
}

fn lint_pattern() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    compile_static(&CELL, r"\.(ts|tsx|js|jsx)$", "i")
}

fn source_pattern() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    compile_static(&CELL, r"/src/.*\.(ts|tsx|js|jsx)$", "i")
}

fn test_file_pattern() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    compile_static(&CELL, r"\.(test|spec)\.(ts|tsx|js|jsx)$", "i")
}
