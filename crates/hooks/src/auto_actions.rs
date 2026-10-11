use std::sync::{Arc, Mutex, OnceLock};

use protocol::HookEventName;
use protocol::js::{JsObject, JsValue};
use regress::Regex;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::context::HookContext;
use crate::handler::{HookErrorMode, HookFailure, HookHandler, HookSignal};
use crate::js_text::{js_string, js_truthy};
use crate::pipeline::HookRegistration;
use crate::regex_util::{JsRegExp, compile_static, compile_user_pattern, is_match};
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

pub fn create_custom_action_hook(
    action: AutoAction,
    config: AutoActionConfig,
) -> Result<HookRegistration, AutoActionError> {
    let id = format!("auto:{}", action.id);
    let description = action.description.clone();
    let tools = action.tools.clone();
    let on_error = if action.soft_fail {
        HookErrorMode::Continue
    } else {
        HookErrorMode::Abort
    };
    let flags = action.file_pattern_flags.clone().unwrap_or_default();
    let pattern = match action.file_pattern.clone() {
        Some(source) => Some(Mutex::new(
            compile_user_pattern(&source, &flags).map_err(AutoActionError::new)?,
        )),
        None => None,
    };
    Ok(auto_registration(
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
            let missed = pattern_miss(pattern.as_ref(), selected.as_ref());
            if missed {
                return Box::pin(async { Ok(HookSignal::Continue) });
            }
            let replacement = selected.as_ref().map(js_string).unwrap_or_default();
            let command = substitute_file(&action.command, &replacement);
            let action_id = action.id.clone();
            let soft_fail = action.soft_fail;
            let config = config.clone();
            Box::pin(
                async move { finish_custom(ctx, &action_id, &command, soft_fail, &config).await },
            )
        },
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct AutoActionError {
    pub message: String,
}

impl AutoActionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub fn create_auto_action_hooks(
    config: AutoActionsConfig,
) -> Result<Vec<HookRegistration>, AutoActionError> {
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
        hooks.push(create_custom_action_hook(action, base.clone())?);
    }
    Ok(hooks)
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
    F: for<'a> Fn(
            &'a mut HookContext,
        ) -> crate::handler::BoxFuture<'a, Result<HookSignal, HookFailure>>
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
    let command = format!(
        "npx prettier --write {} 2>/dev/null",
        posix_shell_quote(&file_path)
    );
    match exec_shell(config, &command).await {
        Ok(result) if result.exit_code == 0 => {
            ctx.metadata.insert_json(
                "autoFormat",
                &serde_json::json!({ "file": file_path, "status": "formatted" }),
            );
        }
        Ok(_) => {}
        Err(_) => {
            ctx.metadata.insert_json(
                "autoFormat",
                &serde_json::json!({
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
    let command = format!(
        "npx eslint --fix {} 2>/dev/null",
        posix_shell_quote(&file_path)
    );
    match exec_shell(config, &command).await {
        Ok(result) if result.exit_code == 0 => {
            ctx.metadata.insert_json(
                "autoLint",
                &serde_json::json!({ "file": file_path, "status": "linted" }),
            );
        }
        Ok(result) => {
            ctx.metadata.insert_key(
                "autoLint",
                record([
                    ("file", JsValue::from_text(&file_path)),
                    ("status", JsValue::from_text("issues")),
                    (
                        "output",
                        JsValue::String(protocol::js::slice_units(&result.stderr, 0, Some(500))),
                    ),
                ]),
            );
        }
        Err(_) => {
            ctx.metadata.insert_json(
                "autoLint",
                &serde_json::json!({
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
    if !pattern_matches(source_pattern(), &file_path)
        || pattern_matches(test_file_pattern(), &file_path)
    {
        return Ok(HookSignal::Continue);
    }
    let command = format!(
        "npx vitest run --related {} --reporter=verbose 2>&1 | tail -20",
        posix_shell_quote(&file_path)
    );
    match exec_shell(config, &command).await {
        Ok(result) => {
            let status = if result.exit_code == 0 {
                "passed"
            } else {
                "failed"
            };
            ctx.metadata.insert_key(
                "autoTest",
                record([
                    ("file", JsValue::from_text(&file_path)),
                    ("status", JsValue::from_text(status)),
                    (
                        "output",
                        JsValue::String(protocol::js::slice_units(&result.stdout, -500, None)),
                    ),
                ]),
            );
        }
        Err(_) => {
            ctx.metadata.insert_json(
                "autoTest",
                &serde_json::json!({
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
            let status = if result.exit_code == 0 {
                "passed"
            } else {
                "issues"
            };
            ctx.metadata.insert_key(
                "autoGitCheck",
                record([
                    ("status", JsValue::from_text(status)),
                    (
                        "output",
                        JsValue::String(protocol::js::slice_units(&result.stdout, -300, None)),
                    ),
                ]),
            );
        }
        Err(_) => {
            ctx.metadata.insert_json(
                "autoGitCheck",
                &serde_json::json!({
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
            ctx.metadata.insert_key(
                &key,
                record([
                    ("status", JsValue::from_text(status)),
                    (
                        "output",
                        JsValue::String(protocol::js::slice_units(&result.stdout, -300, None)),
                    ),
                ]),
            );
            Ok(HookSignal::Continue)
        }
        Err(err) => {
            let message = err.message.clone();
            ctx.metadata.insert_json(
                &key,
                &serde_json::json!({
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
        if let Some(value) = args.get(key)
            && !value.is_null()
        {
            return Some(value);
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

fn pattern_miss(pattern: Option<&Mutex<JsRegExp>>, value: Option<&Value>) -> bool {
    let Some(regex) = pattern else {
        return false;
    };
    let Some(value) = value else {
        return false;
    };
    if !js_truthy(value) {
        return false;
    }
    let text = js_string(value);
    let mut state = regex.lock().unwrap_or_else(|err| err.into_inner());
    !state.test(&text)
}

fn record<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert_key(key, value);
    }
    JsValue::Object(object)
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

fn substitute_file(command: &str, path: &str) -> String {
    command.replace("{{file}}", &posix_shell_quote(path))
}

fn posix_shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}
