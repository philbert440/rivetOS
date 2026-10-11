use protocol::HARNESS_IDS;
use protocol::JsNumber;
use protocol::js::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::PresetError;
use crate::validate::{is_harness_id, json_is_integer};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreset {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_id: Option<String>,
    pub model: String,
    pub effort: String,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_link: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,
    pub created_at: JsNumber,
    pub updated_at: JsNumber,
}

impl AgentPreset {
    pub fn created_at_ms(&self) -> f64 {
        self.created_at.as_f64()
    }

    pub fn updated_at_ms(&self) -> f64 {
        self.updated_at.as_f64()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPresetInput {
    pub name: String,
    pub color: Option<String>,
    pub harness_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub system_prompt: Option<String>,
    pub node: String,
    pub directory: String,
    pub shared_link: Option<bool>,
    pub node_base_url: Option<String>,
    pub id: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum HarnessPatch {
    #[default]
    Unchanged,
    Clear,
    Set(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentPresetPatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub harness: HarnessPatch,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub system_prompt: Option<String>,
    pub directory: Option<String>,
    pub shared_link: Option<bool>,
    pub sort_order: SortPatch,
    pub node_base_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortPatch {
    #[default]
    Unchanged,
    Clear,
    Set(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRegistryBackend {
    Postgres,
    File,
}

impl AgentRegistryBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::File => "file",
        }
    }
}

pub fn catalog_agent_to_harness(id: &str) -> Option<&'static str> {
    if let Some(found) = HARNESS_IDS.iter().copied().find(|item| *item == id) {
        return Some(found);
    }
    match id {
        "claude" => Some("claude-code"),
        "grok" | "grok-fast" => Some("grok-build"),
        "kimi" => Some("kimi-code"),
        "hermes" => Some("hermes"),
        _ => None,
    }
}

pub fn catalog_pairs() -> Vec<(&'static str, &'static str)> {
    let mut pairs: Vec<(&'static str, &'static str)> = Vec::new();
    for id in HARNESS_IDS {
        if !pairs.iter().any(|(key, _)| *key == *id) {
            pairs.push((*id, *id));
        }
    }
    for (catalog, harness) in [
        ("claude", "claude-code"),
        ("grok", "grok-build"),
        ("grok-fast", "grok-build"),
        ("kimi", "kimi-code"),
        ("hermes", "hermes"),
    ] {
        if !pairs.iter().any(|(key, _)| *key == catalog) {
            pairs.push((catalog, harness));
        }
    }
    pairs
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigratedFields {
    pub model: String,
    pub harness_id: Option<String>,
}

pub fn migrate_fields(model: &str, harness_id: Option<&str>) -> MigratedFields {
    if let Some(id) = harness_id.filter(|id| !id.is_empty()) {
        return MigratedFields {
            model: model.to_string(),
            harness_id: Some(id.to_string()),
        };
    }
    match catalog_agent_to_harness(model) {
        Some(harness) => MigratedFields {
            model: String::new(),
            harness_id: Some(harness.to_string()),
        },
        None => MigratedFields {
            model: model.to_string(),
            harness_id: None,
        },
    }
}

pub fn epoch_ms(ms: i64) -> Result<JsNumber, PresetError> {
    if ms < 0 {
        return Err(PresetError::message(format!(
            "invalid preset timestamp: {ms}"
        )));
    }
    Ok(JsNumber::from(ms))
}

pub fn json_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn json_bool(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

pub fn number_to_i64(number: &Number) -> Option<i64> {
    if let Some(value) = number.as_i64() {
        return Some(value);
    }
    if let Some(value) = number.as_u64() {
        return i64::try_from(value).ok();
    }
    let value = number.as_f64()?;
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    if value < -9_223_372_036_854_775_808.0 || value >= 9_223_372_036_854_775_808.0 {
        return None;
    }
    Some(value as i64)
}

pub fn json_f64(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

fn harness_for_migrate(raw: Option<&str>) -> Option<&str> {
    match raw {
        Some(value) if is_harness_id(value) => Some(value),
        _ => None,
    }
}

pub fn preset_from_map(map: &Map<String, Value>) -> Result<AgentPreset, PresetError> {
    let model = json_string(map, "model").unwrap_or_default();
    let harness_raw = json_string(map, "harnessId").filter(|value| !value.is_empty());
    let migrated = migrate_fields(&model, harness_for_migrate(harness_raw.as_deref()));
    let created = json_f64(map, "createdAt").unwrap_or(0.0);
    let updated = json_f64(map, "updatedAt").unwrap_or(0.0);
    let sort_order = map.get("sortOrder").and_then(|value| match value {
        Value::Number(number) if json_is_integer(number) => number_to_i64(number),
        _ => None,
    });
    Ok(AgentPreset {
        id: json_string(map, "id").unwrap_or_default(),
        name: json_string(map, "name").unwrap_or_default(),
        color: json_string(map, "color").unwrap_or_default(),
        harness_id: migrated.harness_id,
        model: migrated.model,
        effort: json_string(map, "effort").unwrap_or_default(),
        system_prompt: json_string(map, "systemPrompt").unwrap_or_default(),
        node: json_string(map, "node"),
        directory: json_string(map, "directory"),
        shared_link: json_bool(map, "sharedLink"),
        node_base_url: json_string(map, "nodeBaseUrl"),
        sort_order,
        created_at: JsNumber::from(created),
        updated_at: JsNumber::from(updated),
    })
}

pub fn number_value(ms: i64) -> Value {
    Value::Number(Number::from(ms))
}

fn push_js_number(map: &mut Map<String, Value>, key: &str, number: JsNumber) {
    if let Some(ms) = number.as_i64() {
        map.insert(key.to_string(), number_value(ms));
        return;
    }
    if let Some(value) = Number::from_f64(number.as_f64()) {
        map.insert(key.to_string(), Value::Number(value));
    }
}

pub fn write_preset_fields(map: &mut Map<String, Value>, preset: &AgentPreset) {
    map.insert("id".to_string(), Value::String(preset.id.clone()));
    map.insert("name".to_string(), Value::String(preset.name.clone()));
    map.insert("color".to_string(), Value::String(preset.color.clone()));
    map.insert("model".to_string(), Value::String(preset.model.clone()));
    map.insert("effort".to_string(), Value::String(preset.effort.clone()));
    map.insert(
        "systemPrompt".to_string(),
        Value::String(preset.system_prompt.clone()),
    );
    if let Some(url) = &preset.node_base_url {
        map.insert("nodeBaseUrl".to_string(), Value::String(url.clone()));
    }
    push_js_number(map, "createdAt", preset.created_at);
    push_js_number(map, "updatedAt", preset.updated_at);
    match preset.shared_link {
        Some(value) => {
            map.insert("sharedLink".to_string(), Value::Bool(value));
        }
        None => {
            map.remove("sharedLink");
        }
    }
    match &preset.node {
        Some(value) => {
            map.insert("node".to_string(), Value::String(value.clone()));
        }
        None => {
            map.remove("node");
        }
    }
    match &preset.directory {
        Some(value) => {
            map.insert("directory".to_string(), Value::String(value.clone()));
        }
        None => {
            map.remove("directory");
        }
    }
    match &preset.harness_id {
        Some(value) => {
            map.insert("harnessId".to_string(), Value::String(value.clone()));
        }
        None => {
            map.remove("harnessId");
        }
    }
    match preset.sort_order {
        Some(value) => {
            map.insert("sortOrder".to_string(), number_value(value));
        }
        None => {
            map.remove("sortOrder");
        }
    }
}

pub fn migrate_map(map: &Map<String, Value>) -> Map<String, Value> {
    let mut next = map.clone();
    let model = json_string(map, "model").unwrap_or_default();
    let harness = json_string(map, "harnessId").filter(|value| !value.is_empty());
    if harness.as_deref().is_some_and(is_harness_id) {
        return next;
    }
    if harness.is_some() {
        next.remove("harnessId");
    }
    if let Some(hid) = catalog_agent_to_harness(&model) {
        next.insert("model".to_string(), Value::String(String::new()));
        next.insert("harnessId".to_string(), Value::String(hid.to_string()));
    }
    next
}

pub fn fresh_preset_map(preset: &AgentPreset) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("id".to_string(), Value::String(preset.id.clone()));
    map.insert("name".to_string(), Value::String(preset.name.clone()));
    map.insert("color".to_string(), Value::String(preset.color.clone()));
    map.insert("model".to_string(), Value::String(preset.model.clone()));
    map.insert("effort".to_string(), Value::String(preset.effort.clone()));
    map.insert(
        "systemPrompt".to_string(),
        Value::String(preset.system_prompt.clone()),
    );
    if let Some(url) = &preset.node_base_url {
        map.insert("nodeBaseUrl".to_string(), Value::String(url.clone()));
    }
    push_js_number(&mut map, "createdAt", preset.created_at);
    push_js_number(&mut map, "updatedAt", preset.updated_at);
    if let Some(value) = preset.shared_link {
        map.insert("sharedLink".to_string(), Value::Bool(value));
    }
    if let Some(value) = &preset.node {
        map.insert("node".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = &preset.directory {
        map.insert("directory".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = &preset.harness_id {
        map.insert("harnessId".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = preset.sort_order {
        map.insert("sortOrder".to_string(), number_value(value));
    }
    map
}

pub fn name_key(name: &str) -> String {
    js_trim(name).to_lowercase()
}

pub fn require_agent_name(name: &str) -> Result<String, PresetError> {
    let trimmed = js_trim(name);
    if trimmed.is_empty() {
        return Err(PresetError::message(crate::error::AGENT_NAME_REQUIRED));
    }
    Ok(trimmed.to_string())
}
