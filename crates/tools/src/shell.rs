use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::string;
use crate::command::run_shell;
use crate::context::{ToolContext, ToolSurface, resolve_against};
use crate::schema::{schema_of, set_property_description};
use crate::textutil::{append_utf16, js_split_ws, strip_one_quote_pair, truncate_middle};
use crate::{Tool, text, text_js};
use protocol::js::js_trim;

const DEFAULT_BLOCKED: &[&str] = &["rm -rf /", "mkfs", ":(){:|:&};:"];

const READ_SINGLE: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "find",
    "which",
    "whoami",
    "hostname",
    "date",
    "uptime",
    "df",
    "du",
    "free",
    "top",
    "ps",
    "env",
    "printenv",
    "echo",
    "pwd",
    "id",
    "groups",
    "file",
    "stat",
    "readlink",
    "realpath",
    "curl",
    "wget",
    "dig",
    "nslookup",
    "ping",
    "traceroute",
    "tree",
    "less",
    "more",
    "grep",
    "awk",
    "sed",
    "sort",
    "uniq",
    "cut",
    "jq",
    "yq",
];

const READ_MULTI: &[&str] = &[
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git remote",
    "git stash list",
    "git tag",
    "git describe",
    "git rev-parse",
    "npm ls",
    "npm view",
    "npm outdated",
    "npx nx graph",
    "docker ps",
    "docker images",
    "docker logs",
];

const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf *",
    "mkfs",
    ":(){:|:&};:",
    "dd if=",
    "> /dev/sda",
    "chmod -R 777 /",
    "chown -R",
    "shutdown",
    "reboot",
    "init 0",
    "systemctl stop",
    "kill -9 1",
    "pkill -9",
];

const GIT_WARN_PATTERNS: &[&str] = &[
    "git push --force",
    "git push -f",
    "git reset --hard",
    "git clean -fd",
    "git checkout -- .",
    "git stash drop",
    "git branch -D",
];

const AGENT_DESCRIPTION: &str = "Execute a shell command and return the output. Use for: running scripts, checking system status, git operations, file operations.";

const SIDECAR_DESCRIPTION: &str = "Execute a shell command and return the output. Maintains a session working directory across calls (cd persists). Use for: running scripts, checking system status, git operations, file operations. Mirrors the in-process `shell` tool exposed to local agents.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandCategory {
    Read,
    Write,
    Dangerous,
}

impl CommandCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Dangerous => "dangerous",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalLevel {
    Allow,
    Warn,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Approval {
    pub read: ApprovalLevel,
    pub write: ApprovalLevel,
    pub dangerous: ApprovalLevel,
}

impl Default for Approval {
    fn default() -> Self {
        Self {
            read: ApprovalLevel::Allow,
            write: ApprovalLevel::Allow,
            dangerous: ApprovalLevel::Block,
        }
    }
}

impl Approval {
    fn level(self, category: CommandCategory) -> ApprovalLevel {
        match category {
            CommandCategory::Read => self.read,
            CommandCategory::Write => self.write,
            CommandCategory::Dangerous => self.dangerous,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShellConfig {
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub max_output: usize,
    pub blocked: Option<Vec<String>>,
    pub approval: Approval,
    pub surface: ToolSurface,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            cwd: None,
            timeout: Duration::from_millis(60_000),
            max_output: 100_000,
            blocked: None,
            approval: Approval::default(),
            surface: ToolSurface::Agent,
        }
    }
}

pub struct ShellTool {
    surface: ToolSurface,
    timeout: Duration,
    max_output: usize,
    max_buffer: usize,
    blocked: Vec<String>,
    approval: Approval,
    config_cwd: String,
    session_cwd: Mutex<String>,
}

#[derive(JsonSchema)]
struct ShellParams {
    command: String,
    cwd: Option<String>,
}

impl ShellTool {
    pub fn new(config: ShellConfig) -> Self {
        let config_cwd = match &config.cwd {
            Some(path) => path.to_string_lossy().into_owned(),
            None => std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .into_owned(),
        };
        let max_output = config.max_output;
        let max_buffer = max_output.max(2 * 1024 * 1024);
        let blocked = config.blocked.unwrap_or_else(|| {
            DEFAULT_BLOCKED
                .iter()
                .map(|item| (*item).to_string())
                .collect()
        });
        Self {
            surface: config.surface,
            timeout: config.timeout,
            max_output,
            max_buffer,
            blocked,
            approval: config.approval,
            session_cwd: Mutex::new(config_cwd.clone()),
            config_cwd,
        }
    }

    pub fn sidecar(mut config: ShellConfig) -> Self {
        config.surface = ToolSurface::Sidecar;
        Self::new(config)
    }

    pub fn get_session_cwd(&self) -> String {
        self.session_cwd.lock().clone()
    }

    pub fn reset_session_cwd(&self) {
        *self.session_cwd.lock() = self.config_cwd.clone();
    }

    fn set_session_cwd(&self, cwd: String) {
        *self.session_cwd.lock() = cwd;
    }
}

#[async_trait::async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &'static str {
        "shell"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(ShellParams { command, cwd });
        let mut schema = schema_of::<ShellParams>();
        set_property_description(&mut schema, "command", "Shell command to execute");
        let cwd = match self.surface {
            ToolSurface::Agent => "Working directory (optional)",
            ToolSurface::Sidecar => {
                "Working directory override for this single call (does not affect session cwd)"
            }
        };
        set_property_description(&mut schema, "cwd", cwd);
        schema
    }

    async fn execute(
        &self,
        args: Value,
        cancellation: &CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let command = string(&args, "command").unwrap_or("").to_string();
        if js_trim(&command).is_empty() {
            return text("Error: No command provided");
        }
        for blocked in &self.blocked {
            if command.contains(blocked) {
                return text(format!("Error: Command blocked (matches \"{blocked}\")"));
            }
        }
        let category = categorize_command(&command);
        let approval = self.approval.level(category);
        if approval == ApprovalLevel::Block {
            return text(format!(
                "Error: Command blocked (category: {}). This command requires elevated approval.",
                category.as_str()
            ));
        }
        let cwd_override = string(&args, "cwd").map(str::to_string);
        let session = self.get_session_cwd();
        let cwd = cwd_override.clone().unwrap_or(session);
        let mut warnings = Vec::new();
        if approval == ApprovalLevel::Warn {
            warnings.push(format!(
                "⚠️ Warning: This is a {} command. Proceeding anyway.",
                category.as_str()
            ));
        }
        if let Some(warning) = check_git_warnings(&command) {
            warnings.push(warning);
        }
        if let Some(target) = cd_target(&command) {
            let new_cwd = resolve_against(std::path::Path::new(&cwd), &target);
            let displayed = new_cwd.to_string_lossy().into_owned();
            match tokio::fs::metadata(&new_cwd).await {
                Ok(meta) if meta.is_dir() => {
                    self.set_session_cwd(displayed.clone());
                    return text(format!("Changed directory to {displayed}"));
                }
                Ok(_) => return text(format!("Error: {displayed} is not a directory")),
                Err(_) => return text(format!("Error: Directory not found: {displayed}")),
            }
        }
        let output = run_shell(
            &command,
            std::path::Path::new(&cwd),
            self.timeout,
            self.max_buffer,
            cancellation,
        )
        .await;
        if let Some(error) = output.error {
            return text(format_output(&warnings, &format!("Error: {error}")));
        }
        if output.aborted {
            return text("Command aborted");
        }
        let captured = combine_output(&output.stdout, &output.stderr);
        if output.buffer_exceeded {
            if captured.is_empty() {
                return text(format_output(
                    &warnings,
                    "Error: stdout maxBuffer length exceeded",
                ));
            }
            let truncated = truncate_middle(&captured, self.max_output);
            let body = append_utf16(&truncated, "\n[output exceeded buffer]");
            return text_js(format_output_js(&warnings, &body));
        }
        if protocol::js::utf16_len(&captured) > self.max_output {
            let truncated = truncate_middle(&captured, self.max_output);
            return text_js(format_output_js(&warnings, &truncated));
        }
        if let Some(code) = output.code
            && code != 0
        {
            return text(format_output(
                &warnings,
                &format!("{captured}\n[exit code: {code}]"),
            ));
        }
        let body = if captured.is_empty() {
            "(no output)".to_string()
        } else {
            captured
        };
        text(format_output(&warnings, &body))
    }
}

pub fn categorize_command(command: &str) -> CommandCategory {
    let trimmed = js_trim(command);
    for pattern in DANGEROUS_PATTERNS {
        if trimmed.contains(pattern) {
            return CommandCategory::Dangerous;
        }
    }
    let first = js_split_ws(trimmed).first().copied().unwrap_or("");
    if READ_SINGLE.contains(&first) {
        return CommandCategory::Read;
    }
    for read_cmd in READ_MULTI {
        if trimmed.starts_with(read_cmd) {
            return CommandCategory::Read;
        }
    }
    CommandCategory::Write
}

pub fn check_git_warnings(command: &str) -> Option<String> {
    for pattern in GIT_WARN_PATTERNS {
        if command.contains(pattern) {
            return Some(format!(
                "⚠️ Git warning: \"{pattern}\" detected. This can cause data loss."
            ));
        }
    }
    None
}

fn cd_target(command: &str) -> Option<String> {
    let regex = cd_regex()?;
    let matched = regex.find(command)?;
    let raw = command.get(matched.group(1)?)?;
    let trimmed = js_trim(raw);
    let stripped = strip_one_quote_pair(trimmed);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped)
    }
}

fn cd_regex() -> Option<&'static regress::Regex> {
    static RE: OnceLock<Option<regress::Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        regress::Regex::with_flags(r"^\s*cd\s+([^;&|]+?)(?:\s*(?:&&|\|\||;|\||&)|$)", "i").ok()
    })
    .as_ref()
}

fn combine_output(stdout: &str, stderr: &str) -> String {
    let combined = if stderr.is_empty() {
        stdout.to_string()
    } else {
        format!("{stdout}\n[stderr] {stderr}")
    };
    js_trim(&combined).to_string()
}

fn format_output(warnings: &[String], output: &str) -> String {
    if warnings.is_empty() {
        return output.to_string();
    }
    format!("{}\n\n{output}", warnings.join("\n"))
}

fn format_output_js(
    warnings: &[String],
    output: &protocol::js::JsString,
) -> protocol::js::JsString {
    if warnings.is_empty() {
        return output.clone();
    }
    let prefix = format!("{}\n\n", warnings.join("\n"));
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend(output.units());
    protocol::js::JsString::from_units(units)
}
