use std::collections::BTreeMap;
use std::sync::Arc;

use protocol::HARNESS_IDS;

use crate::acp_exec::{
    CODEX_HARNESS_ID, CURSOR_HARNESS_ID, GROK_BUILD_HARNESS_ID, HERMES_HARNESS_ID, codex_executor,
    cursor_executor, grok_build_executor, hermes_executor,
};
use crate::drive::HistorySource;
use crate::kimi::{KIMI_HARNESS_ID, KimiCodeExecutor};
use crate::opencode::{OPENCODE_HARNESS_ID, OpencodeExecutor};
use crate::pi::{PI_HARNESS_ID, PiExecutor};
use crate::qwen::{QWEN_CODE_HARNESS_ID, QwenCodeExecutor};
use crate::registry::{
    ExecutorRegistry, claude_missing_binary, claude_package_load,
    create_not_implemented_harness_executor, harness_executor_gap, kimi_missing_binary,
    opencode_missing_binary, pi_missing_binary, qwen_missing_binary,
};
use crate::spawn::probe_binary;
use protocol::host::Env;

#[derive(Clone, Debug)]
pub struct HarnessBinaries {
    pub claude: String,
    pub kimi: String,
    pub opencode: String,
    pub pi: String,
    pub qwen: String,
    pub grok: String,
    pub hermes: String,
    pub codex_acp: String,
    pub cursor: String,
}

impl Default for HarnessBinaries {
    fn default() -> Self {
        Self {
            claude: "claude".to_string(),
            kimi: "kimi".to_string(),
            opencode: "opencode".to_string(),
            pi: "pi".to_string(),
            qwen: "qwen".to_string(),
            grok: "grok".to_string(),
            hermes: "hermes".to_string(),
            codex_acp: "codex-acp".to_string(),
            cursor: "agent".to_string(),
        }
    }
}

pub fn grok_missing_binary(binary: &str) -> String {
    format!(
        "the `grok` binary is not resolvable on this node (tried \"{binary}\"): install Grok, or set tasks.harnesses.grok-build.binary to its path"
    )
}

pub fn hermes_missing_binary(binary: &str) -> String {
    format!(
        "the `hermes` binary is not resolvable on this node (tried \"{binary}\"): install Hermes, or set tasks.harnesses.hermes.binary to its path"
    )
}

pub fn codex_missing_binary(binary: &str) -> String {
    format!(
        "the `codex-acp` binary is not resolvable on this node (tried \"{binary}\"): install the Codex ACP adapter, or set tasks.harnesses.codex.binary to its path"
    )
}

pub fn cursor_missing_binary(binary: &str) -> String {
    format!(
        "the `agent` binary is not resolvable on this node (tried \"{binary}\"): install Cursor agent, or set tasks.harnesses.cursor.binary to its path"
    )
}

#[derive(Clone, Debug, Default)]
pub struct HarnessSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub home: Option<String>,
}

#[derive(Clone, Default)]
pub struct HeadlessConfig {
    pub workspace: Option<String>,
    pub history: Option<Arc<HistorySource>>,
    pub harnesses: BTreeMap<String, HarnessSettings>,
}

impl std::fmt::Debug for HeadlessConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HeadlessConfig")
            .field("workspace", &self.workspace)
            .field("history", &self.history.is_some())
            .field("harnesses", &self.harnesses)
            .finish()
    }
}

fn harness_settings(config: &HeadlessConfig, harness_id: &str) -> HarnessSettings {
    let mut settings = config
        .harnesses
        .get(harness_id)
        .cloned()
        .unwrap_or_default();
    if settings.cwd.is_none() {
        settings.cwd = config.workspace.clone();
    }
    settings
}

pub type ArgvHarnessConfig = HeadlessConfig;

pub async fn install_headless_executors(
    registry: &ExecutorRegistry,
    env: Arc<dyn Env>,
    bins: &HarnessBinaries,
    config: &HeadlessConfig,
) {
    register_claude(registry, env.as_ref(), &bins.claude).await;
    register_probed(
        registry,
        env.as_ref(),
        KIMI_HARNESS_ID,
        &bins.kimi,
        &[],
        &kimi_missing_binary(&bins.kimi),
        {
            let env = Arc::clone(&env);
            let binary = bins.kimi.clone();
            let settings = harness_settings(config, KIMI_HARNESS_ID);
            let history = config.history.clone();
            move || {
                let mut executor = KimiCodeExecutor::new(binary);
                executor.env = env;
                executor.model_id = settings.model;
                executor.effort = settings.effort;
                executor.cwd = settings.cwd;
                executor.kimi_home = settings.home;
                executor.history = history;
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        OPENCODE_HARNESS_ID,
        &bins.opencode,
        &[],
        &opencode_missing_binary(&bins.opencode),
        {
            let env = Arc::clone(&env);
            let binary = bins.opencode.clone();
            let settings = harness_settings(config, OPENCODE_HARNESS_ID);
            let history = config.history.clone();
            move || {
                let mut executor = OpencodeExecutor::new(binary);
                executor.env = env;
                executor.model_id = settings.model;
                executor.effort = settings.effort;
                executor.cwd = settings.cwd;
                executor.opencode_home = settings.home;
                executor.history = history;
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        PI_HARNESS_ID,
        &bins.pi,
        &[],
        &pi_missing_binary(&bins.pi),
        {
            let env = Arc::clone(&env);
            let binary = bins.pi.clone();
            let settings = harness_settings(config, PI_HARNESS_ID);
            let history = config.history.clone();
            move || {
                let mut executor = PiExecutor::new(binary);
                executor.env = env;
                executor.model_id = settings.model;
                executor.effort = settings.effort;
                executor.cwd = settings.cwd;
                executor.pi_home = settings.home;
                executor.history = history;
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        QWEN_CODE_HARNESS_ID,
        &bins.qwen,
        &[],
        &qwen_missing_binary(),
        {
            let env = Arc::clone(&env);
            let binary = bins.qwen.clone();
            let settings = harness_settings(config, QWEN_CODE_HARNESS_ID);
            let history = config.history.clone();
            move || {
                let mut executor = QwenCodeExecutor::new(binary);
                executor.env = env;
                executor.model_id = settings.model;
                executor.cwd = settings.cwd;
                executor.qwen_home = settings.home;
                executor.history = history;
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        GROK_BUILD_HARNESS_ID,
        &bins.grok,
        &[],
        &grok_missing_binary(&bins.grok),
        acp_builder(
            Arc::clone(&env),
            bins.grok.clone(),
            config,
            GROK_BUILD_HARNESS_ID,
            grok_build_executor,
        ),
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        HERMES_HARNESS_ID,
        &bins.hermes,
        &[],
        &hermes_missing_binary(&bins.hermes),
        acp_builder(
            Arc::clone(&env),
            bins.hermes.clone(),
            config,
            HERMES_HARNESS_ID,
            hermes_executor,
        ),
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        CODEX_HARNESS_ID,
        &bins.codex_acp,
        &[],
        &codex_missing_binary(&bins.codex_acp),
        acp_builder(
            Arc::clone(&env),
            bins.codex_acp.clone(),
            config,
            CODEX_HARNESS_ID,
            codex_executor,
        ),
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        CURSOR_HARNESS_ID,
        &bins.cursor,
        &[],
        &cursor_missing_binary(&bins.cursor),
        acp_builder(
            Arc::clone(&env),
            bins.cursor.clone(),
            config,
            CURSOR_HARNESS_ID,
            cursor_executor,
        ),
    )
    .await;
    registry.register(
        "harness-session",
        create_not_implemented_harness_executor("cowork", &harness_executor_gap("cowork")),
        Some("cowork"),
    );
    for id in HARNESS_IDS {
        let covered = registry
            .harnesses()
            .into_iter()
            .any(|row| row.harness_id == *id && row.registered);
        if !covered {
            registry.register(
                "harness-session",
                create_not_implemented_harness_executor(id, &harness_executor_gap(id)),
                Some(id),
            );
        }
    }
}

fn acp_builder<F>(
    env: Arc<dyn Env>,
    binary: String,
    config: &HeadlessConfig,
    harness_id: &str,
    build: F,
) -> impl FnOnce() -> Arc<dyn crate::registry::HarnessExecutor> + Send
where
    F: FnOnce(String) -> crate::acp_exec::AcpHarnessExecutor + Send,
{
    let settings = harness_settings(config, harness_id);
    let history = config.history.clone();
    move || {
        let mut executor = build(binary);
        executor.env = env;
        executor.cwd = settings.cwd;
        executor.history = history;
        Arc::new(executor)
    }
}

async fn register_claude(registry: &ExecutorRegistry, env: &dyn Env, binary: &str) {
    let reason = if probe_binary(binary, env, &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]).await
    {
        claude_package_load(
            "claude-code executor is provided by the provider plugin, not this crate",
        )
    } else {
        claude_missing_binary(binary)
    };
    registry.register(
        "harness-session",
        create_not_implemented_harness_executor("claude-code", &reason),
        Some("claude-code"),
    );
}

async fn register_probed<F>(
    registry: &ExecutorRegistry,
    env: &dyn Env,
    harness_id: &str,
    binary: &str,
    scrub: &[&str],
    missing: &str,
    build: F,
) where
    F: FnOnce() -> Arc<dyn crate::registry::HarnessExecutor> + Send,
{
    let executor = if probe_binary(binary, env, scrub).await {
        build()
    } else {
        create_not_implemented_harness_executor(harness_id, missing)
    };
    registry.register("harness-session", executor, Some(harness_id));
}
