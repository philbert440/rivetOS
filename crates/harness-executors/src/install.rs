use std::sync::Arc;

use protocol::HARNESS_IDS;

use crate::acp_exec::{codex_executor, cursor_executor, grok_build_executor, hermes_executor};
use crate::kimi::KimiCodeExecutor;
use crate::opencode::OpencodeExecutor;
use crate::pi::PiExecutor;
use crate::qwen::QwenCodeExecutor;
use crate::registry::{
    ExecutorRegistry, claude_missing_binary, claude_package_load,
    create_not_implemented_harness_executor, harness_executor_gap, kimi_missing_binary,
    opencode_missing_binary, pi_missing_binary, qwen_missing_binary,
};
use crate::spawn::probe_binary;
use crate::standard_helpers::Env;

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

pub async fn install_headless_executors(
    registry: &ExecutorRegistry,
    env: Arc<dyn Env>,
    bins: &HarnessBinaries,
) {
    register_claude(registry, env.as_ref(), &bins.claude).await;
    register_probed(
        registry,
        env.as_ref(),
        "kimi-code",
        &bins.kimi,
        &[],
        &kimi_missing_binary(&bins.kimi),
        {
            let env = Arc::clone(&env);
            let binary = bins.kimi.clone();
            move || {
                let mut executor = KimiCodeExecutor::new(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "opencode",
        &bins.opencode,
        &[],
        &opencode_missing_binary(&bins.opencode),
        {
            let env = Arc::clone(&env);
            let binary = bins.opencode.clone();
            move || {
                let mut executor = OpencodeExecutor::new(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "pi",
        &bins.pi,
        &[],
        &pi_missing_binary(&bins.pi),
        {
            let env = Arc::clone(&env);
            let binary = bins.pi.clone();
            move || {
                let mut executor = PiExecutor::new(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "qwen-code",
        &bins.qwen,
        &[],
        &qwen_missing_binary(),
        {
            let env = Arc::clone(&env);
            let binary = bins.qwen.clone();
            move || {
                let mut executor = QwenCodeExecutor::new(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "grok-build",
        &bins.grok,
        &[],
        &grok_missing_binary(&bins.grok),
        {
            let env = Arc::clone(&env);
            let binary = bins.grok.clone();
            move || {
                let mut executor = grok_build_executor(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "hermes",
        &bins.hermes,
        &[],
        &hermes_missing_binary(&bins.hermes),
        {
            let env = Arc::clone(&env);
            let binary = bins.hermes.clone();
            move || {
                let mut executor = hermes_executor(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "codex",
        &bins.codex_acp,
        &[],
        &codex_missing_binary(&bins.codex_acp),
        {
            let env = Arc::clone(&env);
            let binary = bins.codex_acp.clone();
            move || {
                let mut executor = codex_executor(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
    )
    .await;
    register_probed(
        registry,
        env.as_ref(),
        "cursor",
        &bins.cursor,
        &[],
        &cursor_missing_binary(&bins.cursor),
        {
            let env = Arc::clone(&env);
            let binary = bins.cursor.clone();
            move || {
                let mut executor = cursor_executor(binary);
                executor.env = Arc::clone(&env);
                Arc::new(executor) as Arc<dyn crate::registry::HarnessExecutor>
            }
        },
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
    F: FnOnce() -> Arc<dyn crate::registry::HarnessExecutor>,
{
    let executor = if probe_binary(binary, env, scrub).await {
        build()
    } else {
        create_not_implemented_harness_executor(harness_id, missing)
    };
    registry.register("harness-session", executor, Some(harness_id));
}
