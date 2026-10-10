use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::{LlmChunk, LlmChunkType, ThinkingLevel};
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::chunks::{reasoning_chunk, text_chunk};
use crate::error::ProviderError;
use crate::jsonutil::thinking_name;
use crate::types::{BoxFuture, ChatRequest, ChatStream, Provider, StepCapture, TurnMessage, lock};

pub const CLAUDE_DEFAULT_TOOLS: &str =
    "Bash,Read,Edit,Grep,Glob,WebFetch,WebSearch,TodoWrite,Write";
pub const CLAUDE_PROBE_TIMEOUT_MS: u64 = 15_000;
pub const PERMISSION_PROMPT_TIMEOUT_MS: i64 = 60_000;
pub const PERMISSION_PROMPT_TIMEOUT_MAX_MS: i64 = 600_000;
pub const PERMISSION_PROMPT_SERVER: &str = "rivetos";
pub const NO_INSTRUCTION: &str = "(no instruction was provided for this turn)";

const STDOUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CliKind {
    Claude,
    Codex,
    Grok,
    Hermes,
    Kimi,
    Opencode,
    Pi,
    Qwen,
}

pub struct CliProvider {
    kind: CliKind,
    id: String,
    name: String,
    model: Mutex<String>,
    binary: String,
    cwd: Option<String>,
    context: u64,
    max_output: u64,
    permission_mode: String,
    no_plan: bool,
    sandbox: String,
    approve_for_me: bool,
    skip_git: Option<bool>,
    profile: Option<String>,
    effort: Option<String>,
    home: Option<String>,
    tools: String,
    permission_prompts: Option<String>,
    exclude_dynamic: bool,
    setting_sources: Option<String>,
    settings_json: Option<String>,
    strict_mcp: bool,
    allowed_tools: Vec<String>,
    mcp_config: Option<String>,
    json_schema: Option<String>,
    session_warned: AtomicBool,
}

pub enum LooseNumber {
    Missing,
    Empty,
    Text(String),
    Number(f64),
}

pub struct ClaudeArgs {
    pub model_id: String,
    pub tools_arg: String,
    pub effort: String,
    pub permission_mode: String,
    pub permission_prompts: Option<String>,
    pub exclude_dynamic: bool,
    pub system_text: String,
    pub mcp_config_path: Option<String>,
    pub json_schema: Option<String>,
    pub setting_sources: Option<String>,
    pub settings_json: Option<String>,
    pub strict_mcp_config: bool,
    pub allowed_tools: Vec<String>,
}

pub struct CodexArgs {
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub cwd: Option<String>,
    pub sandbox: String,
    pub approve_for_me: bool,
    pub skip_git_repo_check: bool,
    pub profile: Option<String>,
    pub session_id: Option<String>,
}

pub struct GrokArgs {
    pub model_id: Option<String>,
    pub permission_mode: String,
    pub reasoning_effort: Option<String>,
    pub max_turns: Option<u64>,
    pub no_plan: bool,
    pub system_prompt_override: String,
    pub allow: Vec<String>,
    pub tools: Option<String>,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub resume: bool,
}

pub struct HermesArgs {
    pub model_id: Option<String>,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
}

pub struct KimiArgs {
    pub model_id: Option<String>,
    pub session_id: Option<String>,
}

pub struct OpencodeArgs {
    pub model_id: Option<String>,
    pub session_id: Option<String>,
    pub effort: Option<String>,
}

pub struct PiArgs {
    pub model_id: Option<String>,
    pub session_id: Option<String>,
    pub pin_session_id: Option<String>,
    pub session_dir: Option<String>,
    pub append_system_prompt: Option<String>,
}

pub struct QwenArgs {
    pub model_id: Option<String>,
    pub session_id: Option<String>,
    pub pin_session_id: Option<String>,
    pub append_system_prompt: Option<String>,
}

impl CliProvider {
    pub fn claude(binary: impl Into<String>) -> Self {
        Self::open(CliKind::Claude, binary.into(), String::new(), 0, 0)
    }

    pub fn codex(binary: impl Into<String>) -> Self {
        Self::open(CliKind::Codex, binary.into(), "default".to_string(), 0, 0)
    }

    pub fn grok(binary: impl Into<String>) -> Self {
        Self::open(CliKind::Grok, binary.into(), String::new(), 0, 0)
    }

    pub fn hermes(binary: impl Into<String>) -> Self {
        Self::open(
            CliKind::Hermes,
            binary.into(),
            "qwen-27b".to_string(),
            262_144,
            81_920,
        )
    }

    pub fn kimi(binary: impl Into<String>) -> Self {
        Self::open(
            CliKind::Kimi,
            binary.into(),
            "moonshotai/kimi-k3".to_string(),
            256_000,
            8_192,
        )
    }

    pub fn opencode(binary: impl Into<String>) -> Self {
        Self::open(
            CliKind::Opencode,
            binary.into(),
            "zai/glm-5.3-flash".to_string(),
            128_000,
            8_192,
        )
    }

    pub fn pi(binary: impl Into<String>) -> Self {
        Self::open(
            CliKind::Pi,
            binary.into(),
            "deepseek/deepseek-v4-flash".to_string(),
            256_000,
            8_192,
        )
    }

    pub fn qwen(binary: impl Into<String>) -> Self {
        Self::open(CliKind::Qwen, binary.into(), String::new(), 262_144, 8_192)
    }

    fn open(kind: CliKind, binary: String, model: String, context: u64, max_output: u64) -> Self {
        let id = id_of(kind).to_string();
        Self {
            kind,
            name: id.clone(),
            id,
            model: Mutex::new(model),
            binary,
            cwd: None,
            context,
            max_output,
            permission_mode: if kind == CliKind::Grok {
                "dontAsk".to_string()
            } else {
                "default".to_string()
            },
            no_plan: true,
            sandbox: "read-only".to_string(),
            approve_for_me: false,
            skip_git: None,
            profile: None,
            effort: None,
            home: None,
            tools: CLAUDE_DEFAULT_TOOLS.to_string(),
            permission_prompts: None,
            exclude_dynamic: false,
            setting_sources: None,
            settings_json: None,
            strict_mcp: false,
            allowed_tools: Vec::new(),
            mcp_config: None,
            json_schema: None,
            session_warned: AtomicBool::new(false),
        }
    }

    pub fn set_cwd(&mut self, cwd: Option<String>) {
        self.cwd = cwd;
    }

    pub fn set_home(&mut self, home: Option<String>) {
        self.home = home;
    }

    pub fn set_effort(&mut self, effort: Option<String>) {
        self.effort = effort;
    }

    pub fn set_sandbox(&mut self, sandbox: impl Into<String>) {
        self.sandbox = sandbox.into();
    }

    pub fn set_profile(&mut self, profile: Option<String>) {
        self.profile = profile;
    }

    pub fn set_skip_git(&mut self, skip: Option<bool>) {
        self.skip_git = skip;
    }

    pub fn set_permission_mode(&mut self, mode: impl Into<String>) {
        self.permission_mode = mode.into();
    }

    pub fn set_context(&mut self, context: u64, max_output: u64) {
        if context > 0 {
            self.context = context;
        }
        if max_output > 0 {
            self.max_output = max_output;
        }
    }

    pub fn warn_session_map(&self, message: &str) {
        if self.session_warned.swap(true, Ordering::Relaxed) {
            return;
        }
        tracing::warn!(provider = %self.id, error = message, "failed to persist session map");
    }

    pub fn binary(&self) -> &str {
        &self.binary
    }

    fn argv(&self, request: &ChatRequest, prompt: &str) -> Vec<String> {
        let model = request
            .model_override
            .clone()
            .unwrap_or_else(|| self.get_model());
        let model = optional_model(&model);
        match self.kind {
            CliKind::Claude => claude_args(&ClaudeArgs {
                model_id: model.unwrap_or_default(),
                tools_arg: self.tools.clone(),
                effort: self
                    .effort
                    .clone()
                    .unwrap_or_else(|| claude_effort(request.thinking).to_string()),
                permission_mode: self.permission_mode.clone(),
                permission_prompts: self.permission_prompts.clone(),
                exclude_dynamic: self.exclude_dynamic,
                system_text: request.system.clone(),
                mcp_config_path: self.mcp_config.clone(),
                json_schema: self.json_schema.clone(),
                setting_sources: self.setting_sources.clone(),
                settings_json: self.settings_json.clone(),
                strict_mcp_config: self.strict_mcp,
                allowed_tools: self.allowed_tools.clone(),
            }),
            CliKind::Codex => codex_args(&CodexArgs {
                model_id: model,
                reasoning_effort: codex_effort(request.thinking, self.effort.as_deref()),
                cwd: self.cwd.clone(),
                sandbox: self.sandbox.clone(),
                approve_for_me: self.approve_for_me,
                skip_git_repo_check: default_skip_git_repo_check(&self.sandbox, self.skip_git),
                profile: self.profile.clone(),
                session_id: request.session_id.clone(),
            }),
            CliKind::Grok => grok_args(
                &GrokArgs {
                    model_id: model,
                    permission_mode: self.permission_mode.clone(),
                    reasoning_effort: grok_effort(request.thinking),
                    max_turns: None,
                    no_plan: self.no_plan,
                    system_prompt_override: request.system.clone(),
                    allow: Vec::new(),
                    tools: None,
                    cwd: self.cwd.clone(),
                    session_id: request.session_id.clone(),
                    resume: false,
                },
                prompt,
            ),
            CliKind::Hermes => hermes_args(
                &HermesArgs {
                    model_id: model.or_else(|| {
                        let current = self.get_model();
                        if current.is_empty() {
                            None
                        } else {
                            Some(current)
                        }
                    }),
                    cwd: self.cwd.clone(),
                    session_id: request.session_id.clone(),
                },
                prompt,
            ),
            CliKind::Kimi => kimi_args(
                &KimiArgs {
                    model_id: model,
                    session_id: request.session_id.clone(),
                },
                prompt,
            ),
            CliKind::Opencode => opencode_args(
                &OpencodeArgs {
                    model_id: model,
                    session_id: request.session_id.clone(),
                    effort: Some(thinking_name(request.thinking).to_string()),
                },
                prompt,
            ),
            CliKind::Pi => pi_args(
                &PiArgs {
                    model_id: model,
                    session_id: request.session_id.clone(),
                    pin_session_id: None,
                    session_dir: None,
                    append_system_prompt: optional_text(&request.system),
                },
                prompt,
            ),
            CliKind::Qwen => qwen_args(
                &QwenArgs {
                    model_id: model.filter(|value| !value.is_empty()),
                    session_id: request.session_id.clone(),
                    pin_session_id: None,
                    append_system_prompt: optional_text(&request.system),
                },
                prompt,
            ),
        }
    }

    fn child_env(&self) -> Vec<(String, String)> {
        let base: Vec<(String, String)> = std::env::vars().collect();
        let mut env = match self.kind {
            CliKind::Claude => scrub_claude_env(base),
            CliKind::Codex => scrub_codex_env(base),
            CliKind::Grok => scrub_grok_env(base),
            _ => base,
        };
        match self.kind {
            CliKind::Kimi => {
                if let Some(home) = &self.home {
                    env.push(("KIMI_CODE_HOME".to_string(), home.clone()));
                }
            }
            CliKind::Opencode => {
                if let Some(home) = &self.home {
                    env.push(("XDG_DATA_HOME".to_string(), opencode_xdg_data_home(home)));
                }
            }
            CliKind::Qwen => {
                env.push((
                    "QWEN_CODE_SUPPRESS_YOLO_WARNING".to_string(),
                    "1".to_string(),
                ));
            }
            _ => {}
        }
        env
    }

    async fn chat_inner(&self, request: ChatRequest) -> Result<ChatStream, ProviderError> {
        if self.kind == CliKind::Hermes && !Path::new(&self.binary).exists() {
            return Err(ProviderError::new(
                format!("hermes binary not found at {}", self.binary),
                0,
                &self.id,
            ));
        }
        let prompt = last_user(&request);
        let args = self.argv(&request, &prompt);
        let env = self.child_env();
        let stdin = match self.kind {
            CliKind::Claude => Some(claude_stdin(&prompt)),
            CliKind::Codex => Some(codex_prompt(&request.system, &prompt)),
            _ => None,
        };
        let timeout_ms = request.timeout.as_millis() as u64;
        let output = run_child(
            &self.binary,
            &args,
            &env,
            self.cwd.as_deref(),
            stdin.as_deref(),
            timeout_ms,
            &self.id,
        )
        .await?;
        if self.kind == CliKind::Hermes {
            let _ = hermes_session_id(&output.stderr);
        }
        if self.kind == CliKind::Codex && output.code.is_none() {
            self.warn_session_map("child produced no exit status");
        }
        let chunks = chunks_from_output(self.kind, &output.stdout);
        if chunks.is_empty() && output.code != Some(0) {
            let detail = if output.stderr.is_empty() {
                format!("exit {}", output.code.unwrap_or(-1))
            } else {
                output.stderr.chars().take(500).collect::<String>()
            };
            return Err(ProviderError::new(
                format!("{} failed ({detail})", self.id),
                0,
                &self.id,
            ));
        }
        Ok(chunk_stream(chunks))
    }

    async fn available_inner(&self) -> bool {
        if self.kind == CliKind::Hermes && !Path::new(&self.binary).exists() {
            return false;
        }
        let args: Vec<String> = if self.kind == CliKind::Codex {
            vec!["login".to_string(), "status".to_string()]
        } else {
            vec!["--version".to_string()]
        };
        match run_child(
            &self.binary,
            &args,
            &self.child_env(),
            None,
            None,
            CLAUDE_PROBE_TIMEOUT_MS,
            &self.id,
        )
        .await
        {
            Ok(output) => output.code == Some(0),
            Err(err) => {
                tracing::warn!(provider = %self.id, error = %err.message, "cli probe failed");
                false
            }
        }
    }
}

impl Provider for CliProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn get_model(&self) -> String {
        lock(&self.model).clone()
    }

    fn set_model(&self, model: String) {
        *lock(&self.model) = model;
    }

    fn context_window(&self) -> u64 {
        self.context
    }

    fn max_output_tokens(&self) -> u64 {
        self.max_output
    }

    fn stream_chat<'a>(
        &'a self,
        request: ChatRequest,
    ) -> BoxFuture<'a, Result<ChatStream, ProviderError>> {
        Box::pin(self.chat_inner(request))
    }

    fn is_available<'a>(&'a self) -> BoxFuture<'a, bool> {
        Box::pin(self.available_inner())
    }
}

pub fn permission_prompt_tool_id() -> String {
    format!("mcp__{PERMISSION_PROMPT_SERVER}__request_permission")
}

pub fn parse_permission_timeout_ms(raw: LooseNumber) -> i64 {
    match raw {
        LooseNumber::Missing | LooseNumber::Empty | LooseNumber::Text(_) => {
            PERMISSION_PROMPT_TIMEOUT_MS
        }
        LooseNumber::Number(value) => {
            if !value.is_finite() || value.fract() != 0.0 {
                return PERMISSION_PROMPT_TIMEOUT_MS;
            }
            let rounded = value as i64;
            if !(1..=PERMISSION_PROMPT_TIMEOUT_MAX_MS).contains(&rounded) {
                return PERMISSION_PROMPT_TIMEOUT_MS;
            }
            rounded
        }
    }
}

pub fn parse_cli_timeout_ms(raw: LooseNumber) -> u64 {
    match raw {
        LooseNumber::Number(value) if value.is_finite() && value > 0.0 => value.floor() as u64,
        LooseNumber::Text(text) => match text.parse::<f64>() {
            Ok(value) if value.is_finite() && value > 0.0 => value.floor() as u64,
            _ => 0,
        },
        _ => 0,
    }
}

pub fn parse_permission_prompts(raw: Option<&str>) -> Option<&'static str> {
    match raw.map(str::trim) {
        None | Some("") => None,
        Some("ui") => Some("ui"),
        Some("none") => Some("none"),
        Some(_) => None,
    }
}

pub fn claude_args(flags: &ClaudeArgs) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-mode".to_string(),
        flags.permission_mode.clone(),
        "--effort".to_string(),
        flags.effort.clone(),
        "--tools".to_string(),
        flags.tools_arg.clone(),
    ];
    match flags.permission_prompts.as_deref() {
        Some("none") => {
            args.push("--permission-prompts".to_string());
            args.push("none".to_string());
        }
        Some("ui") => {
            args.push("--permission-prompts".to_string());
            args.push("host".to_string());
            args.push("--permission-prompt-tool".to_string());
            args.push(permission_prompt_tool_id());
        }
        _ => {}
    }
    if let Some(sources) = &flags.setting_sources {
        args.push("--setting-sources".to_string());
        args.push(sources.clone());
    }
    if let Some(settings) = &flags.settings_json {
        args.push("--settings".to_string());
        args.push(settings.clone());
    }
    if flags.strict_mcp_config {
        args.push("--strict-mcp-config".to_string());
    }
    if !flags.allowed_tools.is_empty() {
        args.push("--allowedTools".to_string());
        args.extend(flags.allowed_tools.iter().cloned());
    }
    if !flags.model_id.is_empty() {
        args.push("--model".to_string());
        args.push(flags.model_id.clone());
    }
    if flags.exclude_dynamic {
        args.push("--exclude-dynamic-system-prompt-sections".to_string());
    }
    if !flags.system_text.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(flags.system_text.clone());
    }
    if let Some(path) = &flags.mcp_config_path {
        args.push("--mcp-config".to_string());
        args.push(path.clone());
    }
    if let Some(schema) = &flags.json_schema {
        args.push("--json-schema".to_string());
        args.push(schema.clone());
    }
    args.push("--no-session-persistence".to_string());
    args
}

pub fn default_skip_git_repo_check(sandbox: &str, configured: Option<bool>) -> bool {
    configured.unwrap_or(sandbox == "read-only")
}

pub fn codex_args(flags: &CodexArgs) -> Vec<String> {
    let mut args = vec!["exec".to_string()];
    if let Some(session) = &flags.session_id {
        args.push("resume".to_string());
        args.push(session.clone());
    }
    args.push("--json".to_string());
    args.push("-s".to_string());
    args.push(flags.sandbox.clone());
    if flags.approve_for_me {
        args.push("--approve-for-me".to_string());
    }
    if flags.skip_git_repo_check {
        args.push("--skip-git-repo-check".to_string());
    }
    if let Some(cwd) = &flags.cwd {
        args.push("-C".to_string());
        args.push(cwd.clone());
    }
    if let Some(model) = &flags.model_id
        && !model.is_empty()
        && model != "default"
    {
        args.push("-m".to_string());
        args.push(model.clone());
    }
    if let Some(profile) = &flags.profile {
        args.push("-p".to_string());
        args.push(profile.clone());
    }
    if let Some(effort) = &flags.reasoning_effort {
        args.push("-c".to_string());
        args.push(format!("model_reasoning_effort={effort}"));
    }
    args.push("-".to_string());
    args
}

pub fn codex_prompt(system: &str, user: &str) -> String {
    let user = if user.is_empty() {
        "USER:\n(no message)".to_string()
    } else {
        user.to_string()
    };
    if system.is_empty() {
        user
    } else {
        format!("SYSTEM:\n{system}\n\n---\n\n{user}")
    }
}

pub fn parse_codex_line(line: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str).is_some() {
        Some(value)
    } else {
        None
    }
}

pub fn codex_agent_text(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("item.completed") {
        return None;
    }
    let item = value.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("agent_message") {
        return None;
    }
    item.get("text").and_then(Value::as_str).map(str::to_string)
}

pub fn grok_args(flags: &GrokArgs, prompt: &str) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "streaming-messages-json".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-mode".to_string(),
        flags.permission_mode.clone(),
    ];
    if let Some(max_turns) = flags.max_turns {
        args.push("--max-turns".to_string());
        args.push(max_turns.to_string());
    }
    if flags.no_plan {
        args.push("--no-plan".to_string());
    }
    if let Some(model) = &flags.model_id
        && !model.is_empty()
    {
        args.push("-m".to_string());
        args.push(model.clone());
    }
    if let Some(effort) = &flags.reasoning_effort {
        args.push("--reasoning-effort".to_string());
        args.push(effort.clone());
    }
    if !flags.system_prompt_override.is_empty() {
        args.push("--system-prompt-override".to_string());
        args.push(flags.system_prompt_override.clone());
    }
    if let Some(tools) = &flags.tools
        && !tools.is_empty()
    {
        args.push("--tools".to_string());
        args.push(tools.clone());
    }
    for rule in &flags.allow {
        args.push("--allow".to_string());
        args.push(rule.clone());
    }
    if let Some(cwd) = &flags.cwd {
        args.push("--cwd".to_string());
        args.push(cwd.clone());
    }
    if let Some(session) = &flags.session_id {
        if flags.resume {
            args.push("--resume".to_string());
        } else {
            args.push("--session-id".to_string());
        }
        args.push(session.clone());
    }
    args
}

pub fn resolve_grok_binary(home: Option<&str>, override_bin: Option<&str>) -> String {
    if let Some(binary) = override_bin
        && !binary.is_empty()
    {
        return binary.to_string();
    }
    if let Some(home) = home {
        let path = format!("{home}/.grok/bin/grok");
        if Path::new(&path).exists() {
            return path;
        }
    }
    "grok".to_string()
}

pub fn hermes_model_args(model_id: &str) -> Vec<String> {
    if let Some(rest) = model_id.strip_prefix("custom:")
        && let Some((provider, model)) = rest.split_once(':')
        && !provider.is_empty()
        && !model.is_empty()
        && !provider.contains(char::is_whitespace)
    {
        return vec![
            "--provider".to_string(),
            provider.to_string(),
            "-m".to_string(),
            model.to_string(),
        ];
    }
    vec!["-m".to_string(), model_id.to_string()]
}

pub fn hermes_args(flags: &HermesArgs, prompt: &str) -> Vec<String> {
    let prompt = if prompt.is_empty() { "(empty)" } else { prompt };
    let mut args = vec![
        "chat".to_string(),
        "-q".to_string(),
        prompt.to_string(),
        "-Q".to_string(),
        "--yolo".to_string(),
        "--cli".to_string(),
    ];
    if let Some(model) = &flags.model_id
        && !model.is_empty()
    {
        args.extend(hermes_model_args(model));
    }
    if let Some(cwd) = &flags.cwd {
        args.push("--in".to_string());
        args.push(cwd.clone());
    }
    if let Some(session) = &flags.session_id {
        args.push("--resume".to_string());
        args.push(session.clone());
    }
    args
}

pub fn hermes_session_id(stderr: &str) -> Option<String> {
    let start = stderr.find("session_id:")?;
    let rest = stderr[start + "session_id:".len()..].trim_start();
    let id: String = rest.chars().take_while(|ch| !ch.is_whitespace()).collect();
    if id.is_empty() { None } else { Some(id) }
}

pub fn kimi_args(flags: &KimiArgs, prompt: &str) -> Vec<String> {
    let prompt = if prompt.is_empty() {
        NO_INSTRUCTION
    } else {
        prompt
    };
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
    ];
    if let Some(model) = &flags.model_id
        && !model.is_empty()
    {
        args.push("-m".to_string());
        args.push(model.clone());
    }
    if let Some(session) = &flags.session_id {
        args.push("-S".to_string());
        args.push(session.clone());
    }
    args
}

pub fn parse_kimi_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("role").and_then(Value::as_str) == Some("assistant") {
        return value
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
    }
    None
}

pub fn variant_for_effort(effort: Option<&str>) -> Option<&'static str> {
    let key = effort?.trim().to_ascii_lowercase();
    match key.as_str() {
        "" | "medium" | "default" => None,
        "low" | "minimal" => Some("minimal"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("max"),
        _ => None,
    }
}

pub fn opencode_args(flags: &OpencodeArgs, prompt: &str) -> Vec<String> {
    let prompt = if prompt.is_empty() {
        NO_INSTRUCTION
    } else {
        prompt
    };
    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(model) = &flags.model_id
        && !model.is_empty()
    {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    if let Some(variant) = variant_for_effort(flags.effort.as_deref()) {
        args.push("--variant".to_string());
        args.push(variant.to_string());
    }
    if let Some(session) = &flags.session_id {
        args.push("--session".to_string());
        args.push(session.clone());
    }
    args.push(prompt.to_string());
    args
}

pub fn opencode_xdg_data_home(home: &str) -> String {
    if let Some(parent) = home.strip_suffix("/opencode") {
        return parent.to_string();
    }
    if let Some(parent) = home.strip_suffix("\\opencode") {
        return parent.to_string();
    }
    home.to_string()
}

pub fn pi_args(flags: &PiArgs, prompt: &str) -> Vec<String> {
    let prompt = if prompt.is_empty() {
        NO_INSTRUCTION
    } else {
        prompt
    };
    let mut args = vec![
        "--print".to_string(),
        "--mode".to_string(),
        "json".to_string(),
    ];
    if let Some(pin) = &flags.pin_session_id {
        args.push("--session-id".to_string());
        args.push(pin.clone());
    } else if let Some(session) = &flags.session_id {
        args.push("--session".to_string());
        args.push(session.clone());
    }
    if let Some(dir) = &flags.session_dir {
        args.push("--session-dir".to_string());
        args.push(dir.clone());
    }
    if let Some(model) = &flags.model_id
        && !model.is_empty()
    {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    if let Some(system) = &flags.append_system_prompt
        && !system.is_empty()
    {
        args.push("--append-system-prompt".to_string());
        args.push(system.clone());
    }
    args.push("--".to_string());
    args.push(prompt.to_string());
    args
}

pub fn qwen_args(flags: &QwenArgs, prompt: &str) -> Vec<String> {
    let prompt = if prompt.is_empty() {
        NO_INSTRUCTION
    } else {
        prompt
    };
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--approval-mode".to_string(),
        "yolo".to_string(),
    ];
    if let Some(pin) = &flags.pin_session_id {
        args.push("--session-id".to_string());
        args.push(pin.clone());
    } else if let Some(session) = &flags.session_id {
        args.push("--resume".to_string());
        args.push(session.clone());
    }
    if let Some(model) = &flags.model_id
        && !model.is_empty()
    {
        args.push("-m".to_string());
        args.push(model.clone());
    }
    if let Some(system) = &flags.append_system_prompt
        && !system.is_empty()
    {
        args.push("--append-system-prompt".to_string());
        args.push(system.clone());
    }
    args
}

pub fn scrub_claude_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(key, _)| key != "ANTHROPIC_API_KEY" && key != "ANTHROPIC_AUTH_TOKEN")
        .collect()
}

pub fn scrub_codex_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(key, _)| !key.starts_with("OPENAI_"))
        .collect()
}

pub fn scrub_grok_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(key, _)| !key.starts_with("XAI_") && key != "TERM_PROGRAM")
        .collect()
}

fn id_of(kind: CliKind) -> &'static str {
    match kind {
        CliKind::Claude => "claude-cli",
        CliKind::Codex => "codex-cli",
        CliKind::Grok => "grok-cli",
        CliKind::Hermes => "hermes-cli",
        CliKind::Kimi => "kimi-code",
        CliKind::Opencode => "opencode-cli",
        CliKind::Pi => "pi-cli",
        CliKind::Qwen => "qwen-code",
    }
}

fn optional_model(model: &str) -> Option<String> {
    if model.is_empty() {
        None
    } else {
        Some(model.to_string())
    }
}

fn optional_text(text: &str) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn claude_effort(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off | ThinkingLevel::Medium => "medium",
        ThinkingLevel::Low => "low",
        ThinkingLevel::High => "high",
        ThinkingLevel::XHigh => "xhigh",
    }
}

fn codex_effort(level: ThinkingLevel, configured: Option<&str>) -> Option<String> {
    match level {
        ThinkingLevel::Off => configured
            .filter(|value| matches!(*value, "low" | "medium" | "high" | "xhigh"))
            .map(str::to_string),
        other => Some(thinking_name(other).to_string()),
    }
}

fn grok_effort(level: ThinkingLevel) -> Option<String> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Low => Some("low".to_string()),
        ThinkingLevel::Medium => Some("medium".to_string()),
        ThinkingLevel::High | ThinkingLevel::XHigh => Some("high".to_string()),
    }
}

fn last_user(request: &ChatRequest) -> String {
    for message in request.messages.iter().rev() {
        if let TurnMessage::User { text } = message {
            return text.clone();
        }
    }
    String::new()
}

fn claude_stdin(prompt: &str) -> String {
    let mut message = Map::new();
    message.insert("role".to_string(), Value::from("user"));
    message.insert("content".to_string(), Value::from(prompt));
    let mut root = Map::new();
    root.insert("type".to_string(), Value::from("user"));
    root.insert("message".to_string(), Value::Object(message));
    format!("{}\n", Value::Object(root))
}

struct ChildOutput {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

async fn read_limited(
    mut pipe: Option<tokio::process::ChildStdout>,
    limit: usize,
) -> Result<String, String> {
    let Some(pipe) = pipe.as_mut() else {
        return Ok(String::new());
    };
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = pipe
            .read(&mut tmp)
            .await
            .map_err(|_| "read failed".to_string())?;
        if n == 0 {
            break;
        }
        if buf.len() + n > limit {
            return Err("output exceeded buffer".to_string());
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8(buf).map_err(|_| "output was not utf-8".to_string())
}

async fn read_limited_err(
    mut pipe: Option<tokio::process::ChildStderr>,
    limit: usize,
) -> Result<String, String> {
    let Some(pipe) = pipe.as_mut() else {
        return Ok(String::new());
    };
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = pipe
            .read(&mut tmp)
            .await
            .map_err(|_| "read failed".to_string())?;
        if n == 0 {
            break;
        }
        if buf.len() + n > limit {
            return Err("output exceeded buffer".to_string());
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8(buf).map_err(|_| "output was not utf-8".to_string())
}

async fn run_child(
    binary: &str,
    args: &[String],
    env: &[(String, String)],
    cwd: Option<&str>,
    stdin_text: Option<&str>,
    timeout_ms: u64,
    provider_id: &str,
) -> Result<ChildOutput, ProviderError> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(if stdin_text.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|err| {
        ProviderError::new(
            format!("{provider_id} failed to spawn: {err}"),
            0,
            provider_id,
        )
    })?;
    if let Some(text) = stdin_text
        && let Some(mut stdin) = child.stdin.take()
    {
        let _ = stdin.write_all(text.as_bytes()).await;
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let work = async move {
        let out = read_limited(stdout, STDOUT_LIMIT);
        let err = read_limited_err(stderr, STDOUT_LIMIT);
        let (out, err) = tokio::join!(out, err);
        let status = child.wait().await;
        (out, err, status)
    };
    let (out, err, status) = if timeout_ms == 0 {
        work.await
    } else {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), work).await {
            Ok(value) => value,
            Err(_) => {
                return Err(ProviderError::timeout(provider_id, timeout_ms));
            }
        }
    };
    let stdout = out.map_err(|err| ProviderError::new(err, 0, provider_id))?;
    let stderr = err.map_err(|err| ProviderError::new(err, 0, provider_id))?;
    let code = match status {
        Ok(status) => status.code(),
        Err(err) => {
            return Err(ProviderError::new(
                format!("{provider_id} failed to spawn: {err}"),
                0,
                provider_id,
            ));
        }
    };
    Ok(ChildOutput {
        stdout,
        stderr,
        code,
    })
}

fn chunks_from_output(kind: CliKind, stdout: &str) -> Vec<LlmChunk> {
    let mut chunks = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match kind {
            CliKind::Codex => {
                if let Some(value) = parse_codex_line(trimmed)
                    && let Some(text) = codex_agent_text(&value)
                {
                    chunks.push(text_chunk(&text));
                }
            }
            CliKind::Kimi => {
                if let Some(text) = parse_kimi_line(trimmed) {
                    chunks.push(text_chunk(&text));
                }
            }
            CliKind::Hermes => {
                chunks.push(text_chunk(trimmed));
            }
            _ => {
                if let Some(text) = text_from_line(trimmed) {
                    if let Some(reasoning) = text.strip_prefix("reasoning:") {
                        chunks.push(reasoning_chunk(reasoning));
                    } else {
                        chunks.push(text_chunk(&text));
                    }
                }
            }
        }
    }
    if chunks.is_empty() && kind == CliKind::Hermes {
        let trimmed = stdout.trim();
        if !trimmed.is_empty() {
            chunks.push(text_chunk(trimmed));
        }
    }
    chunks
}

fn text_from_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if let Some(text) = value.get("delta").and_then(Value::as_str)
        && !text.is_empty()
    {
        return Some(text.to_string());
    }
    if let Some(event) = value.get("event")
        && let Some(delta) = event.get("delta")
    {
        if let Some(text) = delta.get("text").and_then(Value::as_str)
            && !text.is_empty()
        {
            return Some(text.to_string());
        }
        if let Some(text) = delta.get("thinking").and_then(Value::as_str)
            && !text.is_empty()
        {
            return Some(format!("reasoning:{text}"));
        }
    }
    if let Some(text) = value.get("text").and_then(Value::as_str)
        && !text.is_empty()
    {
        return Some(text.to_string());
    }
    if let Some(result) = value.get("result").and_then(Value::as_str)
        && !result.is_empty()
    {
        return Some(result.to_string());
    }
    None
}

fn chunk_stream(chunks: Vec<LlmChunk>) -> ChatStream {
    let mut capture = StepCapture::default();
    for chunk in &chunks {
        if chunk.r#type == LlmChunkType::Text {
            if let Some(delta) = &chunk.delta {
                capture.text.push_str(delta);
                capture.saw_text = true;
            }
        } else if chunk.r#type == LlmChunkType::Reasoning
            && let Some(delta) = &chunk.delta
        {
            capture.reasoning.push_str(delta);
        }
    }
    let capture = Arc::new(Mutex::new(capture));
    let inner = futures_util::stream::iter(chunks.into_iter().map(Ok));
    ChatStream {
        capture,
        inner: Box::pin(inner),
    }
}
