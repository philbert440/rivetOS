use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use acp::{
    AcpClient, AcpError, AllowOncePolicy, FakeScript, InitializeInfo, PermissionPolicy,
    SessionEvent, ToolStatus, child_lines, spawn_fake,
};
use parking_lot::Mutex;
use tokio::task::JoinHandle;

use crate::drive::{DrivePlan, HistorySource, ScaffoldMode, SpawnOutcome, TurnCall, drive};
use crate::model::{
    AbortFlag, Capabilities, TaskSpec, den_message, den_thinking, den_tool_end, den_tool_start,
    log_event, open_handle, publish,
};
use crate::prompt::clamp_prompt;
use crate::registry::HarnessExecutor;
use crate::spawn::{KILL_GRACE_MS, child_env, signal_pid};
use crate::standard_helpers::{Env, ProcessEnv};

pub const GROK_BUILD_HARNESS_ID: &str = "grok-build";
pub const HERMES_HARNESS_ID: &str = "hermes";
pub const CODEX_HARNESS_ID: &str = "codex";
pub const CURSOR_HARNESS_ID: &str = "cursor";

type AgentJoin = JoinHandle<Result<(), AcpError>>;
type AgentTask = Arc<Mutex<Option<AgentJoin>>>;

#[derive(Clone)]
enum Launch {
    Command { program: String, args: Vec<String> },
    Fake(Box<FakeScript>),
}

#[derive(Clone)]
pub struct AcpHarnessExecutor {
    pub harness_id: String,
    launch: Launch,
    pub cwd: Option<String>,
    pub resume_session_id: Option<String>,
    pub kill_grace: Duration,
    pub env: Arc<dyn Env>,
    pub history: Option<Arc<HistorySource>>,
    pub policy: Arc<dyn PermissionPolicy>,
}

impl AcpHarnessExecutor {
    pub fn command(
        harness_id: impl Into<String>,
        program: impl Into<String>,
        args: Vec<String>,
    ) -> Self {
        Self::new(
            harness_id,
            Launch::Command {
                program: program.into(),
                args,
            },
        )
    }

    pub fn fake(harness_id: impl Into<String>, script: FakeScript) -> Self {
        Self::new(harness_id, Launch::Fake(Box::new(script)))
    }

    fn new(harness_id: impl Into<String>, launch: Launch) -> Self {
        Self {
            harness_id: harness_id.into(),
            launch,
            cwd: None,
            resume_session_id: None,
            kill_grace: Duration::from_millis(KILL_GRACE_MS),
            env: Arc::new(ProcessEnv),
            history: None,
            policy: Arc::new(AllowOncePolicy),
        }
    }
}

pub fn grok_build_executor(binary: impl Into<String>) -> AcpHarnessExecutor {
    AcpHarnessExecutor::command(
        GROK_BUILD_HARNESS_ID,
        binary,
        vec!["agent".to_string(), "stdio".to_string()],
    )
}

pub fn hermes_executor(binary: impl Into<String>) -> AcpHarnessExecutor {
    AcpHarnessExecutor::command(HERMES_HARNESS_ID, binary, vec!["acp".to_string()])
}

pub fn codex_executor(binary: impl Into<String>) -> AcpHarnessExecutor {
    AcpHarnessExecutor::command(CODEX_HARNESS_ID, binary, Vec::new())
}

pub fn cursor_executor(binary: impl Into<String>) -> AcpHarnessExecutor {
    AcpHarnessExecutor::command(CURSOR_HARNESS_ID, binary, vec!["acp".to_string()])
}

struct Shared {
    client: Mutex<Option<Arc<AcpClient>>>,
    session: Mutex<Option<String>>,
    child_kill: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    child_exited: Mutex<Option<Arc<AtomicBool>>>,
    load_session: AtomicBool,
    initial_used: AtomicBool,
    usage_usd: Mutex<Option<f64>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            client: Mutex::new(None),
            session: Mutex::new(None),
            child_kill: Mutex::new(None),
            child_exited: Mutex::new(None),
            load_session: AtomicBool::new(false),
            initial_used: AtomicBool::new(false),
            usage_usd: Mutex::new(None),
        }
    }
}

#[derive(Default)]
struct ToolLive {
    label: Option<String>,
    terminal: bool,
}

impl HarnessExecutor for AcpHarnessExecutor {
    fn name(&self) -> &str {
        &self.harness_id
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::argv(false)
    }

    fn start(&self, spec: TaskSpec, abort: AbortFlag) -> crate::model::TaskHandle {
        let cfg = self.clone();
        let (handle, parts) = open_handle(None);
        let kill_now = handle.kill_hook();
        if let Some(reason) = abort.arm({
            let kill_now = Arc::clone(&kill_now);
            Arc::new(move |reason: String| kill_now(&reason))
        }) {
            kill_now(&reason);
        }
        let shared = Arc::new(Shared::new());
        let kill = {
            let shared = Arc::clone(&shared);
            Arc::new(move || {
                if let Some(kill) = shared.child_kill.lock().clone() {
                    kill();
                }
                let client = shared.client.lock().clone();
                let session = shared.session.lock().clone();
                if let (Some(client), Some(session)) = (client, session) {
                    tokio::spawn(async move {
                        let _ = client.cancel_session(&session).await;
                    });
                }
            }) as Arc<dyn Fn() + Send + Sync>
        };
        *parts.active.lock() = Some(Arc::clone(&kill));
        let killed = Arc::clone(&parts.killed);
        let events = parts.events.clone();
        let parts_for_task = parts.clone();
        let harness = self.harness_id.clone();
        tokio::spawn(async move {
            let cwd = spec
                .working_dir
                .clone()
                .or_else(|| cfg.cwd.clone())
                .unwrap_or_else(current_dir);
            let fake_task: AgentTask = Arc::new(Mutex::new(None));
            let result =
                drive(
                    spec,
                    parts_for_task,
                    DrivePlan {
                        harness: harness.clone(),
                        prefix: harness,
                        mode: ScaffoldMode::Inline,
                        cwd: cwd.clone(),
                        history: cfg.history.clone(),
                    },
                    |call| {
                        let cfg = cfg.clone();
                        let cwd = cwd.clone();
                        let shared = Arc::clone(&shared);
                        let killed = Arc::clone(&killed);
                        let events = events.clone();
                        let fake_task = Arc::clone(&fake_task);
                        async move {
                            run_acp_turn(cfg, call, cwd, shared, killed, events, fake_task).await
                        }
                    },
                )
                .await;
            if let Some(task) = fake_task.lock().take() {
                task.abort();
            }
            if let Some(kill) = shared.child_kill.lock().clone() {
                let exited = shared.child_exited.lock().clone();
                if exited.is_none_or(|flag| !flag.load(Ordering::SeqCst)) {
                    kill();
                }
            }
            drop(shared.client.lock().take());
            publish(&parts, result);
        });
        handle
    }
}

async fn run_acp_turn(
    cfg: AcpHarnessExecutor,
    call: TurnCall,
    cwd: String,
    shared: Arc<Shared>,
    killed: Arc<AtomicBool>,
    events: crate::model::EventQueue,
    fake_task: AgentTask,
) -> SpawnOutcome {
    if let Err(error) = ensure_client(&cfg, &call, &cwd, &shared, &fake_task, &killed).await {
        if killed.load(Ordering::SeqCst) {
            return stopped_turn(shared.session.lock().clone());
        }
        return SpawnOutcome::failure(error);
    }
    let client = match shared.client.lock().clone() {
        Some(client) => client,
        None => return SpawnOutcome::failure("acp session ended: client missing"),
    };
    let first = !shared.initial_used.swap(true, Ordering::SeqCst);
    let resume = if let Some(native) = call.resume_native.clone() {
        Some(native)
    } else if first {
        cfg.resume_session_id.clone()
    } else {
        None
    };
    let session = if let Some(native) = resume {
        if shared.session.lock().as_deref() == Some(native.as_str()) {
            native
        } else if !shared.load_session.load(Ordering::SeqCst) {
            return SpawnOutcome::rejected("acp agent does not advertise loadSession");
        } else {
            match until_stopped(
                client.load_session(native.clone(), PathBuf::from(&cwd)),
                &killed,
                || signal_child(&shared),
            )
            .await
            {
                Ok(loaded) => {
                    note_usd(&mut shared.usage_usd.lock(), &loaded.events);
                    *shared.session.lock() = Some(native.clone());
                    native
                }
                Err(error) => {
                    if killed.load(Ordering::SeqCst) {
                        return stopped_turn(shared.session.lock().clone());
                    }
                    return SpawnOutcome::rejected(format!("acp session load failed: {error}"));
                }
            }
        }
    } else {
        match until_stopped(client.new_session(PathBuf::from(&cwd)), &killed, || {
            signal_child(&shared)
        })
        .await
        {
            Ok(id) => {
                *shared.session.lock() = Some(id.clone());
                id
            }
            Err(error) => {
                if killed.load(Ordering::SeqCst) {
                    return stopped_turn(None);
                }
                return SpawnOutcome::failure(format!("acp session ended: {error}"));
            }
        }
    };
    if killed.load(Ordering::SeqCst) {
        let _ = client.cancel_session(&session).await;
        signal_child(&shared);
        return stopped_turn(Some(session));
    }
    let mut prompt = call.prompt;
    if !call.append_system_prompt.is_empty() {
        prompt = format!("{}\n\n{prompt}", call.append_system_prompt);
    }
    let prompt = clamp_prompt(&prompt);
    let output = prompt_until_done(&client, &session, prompt, &killed).await;
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            if killed.load(Ordering::SeqCst) {
                return stopped_turn(Some(session));
            }
            return SpawnOutcome::failure(format!("acp session ended: {error}"));
        }
    };
    let mut tools = HashMap::<String, ToolLive>::new();
    for event in &output.events {
        match event {
            SessionEvent::AgentMessage { text } if !text.is_empty() => {
                events.push(den_message(text.clone()));
            }
            SessionEvent::AgentThought { text } if !text.is_empty() => {
                events.push(den_thinking(text.clone()));
            }
            SessionEvent::ToolCall {
                id,
                name,
                title,
                status,
            } => {
                remember_tool(&mut tools, id, name, Some(title.as_str()));
                if let Some(label) = tools.get(id).and_then(|slot| slot.label.clone()) {
                    events.push(den_tool_start(label));
                }
                end_if_terminal(&mut tools, id, Some(*status), &events);
            }
            SessionEvent::ToolCallUpdate {
                id,
                name,
                title,
                status,
            } => {
                remember_tool(&mut tools, id, name, title.as_deref());
                end_if_terminal(&mut tools, id, *status, &events);
            }
            SessionEvent::Plan { entries } if !entries.is_empty() => {
                events.push(log_event("info", entries.join("\n")));
            }
            SessionEvent::Usage { .. } => {}
            _ => {}
        }
    }
    let cost_usd = charge_usd(&mut shared.usage_usd.lock(), &output.events);
    let error = if killed.load(Ordering::SeqCst) || output.stop_reason == "end_turn" {
        None
    } else {
        Some(format!("acp stop: {}", output.stop_reason))
    };
    SpawnOutcome {
        text: output.text,
        native_id: Some(session),
        error,
        resume_rejected: false,
        input_tokens: 0.0,
        output_tokens: 0.0,
        cost_usd,
    }
}

async fn prompt_until_done(
    client: &Arc<AcpClient>,
    session: &str,
    prompt: String,
    killed: &AtomicBool,
) -> Result<acp::PromptOutput, AcpError> {
    let pending = client.prompt(session.to_string(), prompt);
    tokio::pin!(pending);
    loop {
        tokio::select! {
            result = &mut pending => return result,
            _ = tokio::time::sleep(Duration::from_millis(15)) => {
                if killed.load(Ordering::SeqCst) {
                    let _ = client.cancel_session(session).await;
                }
            }
        }
    }
}

async fn ensure_client(
    cfg: &AcpHarnessExecutor,
    call: &TurnCall,
    cwd: &str,
    shared: &Shared,
    fake_task: &AgentTask,
    killed: &AtomicBool,
) -> Result<(), String> {
    if shared.client.lock().is_some() {
        return Ok(());
    }
    let client = match &cfg.launch {
        Launch::Fake(script) => {
            let (transport, task) = spawn_fake(script.as_ref().clone());
            *fake_task.lock() = Some(task);
            until_stopped(
                AcpClient::connect(transport, Arc::clone(&cfg.policy)),
                killed,
                || signal_child(shared),
            )
            .await
            .map_err(|error| format!("acp session ended: {error}"))?
        }
        Launch::Command { program, args } => {
            spawn_command(cfg, call, cwd, program, args, shared, killed).await?
        }
    };
    let info = until_stopped(client.initialize(), killed, || signal_child(shared))
        .await
        .map_err(|error| format!("acp session ended: {error}"))?;
    shared
        .load_session
        .store(info.load_session, Ordering::SeqCst);
    authenticate_if_needed(cfg, &client, &info, killed, shared).await?;
    *shared.client.lock() = Some(Arc::new(client));
    Ok(())
}

async fn spawn_command(
    cfg: &AcpHarnessExecutor,
    call: &TurnCall,
    cwd: &str,
    program: &str,
    args: &[String],
    shared: &Shared,
    killed: &AtomicBool,
) -> Result<AcpClient, String> {
    let env = acp_child_env(cfg.env.as_ref(), &call.task_id);
    let mut command = tokio::process::Command::new(program);
    command.args(args);
    command.env_clear();
    for (key, value) in &env {
        command.env(key, value);
    }
    command.current_dir(cwd);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());
    command.kill_on_drop(false);
    tracing::info!(task_id = %call.task_id, "task.spawn");
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn {program}: {error}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("Failed to spawn {program}: stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Failed to spawn {program}: stdout"))?;
    let exited = Arc::new(AtomicBool::new(false));
    let exited_flag = Arc::clone(&exited);
    tokio::spawn(async move {
        let _ = child.wait().await;
        exited_flag.store(true, Ordering::SeqCst);
    });
    let killing = Arc::new(AtomicBool::new(false));
    let grace = cfg.kill_grace;
    let exited_for_kill = Arc::clone(&exited);
    let kill = Arc::new(move || {
        signal_pid(
            pid,
            Arc::clone(&exited_for_kill),
            Arc::clone(&killing),
            grace,
        );
    }) as Arc<dyn Fn() + Send + Sync>;
    *shared.child_kill.lock() = Some(Arc::clone(&kill));
    *shared.child_exited.lock() = Some(exited);
    if killed.load(Ordering::SeqCst) {
        kill();
    }
    let lines = child_lines(stdin, stdout);
    until_stopped(
        AcpClient::connect(lines, Arc::clone(&cfg.policy)),
        killed,
        || kill(),
    )
    .await
    .map_err(|error| format!("acp session ended: {error}"))
}

fn acp_child_env(base: &dyn Env, task_id: &str) -> BTreeMap<String, String> {
    let overrides = vec![
        ("RIVETOS_TASK_ID".to_string(), Some(task_id.to_string())),
        ("RIVETOS_SESSION_KEY".to_string(), None),
        (
            "RIVETOS_DEN_HOOK_DISABLED".to_string(),
            Some("1".to_string()),
        ),
    ];
    let mut env = child_env(base, &overrides, &[], &[]);
    env.retain(|key, _| key == "XAI_API_KEY" || !key.starts_with("XAI_"));
    env
}

async fn authenticate_if_needed(
    cfg: &AcpHarnessExecutor,
    client: &AcpClient,
    info: &InitializeInfo,
    killed: &AtomicBool,
    shared: &Shared,
) -> Result<(), String> {
    if cfg.harness_id != GROK_BUILD_HARNESS_ID {
        return Ok(());
    }
    let key = cfg.env.get("XAI_API_KEY").unwrap_or_default();
    let method = if !key.is_empty() && info.auth_methods.iter().any(|id| id == "xai.api_key") {
        Some("xai.api_key")
    } else if info.auth_methods.iter().any(|id| id == "cached_token") {
        Some("cached_token")
    } else {
        None
    };
    let Some(method) = method else {
        return Ok(());
    };
    until_stopped(client.authenticate(method.to_string()), killed, || {
        signal_child(shared)
    })
    .await
    .map(|_| ())
    .map_err(|error| format!("acp session ended: {error}"))
}

async fn until_stopped<T, F, K>(
    pending: F,
    killed: &AtomicBool,
    on_killed: K,
) -> Result<T, AcpError>
where
    F: Future<Output = Result<T, AcpError>>,
    K: Fn(),
{
    tokio::pin!(pending);
    loop {
        tokio::select! {
            biased;
            result = &mut pending => return result,
            _ = tokio::time::sleep(Duration::from_millis(15)) => {
                if killed.load(Ordering::SeqCst) {
                    on_killed();
                    return Err(AcpError::message("cancelled"));
                }
            }
        }
    }
}

fn signal_child(shared: &Shared) {
    if let Some(kill) = shared.child_kill.lock().clone() {
        kill();
    }
}

fn stopped_turn(native_id: Option<String>) -> SpawnOutcome {
    SpawnOutcome {
        text: String::new(),
        native_id,
        error: None,
        resume_rejected: false,
        input_tokens: 0.0,
        output_tokens: 0.0,
        cost_usd: None,
    }
}

fn prefer_label(name: &Option<String>, title: Option<&str>) -> Option<String> {
    if let Some(name) = name.as_ref().filter(|name| !name.is_empty()) {
        return Some(name.clone());
    }
    title
        .filter(|title| !title.is_empty())
        .map(ToString::to_string)
}

fn remember_tool(
    tools: &mut HashMap<String, ToolLive>,
    id: &str,
    name: &Option<String>,
    title: Option<&str>,
) {
    let incoming = prefer_label(name, title);
    let slot = tools.entry(id.to_string()).or_default();
    if incoming.is_some() {
        slot.label = incoming;
    }
}

fn end_if_terminal(
    tools: &mut HashMap<String, ToolLive>,
    id: &str,
    status: Option<ToolStatus>,
    events: &crate::model::EventQueue,
) {
    if !status.is_some_and(ToolStatus::is_terminal) {
        return;
    }
    let Some(slot) = tools.get_mut(id) else {
        return;
    };
    if slot.terminal {
        return;
    }
    slot.terminal = true;
    events.push(den_tool_end(slot.label.clone()));
}

fn note_usd(baseline: &mut Option<f64>, events: &[SessionEvent]) {
    for event in events {
        if let SessionEvent::Usage {
            cost_amount: Some(amount),
            cost_currency,
            ..
        } = event
            && cost_currency.as_deref() == Some("USD")
        {
            *baseline = Some(*amount);
        }
    }
}

fn charge_usd(baseline: &mut Option<f64>, events: &[SessionEvent]) -> Option<f64> {
    let mut latest = None;
    for event in events {
        if let SessionEvent::Usage {
            cost_amount: Some(amount),
            cost_currency,
            ..
        } = event
            && cost_currency.as_deref() == Some("USD")
        {
            latest = Some(*amount);
        }
    }
    let latest = latest?;
    let start = baseline.unwrap_or(0.0);
    *baseline = Some(latest);
    if latest > start {
        Some(latest - start)
    } else {
        None
    }
}

fn current_dir() -> String {
    std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| ".".to_string())
}
