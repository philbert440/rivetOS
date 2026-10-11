use std::sync::Arc;

use protocol::HARNESS_IDS;
use protocol::JsNumber;
use protocol::js::{JsValue, js_trim};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::PresetError;
use crate::js_row::{
    entries_of, js_f64, js_i64, js_str, js_string, object_from_entries, object_from_pairs,
    remove_key, serde_to_js, upsert,
};
use crate::validate::is_harness_id;

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
    #[serde(skip)]
    pub document: Option<Arc<JsValue>>,
}

impl AgentPreset {
    pub fn created_at_ms(&self) -> f64 {
        self.created_at.as_f64()
    }

    pub fn updated_at_ms(&self) -> f64 {
        self.updated_at.as_f64()
    }

    pub fn document_json(&self) -> String {
        if let Some(document) = &self.document {
            return protocol::js::stringify(document);
        }
        protocol::js::stringify(&synthesized_document(self))
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
    Ok(JsNumber::from(ms))
}

pub fn json_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
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

pub fn preset_from_map(map: &Map<String, Value>) -> Result<AgentPreset, PresetError> {
    preset_from_js(&serde_to_js(&Value::Object(map.clone())))
}

pub fn preset_from_js(row: &JsValue) -> Result<AgentPreset, PresetError> {
    let migrated = migrate_row(row)?;
    preset_from_migrated(&migrated)
}

pub fn migrate_row(row: &JsValue) -> Result<JsValue, PresetError> {
    let Some(object) = row.as_object() else {
        return Err(PresetError::message("preset row is not an object"));
    };
    if object
        .get("harnessId")
        .and_then(JsValue::as_str)
        .is_some_and(|id| !id.is_empty())
    {
        return Ok(row.clone());
    }
    let model = object.get("model").and_then(JsValue::as_str).unwrap_or("");
    let Some(harness) = catalog_agent_to_harness(model) else {
        return Ok(row.clone());
    };
    let mut entries = entries_of(row)?;
    upsert(&mut entries, "model", js_string(""));
    upsert(&mut entries, "harnessId", js_string(harness));
    object_from_entries(entries)
}

fn preset_from_migrated(migrated: &JsValue) -> Result<AgentPreset, PresetError> {
    let Some(object) = migrated.as_object() else {
        return Err(PresetError::message("preset row is not an object"));
    };
    let sort_order = object.get("sortOrder").and_then(js_i64);
    let created = object.get("createdAt").and_then(js_f64).unwrap_or(0.0);
    let updated = object.get("updatedAt").and_then(js_f64).unwrap_or(0.0);
    Ok(AgentPreset {
        id: js_str(migrated, "id").unwrap_or("").to_string(),
        name: js_str(migrated, "name").unwrap_or("").to_string(),
        color: js_str(migrated, "color").unwrap_or("").to_string(),
        harness_id: object
            .get("harnessId")
            .and_then(JsValue::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        model: js_str(migrated, "model").unwrap_or("").to_string(),
        effort: js_str(migrated, "effort").unwrap_or("").to_string(),
        system_prompt: js_str(migrated, "systemPrompt").unwrap_or("").to_string(),
        node: object
            .get("node")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        directory: object
            .get("directory")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        shared_link: object.get("sharedLink").and_then(JsValue::as_bool),
        node_base_url: object
            .get("nodeBaseUrl")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        sort_order,
        created_at: JsNumber::from(created),
        updated_at: JsNumber::from(updated),
        document: Some(Arc::new(migrated.clone())),
    })
}

pub(crate) struct PresetColumns<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub color: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub system_prompt: &'a str,
    pub node: &'a str,
    pub directory: &'a str,
    pub shared_link: bool,
    pub node_base_url: &'a str,
    pub created_at: JsNumber,
    pub updated_at: JsNumber,
    pub sort_order: Option<i64>,
    pub harness_id: Option<&'a str>,
}

pub(crate) fn preset_from_columns(columns: PresetColumns<'_>) -> Result<AgentPreset, PresetError> {
    let mut pairs = vec![
        ("id", js_string(columns.id)),
        ("name", js_string(columns.name)),
        ("color", js_string(columns.color)),
        ("model", js_string(columns.model)),
        ("effort", js_string(columns.effort)),
        ("systemPrompt", js_string(columns.system_prompt)),
        ("node", js_string(columns.node)),
        ("directory", js_string(columns.directory)),
        ("sharedLink", JsValue::Bool(columns.shared_link)),
        ("nodeBaseUrl", js_string(columns.node_base_url)),
        ("createdAt", JsValue::Number(columns.created_at.as_f64())),
        ("updatedAt", JsValue::Number(columns.updated_at.as_f64())),
    ];
    if let Some(order) = columns.sort_order {
        pairs.push(("sortOrder", JsValue::Number(order as f64)));
    }
    if let Some(harness) = columns.harness_id.filter(|value| is_harness_id(value)) {
        pairs.push(("harnessId", js_string(harness)));
    }
    preset_from_js(&object_from_pairs(pairs)?)
}

pub fn patch_stored_row(
    current: &JsValue,
    patch: &AgentPresetPatch,
    now: i64,
) -> Result<JsValue, PresetError> {
    let name = match &patch.name {
        Some(value) => Some(require_agent_name(value)?),
        None => None,
    };
    let mut entries = entries_of(current)?;
    upsert(&mut entries, "updatedAt", JsValue::Number(now as f64));
    if let Some(value) = name {
        upsert(&mut entries, "name", js_string(&value));
    }
    if let Some(value) = &patch.color {
        upsert(&mut entries, "color", js_string(value));
    }
    if let Some(value) = &patch.model {
        upsert(&mut entries, "model", js_string(value));
    }
    if let Some(value) = &patch.effort {
        upsert(&mut entries, "effort", js_string(value));
    }
    if let Some(value) = &patch.system_prompt {
        upsert(&mut entries, "systemPrompt", js_string(value));
    }
    if let Some(value) = &patch.directory {
        upsert(&mut entries, "directory", js_string(value));
    }
    if let Some(value) = patch.shared_link {
        upsert(&mut entries, "sharedLink", JsValue::Bool(value));
    }
    match patch.sort_order {
        SortPatch::Unchanged => {}
        SortPatch::Clear => remove_key(&mut entries, "sortOrder"),
        SortPatch::Set(value) => upsert(&mut entries, "sortOrder", JsValue::Number(value as f64)),
    }
    if let Some(value) = &patch.node_base_url {
        upsert(&mut entries, "nodeBaseUrl", js_string(value));
    }
    match &patch.harness {
        HarnessPatch::Unchanged => {}
        HarnessPatch::Clear => remove_key(&mut entries, "harnessId"),
        HarnessPatch::Set(value) => upsert(&mut entries, "harnessId", js_string(value)),
    }
    migrate_row(&object_from_entries(entries)?)
}

pub fn fresh_stored_row(
    input: &AgentPresetInput,
    id: &str,
    now: i64,
) -> Result<JsValue, PresetError> {
    let name = require_agent_name(&input.name)?;
    let mut pairs = vec![
        (
            "id",
            js_string(&input.id.clone().unwrap_or_else(|| id.to_string())),
        ),
        ("name", js_string(&name)),
        ("color", js_string(input.color.as_deref().unwrap_or(""))),
        ("model", js_string(input.model.as_deref().unwrap_or(""))),
        (
            "effort",
            js_string(input.effort.as_deref().unwrap_or("medium")),
        ),
        (
            "systemPrompt",
            js_string(input.system_prompt.as_deref().unwrap_or("")),
        ),
        (
            "nodeBaseUrl",
            js_string(input.node_base_url.as_deref().unwrap_or("")),
        ),
        (
            "createdAt",
            JsValue::Number(input.created_at.unwrap_or(now) as f64),
        ),
        ("updatedAt", JsValue::Number(now as f64)),
        (
            "sharedLink",
            JsValue::Bool(input.shared_link.unwrap_or(true)),
        ),
        ("node", js_string(&input.node)),
        ("directory", js_string(&input.directory)),
    ];
    if let Some(harness) = input
        .harness_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        pairs.push(("harnessId", js_string(harness)));
    }
    migrate_row(&object_from_pairs(pairs)?)
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

fn synthesized_document(preset: &AgentPreset) -> JsValue {
    let mut pairs = vec![
        ("id", js_string(&preset.id)),
        ("name", js_string(&preset.name)),
        ("color", js_string(&preset.color)),
        ("model", js_string(&preset.model)),
        ("effort", js_string(&preset.effort)),
        ("systemPrompt", js_string(&preset.system_prompt)),
    ];
    if let Some(value) = &preset.node_base_url {
        pairs.push(("nodeBaseUrl", js_string(value)));
    }
    pairs.push(("createdAt", JsValue::Number(preset.created_at.as_f64())));
    pairs.push(("updatedAt", JsValue::Number(preset.updated_at.as_f64())));
    if let Some(value) = preset.shared_link {
        pairs.push(("sharedLink", JsValue::Bool(value)));
    }
    if let Some(value) = &preset.node {
        pairs.push(("node", js_string(value)));
    }
    if let Some(value) = &preset.directory {
        pairs.push(("directory", js_string(value)));
    }
    if let Some(value) = &preset.harness_id {
        pairs.push(("harnessId", js_string(value)));
    }
    if let Some(value) = preset.sort_order {
        pairs.push(("sortOrder", JsValue::Number(value as f64)));
    }
    object_from_pairs(pairs).unwrap_or(JsValue::Null)
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
