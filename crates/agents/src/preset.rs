use std::sync::Arc;

use protocol::HARNESS_IDS;
use protocol::JsNumber;
use protocol::js::{JsString, JsValue, js_trim_units};
use serde::de::Deserializer;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Number, Value};

use crate::error::PresetError;
use crate::js_row::{
    entries_of, js_f64, js_from, js_i64, js_string, js_text, js_text_opt, object_from_entries,
    object_from_pairs, remove_key, upsert,
};
use crate::validate::is_harness_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPreset {
    pub id: JsString,
    pub name: JsString,
    pub color: JsString,
    pub harness_id: Option<JsString>,
    pub model: JsString,
    pub effort: JsString,
    pub system_prompt: JsString,
    pub node: Option<JsString>,
    pub directory: Option<JsString>,
    pub shared_link: Option<bool>,
    pub node_base_url: Option<JsString>,
    pub sort_order: Option<i64>,
    pub created_at: JsNumber,
    pub updated_at: JsNumber,
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

impl Serialize for AgentPreset {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match &self.document {
            Some(document) => document.as_ref().serialize(serializer),
            None => synthesized_document(self).serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for AgentPreset {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = JsValue::deserialize(deserializer)?;
        preset_from_js(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPresetInput {
    pub name: JsString,
    pub color: Option<JsString>,
    pub harness_id: Option<JsString>,
    pub model: Option<JsString>,
    pub effort: Option<JsString>,
    pub system_prompt: Option<JsString>,
    pub node: JsString,
    pub directory: JsString,
    pub shared_link: Option<bool>,
    pub node_base_url: Option<JsString>,
    pub id: Option<JsString>,
    pub created_at: Option<i64>,
    pub source: Option<Arc<JsValue>>,
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
    pub name: Option<JsString>,
    pub color: Option<JsString>,
    pub harness: HarnessPatch,
    pub model: Option<JsString>,
    pub effort: Option<JsString>,
    pub system_prompt: Option<JsString>,
    pub directory: Option<JsString>,
    pub shared_link: Option<bool>,
    pub sort_order: SortPatch,
    pub node_base_url: Option<JsString>,
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
    preset_from_js(&protocol::js::from_serde(&Value::Object(map.clone())))
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
        id: js_text(migrated, "id"),
        name: js_text(migrated, "name"),
        color: js_text(migrated, "color"),
        harness_id: js_text_opt(migrated, "harnessId").filter(|value| !value.is_empty()),
        model: js_text(migrated, "model"),
        effort: js_text(migrated, "effort"),
        system_prompt: js_text(migrated, "systemPrompt"),
        node: js_text_opt(migrated, "node"),
        directory: js_text_opt(migrated, "directory"),
        shared_link: object.get("sharedLink").and_then(JsValue::as_bool),
        node_base_url: js_text_opt(migrated, "nodeBaseUrl"),
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
        upsert(&mut entries, "name", js_from(&value));
    }
    if let Some(value) = &patch.color {
        upsert(&mut entries, "color", js_from(value));
    }
    if let Some(value) = &patch.model {
        upsert(&mut entries, "model", js_from(value));
    }
    if let Some(value) = &patch.effort {
        upsert(&mut entries, "effort", js_from(value));
    }
    if let Some(value) = &patch.system_prompt {
        upsert(&mut entries, "systemPrompt", js_from(value));
    }
    if let Some(value) = &patch.directory {
        upsert(&mut entries, "directory", js_from(value));
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
        upsert(&mut entries, "nodeBaseUrl", js_from(value));
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
    if let Some(source) = &input.source {
        return fresh_from_source(source, input, &name, id, now);
    }
    let stored_id = input.id.clone().unwrap_or_else(|| JsString::from_text(id));
    let mut pairs = vec![
        ("id", js_from(&stored_id)),
        ("name", js_from(&name)),
        ("color", optional_text(input.color.as_ref())),
        ("model", optional_text(input.model.as_ref())),
        (
            "effort",
            match &input.effort {
                Some(value) => js_from(value),
                None => js_string("medium"),
            },
        ),
        ("systemPrompt", optional_text(input.system_prompt.as_ref())),
        ("nodeBaseUrl", optional_text(input.node_base_url.as_ref())),
        (
            "createdAt",
            JsValue::Number(input.created_at.unwrap_or(now) as f64),
        ),
        ("updatedAt", JsValue::Number(now as f64)),
        (
            "sharedLink",
            JsValue::Bool(input.shared_link.unwrap_or(true)),
        ),
        ("node", js_from(&input.node)),
        ("directory", js_from(&input.directory)),
    ];
    if let Some(harness) = input.harness_id.as_ref().filter(|value| !value.is_empty()) {
        pairs.push(("harnessId", js_from(harness)));
    }
    migrate_row(&object_from_pairs(pairs)?)
}

fn optional_text(value: Option<&JsString>) -> JsValue {
    match value {
        Some(text) => js_from(text),
        None => js_string(""),
    }
}

fn fresh_from_source(
    source: &JsValue,
    input: &AgentPresetInput,
    name: &JsString,
    id: &str,
    now: i64,
) -> Result<JsValue, PresetError> {
    let mut entries = entries_of(source)?;
    let stored_id = input.id.clone().unwrap_or_else(|| JsString::from_text(id));
    upsert(&mut entries, "id", js_from(&stored_id));
    upsert(&mut entries, "name", js_from(name));
    upsert(&mut entries, "node", js_from(&input.node));
    upsert(&mut entries, "directory", js_from(&input.directory));
    upsert(&mut entries, "updatedAt", JsValue::Number(now as f64));
    if let Some(created) = input.created_at {
        upsert(&mut entries, "createdAt", JsValue::Number(created as f64));
    }
    if let Some(value) = &input.color {
        upsert(&mut entries, "color", js_from(value));
    }
    if let Some(value) = &input.model {
        upsert(&mut entries, "model", js_from(value));
    }
    if let Some(value) = &input.effort {
        upsert(&mut entries, "effort", js_from(value));
    }
    if let Some(value) = &input.system_prompt {
        upsert(&mut entries, "systemPrompt", js_from(value));
    }
    if let Some(value) = &input.node_base_url {
        upsert(&mut entries, "nodeBaseUrl", js_from(value));
    }
    if let Some(value) = input.shared_link {
        upsert(&mut entries, "sharedLink", JsValue::Bool(value));
    }
    if let Some(harness) = input.harness_id.as_ref().filter(|value| !value.is_empty()) {
        upsert(&mut entries, "harnessId", js_from(harness));
    }
    migrate_row(&object_from_entries(entries)?)
}

pub fn write_preset_fields(document: &mut JsValue, preset: &AgentPreset) {
    if document.as_object().is_none() {
        *document = synthesized_document(preset);
        return;
    }
    let Some(object) = document.as_object_mut() else {
        return;
    };
    object.insert("id", JsValue::String(preset.id.clone()));
    object.insert("name", JsValue::String(preset.name.clone()));
    object.insert("color", JsValue::String(preset.color.clone()));
    object.insert("model", JsValue::String(preset.model.clone()));
    object.insert("effort", JsValue::String(preset.effort.clone()));
    object.insert(
        "systemPrompt",
        JsValue::String(preset.system_prompt.clone()),
    );
    if let Some(url) = &preset.node_base_url {
        object.insert("nodeBaseUrl", JsValue::String(url.clone()));
    }
    object.insert("createdAt", JsValue::Number(preset.created_at.as_f64()));
    object.insert("updatedAt", JsValue::Number(preset.updated_at.as_f64()));
    match preset.shared_link {
        Some(value) => object.insert("sharedLink", JsValue::Bool(value)),
        None => {
            object.remove("sharedLink");
        }
    }
    match &preset.node {
        Some(value) => object.insert("node", JsValue::String(value.clone())),
        None => {
            object.remove("node");
        }
    }
    match &preset.directory {
        Some(value) => object.insert("directory", JsValue::String(value.clone())),
        None => {
            object.remove("directory");
        }
    }
    match &preset.harness_id {
        Some(value) => object.insert("harnessId", JsValue::String(value.clone())),
        None => {
            object.remove("harnessId");
        }
    }
    match preset.sort_order {
        Some(value) => object.insert("sortOrder", JsValue::Number(value as f64)),
        None => {
            object.remove("sortOrder");
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

pub fn fresh_preset_map(preset: &AgentPreset) -> JsValue {
    match &preset.document {
        Some(document) => document.as_ref().clone(),
        None => synthesized_document(preset),
    }
}

fn synthesized_document(preset: &AgentPreset) -> JsValue {
    let mut pairs = vec![
        ("id", js_from(&preset.id)),
        ("name", js_from(&preset.name)),
        ("color", js_from(&preset.color)),
        ("model", js_from(&preset.model)),
        ("effort", js_from(&preset.effort)),
        ("systemPrompt", js_from(&preset.system_prompt)),
    ];
    if let Some(value) = &preset.node_base_url {
        pairs.push(("nodeBaseUrl", js_from(value)));
    }
    pairs.push(("createdAt", JsValue::Number(preset.created_at.as_f64())));
    pairs.push(("updatedAt", JsValue::Number(preset.updated_at.as_f64())));
    if let Some(value) = preset.shared_link {
        pairs.push(("sharedLink", JsValue::Bool(value)));
    }
    if let Some(value) = &preset.node {
        pairs.push(("node", js_from(value)));
    }
    if let Some(value) = &preset.directory {
        pairs.push(("directory", js_from(value)));
    }
    if let Some(value) = &preset.harness_id {
        pairs.push(("harnessId", js_from(value)));
    }
    if let Some(value) = preset.sort_order {
        pairs.push(("sortOrder", JsValue::Number(value as f64)));
    }
    match object_from_pairs(pairs) {
        Ok(value) => value,
        Err(_) => JsValue::Null,
    }
}

pub fn name_key(name: &str) -> String {
    JsString::from_units(name_key_text(&JsString::from_text(name)))
        .to_utf8()
        .to_string()
}

pub fn name_key_text(name: &JsString) -> Vec<u16> {
    lowercase_units(js_trim_units(name.units()))
}

pub(crate) fn submitted_name(name: &JsString) -> String {
    let units = js_trim_units(name.units());
    let mut out = String::new();
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if is_high_surrogate(unit) {
            if let Some(low) = units.get(index + 1).copied()
                && is_low_surrogate(low)
                && let Some(ch) = decode_pair(unit, low)
            {
                out.push(ch);
                index += 2;
                continue;
            }
            push_unit_escape(&mut out, unit);
            index += 1;
            continue;
        }
        if is_low_surrogate(unit) {
            push_unit_escape(&mut out, unit);
            index += 1;
            continue;
        }
        if let Some(ch) = char::from_u32(u32::from(unit)) {
            out.push(ch);
        }
        index += 1;
    }
    out
}

fn lowercase_units(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut buf = String::new();
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if is_high_surrogate(unit) {
            if let Some(low) = units.get(index + 1).copied()
                && is_low_surrogate(low)
                && let Some(ch) = decode_pair(unit, low)
            {
                buf.push(ch);
                index += 2;
                continue;
            }
            flush_lower(&mut buf, &mut out);
            out.push(unit);
            index += 1;
            continue;
        }
        if is_low_surrogate(unit) {
            flush_lower(&mut buf, &mut out);
            out.push(unit);
            index += 1;
            continue;
        }
        if let Some(ch) = char::from_u32(u32::from(unit)) {
            buf.push(ch);
        }
        index += 1;
    }
    flush_lower(&mut buf, &mut out);
    out
}

fn flush_lower(buf: &mut String, out: &mut Vec<u16>) {
    if buf.is_empty() {
        return;
    }
    out.extend(buf.to_lowercase().encode_utf16());
    buf.clear();
}

fn push_unit_escape(out: &mut String, unit: u16) {
    out.push_str(&format!("\\u{unit:04x}"));
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

fn decode_pair(high: u16, low: u16) -> Option<char> {
    let code = 0x10000 + (((u32::from(high) - 0xD800) << 10) | (u32::from(low) - 0xDC00));
    char::from_u32(code)
}

pub fn require_agent_name(name: &JsString) -> Result<JsString, PresetError> {
    let trimmed = js_trim_units(name.units());
    if trimmed.is_empty() {
        return Err(PresetError::message(crate::error::AGENT_NAME_REQUIRED));
    }
    Ok(JsString::from_units(trimmed.to_vec()))
}

#[cfg(test)]
mod field_tests {
    use protocol::js::{JsString, parse, stringify};

    use super::{
        fresh_preset_map, name_key, name_key_text, preset_from_js, submitted_name,
        write_preset_fields,
    };

    #[test]
    fn field_writes_keep_unknown_keys_and_surrogate_units() {
        let document = parse(
            r##"{"id":"a","name":"N","color":"#000","model":"opus","effort":"medium","systemPrompt":"\ud83d","nodeBaseUrl":"","createdAt":1,"updatedAt":1,"displayMetadata":{"k":1}}"##,
        )
        .expect("document");
        let preset = preset_from_js(&document).expect("preset");
        let encoded = stringify(&fresh_preset_map(&preset));
        assert!(encoded.contains(r"\ud83d"), "{encoded}");
        assert!(encoded.contains("displayMetadata"), "{encoded}");
        let mut next = preset.clone();
        next.color = "#fff".into();
        let mut edited = fresh_preset_map(&preset);
        write_preset_fields(&mut edited, &next);
        let again = stringify(&edited);
        assert!(again.contains(r"\ud83d"), "{again}");
        assert!(again.contains("displayMetadata"), "{again}");
        assert!(again.contains("#fff"), "{again}");
        assert!(!again.contains("#000"), "{again}");
    }

    #[test]
    fn submitted_name_keeps_casing_and_distinct_surrogate_keys() {
        assert_eq!(name_key(" Alice "), "alice");
        assert_eq!(submitted_name(&JsString::from_text(" Alice ")), "Alice");
        assert_eq!(
            submitted_name(&JsString::from_units(vec![0xD83D])),
            "\\ud83d"
        );
        let mut smile = vec![u16::from(b'a'); 127];
        smile.push(0xD83D);
        let mut robot = vec![u16::from(b'a'); 127];
        robot.push(0xD83E);
        assert_ne!(
            name_key_text(&JsString::from_units(smile)),
            name_key_text(&JsString::from_units(robot))
        );
    }
}
