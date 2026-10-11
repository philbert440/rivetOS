use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use protocol::{HARNESS_IDS, TaskResult};
use serde_json::{Map, Value};

use crate::model::{
    AbortFlag, Capabilities, SteerError, TaskHandle, TaskSpec, empty_usage, log_event, publish,
};

pub trait HarnessExecutor: Send + Sync {
    fn name(&self) -> &str;
    fn capabilities(&self) -> Capabilities;
    fn start(&self, spec: TaskSpec, abort: AbortFlag) -> TaskHandle;
    fn is_not_implemented(&self) -> bool {
        false
    }
    fn not_implemented_reason(&self) -> Option<String> {
        None
    }
}

pub const DEPRECATED_EXECUTOR_TARGETS: &[(&str, &str)] = &[("claude-cli", "claude-code")];

pub fn is_harness_executor_target(target: &str) -> bool {
    HARNESS_IDS.contains(&target)
}

pub struct CanonicalTarget {
    pub target: Option<String>,
    pub deprecated_alias: Option<String>,
}

pub fn canonicalize_executor_target(target: Option<&str>) -> CanonicalTarget {
    let Some(target) = target else {
        return CanonicalTarget {
            target: None,
            deprecated_alias: None,
        };
    };
    if let Some((_, canonical)) = DEPRECATED_EXECUTOR_TARGETS
        .iter()
        .find(|(legacy, _)| *legacy == target)
    {
        return CanonicalTarget {
            target: Some((*canonical).to_string()),
            deprecated_alias: Some(target.to_string()),
        };
    }
    CanonicalTarget {
        target: Some(target.to_string()),
        deprecated_alias: None,
    }
}

pub const COWORK_GAP: &str = "\
cowork is capture-only: Claude Desktop Cowork sessions are listed and read from \
host metadata (and a transcript when the sandbox left one on disk). There is no \
task executor, no resume, and no turn injection — the Desktop plugin captures \
through host MCP hooks";

pub fn harness_executor_gap(harness_id: &str) -> String {
    if harness_id == "cowork" {
        COWORK_GAP.to_string()
    } else {
        "no task executor is wired for this harness on this node".to_string()
    }
}

pub fn claude_missing_binary(binary: &str) -> String {
    format!(
        "the `claude` binary is not resolvable on this node (tried \"{binary}\"): install Claude Code, or set providers.claude-cli.binary to its path"
    )
}

pub fn claude_package_load(message: &str) -> String {
    format!("the @rivetos/provider-claude-cli package did not load on this node: {message}")
}

pub fn kimi_missing_binary(binary: &str) -> String {
    format!(
        "the `kimi` binary is not resolvable on this node (tried \"{binary}\"): install Kimi Code, or set tasks.harnesses.kimi-code.binary to its path"
    )
}

pub fn kimi_package_load(message: &str) -> String {
    format!("the @rivetos/harness-kimi-code package did not load on this node: {message}")
}

pub fn opencode_missing_binary(binary: &str) -> String {
    format!(
        "the `opencode` binary is not resolvable on this node (tried \"{binary}\"): install OpenCode, or set tasks.harnesses.opencode.binary to its path"
    )
}

pub fn opencode_package_load(message: &str) -> String {
    format!("the @rivetos/harness-opencode package did not load on this node: {message}")
}

pub fn pi_missing_binary(binary: &str) -> String {
    format!(
        "the `pi` binary is not resolvable on this node (tried \"{binary}\"): install Pi (earendil-works/pi), or set tasks.harnesses.pi.binary to its path"
    )
}

pub fn pi_package_load(message: &str) -> String {
    format!("the @rivetos/harness-pi package did not load on this node: {message}")
}

pub fn qwen_missing_binary() -> String {
    "qwen not found on PATH — install Qwen Code (npm i -g @qwen-code/qwen-code) or set tasks.harnesses.qwen-code.binary"
        .to_string()
}

pub fn qwen_package_load(message: &str) -> String {
    format!("the @rivetos/harness-qwen-code package did not load on this node: {message}")
}

pub struct UnsupportedError {
    pub code: String,
    pub message: String,
    pub harness_id: String,
    pub retryable: bool,
    pub context: Map<String, Value>,
}

pub fn harness_executor_unsupported(harness_id: &str, reason: &str) -> UnsupportedError {
    let message = format!("no task executor for harness \"{harness_id}\": {reason}");
    let mut context = Map::new();
    context.insert(
        "executor".to_string(),
        Value::String("harness-session".to_string()),
    );
    context.insert(
        "executorTarget".to_string(),
        Value::String(harness_id.to_string()),
    );
    context.insert(
        "harnessId".to_string(),
        Value::String(harness_id.to_string()),
    );
    UnsupportedError {
        code: "capability_unsupported".to_string(),
        message,
        harness_id: harness_id.to_string(),
        retryable: false,
        context,
    }
}

struct RejectingExecutor {
    harness_id: String,
    reason: String,
}

impl HarnessExecutor for RejectingExecutor {
    fn name(&self) -> &str {
        &self.harness_id
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::none()
    }

    fn start(&self, _spec: TaskSpec, _abort: AbortFlag) -> TaskHandle {
        let error = harness_executor_unsupported(&self.harness_id, &self.reason);
        let (handle, parts) = crate::model::open_handle(Some(steer_of(&error)));
        let summary = error.message.clone();
        let error_text = format!("{}: {}", error.code, error.message);
        parts.events.push(log_event("error", summary.clone()));
        publish(
            &parts,
            TaskResult {
                verdict: protocol::TaskVerdict::Failed,
                summary,
                output: None,
                artifacts: Vec::new(),
                criteria_self_report: None,
                usage: empty_usage(),
                error: Some(error_text),
            },
        );
        handle
    }

    fn is_not_implemented(&self) -> bool {
        true
    }

    fn not_implemented_reason(&self) -> Option<String> {
        if self.reason.is_empty() {
            None
        } else {
            Some(self.reason.clone())
        }
    }
}

fn steer_of(error: &UnsupportedError) -> SteerError {
    SteerError {
        code: error.code.clone(),
        message: error.message.clone(),
        harness_id: Some(error.harness_id.clone()),
        retryable: error.retryable,
        context: error.context.clone(),
    }
}

pub fn create_not_implemented_harness_executor(
    harness_id: &str,
    reason: &str,
) -> Arc<dyn HarnessExecutor> {
    Arc::new(RejectingExecutor {
        harness_id: harness_id.to_string(),
        reason: reason.to_string(),
    })
}

pub fn is_not_implemented_harness_executor(executor: &dyn HarnessExecutor) -> bool {
    executor.is_not_implemented()
}

pub fn not_implemented_harness_reason(executor: &dyn HarnessExecutor) -> Option<String> {
    if !executor.is_not_implemented() {
        return None;
    }
    executor.not_implemented_reason()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HarnessCoverage {
    pub harness_id: String,
    pub registered: bool,
    pub implemented: bool,
}

pub fn harness_executor_coverage<F>(resolve: F) -> Vec<HarnessCoverage>
where
    F: Fn(&str) -> Option<Arc<dyn HarnessExecutor>>,
{
    HARNESS_IDS
        .iter()
        .map(|harness_id| {
            let executor = resolve(harness_id);
            HarnessCoverage {
                harness_id: (*harness_id).to_string(),
                registered: executor.is_some(),
                implemented: executor
                    .as_ref()
                    .is_some_and(|executor| !executor.is_not_implemented()),
            }
        })
        .collect()
}

pub struct RegistryEntry {
    pub key: String,
    pub executor: Arc<dyn HarnessExecutor>,
}

pub type DeprecatedHook = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct ExecutorRegistry {
    entries: Mutex<Vec<(String, Arc<dyn HarnessExecutor>)>>,
    warned: Mutex<HashSet<String>>,
    on_deprecated: Mutex<Option<DeprecatedHook>>,
}

impl ExecutorRegistry {
    pub fn new(on_deprecated: Option<DeprecatedHook>) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            warned: Mutex::new(HashSet::new()),
            on_deprecated: Mutex::new(on_deprecated),
        }
    }

    pub fn register(&self, kind: &str, executor: Arc<dyn HarnessExecutor>, target: Option<&str>) {
        let key = registry_key(kind, &self.canonical(kind, target));
        let mut entries = self.entries.lock();
        if let Some(slot) = entries.iter_mut().find(|(existing, _)| existing == &key) {
            slot.1 = executor;
        } else {
            entries.push((key, executor));
        }
    }

    pub fn resolve(&self, kind: &str, target: Option<&str>) -> Option<Arc<dyn HarnessExecutor>> {
        let specific = registry_key(kind, &self.canonical(kind, target));
        let kind_key = kind.to_string();
        let entries = self.entries.lock();
        entries
            .iter()
            .find(|(key, _)| key == &specific)
            .or_else(|| entries.iter().find(|(key, _)| key == &kind_key))
            .map(|(_, executor)| Arc::clone(executor))
    }

    pub fn entries(&self) -> Vec<RegistryEntry> {
        self.entries
            .lock()
            .iter()
            .map(|(key, executor)| RegistryEntry {
                key: key.clone(),
                executor: Arc::clone(executor),
            })
            .collect()
    }

    pub fn harnesses(&self) -> Vec<HarnessCoverage> {
        let entries = self.entries.lock();
        harness_executor_coverage(|harness_id| {
            let key = registry_key("harness-session", &Some(harness_id.to_string()));
            entries
                .iter()
                .find(|(entry, _)| entry == &key)
                .map(|(_, executor)| Arc::clone(executor))
        })
    }

    fn canonical(&self, kind: &str, target: Option<&str>) -> Option<String> {
        if kind != "harness-session" {
            return target.map(str::to_string);
        }
        let resolved = canonicalize_executor_target(target);
        if let (Some(alias), Some(canonical)) = (resolved.deprecated_alias, resolved.target.clone())
        {
            let mut warned = self.warned.lock();
            if warned.insert(alias.clone()) {
                if let Some(callback) = self.on_deprecated.lock().clone() {
                    callback(&alias, &canonical);
                } else {
                    tracing::warn!(
                        "executor target \"{alias}\" is deprecated and maps to \"{canonical}\" — update callers; the alias will be removed once no queued task names it."
                    );
                }
            }
        }
        resolved.target
    }
}

fn registry_key(kind: &str, target: &Option<String>) -> String {
    match target {
        Some(target) => format!("{kind}:{target}"),
        None => kind.to_string(),
    }
}

pub fn create_executor_registry(on_deprecated: Option<DeprecatedHook>) -> ExecutorRegistry {
    ExecutorRegistry::new(on_deprecated)
}
