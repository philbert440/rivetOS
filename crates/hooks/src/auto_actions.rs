use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use protocol::HookEventName;
use protocol::js::{JsObject, JsValue};
use regress::Regex;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::context::HookContext;
use crate::handler::{HookErrorMode, HookFailure, HookHandler, HookSignal};
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
            let replacement = selected
                .as_ref()
                .map(protocol::js::js_to_string_json)
                .unwrap_or_default();
            let command = substitute_file(&action.command);
            let action_id = action.id.clone();
            let soft_fail = action.soft_fail;
            let config = config.clone();
            Box::pin(async move {
                finish_custom(ctx, &action_id, &command, &replacement, soft_fail, &config).await
            })
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
    let command = format!("npx prettier --write \"{FILE_EXPANSION}\" 2>/dev/null");
    match exec_shell(config, &command, Some(&file_path)).await {
        Ok(result) if result.exit_code == 0 => {
            ctx.metadata.insert(
                "autoFormat",
                protocol::js::from_serde(
                    &serde_json::json!({ "file": file_path, "status": "formatted" }),
                ),
            );
        }
        Ok(_) => {}
        Err(_) => {
            ctx.metadata.insert(
                "autoFormat",
                protocol::js::from_serde(&serde_json::json!({
                    "file": file_path,
                    "status": "skipped",
                    "reason": "prettier not available",
                })),
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
    let command = format!("npx eslint --fix \"{FILE_EXPANSION}\" 2>/dev/null");
    match exec_shell(config, &command, Some(&file_path)).await {
        Ok(result) if result.exit_code == 0 => {
            ctx.metadata.insert(
                "autoLint",
                protocol::js::from_serde(
                    &serde_json::json!({ "file": file_path, "status": "linted" }),
                ),
            );
        }
        Ok(result) => {
            ctx.metadata.insert(
                "autoLint",
                record([
                    ("file", JsValue::from_text(&file_path)),
                    ("status", JsValue::from_text("issues")),
                    (
                        "output",
                        JsValue::String(protocol::js::js_slice(
                            &result.stderr,
                            Some(0.0),
                            Some(500.0),
                        )),
                    ),
                ]),
            );
        }
        Err(_) => {
            ctx.metadata.insert(
                "autoLint",
                protocol::js::from_serde(&serde_json::json!({
                    "file": file_path,
                    "status": "skipped",
                    "reason": "eslint not available",
                })),
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
    let command =
        format!("npx vitest run --related \"{FILE_EXPANSION}\" --reporter=verbose 2>&1 | tail -20");
    match exec_shell(config, &command, Some(&file_path)).await {
        Ok(result) => {
            let status = if result.exit_code == 0 {
                "passed"
            } else {
                "failed"
            };
            ctx.metadata.insert(
                "autoTest",
                record([
                    ("file", JsValue::from_text(&file_path)),
                    ("status", JsValue::from_text(status)),
                    (
                        "output",
                        JsValue::String(protocol::js::js_slice(&result.stdout, Some(-500.0), None)),
                    ),
                ]),
            );
        }
        Err(_) => {
            ctx.metadata.insert(
                "autoTest",
                protocol::js::from_serde(&serde_json::json!({
                    "file": file_path,
                    "status": "skipped",
                    "reason": "test runner not available",
                })),
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
    match exec_shell(config, "npx tsc --noEmit 2>&1 | tail -10", None).await {
        Ok(result) => {
            let status = if result.exit_code == 0 {
                "passed"
            } else {
                "issues"
            };
            ctx.metadata.insert(
                "autoGitCheck",
                record([
                    ("status", JsValue::from_text(status)),
                    (
                        "output",
                        JsValue::String(protocol::js::js_slice(&result.stdout, Some(-300.0), None)),
                    ),
                ]),
            );
        }
        Err(_) => {
            ctx.metadata.insert(
                "autoGitCheck",
                protocol::js::from_serde(&serde_json::json!({
                    "status": "skipped",
                    "reason": "tsc not available",
                })),
            );
        }
    }
    Ok(HookSignal::Continue)
}

async fn finish_custom(
    ctx: &mut HookContext,
    action_id: &str,
    command: &str,
    file: &str,
    soft_fail: bool,
    config: &AutoActionConfig,
) -> Result<HookSignal, HookFailure> {
    let key = format!("auto:{action_id}");
    match exec_shell(config, command, Some(file)).await {
        Ok(result) => {
            let status = if result.exit_code == 0 {
                "success"
            } else {
                "failed"
            };
            ctx.metadata.insert(
                key.as_str(),
                record([
                    ("status", JsValue::from_text(status)),
                    (
                        "output",
                        JsValue::String(protocol::js::js_slice(&result.stdout, Some(-300.0), None)),
                    ),
                ]),
            );
            Ok(HookSignal::Continue)
        }
        Err(err) => {
            let message = err.message.clone();
            ctx.metadata.insert(
                key.as_str(),
                protocol::js::from_serde(&serde_json::json!({
                    "status": "error",
                    "message": message,
                })),
            );
            if soft_fail {
                Ok(HookSignal::Continue)
            } else {
                Err(HookFailure::new(err.message))
            }
        }
    }
}

async fn exec_shell(
    config: &AutoActionConfig,
    command: &str,
    file: Option<&str>,
) -> Result<ShellOutput, ShellError> {
    match file {
        Some(path) => {
            config
                .shell
                .exec_with_env(command, config.cwd.as_deref(), &[(FILE_ENV, path)])
                .await
        }
        None => config.shell.exec(command, config.cwd.as_deref()).await,
    }
}

fn truthy_file_path(args: Option<&Map<String, Value>>) -> Option<String> {
    let value = file_value(args)?;
    if protocol::js::js_boolean_json(value) {
        Some(protocol::js::js_to_string_json(value))
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
    if !protocol::js::js_boolean_json(value) {
        return false;
    }
    let text = protocol::js::js_to_string_json(value);
    let mut state = regex.lock();
    !state.test(&text)
}

fn record<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.insert(key, value);
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

const FILE_ENV: &str = "RIVET_FILE";
const FILE_EXPANSION: &str = "${RIVET_FILE}";

#[derive(Clone, Copy, PartialEq, Eq)]
enum ShellQuote {
    None,
    Single,
    Double,
}

fn substitute_file(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let mut rest = command;
    let mut base = 0;
    while let Some(rel) = rest.find("{{file}}") {
        let abs = base + rel;
        out.push_str(&command[base..abs]);
        match quote_at(command, abs) {
            ShellQuote::Single => {
                out.push('\'');
                out.push('"');
                out.push_str(FILE_EXPANSION);
                out.push('"');
                out.push('\'');
            }
            ShellQuote::None | ShellQuote::Double => out.push_str(FILE_EXPANSION),
        }
        base = abs + "{{file}}".len();
        rest = &command[base..];
    }
    out.push_str(&command[base..]);
    out
}

fn quote_at(command: &str, index: usize) -> ShellQuote {
    let bytes = command.as_bytes();
    let mut i = 0;
    let mut state = ShellQuote::None;
    while i < index && i < bytes.len() {
        let ch = bytes[i];
        match state {
            ShellQuote::None => {
                if ch == b'\\' {
                    i = skip_escaped(bytes, i);
                    continue;
                } else if ch == b'\'' {
                    state = ShellQuote::Single;
                } else if ch == b'"' {
                    state = ShellQuote::Double;
                }
                i += 1;
            }
            ShellQuote::Single => {
                if ch == b'\'' {
                    state = ShellQuote::None;
                }
                i += 1;
            }
            ShellQuote::Double => {
                if ch == b'\\' {
                    i = skip_escaped(bytes, i);
                    continue;
                } else if ch == b'"' {
                    state = ShellQuote::None;
                }
                i += 1;
            }
        }
    }
    state
}

fn skip_escaped(bytes: &[u8], slash: usize) -> usize {
    let next = slash + 1;
    if next >= bytes.len() {
        return next;
    }
    next + utf8_width(bytes[next])
}

fn utf8_width(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead < 0xE0 {
        2
    } else if lead < 0xF0 {
        3
    } else {
        4
    }
}

#[cfg(test)]
mod tests {
    use super::{FILE_ENV, FILE_EXPANSION, substitute_file};

    #[test]
    fn file_placeholder_becomes_an_env_expansion() {
        assert_eq!(FILE_EXPANSION, format!("${{{FILE_ENV}}}"));
        assert_eq!(substitute_file("echo {{file}}"), "echo ${RIVET_FILE}");
        assert_eq!(
            substitute_file("echo \"{{file}}\""),
            "echo \"${RIVET_FILE}\""
        );
        assert_eq!(
            substitute_file("echo '{{file}}'"),
            "echo ''\"${RIVET_FILE}\"''"
        );
        assert_eq!(
            substitute_file("cp \"{{file}}\" '{{file}}' {{file}}"),
            "cp \"${RIVET_FILE}\" ''\"${RIVET_FILE}\"'' ${RIVET_FILE}"
        );
        assert_eq!(
            substitute_file("cp {{file}} {{file}}.bak"),
            "cp ${RIVET_FILE} ${RIVET_FILE}.bak"
        );
        assert_eq!(
            substitute_file("cp '{{file}}.bak'"),
            "cp ''\"${RIVET_FILE}\"'.bak'"
        );
        assert_eq!(substitute_file("echo hello"), "echo hello");
        assert_eq!(
            substitute_file("echo \\\"{{file}}"),
            "echo \\\"${RIVET_FILE}"
        );
    }
}
