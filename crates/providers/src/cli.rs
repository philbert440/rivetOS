use std::collections::BTreeMap;
use std::os::unix::io::{AsFd, OwnedFd};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures_util::Stream;
use protocol::{LlmChunk, LlmChunkType, ThinkingLevel};
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use crate::cli_machine::{Family, Machine, clip_utf16_tail};
use crate::error::{ProviderError, now_ms};
use crate::hermes_db::{
    HermesTokenCounts, HermesTokenSnapshot, read_hermes_session_tokens, tokens_for_turn,
    unknown_tokens,
};
use crate::jsonutil::thinking_name;
use crate::session::{
    CODEX_SESSION_MAP, GROK_SESSION_MAP, HERMES_SESSION_MAP, KIMI_SESSION_MAP,
    OPENCODE_SESSION_MAP, PI_SESSION_MAP, QWEN_SESSION_MAP, delete_session_map_key,
    delete_session_map_key_merge, random_uuid_v4, save_session_map, save_session_map_merge,
    session_map_strings, session_not_found, uuid_for_conversation,
};
use crate::types::{BoxFuture, ChatRequest, ChatStream, Provider, TurnMessage, lock};

pub const CLAUDE_DEFAULT_TOOLS: &str =
    "Bash,Read,Edit,Grep,Glob,WebFetch,WebSearch,TodoWrite,Write";
pub const CLAUDE_PROBE_TIMEOUT_MS: u64 = 15_000;
pub const PERMISSION_PROMPT_TIMEOUT_MS: i64 = 60_000;
pub const PERMISSION_PROMPT_TIMEOUT_MAX_MS: i64 = 600_000;
pub const PERMISSION_PROMPT_SERVER: &str = "rivetos";
pub const NO_INSTRUCTION: &str = "(no instruction was provided for this turn)";

const STDOUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct SessionPlan {
    session_id: Option<String>,
    pin_session_id: Option<String>,
    resume: bool,
    conv_key: String,
    map_path: Option<String>,
    resumed: bool,
}

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
    max_turns: Option<u64>,
    allow: Vec<String>,
    grok_tools: Option<String>,
    system_prompt_mode: String,
    session_warned: Arc<AtomicBool>,
    session_map_path: Mutex<Option<String>>,
    hermes_db_path: Mutex<Option<String>>,
    session_replay: Arc<AtomicBool>,
    session_mint: Arc<Mutex<Option<String>>>,
    hermes_turn: Arc<Mutex<HermesTokenCounts>>,
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
            max_turns: None,
            allow: Vec::new(),
            grok_tools: None,
            system_prompt_mode: "prepend".to_string(),
            session_warned: Arc::new(AtomicBool::new(false)),
            session_map_path: Mutex::new(None),
            hermes_db_path: Mutex::new(None),
            session_replay: Arc::new(AtomicBool::new(false)),
            session_mint: Arc::new(Mutex::new(None)),
            hermes_turn: Arc::new(Mutex::new(HermesTokenCounts::default())),
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

    pub fn set_max_turns(&mut self, max_turns: Option<u64>) {
        self.max_turns = max_turns;
    }

    pub fn set_allow(&mut self, allow: Vec<String>) {
        self.allow = allow;
    }

    pub fn set_grok_tools(&mut self, tools: Option<String>) {
        self.grok_tools = tools;
    }

    pub fn set_system_prompt_mode(&mut self, mode: impl Into<String>) {
        self.system_prompt_mode = mode.into();
    }

    pub fn set_no_plan(&mut self, no_plan: bool) {
        self.no_plan = no_plan;
    }

    pub fn set_tools(&mut self, tools: impl Into<String>) {
        self.tools = tools.into();
    }

    pub fn set_permission_prompts(&mut self, mode: Option<String>) {
        self.permission_prompts = mode;
    }

    pub fn set_allowed_tools(&mut self, tools: Vec<String>) {
        self.allowed_tools = tools;
    }

    pub fn set_mcp_config(&mut self, path: Option<String>) {
        self.mcp_config = path;
    }

    pub fn set_exclude_dynamic(&mut self, exclude: bool) {
        self.exclude_dynamic = exclude;
    }

    pub fn set_json_schema(&mut self, schema: Option<String>) {
        self.json_schema = schema;
    }

    pub fn set_setting_sources(&mut self, sources: Option<String>) {
        self.setting_sources = sources;
    }

    pub fn set_settings_json(&mut self, settings: Option<String>) {
        self.settings_json = settings;
    }

    pub fn set_strict_mcp(&mut self, strict: bool) {
        self.strict_mcp = strict;
    }

    pub fn set_context(&mut self, context: u64, max_output: u64) {
        if context > 0 {
            self.context = context;
        }
        if max_output > 0 {
            self.max_output = max_output;
        }
    }

    pub fn set_session_map_path(&self, path: Option<String>) {
        *lock(&self.session_map_path) = path;
    }

    pub fn set_hermes_db_path(&self, path: Option<String>) {
        *lock(&self.hermes_db_path) = path;
    }

    pub fn set_session_replay(&self, replay: bool) {
        self.session_replay.store(replay, Ordering::Relaxed);
    }

    pub fn set_session_mint(&self, mint: Option<String>) {
        *lock(&self.session_mint) = mint;
    }

    pub fn hermes_turn_counts(&self) -> HermesTokenCounts {
        lock(&self.hermes_turn).clone()
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

    fn snap(&self) -> ArgSnap {
        ArgSnap {
            kind: self.kind,
            model: self.get_model(),
            cwd: self.cwd.clone(),
            permission_mode: self.permission_mode.clone(),
            no_plan: self.no_plan,
            sandbox: self.sandbox.clone(),
            approve_for_me: self.approve_for_me,
            skip_git: self.skip_git,
            profile: self.profile.clone(),
            effort: self.effort.clone(),
            tools: self.tools.clone(),
            permission_prompts: self.permission_prompts.clone(),
            exclude_dynamic: self.exclude_dynamic,
            setting_sources: self.setting_sources.clone(),
            settings_json: self.settings_json.clone(),
            strict_mcp: self.strict_mcp,
            allowed_tools: self.allowed_tools.clone(),
            mcp_config: self.mcp_config.clone(),
            json_schema: self.json_schema.clone(),
            max_turns: self.max_turns,
            allow: self.allow.clone(),
            grok_tools: self.grok_tools.clone(),
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
        let user_prompt = last_user(&request);
        let mut plan = self.prepare_session(&request).await;
        let prior = self.prior_tokens(&plan).await;
        let env = self.child_env();
        let snap = self.snap();
        let (grok_full, mut prompt, mut grok_override) = if self.kind == CliKind::Grok {
            let (system, chunks) = grok_chunks(&request);
            let full = compose_grok_prompt(&system, &chunks, &self.system_prompt_mode);
            let active = if plan.resume {
                let newest = newest_user_chunk(&chunks);
                compose_grok_prompt(
                    &system,
                    std::slice::from_ref(&newest),
                    &self.system_prompt_mode,
                )
            } else {
                full.clone()
            };
            (full, active.prompt, active.system_prompt_override)
        } else {
            (
                GrokPrompt {
                    prompt: String::new(),
                    system_prompt_override: String::new(),
                },
                user_prompt.clone(),
                String::new(),
            )
        };
        let kind = self.kind;
        let provider_id = self.id.clone();
        let binary = self.binary.clone();
        let cwd = self.cwd.clone();
        let timeout_ms = u64::try_from(request.timeout.as_millis()).unwrap_or(u64::MAX);
        let hermes_db = self.hermes_db();
        let hermes_turn = Arc::clone(&self.hermes_turn);
        let warned = Arc::clone(&self.session_warned);
        let replay = Arc::clone(&self.session_replay);
        let mint = Arc::clone(&self.session_mint);
        let mut machine = Machine::new(family_of(kind), provider_id.clone());
        let resume_attempt = match kind {
            CliKind::Qwen => plan.resumed,
            CliKind::Grok => plan.resume,
            _ => false,
        };
        if resume_attempt {
            machine.arm_retry(true);
        }
        let args = args_of(&snap, &request, &prompt, &plan, &grok_override);
        let has_stdin = matches!(kind, CliKind::Claude | CliKind::Codex);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (tx, rx) = unbounded_channel();
        let task = tokio::spawn(async move {
            let spawned = spawn_command(
                &binary,
                &args,
                &env,
                cwd.as_deref(),
                has_stdin,
                &provider_id,
            );
            let mut child = match spawned {
                Ok(child) => child,
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                    return;
                }
            };
            let mut guard = arm_watch(&mut child);
            if ready_tx.send(Ok(())).is_err() {
                guard.disarm();
                return;
            }
            loop {
                let stdin_text = match kind {
                    CliKind::Claude => Some(claude_stdin(&user_prompt)),
                    CliKind::Codex => Some(codex_prompt(&request.system, &user_prompt)),
                    _ => None,
                };
                let pumped = supervise(
                    &mut child,
                    &guard,
                    stdin_text.as_deref(),
                    timeout_ms,
                    &provider_id,
                    |line| {
                        let (chunks, fatal) = machine.push_line(line);
                        for chunk in chunks {
                            let _ = tx.send(Ok(chunk));
                        }
                        fatal
                    },
                )
                .await;
                let output = match pumped {
                    Ok(output) => output,
                    Err(err) => {
                        let _ = tx.send(Err(err));
                        return;
                    }
                };
                if let Some(err) = output.fatal {
                    let _ = tx.send(Err(err));
                    return;
                }
                let finish = machine.finish(output.code, &output.stderr, &output.stdout);
                if finish.retry_qwen {
                    machine.mark_retried();
                    machine.arm_retry(false);
                    plan = fresh_qwen_plan(&plan, &mint, &warned, &provider_id).await;
                    let retry_args = args_of(&snap, &request, &prompt, &plan, &grok_override);
                    match spawn_command(
                        &binary,
                        &retry_args,
                        &env,
                        cwd.as_deref(),
                        false,
                        &provider_id,
                    ) {
                        Ok(next) => {
                            child = next;
                            guard = arm_watch(&mut child);
                            continue;
                        }
                        Err(err) => {
                            let _ = tx.send(Err(err));
                            return;
                        }
                    }
                }
                if finish.retry_grok {
                    machine.mark_retried();
                    machine.arm_retry(false);
                    plan.session_id = Some(uuid_for_conversation(&plan.conv_key));
                    plan.resume = false;
                    plan.resumed = false;
                    prompt.clone_from(&grok_full.prompt);
                    grok_override.clone_from(&grok_full.system_prompt_override);
                    let retry_args = args_of(&snap, &request, &prompt, &plan, &grok_override);
                    match spawn_command(
                        &binary,
                        &retry_args,
                        &env,
                        cwd.as_deref(),
                        false,
                        &provider_id,
                    ) {
                        Ok(next) => {
                            child = next;
                            guard = arm_watch(&mut child);
                            continue;
                        }
                        Err(err) => {
                            let _ = tx.send(Err(err));
                            return;
                        }
                    }
                }
                if kind == CliKind::Codex && output.code.is_none() {
                    warn_once(&warned, &provider_id, "child produced no exit status");
                }
                if finish.delete_session {
                    delete_best_effort(&plan).await;
                }
                let grok_failed = kind == CliKind::Grok && finish.error.is_some();
                persist_turn(Persist {
                    kind,
                    provider_id: &provider_id,
                    replay: replay.load(Ordering::Relaxed),
                    plan: &plan,
                    prior: &prior,
                    output: &output,
                    hermes_db: &hermes_db,
                    hermes_turn: &hermes_turn,
                    warned: &warned,
                    learned: finish.session_id.as_deref(),
                    grok_failed,
                })
                .await;
                for chunk in finish.chunks {
                    let _ = tx.send(Ok(chunk));
                }
                if let Some(err) = finish.error {
                    let _ = tx.send(Err(err));
                }
                break;
            }
        });
        match ready_rx.await {
            Ok(Ok(())) => Ok(live_stream(rx, task)),
            Ok(Err(err)) => {
                task.abort();
                Err(err)
            }
            Err(_) => {
                task.abort();
                Err(ProviderError::new(
                    format!("{} failed to spawn", self.id),
                    0,
                    &self.id,
                ))
            }
        }
    }

    fn map_path(&self) -> Option<String> {
        if let Some(path) = lock(&self.session_map_path).clone() {
            return Some(path);
        }
        let file = match self.kind {
            CliKind::Codex => CODEX_SESSION_MAP,
            CliKind::Hermes => HERMES_SESSION_MAP,
            CliKind::Kimi => KIMI_SESSION_MAP,
            CliKind::Opencode => OPENCODE_SESSION_MAP,
            CliKind::Pi => PI_SESSION_MAP,
            CliKind::Qwen => QWEN_SESSION_MAP,
            CliKind::Grok => GROK_SESSION_MAP,
            CliKind::Claude => return None,
        };
        let home = self
            .home
            .clone()
            .or_else(|| std::env::var("HOME").ok())
            .filter(|home| !home.is_empty())?;
        Some(format!("{home}/.rivetos/{file}"))
    }

    fn hermes_db(&self) -> String {
        if let Some(path) = lock(&self.hermes_db_path).clone() {
            return path;
        }
        let base = std::env::var("HERMES_HOME")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|home| format!("{home}/.hermes"))
            })
            .unwrap_or_else(|| ".hermes".to_string());
        format!("{base}/state.db")
    }

    async fn mint_session(&self) -> String {
        if let Some(mint) = lock(&self.session_mint).clone() {
            return mint;
        }
        match tokio::task::spawn_blocking(random_uuid_v4).await {
            Ok(Ok(id)) => id,
            _ => uuid_for_conversation(&now_ms().to_string()),
        }
    }

    async fn load_stored(&self, path: &str, key: &str) -> Option<String> {
        let path = path.to_string();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || session_map_strings(&path).get(&key).cloned())
            .await
            .ok()
            .flatten()
    }

    async fn prepare_session(&self, request: &ChatRequest) -> SessionPlan {
        let conv_key = request
            .conversation_key
            .clone()
            .filter(|key| !key.is_empty())
            .unwrap_or_else(|| "default".to_string());
        let map_path = self.map_path();
        let replay = self.session_replay.load(Ordering::Relaxed);
        let mut plan = SessionPlan {
            session_id: None,
            pin_session_id: None,
            resume: false,
            conv_key: conv_key.clone(),
            map_path: map_path.clone(),
            resumed: false,
        };
        if self.kind == CliKind::Claude {
            return plan;
        }
        let stored = match &map_path {
            Some(path) => self.load_stored(path, &conv_key).await,
            None => None,
        };
        match self.kind {
            CliKind::Codex => {
                if !replay {
                    plan.session_id = stored.or_else(|| request.session_id.clone());
                    plan.resumed = plan.session_id.is_some();
                }
            }
            CliKind::Grok => {
                if replay || map_path.is_none() {
                    if !replay {
                        plan.session_id = request.session_id.clone();
                    }
                } else if let Some(existing) = stored {
                    plan.session_id = Some(existing);
                    plan.resume = true;
                    plan.resumed = true;
                } else {
                    plan.session_id = Some(uuid_for_conversation(&conv_key));
                }
            }
            CliKind::Pi => {
                plan.session_id = stored;
            }
            CliKind::Qwen => {
                if let Some(existing) = stored {
                    plan.session_id = Some(existing);
                    plan.resumed = true;
                } else {
                    let minted = self.mint_session().await;
                    remember_id(self.kind, &plan, &minted, &self.session_warned, &self.id).await;
                    plan.pin_session_id = Some(minted);
                }
            }
            CliKind::Hermes | CliKind::Kimi | CliKind::Opencode => {
                plan.resumed = stored.is_some();
                plan.session_id = stored.or_else(|| request.session_id.clone());
            }
            CliKind::Claude => {}
        }
        plan
    }

    async fn prior_tokens(&self, plan: &SessionPlan) -> HermesTokenSnapshot {
        if self.kind != CliKind::Hermes {
            return unknown_tokens();
        }
        let Some(session_id) = plan.session_id.clone() else {
            return unknown_tokens();
        };
        let path = self.hermes_db();
        tokio::task::spawn_blocking(move || read_hermes_session_tokens(&path, &session_id))
            .await
            .unwrap_or_else(|_| unknown_tokens())
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
        if let TurnMessage::User { text, .. } = message {
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
    fatal: Option<ProviderError>,
}

#[derive(Clone)]
struct ArgSnap {
    kind: CliKind,
    model: String,
    cwd: Option<String>,
    permission_mode: String,
    no_plan: bool,
    sandbox: String,
    approve_for_me: bool,
    skip_git: Option<bool>,
    profile: Option<String>,
    effort: Option<String>,
    tools: String,
    permission_prompts: Option<String>,
    exclude_dynamic: bool,
    setting_sources: Option<String>,
    settings_json: Option<String>,
    strict_mcp: bool,
    allowed_tools: Vec<String>,
    mcp_config: Option<String>,
    json_schema: Option<String>,
    max_turns: Option<u64>,
    allow: Vec<String>,
    grok_tools: Option<String>,
}

fn args_of(
    snap: &ArgSnap,
    request: &ChatRequest,
    prompt: &str,
    plan: &SessionPlan,
    grok_override: &str,
) -> Vec<String> {
    let chosen = request
        .model_override
        .clone()
        .unwrap_or_else(|| snap.model.clone());
    let model = optional_model(&chosen);
    match snap.kind {
        CliKind::Claude => claude_args(&ClaudeArgs {
            model_id: model.unwrap_or_default(),
            tools_arg: snap.tools.clone(),
            effort: snap
                .effort
                .clone()
                .unwrap_or_else(|| claude_effort(request.thinking).to_string()),
            permission_mode: snap.permission_mode.clone(),
            permission_prompts: snap.permission_prompts.clone(),
            exclude_dynamic: snap.exclude_dynamic,
            system_text: request.system.clone(),
            mcp_config_path: snap.mcp_config.clone(),
            json_schema: snap.json_schema.clone(),
            setting_sources: snap.setting_sources.clone(),
            settings_json: snap.settings_json.clone(),
            strict_mcp_config: snap.strict_mcp,
            allowed_tools: snap.allowed_tools.clone(),
        }),
        CliKind::Codex => codex_args(&CodexArgs {
            model_id: model,
            reasoning_effort: codex_effort(request.thinking, snap.effort.as_deref()),
            cwd: snap.cwd.clone(),
            sandbox: snap.sandbox.clone(),
            approve_for_me: snap.approve_for_me,
            skip_git_repo_check: default_skip_git_repo_check(&snap.sandbox, snap.skip_git),
            profile: snap.profile.clone(),
            session_id: plan.session_id.clone(),
        }),
        CliKind::Grok => grok_args(
            &GrokArgs {
                model_id: model,
                permission_mode: snap.permission_mode.clone(),
                reasoning_effort: grok_effort(request.thinking),
                max_turns: snap.max_turns,
                no_plan: snap.no_plan,
                system_prompt_override: grok_override.to_string(),
                allow: snap.allow.clone(),
                tools: snap.grok_tools.clone(),
                cwd: snap.cwd.clone(),
                session_id: plan.session_id.clone(),
                resume: plan.resume,
            },
            prompt,
        ),
        CliKind::Hermes => hermes_args(
            &HermesArgs {
                model_id: model.or_else(|| optional_model(&snap.model)),
                cwd: snap.cwd.clone(),
                session_id: plan.session_id.clone(),
            },
            prompt,
        ),
        CliKind::Kimi => kimi_args(
            &KimiArgs {
                model_id: model,
                session_id: plan.session_id.clone(),
            },
            prompt,
        ),
        CliKind::Opencode => opencode_args(
            &OpencodeArgs {
                model_id: model,
                session_id: plan.session_id.clone(),
                effort: Some(thinking_name(request.thinking).to_string()),
            },
            prompt,
        ),
        CliKind::Pi => pi_args(
            &PiArgs {
                model_id: model,
                session_id: plan.session_id.clone(),
                pin_session_id: plan.pin_session_id.clone(),
                session_dir: None,
                append_system_prompt: optional_text(&request.system),
            },
            prompt,
        ),
        CliKind::Qwen => qwen_args(
            &QwenArgs {
                model_id: model.filter(|value| !value.is_empty()),
                session_id: plan.session_id.clone(),
                pin_session_id: plan.pin_session_id.clone(),
                append_system_prompt: optional_text(&request.system),
            },
            prompt,
        ),
    }
}

fn family_of(kind: CliKind) -> Family {
    match kind {
        CliKind::Claude => Family::Claude,
        CliKind::Codex => Family::Codex,
        CliKind::Grok => Family::Grok,
        CliKind::Hermes => Family::Hermes,
        CliKind::Kimi => Family::Kimi,
        CliKind::Opencode => Family::Opencode,
        CliKind::Pi => Family::Pi,
        CliKind::Qwen => Family::Qwen,
    }
}

#[derive(Clone)]
struct GrokPrompt {
    prompt: String,
    system_prompt_override: String,
}

const MAX_PROMPT_BYTES: usize = 100_000;
const TRUNCATION_NOTE: &str = "[… earlier conversation trimmed to fit the CLI argument limit …]";
const PROMPT_SEP: &str = "\n\n---\n\n";

fn grok_chunks(request: &ChatRequest) -> (String, Vec<String>) {
    let mut system = Vec::new();
    if !request.system.is_empty() {
        system.push(request.system.clone());
    }
    let mut chunks = Vec::new();
    for message in &request.messages {
        match message {
            TurnMessage::System { text } => {
                if !text.is_empty() {
                    system.push(text.clone());
                }
            }
            TurnMessage::User { text, .. } => {
                if !text.is_empty() {
                    chunks.push(format!("USER:\n{text}"));
                }
            }
            TurnMessage::Assistant {
                text, tool_calls, ..
            } => {
                if !text.is_empty() {
                    chunks.push(format!("ASSISTANT:\n{text}"));
                }
                if !tool_calls.is_empty() {
                    let calls = tool_calls
                        .iter()
                        .map(|tool| format!("  - {}({})", tool.name, tool.arguments_json))
                        .collect::<Vec<_>>()
                        .join("\n");
                    chunks.push(format!("ASSISTANT TOOL CALLS:\n{calls}"));
                }
            }
            TurnMessage::ToolResult { name, content, .. } => {
                chunks.push(format!("TOOL RESULT ({name}):\n{content}"));
            }
        }
    }
    (system.join("\n\n"), chunks)
}

fn newest_user_chunk(chunks: &[String]) -> String {
    for chunk in chunks.iter().rev() {
        if chunk.starts_with("USER:") {
            return chunk.clone();
        }
    }
    "USER:\n(no message)".to_string()
}

fn compose_grok_prompt(system: &str, chunks: &[String], mode: &str) -> GrokPrompt {
    let head = if mode == "prepend" && !system.is_empty() {
        format!("SYSTEM:\n{system}{PROMPT_SEP}")
    } else {
        String::new()
    };
    let system_prompt_override = if mode == "override" {
        system.to_string()
    } else {
        String::new()
    };
    let mut kept = chunks.to_vec();
    let mut prompt = build_grok_prompt(&head, &kept, false);
    while prompt.len() > MAX_PROMPT_BYTES && kept.len() > 1 {
        kept.remove(0);
        prompt = build_grok_prompt(&head, &kept, true);
    }
    if prompt.len() > MAX_PROMPT_BYTES && kept.len() == 1 {
        let extra = format!("{head}{TRUNCATION_NOTE}{PROMPT_SEP}");
        let keep = MAX_PROMPT_BYTES.saturating_sub(extra.len());
        let last = clip_utf16_tail(&kept[0], keep);
        prompt = format!("{head}{TRUNCATION_NOTE}{PROMPT_SEP}{last}");
    }
    GrokPrompt {
        prompt,
        system_prompt_override,
    }
}

fn build_grok_prompt(head: &str, chunks: &[String], trimmed: bool) -> String {
    let body = if chunks.is_empty() {
        "USER:\n(no message)".to_string()
    } else if trimmed {
        format!("{TRUNCATION_NOTE}{PROMPT_SEP}{}", chunks.join(PROMPT_SEP))
    } else {
        chunks.join(PROMPT_SEP)
    };
    format!("{head}{body}")
}

fn warn_once(warned: &AtomicBool, provider_id: &str, message: &str) {
    if warned.swap(true, Ordering::Relaxed) {
        return;
    }
    tracing::warn!(provider = %provider_id, error = message, "failed to persist session map");
}

async fn mint_id(mint: &Mutex<Option<String>>) -> String {
    if let Some(minted) = lock(mint).clone() {
        return minted;
    }
    match tokio::task::spawn_blocking(random_uuid_v4).await {
        Ok(Ok(id)) => id,
        _ => uuid_for_conversation(&now_ms().to_string()),
    }
}

async fn remember_id(
    kind: CliKind,
    plan: &SessionPlan,
    id: &str,
    warned: &AtomicBool,
    provider_id: &str,
) {
    let Some(path) = plan.map_path.clone() else {
        return;
    };
    let key = plan.conv_key.clone();
    let id = id.to_string();
    let codex = kind == CliKind::Codex;
    let saved = tokio::task::spawn_blocking(move || {
        if codex {
            let mut changes = BTreeMap::new();
            changes.insert(key, id);
            save_session_map_merge(&path, &changes)
        } else {
            let mut map = session_map_strings(&path);
            map.insert(key, id);
            save_session_map(&path, &map);
            Ok(())
        }
    })
    .await;
    if codex && let Ok(Err(err)) = saved {
        warn_once(warned, provider_id, &err);
    }
}

async fn fresh_qwen_plan(
    plan: &SessionPlan,
    mint: &Mutex<Option<String>>,
    warned: &AtomicBool,
    provider_id: &str,
) -> SessionPlan {
    if let Some(path) = plan.map_path.clone() {
        let key = plan.conv_key.clone();
        let _ = tokio::task::spawn_blocking(move || delete_session_map_key(&path, &key)).await;
    }
    let minted = mint_id(mint).await;
    let mut next = plan.clone();
    next.session_id = None;
    next.pin_session_id = Some(minted.clone());
    next.resumed = false;
    next.resume = false;
    remember_id(CliKind::Qwen, &next, &minted, warned, provider_id).await;
    next
}

struct Persist<'a> {
    kind: CliKind,
    provider_id: &'a str,
    replay: bool,
    plan: &'a SessionPlan,
    prior: &'a crate::hermes_db::HermesTokenSnapshot,
    output: &'a ChildOutput,
    hermes_db: &'a str,
    hermes_turn: &'a Mutex<crate::hermes_db::HermesTokenCounts>,
    warned: &'a AtomicBool,
    learned: Option<&'a str>,
    grok_failed: bool,
}

async fn persist_turn(ctx: Persist<'_>) {
    let Persist {
        kind,
        provider_id,
        replay,
        plan,
        prior,
        output,
        hermes_db,
        hermes_turn,
        warned,
        learned,
        grok_failed,
    } = ctx;
    match kind {
        CliKind::Codex => {
            if replay {
                return;
            }
            if let Some(id) = codex_thread_id(&output.stdout) {
                remember_id(kind, plan, &id, warned, provider_id).await;
            } else if plan.session_id.is_some() && output.code != Some(0) {
                delete_codex_key(plan, warned, provider_id).await;
            }
        }
        CliKind::Hermes => {
            let found = hermes_session_id(&output.stderr);
            if let Some(id) = found.clone()
                && plan.session_id.as_ref() != Some(&id)
            {
                remember_id(kind, plan, &id, warned, provider_id).await;
            }
            let after_id = found.or_else(|| plan.session_id.clone());
            let Some(after_id) = after_id else {
                return;
            };
            let resumed = plan.session_id.as_deref() == Some(after_id.as_str());
            let path = hermes_db.to_string();
            let after =
                tokio::task::spawn_blocking(move || read_hermes_session_tokens(&path, &after_id))
                    .await
                    .unwrap_or_else(|_| unknown_tokens());
            *lock(hermes_turn) = tokens_for_turn(resumed, prior, &after);
        }
        CliKind::Kimi => {
            if let Some(id) =
                kimi_resume_hint(&output.stdout).or_else(|| learned.map(str::to_string))
                && plan.session_id.as_ref() != Some(&id)
            {
                remember_id(kind, plan, &id, warned, provider_id).await;
            }
        }
        CliKind::Pi => {
            if let Some(id) = pi_session_id(&output.stdout).or_else(|| learned.map(str::to_string))
            {
                remember_id(kind, plan, &id, warned, provider_id).await;
            }
        }
        CliKind::Opencode => {
            let learned_line =
                opencode_session_id(&output.stdout).or_else(|| learned.map(str::to_string));
            let tail = output
                .stdout
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("");
            if plan.session_id.is_some()
                && (session_not_found(&output.stderr) || session_not_found(tail))
            {
                delete_best_effort(plan).await;
            } else if let Some(id) = learned_line {
                remember_id(kind, plan, &id, warned, provider_id).await;
            }
        }
        CliKind::Grok => {
            if replay || grok_failed {
                return;
            }
            let keep = learned
                .map(str::to_string)
                .or_else(|| grok_session_id(&output.stdout))
                .or_else(|| plan.session_id.clone());
            if let Some(id) = keep {
                remember_id(kind, plan, &id, warned, provider_id).await;
            }
        }
        CliKind::Claude | CliKind::Qwen => {}
    }
}

async fn delete_codex_key(plan: &SessionPlan, warned: &AtomicBool, provider_id: &str) {
    let Some(path) = plan.map_path.clone() else {
        return;
    };
    let key = plan.conv_key.clone();
    let deleted =
        tokio::task::spawn_blocking(move || delete_session_map_key_merge(&path, &key)).await;
    if let Ok(Err(err)) = deleted {
        warn_once(warned, provider_id, &err);
    }
}

async fn delete_best_effort(plan: &SessionPlan) {
    let Some(path) = plan.map_path.clone() else {
        return;
    };
    let key = plan.conv_key.clone();
    let _ = tokio::task::spawn_blocking(move || delete_session_map_key(&path, &key)).await;
}

fn spawn_command(
    binary: &str,
    args: &[String],
    env: &[(String, String)],
    cwd: Option<&str>,
    stdin: bool,
    provider_id: &str,
) -> Result<Child, ProviderError> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .kill_on_drop(false)
        .process_group(0)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(if stdin {
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
    command.spawn().map_err(|err| {
        ProviderError::new(
            format!("{provider_id} failed to spawn: {err}"),
            0,
            provider_id,
        )
    })
}

fn arm_watch(child: &mut Child) -> ChildWatch {
    let stdout = child.stdout.as_ref().and_then(dup_owned);
    let stderr = child.stderr.as_ref().and_then(dup_owned);
    ChildWatch::arm(child.id(), stdout, stderr)
}

struct LiveBody {
    rx: UnboundedReceiver<Result<LlmChunk, ProviderError>>,
    task: Option<tokio::task::JoinHandle<()>>,
    capture: Arc<Mutex<crate::types::StepCapture>>,
}

impl Drop for LiveBody {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Stream for LiveBody {
    type Item = Result<LlmChunk, ProviderError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let body = self.get_mut();
        match Pin::new(&mut body.rx).poll_recv(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                note_capture(&body.capture, &chunk);
                Poll::Ready(Some(Ok(chunk)))
            }
            other => other,
        }
    }
}

fn note_capture(capture: &Mutex<crate::types::StepCapture>, chunk: &LlmChunk) {
    let mut cap = lock(capture);
    match chunk.r#type {
        LlmChunkType::Text => {
            if let Some(delta) = &chunk.delta {
                cap.text.push_str(delta);
                cap.saw_text = true;
            }
        }
        LlmChunkType::Reasoning => {
            if let Some(delta) = &chunk.delta {
                cap.reasoning.push_str(delta);
            }
        }
        LlmChunkType::Done => {
            if let Some(usage) = &chunk.usage {
                cap.prompt_tokens = usage.prompt_tokens.as_u64().unwrap_or(0);
                cap.completion_tokens = usage.completion_tokens.as_u64().unwrap_or(0);
            }
        }
        _ => {}
    }
}

fn live_stream(
    rx: UnboundedReceiver<Result<LlmChunk, ProviderError>>,
    task: tokio::task::JoinHandle<()>,
) -> ChatStream {
    let capture = Arc::new(Mutex::new(crate::types::StepCapture::default()));
    let inner = LiveBody {
        rx,
        task: Some(task),
        capture: Arc::clone(&capture),
    };
    ChatStream {
        capture,
        inner: Box::pin(inner),
    }
}

async fn supervise<F>(
    child: &mut Child,
    guard: &ChildWatch,
    stdin_text: Option<&str>,
    timeout_ms: u64,
    provider_id: &str,
    mut on_line: F,
) -> Result<ChildOutput, ProviderError>
where
    F: FnMut(&str) -> Option<ProviderError>,
{
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut stdin = child.stdin.take();
    let stdin_bytes = stdin_text.unwrap_or("").as_bytes().to_vec();
    let mut stdin_off = 0usize;
    let mut stdin_done = stdin.is_none() || stdin_bytes.is_empty();
    if stdin_done {
        drop(stdin.take());
    }
    let mut out_done = stdout.is_none();
    let mut err_done = stderr.is_none();
    let mut out_tmp = [0u8; 4096];
    let mut err_tmp = [0u8; 4096];
    let mut pending = Vec::new();
    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut waited = false;
    let mut code = None;
    let mut timed_out = false;
    let mut capped = false;
    let mut fatal = None;
    let mut wait_err: Option<std::io::Error> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let read_out = async {
            match stdout.as_mut() {
                Some(pipe) if !out_done => pipe.read(&mut out_tmp).await,
                _ => std::future::pending().await,
            }
        };
        let read_err = async {
            match stderr.as_mut() {
                Some(pipe) if !err_done => pipe.read(&mut err_tmp).await,
                _ => std::future::pending().await,
            }
        };
        let write_in = async {
            match stdin.as_mut() {
                Some(pipe) if !stdin_done => pipe.write(&stdin_bytes[stdin_off..]).await,
                _ => std::future::pending().await,
            }
        };
        tokio::pin!(read_out);
        tokio::pin!(read_err);
        tokio::pin!(write_in);
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline), if timeout_ms > 0 && !timed_out => {
                timed_out = true;
            }
            wrote = &mut write_in, if !stdin_done => {
                match wrote {
                    Ok(0) => {
                        stdin_done = true;
                        drop(stdin.take());
                    }
                    Ok(count) => {
                        stdin_off += count;
                        if stdin_off >= stdin_bytes.len() {
                            stdin_done = true;
                            drop(stdin.take());
                        }
                    }
                    Err(_) => {
                        stdin_done = true;
                        drop(stdin.take());
                    }
                }
            }
            read = &mut read_out, if !out_done => {
                match read {
                    Ok(0) | Err(_) => out_done = true,
                    Ok(count) => {
                        if stdout_text.len() + count > STDOUT_LIMIT {
                            capped = true;
                        } else {
                            pending.extend_from_slice(&out_tmp[..count]);
                            stdout_text.push_str(&String::from_utf8_lossy(&out_tmp[..count]));
                            fatal = drain_lines(&mut pending, &mut on_line).or(fatal);
                        }
                    }
                }
            }
            read = &mut read_err, if !err_done => {
                match read {
                    Ok(0) | Err(_) => err_done = true,
                    Ok(count) => {
                        if stderr_text.len() + count > STDOUT_LIMIT {
                            capped = true;
                        } else {
                            stderr_text.push_str(&String::from_utf8_lossy(&err_tmp[..count]));
                            if stderr_text.len() > 64_000 {
                                stderr_text = clip_utf16_tail(&stderr_text, 32_000);
                            }
                        }
                    }
                }
            }
            status = child.wait(), if !waited => {
                waited = true;
                match status {
                    Ok(status) => code = status.code(),
                    Err(err) => wait_err = Some(err),
                }
            }
        }
        if timed_out || capped || fatal.is_some() || wait_err.is_some() {
            break;
        }
        if out_done && err_done && stdin_done && waited {
            break;
        }
    }
    if out_done && fatal.is_none() && !capped && !timed_out {
        fatal = drain_lines(&mut pending, &mut on_line).or(fatal);
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).into_owned();
            pending.clear();
            let trimmed = tail.trim();
            if !trimmed.is_empty() {
                fatal = on_line(trimmed).or(fatal);
            }
        }
    }
    if timed_out {
        terminate_child(child).await;
        guard.disarm();
        return Err(ProviderError::timeout(provider_id, timeout_ms));
    }
    if capped {
        terminate_child(child).await;
        guard.disarm();
        return Err(ProviderError::new(
            "output exceeded buffer".to_string(),
            0,
            provider_id,
        ));
    }
    if let Some(err) = wait_err {
        terminate_child(child).await;
        guard.disarm();
        return Err(ProviderError::new(
            format!("{provider_id} failed to spawn: {err}"),
            0,
            provider_id,
        ));
    }
    if fatal.is_some() {
        terminate_child(child).await;
    }
    guard.disarm();
    Ok(ChildOutput {
        stdout: stdout_text,
        stderr: stderr_text,
        code,
        fatal,
    })
}

fn drain_lines<F>(pending: &mut Vec<u8>, on_line: &mut F) -> Option<ProviderError>
where
    F: FnMut(&str) -> Option<ProviderError>,
{
    let mut fatal = None;
    while let Some(pos) = pending.iter().position(|byte| *byte == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)]);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(err) = on_line(trimmed) {
            fatal = Some(err);
            break;
        }
    }
    fatal
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
    let mut child = spawn_command(binary, args, env, cwd, stdin_text.is_some(), provider_id)?;
    let guard = arm_watch(&mut child);
    supervise(
        &mut child,
        &guard,
        stdin_text,
        timeout_ms,
        provider_id,
        |_| None,
    )
    .await
}

const KILL_GRACE: Duration = Duration::from_millis(3_000);

struct ChildWatch {
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

impl ChildWatch {
    fn arm(pid: Option<u32>, stdout: Option<OwnedFd>, stderr: Option<OwnedFd>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(pid) = pid {
            let started = proc_start(pid).unwrap_or(0);
            let stop_flag = Arc::clone(&stop);
            let cancel_flag = Arc::clone(&cancel);
            let _ = std::thread::Builder::new().spawn(move || {
                let _hold = (stdout, stderr);
                watch_child(pid, started, &stop_flag, &cancel_flag);
            });
        }
        Self { stop, cancel }
    }

    fn disarm(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl Drop for ChildWatch {
    fn drop(&mut self) {
        if !self.stop.load(Ordering::Acquire) {
            self.cancel.store(true, Ordering::Release);
        }
    }
}

fn watch_child(pid: u32, started: u64, stop: &AtomicBool, cancel: &AtomicBool) {
    loop {
        if stop.load(Ordering::Acquire) {
            return;
        }
        if cancel.load(Ordering::Acquire) {
            if stop.load(Ordering::Acquire) {
                return;
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(50));
    if stop.load(Ordering::Acquire) {
        return;
    }
    let started_at = Instant::now();
    let deadline = started_at + KILL_GRACE;
    signal_tree(pid, "-TERM");
    while still_running(pid, started) {
        if Instant::now() >= deadline {
            signal_tree(pid, "-KILL");
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
        if !still_running(pid, started) {
            break;
        }
        if started_at.elapsed() < Duration::from_millis(500) || has_children(pid) {
            signal_tree(pid, "-TERM");
        }
    }
}

fn dup_owned(fd: &impl AsFd) -> Option<OwnedFd> {
    fd.as_fd().try_clone_to_owned().ok()
}

fn proc_start(pid: u32) -> Option<u64> {
    proc_identity(pid).map(|(_, start)| start)
}

fn proc_identity(pid: u32) -> Option<(char, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let end = stat.rfind(')')?;
    let mut parts = stat[end + 1..].split_whitespace();
    let state = parts.next()?.chars().next()?;
    let start = parts.nth(18)?.parse().ok()?;
    Some((state, start))
}

fn still_running(pid: u32, started: u64) -> bool {
    let Some((state, start)) = proc_identity(pid) else {
        return false;
    };
    if started != 0 && start != started {
        return false;
    }
    !matches!(state, 'Z' | 'X' | 'x')
}

fn signal_tree(pid: u32, flag: &str) {
    let group = kill_cmd(flag).arg(format!("-{pid}")).status();
    if !matches!(group, Ok(status) if status.success()) {
        signal_one(pid, flag);
    }
    let mut kids = child_pids(pid);
    if kids.is_empty() {
        kids = ppid_children(pid);
    }
    for kid in kids {
        signal_descendants(kid, flag);
        signal_one(kid, flag);
    }
}

fn has_children(pid: u32) -> bool {
    if !child_pids(pid).is_empty() {
        return true;
    }
    !ppid_children(pid).is_empty()
}

fn child_pids(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    if let Ok(kids) = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")) {
        for kid in kids.split_whitespace() {
            if let Ok(kid) = kid.parse::<u32>() {
                out.push(kid);
            }
        }
    }
    out
}

fn ppid_children(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(cand) = name.parse::<u32>() else {
            continue;
        };
        if parent_pid(cand) == Some(pid) {
            out.push(cand);
        }
    }
    out
}

fn parent_pid(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("PPid:") {
            return rest.trim().parse().ok();
        }
    }
    None
}

fn signal_descendants(pid: u32, flag: &str) {
    for kid in child_pids(pid) {
        signal_descendants(kid, flag);
        signal_one(kid, flag);
    }
}

fn signal_one(pid: u32, flag: &str) {
    let _ = kill_cmd(flag).arg(pid.to_string()).status();
}

fn kill_cmd(flag: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("/bin/kill");
    cmd.arg(flag)
        .arg("--")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd
}

async fn terminate_child(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        let _ = tokio::task::spawn_blocking(move || signal_tree(pid, "-TERM")).await;
    }
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            _ if started.elapsed() >= KILL_GRACE => {
                if let Some(pid) = child.id() {
                    let _ = tokio::task::spawn_blocking(move || signal_tree(pid, "-KILL")).await;
                }
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    let _ = child.wait().await;
}

fn codex_thread_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Some(value) = parse_codex_line(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("thread.started") {
            return value
                .get("thread_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
        }
    }
    None
}

fn kimi_resume_hint(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("role").and_then(Value::as_str) == Some("meta")
            && value.get("type").and_then(Value::as_str) == Some("session.resume_hint")
        {
            return value
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
        }
    }
    None
}

fn pi_session_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        for key in ["id", "session_id", "sessionId"] {
            if let Some(id) = value
                .get(key)
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                return Some(id.to_string());
            }
        }
    }
    None
}

fn opencode_session_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = session_id_from_value(&value) {
            return Some(id);
        }
    }
    None
}

fn session_id_from_value(value: &Value) -> Option<String> {
    let obj = value.as_object()?;
    for key in ["sessionID", "sessionId", "session_id"] {
        if let Some(id) = obj
            .get(key)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return Some(id.to_string());
        }
    }
    if let Some(id) = obj
        .get("session")
        .and_then(|session| session.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(id.to_string());
    }
    if let Some(part) = obj.get("part")
        && let Some(id) = session_id_from_value(part)
    {
        return Some(id);
    }
    if let Some(params) = obj.get("params")
        && let Some(id) = session_id_from_value(params)
    {
        return Some(id);
    }
    None
}

fn grok_session_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = value
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return Some(id.to_string());
        }
        if let Some(id) = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return Some(id.to_string());
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct PermissionEvent {
    pub ts: i64,
    pub kind: String,
    pub task_id: String,
    pub request_id: String,
    pub name: Option<String>,
    pub input: Option<Value>,
    pub tool_call_id: Option<String>,
    pub decision: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PermissionAnswer {
    pub behavior: String,
    pub message: Option<String>,
    pub decision: String,
}

#[derive(Debug, Clone)]
pub struct PermissionAsk {
    pub task_id: String,
    pub request_id: String,
    pub name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
}

static PERMISSION_IDS: AtomicU64 = AtomicU64::new(1);

pub fn permission_decision_text(behavior: &str, message: Option<&str>) -> String {
    if behavior == "allow" {
        return "{\"behavior\":\"allow\"}".to_string();
    }
    let message = message
        .filter(|item| !item.is_empty())
        .unwrap_or("permission denied");
    let mut map = Map::new();
    map.insert("behavior".to_string(), Value::from("deny"));
    map.insert("message".to_string(), Value::from(message));
    serde_json::to_string(&Value::Object(map))
        .unwrap_or_else(|_| "{\"behavior\":\"deny\",\"message\":\"permission denied\"}".to_string())
}

pub async fn execute_permission_prompt<F, Fut>(
    task_id: &str,
    tool_name: &str,
    input: Value,
    tool_use_id: Option<String>,
    ask: F,
    mut emit: impl FnMut(PermissionEvent),
) -> String
where
    F: FnOnce(PermissionAsk) -> Fut,
    Fut: std::future::Future<Output = Result<PermissionAnswer, ()>>,
{
    if tool_name.is_empty() {
        return permission_decision_text("deny", Some("permission request missing tool_name"));
    }
    let request_id = format!(
        "perm-{}-{}",
        now_ms(),
        PERMISSION_IDS.fetch_add(1, Ordering::Relaxed)
    );
    emit(PermissionEvent {
        ts: now_ms(),
        kind: "approval-request".to_string(),
        task_id: task_id.to_string(),
        request_id: request_id.clone(),
        name: Some(tool_name.to_string()),
        input: Some(input.clone()),
        tool_call_id: tool_use_id.clone(),
        decision: None,
    });
    let answer = match ask(PermissionAsk {
        task_id: task_id.to_string(),
        request_id: request_id.clone(),
        name: tool_name.to_string(),
        input,
        tool_use_id,
    })
    .await
    {
        Ok(answer) => answer,
        Err(()) => PermissionAnswer {
            behavior: "deny".to_string(),
            message: Some("permission request failed closed".to_string()),
            decision: "deny".to_string(),
        },
    };
    emit(PermissionEvent {
        ts: now_ms(),
        kind: "approval-resolved".to_string(),
        task_id: task_id.to_string(),
        request_id,
        name: None,
        input: None,
        tool_call_id: None,
        decision: Some(answer.decision.clone()),
    });
    permission_decision_text(&answer.behavior, answer.message.as_deref())
}
