use std::collections::HashSet;

use parking_lot::Mutex;
use protocol::js::{JsString, JsValue, js_trim, js_trim_units};

use crate::js_row::{js_from, js_string, object_from_pairs};
use crate::preset::{AgentPreset, name_key};
use crate::store::find_preset_by_handle;

pub const DEFAULT_MAX_CHAIN_DEPTH: u32 = 3;
pub const DEFAULT_WAIT_MS: i64 = 1_800_000;
pub const MESH_REFRESH_TTL_MS: i64 = 30_000;
pub const ROSTER_READ_BOUND_MS: i64 = 2_000;
pub const DELEGATION_CACHE_TTL_MS: i64 = 300_000;
pub const NO_MESH_REGISTRY: &str = "no mesh registry";

#[derive(Debug)]
pub struct DelegationResolver {
    warned_efforts: Mutex<HashSet<String>>,
}

impl Default for DelegationResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl DelegationResolver {
    pub fn new() -> Self {
        Self {
            warned_efforts: Mutex::new(HashSet::new()),
        }
    }

    pub fn note_non_task_effort(&self, effort: &str) -> bool {
        self.warned_efforts.lock().insert(effort.to_string())
    }

    pub fn task_effort(&self, effort: &str) -> Option<&'static str> {
        let trimmed = js_trim(effort);
        if trimmed.is_empty() {
            return None;
        }
        match trimmed {
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            other => {
                if self.note_non_task_effort(other) {
                    tracing::warn!("{}", non_task_effort_message(other));
                }
                None
            }
        }
    }

    pub fn preset_task_spec(&self, preset: &AgentPreset, opts: &PresetTaskSpecOptions) -> JsValue {
        preset_task_spec_with(self, preset, opts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigAgentRef {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DelegationTarget {
    ConfigAgent { id: String },
    Preset(Box<AgentPreset>),
}

pub fn resolve_delegation_target(
    to_agent: &str,
    config_agents: &[ConfigAgentRef],
    presets: &[AgentPreset],
) -> Option<DelegationTarget> {
    if let Some(agent) = config_agents.iter().find(|agent| agent.id == to_agent) {
        return Some(DelegationTarget::ConfigAgent {
            id: agent.id.clone(),
        });
    }
    find_preset_by_handle(presets, to_agent)
        .cloned()
        .map(|preset| DelegationTarget::Preset(Box::new(preset)))
}

pub fn chain_depth_limited(chain_depth: u32, max_chain_depth: u32) -> bool {
    chain_depth >= max_chain_depth
}

pub fn chain_depth_limit_message(max: u32, from: &str, to: &str, chain_depth: u32) -> String {
    format!(
        "Delegation chain depth limit reached ({max}). Chain: {from} → {to} at depth {chain_depth}. Increase maxChainDepth in config if deeper chains are needed."
    )
}

pub fn preset_chain_depth(chain_depth: u32) -> u32 {
    chain_depth.saturating_add(1)
}

pub fn preset_chain_too_deep(depth: u32, max: u32) -> bool {
    depth > max
}

pub fn preset_chain_too_deep_message(
    depth: u32,
    max: u32,
    to_agent: &str,
    preset_node: Option<&str>,
    this_node: &str,
) -> String {
    let remote = preset_node.is_some_and(|node| !node.is_empty() && node != this_node);
    let kind = if remote {
        "mesh delegation"
    } else {
        "delegation"
    };
    format!("Delegation chain too deep ({depth} > {max}) — refusing {kind} to {to_agent}")
}

pub fn unknown_agent_message(
    to_agent: &str,
    config_ids: &[String],
    roster_names: &[String],
) -> String {
    let mut names = Vec::new();
    for id in config_ids {
        if !names.iter().any(|name| name == id) {
            names.push(id.clone());
        }
    }
    for name in roster_names {
        if !names.iter().any(|existing| existing == name) {
            names.push(name.clone());
        }
    }
    let listed = if names.is_empty() {
        "(none reachable)".to_string()
    } else {
        names.join(", ")
    };
    format!("Unknown agent: {to_agent}. Agents you can delegate to: {listed}")
}

pub fn no_harness_message(name: &str) -> String {
    format!("preset \"{name}\" has no harness configured")
}

pub fn no_hosting_node_message(name: &str) -> String {
    format!("preset \"{name}\" has no hosting node")
}

pub fn hosting_node_offline_message(node: &str) -> String {
    format!("hosting node \"{node}\" is offline or unknown")
}

pub fn no_mesh_registry_reach_message(node: &str) -> String {
    format!("no mesh registry; cannot reach node \"{node}\"")
}

pub fn no_shared_queue_message(name: &str, node: &str) -> String {
    format!("preset \"{name}\" lives on {node}; this node has no shared task queue")
}

pub fn not_runnable_message(name: &str) -> String {
    format!("preset \"{name}\" is not runnable")
}

pub fn gap_message(name: &str, harness_id: &str, where_node: &str, reason: &str) -> String {
    format!("agent \"{name}\" ({harness_id} on {where_node}): {reason}")
}

pub fn non_task_effort_message(effort: &str) -> String {
    format!(
        "preset effort \"{effort}\" is not a task effort (low|medium|high) — omitting it from the row"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PresetTaskSpecOptions {
    pub model: Option<String>,
    pub model_present: bool,
    pub mesh_from: Option<String>,
    pub delegation: Option<bool>,
    pub parent_session_id: Option<String>,
    pub owner: Option<String>,
}

fn preset_task_spec_with(
    resolver: &DelegationResolver,
    preset: &AgentPreset,
    opts: &PresetTaskSpecOptions,
) -> JsValue {
    let delegation = opts.delegation.unwrap_or(true);
    let model_source = if opts.model_present {
        JsString::from_text(opts.model.as_deref().unwrap_or(""))
    } else {
        preset.model.clone()
    };
    let trimmed_model = JsString::from_units(js_trim_units(model_source.units()).to_vec());
    let model = if trimmed_model.is_empty() {
        None
    } else {
        Some(trimmed_model)
    };
    let effort = resolver.task_effort(preset.effort.to_utf8());
    let system_prompt_append = if preset.system_prompt.is_empty() {
        None
    } else {
        Some(preset.system_prompt.clone())
    };
    let parent = opts
        .parent_session_id
        .as_deref()
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let owner = opts
        .owner
        .as_deref()
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut pairs = Vec::new();
    if delegation {
        pairs.push(("delegation", JsValue::Bool(true)));
    }
    pairs.push(("presetId", js_from(&preset.id)));
    pairs.push(("presetName", js_from(&preset.name)));
    if let Some(parent) = parent {
        pairs.push(("parentSessionId", js_string(&parent)));
    }
    if let Some(owner) = owner {
        pairs.push(("owner", js_string(&owner)));
    }
    if delegation
        && let Some(mesh_from) = opts.mesh_from.as_deref().filter(|value| !value.is_empty())
    {
        pairs.push(("meshFrom", js_string(mesh_from)));
    }
    if let Some(directory) = &preset.directory {
        pairs.push(("workingDir", js_from(directory)));
    }
    pairs.push((
        "sharedLink",
        JsValue::Bool(preset.shared_link.unwrap_or(true)),
    ));
    pairs.push((
        "excludeTools",
        JsValue::Array(vec![js_string("delegate_task")]),
    ));
    if let Some(model) = &model {
        pairs.push(("model", js_from(model)));
    }
    if let Some(effort) = effort {
        pairs.push(("effort", js_string(effort)));
    }
    if let Some(prompt) = &system_prompt_append {
        pairs.push(("systemPromptAppend", js_from(prompt)));
    }
    match object_from_pairs(pairs) {
        Ok(value) => value,
        Err(_) => JsValue::Null,
    }
}

pub fn preset_name_key(name: &str) -> String {
    name_key(name)
}
