use std::sync::{Arc, OnceLock};

use protocol::HookEventName;
use regress::Regex;
use serde_json::{Map, Value};

use crate::audit::{AuditWriter, create_audit_hooks};
use crate::context::HookContext;
use crate::handler::{HookErrorMode, HookFailure, HookHandler, HookSignal};
use crate::js_text::js_string;
use crate::pipeline::HookRegistration;
use crate::regex_util::{compile_static, is_match};

pub const BLOCKED_SHELL_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf *",
    "rm -rf .",
    "mkfs",
    ":(){:|:&};:",
    "dd if=/dev/zero",
    "dd if=/dev/random",
    "> /dev/sda",
    "chmod -R 777 /",
    "chmod -R 000 /",
    "shutdown -h",
    "shutdown now",
    "reboot",
    "init 0",
    "init 6",
    "kill -9 1",
    "kill -9 -1",
    "pkill -9",
    "curl | sh",
    "curl | bash",
    "| sh",
    "| bash",
    "| sudo",
];

pub const WARN_SHELL_PATTERNS: &[(&str, &str)] = &[
    (
        "git push --force",
        "Force push can overwrite remote history",
    ),
    ("git push -f", "Force push can overwrite remote history"),
    (
        "git reset --hard",
        "Hard reset discards uncommitted changes",
    ),
    ("git clean -fd", "Clean removes untracked files permanently"),
    ("git checkout -- .", "Discards all local changes"),
    ("git stash drop", "Stash drop is irreversible"),
    ("git branch -D", "Force-deletes branch without merge check"),
    ("docker system prune", "Removes all unused Docker resources"),
    (
        "npm install -g",
        "Global npm install affects system packages",
    ),
    (
        "pip install",
        "Installing Python packages — check for conflicts",
    ),
    ("apt install", "System package install — may require sudo"),
    ("apt remove", "System package removal"),
    (
        "npm publish",
        "Publishing to npm registry — verify package and tag",
    ),
    (
        "npx publish",
        "Publishing to npm registry — verify package and tag",
    ),
];

const DEFAULT_FENCE_TOOLS: &[&str] = &["file_read", "file_write", "file_edit"];
const DEFAULT_ALWAYS_ALLOW: &[&str] = &["/tmp", "/var/tmp"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyAction {
    Block,
    Warn,
}

type SafetyMatch = Arc<dyn Fn(&str, &Map<String, Value>) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct SafetyRule {
    pub id: String,
    pub tools: Option<Vec<String>>,
    pub action: SafetyAction,
    pub description: String,
    matches: SafetyMatch,
}

impl SafetyRule {
    pub fn new(
        id: impl Into<String>,
        action: SafetyAction,
        description: impl Into<String>,
        matches: impl Fn(&str, &Map<String, Value>) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            tools: None,
            action,
            description: description.into(),
            matches: Arc::new(matches),
        }
    }

    pub fn tools<I, S>(mut self, tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.tools = Some(tools.into_iter().map(Into::into).collect());
        self
    }

    pub fn matches(&self, tool_name: &str, args: &Map<String, Value>) -> bool {
        (self.matches)(tool_name, args)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceFenceConfig {
    pub allowed_dirs: Vec<String>,
    pub always_allow: Option<Vec<String>>,
    pub tools: Option<Vec<String>>,
}

impl WorkspaceFenceConfig {
    pub fn new<I, S>(allowed_dirs: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            allowed_dirs: allowed_dirs.into_iter().map(Into::into).collect(),
            always_allow: None,
            tools: None,
        }
    }
}

pub fn home_dir() -> String {
    match std::env::var("HOME") {
        Ok(value) => value,
        Err(_) => "/root".to_string(),
    }
}

pub fn normalize_fence_path(path: &str, home: &str) -> String {
    let resolved = match path.strip_prefix('~') {
        Some(rest) => format!("{home}{rest}"),
        None => path.to_string(),
    };
    let trimmed = resolved.trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.to_string()
    }
}

pub fn create_shell_danger_hook() -> HookRegistration {
    HookRegistration {
        id: "safety:shell-danger".to_string(),
        event: HookEventName::ToolBefore,
        handler: HookHandler::from_sync(shell_danger),
        priority: 10,
        on_error: HookErrorMode::Abort,
        agent_filter: None,
        tool_filter: Some(vec!["shell".to_string()]),
        description: Some("Blocks dangerous shell commands, warns on risky ones".to_string()),
        enabled: true,
    }
}

fn shell_danger(ctx: &mut HookContext) -> Result<HookSignal, HookFailure> {
    let args = ctx.args.as_ref().cloned().unwrap_or_default();
    let command = shell_command_folded(&args);
    if command.is_empty() {
        return Ok(HookSignal::Continue);
    }
    for pattern in BLOCKED_SHELL_PATTERNS {
        if command.contains(&pattern.to_lowercase()) {
            ctx.blocked = Some(true);
            ctx.block_reason = Some(format!(
                "Dangerous command blocked: \"{pattern}\". This command can cause irreversible damage."
            ));
            return Ok(HookSignal::Abort);
        }
    }
    for (pattern, reason) in WARN_SHELL_PATTERNS {
        if command.contains(&pattern.to_lowercase()) {
            push_warning(&mut ctx.metadata, reason)?;
        }
    }
    Ok(HookSignal::Continue)
}

fn shell_command_folded(args: &Map<String, Value>) -> String {
    let raw = match args.get("command") {
        Some(value) if !value.is_null() => js_string(value),
        _ => String::new(),
    };
    protocol::js::js_trim(&raw).to_lowercase()
}

pub fn push_warning(metadata: &mut Map<String, Value>, text: &str) -> Result<(), HookFailure> {
    let warning = Value::String(format!("⚠️ {text}"));
    match metadata.get_mut("warnings") {
        None => {
            metadata.insert("warnings".to_string(), Value::Array(vec![warning]));
            Ok(())
        }
        Some(Value::Array(items)) => {
            items.push(warning);
            Ok(())
        }
        Some(_) => Err(HookFailure::new("warnings is not an array")),
    }
}

pub fn create_workspace_fence_hook(config: WorkspaceFenceConfig) -> HookRegistration {
    let home = home_dir();
    let extras = match &config.always_allow {
        Some(dirs) => dirs.clone(),
        None => DEFAULT_ALWAYS_ALLOW
            .iter()
            .map(|dir| (*dir).to_string())
            .collect(),
    };
    let allowed = config
        .allowed_dirs
        .iter()
        .cloned()
        .chain(extras)
        .map(|dir| normalize_fence_path(&dir, &home))
        .collect::<Vec<_>>();
    let listed = config.allowed_dirs.clone();
    let tools = match &config.tools {
        Some(tools) => tools.clone(),
        None => DEFAULT_FENCE_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
    };
    HookRegistration {
        id: "safety:workspace-fence".to_string(),
        event: HookEventName::ToolBefore,
        handler: HookHandler::from_sync(move |ctx| fence(ctx, &allowed, &listed, &tools)),
        priority: 15,
        on_error: HookErrorMode::Abort,
        agent_filter: None,
        tool_filter: None,
        description: Some("Blocks file operations outside workspace boundaries".to_string()),
        enabled: true,
    }
}

fn fence(
    ctx: &mut HookContext,
    allowed: &[String],
    listed: &[String],
    tools: &[String],
) -> Result<HookSignal, HookFailure> {
    let tool_name = ctx.tool_name.clone().unwrap_or_default();
    if !tools.iter().any(|tool| tool == &tool_name) {
        return Ok(HookSignal::Continue);
    }
    let args = ctx.args.as_ref().cloned().unwrap_or_default();
    let target = fence_target(&args);
    if target.is_empty() {
        return Ok(HookSignal::Continue);
    }
    let normalized = normalize_fence_path(&target, &home_dir());
    let permitted = allowed.iter().any(|dir| normalized.starts_with(dir));
    if !permitted {
        ctx.blocked = Some(true);
        ctx.block_reason = Some(format!(
            "File operation blocked: \"{target}\" is outside the allowed workspace. Allowed: {}",
            listed.join(", ")
        ));
        return Ok(HookSignal::Abort);
    }
    Ok(HookSignal::Continue)
}

fn fence_target(args: &Map<String, Value>) -> String {
    for key in ["path", "file", "cwd"] {
        if let Some(value) = args.get(key)
            && !value.is_null()
        {
            return js_string(value);
        }
    }
    String::new()
}

pub fn rule_npm_dry_run() -> SafetyRule {
    SafetyRule::new(
        "npm-dry-run",
        SafetyAction::Warn,
        "npm publish without --dry-run — proceed with caution",
        |_tool, args| {
            let command = raw_string_field(args, "command");
            command.contains("npm publish") && !command.contains("--dry-run")
        },
    )
    .tools(["shell"])
}

pub fn rule_warn_config_write() -> SafetyRule {
    SafetyRule::new(
        "warn-config-write",
        SafetyAction::Warn,
        "Modifying a config file — double-check the changes",
        |_tool, args| {
            let path = raw_string_field(args, "path");
            config_write_regex().is_some_and(|regex| is_match(regex, &path))
        },
    )
    .tools(["file_write", "file_edit"])
}

pub fn rule_no_delete_git() -> SafetyRule {
    SafetyRule::new(
        "no-delete-git",
        SafetyAction::Block,
        "Deleting .git directories is blocked",
        |_tool, args| {
            let command = raw_string_field(args, "command");
            delete_git_regex().is_some_and(|regex| is_match(regex, &command))
        },
    )
    .tools(["shell"])
}

pub fn boot_custom_rules() -> Vec<SafetyRule> {
    vec![
        rule_npm_dry_run(),
        rule_no_delete_git(),
        rule_warn_config_write(),
    ]
}

fn config_write_regex() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    compile_static(&CELL, r"\.(ya?ml|json|toml|env|ini|conf|cfg)$", "i")
}

fn delete_git_regex() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    compile_static(&CELL, r"rm\s+.*\.git\b", "")
}

fn raw_string_field(args: &Map<String, Value>, key: &str) -> String {
    match args.get(key) {
        Some(value) if !value.is_null() => js_string(value),
        _ => String::new(),
    }
}

pub fn create_custom_rules_hook(rules: Vec<SafetyRule>) -> HookRegistration {
    let description = format!("Custom safety rules ({} rules)", rules.len());
    HookRegistration {
        id: "safety:custom-rules".to_string(),
        event: HookEventName::ToolBefore,
        handler: HookHandler::from_sync(move |ctx| custom_rules(ctx, &rules)),
        priority: 20,
        on_error: HookErrorMode::Continue,
        agent_filter: None,
        tool_filter: None,
        description: Some(description),
        enabled: true,
    }
}

#[derive(Default)]
pub struct SafetyHooksConfig {
    pub shell_danger: Option<bool>,
    pub workspace_fence: Option<WorkspaceFenceConfig>,
    pub audit_writer: Option<Arc<dyn AuditWriter>>,
    pub custom_rules: Option<Vec<SafetyRule>>,
}

pub fn create_safety_hooks(config: SafetyHooksConfig) -> Vec<HookRegistration> {
    let mut hooks = Vec::new();
    if config.shell_danger != Some(false) {
        hooks.push(create_shell_danger_hook());
    }
    if let Some(fence) = config.workspace_fence {
        hooks.push(create_workspace_fence_hook(fence));
    }
    if let Some(writer) = config.audit_writer {
        hooks.extend(create_audit_hooks(writer));
    }
    if let Some(rules) = config.custom_rules.filter(|rules| !rules.is_empty()) {
        hooks.push(create_custom_rules_hook(rules));
    }
    hooks
}

fn custom_rules(ctx: &mut HookContext, rules: &[SafetyRule]) -> Result<HookSignal, HookFailure> {
    let tool_name = ctx.tool_name.clone().unwrap_or_default();
    let args = ctx.args.as_ref().cloned().unwrap_or_default();
    for rule in rules {
        if let Some(tools) = rule.tools.as_ref().filter(|tools| !tools.is_empty())
            && !tools.iter().any(|tool| tool == &tool_name)
        {
            continue;
        }
        if rule.matches(&tool_name, &args) {
            if rule.action == SafetyAction::Block {
                ctx.blocked = Some(true);
                ctx.block_reason = Some(rule.description.clone());
                return Ok(HookSignal::Abort);
            }
            push_warning(&mut ctx.metadata, &rule.description)?;
        }
    }
    Ok(HookSignal::Continue)
}

#[cfg(test)]
mod tests {
    use super::{BLOCKED_SHELL_PATTERNS, WARN_SHELL_PATTERNS, normalize_fence_path};
    use crate::regex_util::{compile_regex, is_match};

    #[test]
    fn pattern_tables_match_the_typescript_lists() {
        assert_eq!(BLOCKED_SHELL_PATTERNS.len(), 24);
        assert_eq!(WARN_SHELL_PATTERNS.len(), 14);
        assert_eq!(BLOCKED_SHELL_PATTERNS[5], ":(){:|:&};:");
        assert_eq!(WARN_SHELL_PATTERNS[0].0, "git push --force");
    }

    #[test]
    fn fence_normalization_is_a_prefix_rule() {
        assert_eq!(normalize_fence_path("~/a/", "/home/u"), "/home/u/a");
        assert_eq!(normalize_fence_path("~foo", "/home/u"), "/home/ufoo");
        assert_eq!(normalize_fence_path("/tmp/", "/root"), "/tmp");
        assert_eq!(normalize_fence_path("/", "/root"), "");
        assert!("/tmp-evil".starts_with(&normalize_fence_path("/tmp", "/root")));
    }

    #[test]
    fn builtin_regular_expressions_match_the_typescript_cases() {
        let config = compile_regex(r"\.(ya?ml|json|toml|env|ini|conf|cfg)$", "i").expect("config");
        assert!(is_match(&config, "/opt/rivetos/config.yaml"));
        assert!(is_match(&config, "FILE.JSON"));
        assert!(is_match(&config, ".env"));
        assert!(!is_match(&config, "file.yaml.bak"));
        let git = compile_regex(r"rm\s+.*\.git\b", "").expect("git");
        assert!(is_match(&git, "rm -rf .git"));
        assert!(!is_match(&git, "rm -rf .github"));
        assert!(is_match(&git, "rm -rf .git/objects"));
    }

    #[test]
    fn boot_rule_order_and_safety_hook_counts() {
        let rules = super::boot_custom_rules();
        assert_eq!(rules[0].id, "npm-dry-run");
        assert_eq!(rules[1].id, "no-delete-git");
        assert_eq!(rules[2].id, "warn-config-write");
        let hooks = super::create_safety_hooks(super::SafetyHooksConfig::default());
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].id, "safety:shell-danger");
        let disabled = super::create_safety_hooks(super::SafetyHooksConfig {
            shell_danger: Some(false),
            ..super::SafetyHooksConfig::default()
        });
        assert!(disabled.is_empty());
        let mut args = serde_json::Map::new();
        args.insert(
            "warnings".to_string(),
            serde_json::Value::String("nope".to_string()),
        );
        assert!(super::push_warning(&mut args, "x").is_err());
    }
}
