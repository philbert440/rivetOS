use std::cmp::Ordering;
use std::future::Future;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

use protocol::JsNumber;

use crate::error::PresetError;
use crate::preset::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentRegistryBackend, HarnessPatch, SortPatch,
    migrate_fields, name_key, require_agent_name,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type LogCallback = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub fn box_future<'a, T>(future: impl Future<Output = T> + Send + 'a) -> BoxFuture<'a, T> {
    Box::pin(future)
}

pub fn system_now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

pub fn sort_presets(presets: Vec<AgentPreset>) -> Vec<AgentPreset> {
    let mut presets = presets;
    presets.sort_by(compare_presets);
    presets
}

fn compare_presets(left: &AgentPreset, right: &AgentPreset) -> Ordering {
    match (left.sort_order, right.sort_order) {
        (None, None) => {}
        (None, Some(_)) => return Ordering::Greater,
        (Some(_), None) => return Ordering::Less,
        (Some(left_order), Some(right_order)) => {
            let order = left_order.cmp(&right_order);
            if order != Ordering::Equal {
                return order;
            }
        }
    }
    match left
        .created_at
        .as_f64()
        .partial_cmp(&right.created_at.as_f64())
    {
        Some(Ordering::Equal) | None => {}
        Some(order) => return order,
    }
    left.id.cmp(&right.id)
}

pub fn find_preset_by_handle<'a>(
    presets: &'a [AgentPreset],
    handle: &str,
) -> Option<&'a AgentPreset> {
    let trimmed = protocol::js::js_trim(handle);
    presets
        .iter()
        .find(|preset| preset.id == trimmed)
        .or_else(|| presets.iter().find(|preset| preset.name == trimmed))
        .or_else(|| {
            let key = name_key(trimmed);
            presets.iter().find(|preset| name_key(&preset.name) == key)
        })
}

pub fn preset_from_create(
    input: &AgentPresetInput,
    id: &str,
    now: i64,
) -> Result<AgentPreset, PresetError> {
    let name = require_agent_name(&input.name)?;
    let harness = input
        .harness_id
        .as_deref()
        .filter(|value| !value.is_empty());
    let model = input.model.clone().unwrap_or_default();
    let migrated = migrate_fields(&model, harness);
    Ok(AgentPreset {
        id: input.id.clone().unwrap_or_else(|| id.to_string()),
        name,
        color: input.color.clone().unwrap_or_default(),
        harness_id: migrated.harness_id,
        model: migrated.model,
        effort: input.effort.clone().unwrap_or_else(|| "medium".to_string()),
        system_prompt: input.system_prompt.clone().unwrap_or_default(),
        node: Some(input.node.clone()),
        directory: Some(input.directory.clone()),
        shared_link: Some(input.shared_link.unwrap_or(true)),
        node_base_url: Some(input.node_base_url.clone().unwrap_or_default()),
        sort_order: None,
        created_at: JsNumber::from(input.created_at.unwrap_or(now)),
        updated_at: JsNumber::from(now),
    })
}

pub fn preset_from_patch(
    current: &AgentPreset,
    patch: &AgentPresetPatch,
    now: i64,
) -> Result<AgentPreset, PresetError> {
    let mut next = current.clone();
    next.updated_at = JsNumber::from(now);
    if let Some(name) = &patch.name {
        next.name = require_agent_name(name)?;
    }
    if let Some(color) = &patch.color {
        next.color = color.clone();
    }
    if let Some(model) = &patch.model {
        next.model = model.clone();
    }
    if let Some(effort) = &patch.effort {
        next.effort = effort.clone();
    }
    if let Some(system_prompt) = &patch.system_prompt {
        next.system_prompt = system_prompt.clone();
    }
    if let Some(directory) = &patch.directory {
        next.directory = Some(directory.clone());
    }
    if let Some(shared_link) = patch.shared_link {
        next.shared_link = Some(shared_link);
    }
    match patch.sort_order {
        SortPatch::Unchanged => {}
        SortPatch::Clear => next.sort_order = None,
        SortPatch::Set(value) => next.sort_order = Some(value),
    }
    if let Some(url) = &patch.node_base_url {
        next.node_base_url = Some(url.clone());
    }
    match &patch.harness {
        HarnessPatch::Unchanged => {}
        HarnessPatch::Clear => next.harness_id = None,
        HarnessPatch::Set(id) => next.harness_id = Some(id.clone()),
    }
    let migrated = migrate_fields(&next.model, next.harness_id.as_deref());
    next.model = migrated.model;
    next.harness_id = migrated.harness_id;
    Ok(next)
}

pub trait AgentPresetStore: Send + Sync {
    fn backend(&self) -> AgentRegistryBackend;
    fn file(&self) -> Option<String>;
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>>;
    fn list(&self, node: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>>;
    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>>;
    fn find_by_handle(
        &self,
        handle: &str,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>>;
    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>>;
    fn update(
        &self,
        id: &str,
        patch: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>>;
    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>>;
}
