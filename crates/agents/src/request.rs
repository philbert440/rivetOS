use protocol::js::js_trim;
use serde_json::Value;

use crate::error::{
    AgentRequestError, COLOR_HEX, DIRECTORY_ABS, EFFORT_TOKEN, HARNESS_KNOWN, INVALID_JSON,
    MODEL_MAX, NAME_MAX, NODE_BASE_URL_MAX, NODE_IMMUTABLE, SYSTEM_PROMPT_MAX_CHARS, UNNAMED_AGENT,
    hosted_elsewhere_message, hosting_node_message, model_list_message, model_list_warning,
    sort_order_message,
};
use crate::preset::{AgentPreset, AgentPresetInput, AgentPresetPatch, HarnessPatch, SortPatch};
use crate::validate::{
    ParsedHarness, default_directory_for, directory_warnings, expand_home, has_dot_dot,
    is_codex_default_model, parse_color, parse_effort, parse_harness_id, utf16_slice_owned,
    validate_directory_str,
};

pub type ModelListLookup<'a> = Option<&'a dyn Fn(&str) -> Option<ModelList>>;

pub struct ModelList {
    pub ids: Vec<String>,
    pub strict: bool,
    pub source: String,
}

pub struct ValidateCtx<'a> {
    pub node_name: &'a str,
    pub directory_root: &'a str,
    pub home: &'a str,
    pub shared_dir: Option<&'a str>,
    pub allow_harness: Option<&'a dyn Fn(&str) -> bool>,
    pub model_list: ModelListLookup<'a>,
}

#[derive(Debug)]
pub struct ValidatedCreate {
    pub name: String,
    pub input: AgentPresetInput,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct ValidatedPatch {
    pub name: String,
    pub patch: AgentPresetPatch,
    pub warnings: Vec<String>,
    pub materialize: bool,
}

pub fn validate_create(
    raw: &Value,
    ctx: &ValidateCtx<'_>,
) -> Result<ValidatedCreate, AgentRequestError> {
    let raw = object(raw)?;
    let name = create_name(raw.get("name"));
    let color = require_color(raw.get("color"))?;
    let effort = require_effort(raw.get("effort"))?;
    let harness_id = require_harness(raw.get("harnessId"), ctx)?;
    let model = trimmed_text(raw.get("model"), MODEL_MAX);
    let system_prompt = trimmed_text(raw.get("systemPrompt"), SYSTEM_PROMPT_MAX_CHARS);
    let node_base_url = trimmed_text(raw.get("nodeBaseUrl"), NODE_BASE_URL_MAX);
    if let Some(Value::String(node)) = raw.get("node") {
        let trimmed = js_trim(node);
        if !trimmed.is_empty() && trimmed != ctx.node_name {
            return Err(AgentRequestError::bad(hosting_node_message(ctx.node_name)));
        }
    }
    let shared_link = match raw.get("sharedLink") {
        Some(Value::Bool(value)) => *value,
        _ => true,
    };
    let directory = resolve_directory(raw.get("directory"), &name, ctx)?;
    let mut warnings = directory_warnings(&directory, ctx.shared_dir);
    vet_model(harness_id.as_deref(), &model, &name, ctx, &mut warnings)?;
    Ok(ValidatedCreate {
        name,
        input: AgentPresetInput {
            name: create_name(raw.get("name")),
            color: Some(color),
            harness_id,
            model: Some(model),
            effort: Some(effort),
            system_prompt: Some(system_prompt),
            node: ctx.node_name.to_string(),
            directory,
            shared_link: Some(shared_link),
            node_base_url: Some(node_base_url),
            id: None,
            created_at: None,
        },
        warnings,
    })
}

pub fn validate_patch(
    raw: &Value,
    existing: &AgentPreset,
    ctx: &ValidateCtx<'_>,
) -> Result<ValidatedPatch, AgentRequestError> {
    let raw = object(raw)?;
    let stored_node = existing
        .node
        .as_deref()
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(ctx.node_name);
    if let Some(node) = raw.get("node") {
        let next = node.as_str().map(js_trim);
        if next != Some(stored_node) {
            return Err(AgentRequestError::bad(NODE_IMMUTABLE));
        }
    }
    let mut patch = AgentPresetPatch::default();
    let mut name = existing.name.clone();
    if let Some(Value::String(raw_name)) = raw.get("name") {
        let trimmed = js_trim(raw_name);
        if !trimmed.is_empty() {
            name = utf16_slice_owned(trimmed, NAME_MAX);
            patch.name = Some(name.clone());
        }
    }
    if raw.contains_key("color") {
        patch.color = Some(require_color(raw.get("color"))?);
    }
    if let Some(Value::String(_)) = raw.get("model") {
        patch.model = Some(trimmed_text(raw.get("model"), MODEL_MAX));
    }
    if raw.contains_key("effort") {
        patch.effort = Some(require_effort(raw.get("effort"))?);
    }
    if raw.contains_key("harnessId") {
        patch.harness = patch_harness(raw.get("harnessId"), ctx)?;
    }
    if let Some(Value::String(_)) = raw.get("systemPrompt") {
        patch.system_prompt = Some(trimmed_text(
            raw.get("systemPrompt"),
            SYSTEM_PROMPT_MAX_CHARS,
        ));
    }
    if raw.contains_key("sortOrder") {
        patch.sort_order = parse_sort(raw.get("sortOrder"))?;
    }
    let stored_directory = existing.directory.clone().unwrap_or_default();
    let stored_shared = existing.shared_link != Some(false);
    let directory_changed = match raw.get("directory") {
        None => false,
        Some(Value::String(text)) => js_trim(text) != stored_directory,
        Some(_) => true,
    };
    let shared_changed = match raw.get("sharedLink") {
        Some(Value::Bool(value)) => *value != stored_shared,
        _ => false,
    };
    let placement = directory_changed || shared_changed;
    let hosted_on = existing
        .node
        .as_deref()
        .map(js_trim)
        .unwrap_or("")
        .to_string();
    if placement && !hosted_on.is_empty() && hosted_on != ctx.node_name {
        return Err(AgentRequestError::conflict(hosted_elsewhere_message(
            &existing.name,
            &hosted_on,
        )));
    }
    let mut warnings = Vec::new();
    let mut materialize = false;
    if placement {
        apply_placement(raw, existing, &name, &mut patch, ctx, &mut warnings)?;
        materialize = true;
    }
    let next_harness = match &patch.harness {
        HarnessPatch::Clear => None,
        HarnessPatch::Set(id) => Some(id.as_str()),
        HarnessPatch::Unchanged => existing.harness_id.as_deref(),
    };
    let next_model = patch
        .model
        .clone()
        .unwrap_or_else(|| existing.model.clone());
    let pair_changed =
        next_harness != existing.harness_id.as_deref() || next_model != existing.model;
    if pair_changed {
        vet_model(next_harness, &next_model, &name, ctx, &mut warnings)?;
    }
    Ok(ValidatedPatch {
        name,
        patch,
        warnings,
        materialize,
    })
}

fn apply_placement(
    raw: &serde_json::Map<String, Value>,
    existing: &AgentPreset,
    name: &str,
    patch: &mut AgentPresetPatch,
    ctx: &ValidateCtx<'_>,
    warnings: &mut Vec<String>,
) -> Result<(), AgentRequestError> {
    let mut next_directory = existing.directory.clone();
    let next_shared = existing.shared_link != Some(false);
    if raw.contains_key("directory") {
        let directory = resolve_directory(raw.get("directory"), name, ctx)?;
        if Some(directory.as_str()) != existing.directory.as_deref() {
            patch.directory = Some(directory.clone());
        }
        next_directory = Some(directory);
    }
    if let Some(Value::Bool(value)) = raw.get("sharedLink")
        && *value != next_shared
    {
        patch.shared_link = Some(*value);
    }
    if next_directory.as_deref().unwrap_or("").is_empty() {
        let fallback = resolve_directory(None, name, ctx)?;
        patch.directory = Some(fallback);
    }
    if let Some(directory) = patch.directory.as_deref().or(next_directory.as_deref()) {
        warnings.extend(directory_warnings(directory, ctx.shared_dir));
    }
    Ok(())
}

fn object(raw: &Value) -> Result<&serde_json::Map<String, Value>, AgentRequestError> {
    raw.as_object()
        .ok_or_else(|| AgentRequestError::bad(INVALID_JSON))
}

fn create_name(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() {
                UNNAMED_AGENT.to_string()
            } else {
                utf16_slice_owned(trimmed, NAME_MAX)
            }
        }
        _ => UNNAMED_AGENT.to_string(),
    }
}

fn trimmed_text(value: Option<&Value>, max_units: usize) -> String {
    match value {
        Some(Value::String(text)) => utf16_slice_owned(js_trim(text), max_units),
        _ => String::new(),
    }
}

fn require_color(value: Option<&Value>) -> Result<String, AgentRequestError> {
    match value {
        None => Ok(String::new()),
        Some(value) => parse_color(value).ok_or_else(|| AgentRequestError::bad(COLOR_HEX)),
    }
}

fn require_effort(value: Option<&Value>) -> Result<String, AgentRequestError> {
    match value {
        None => Ok("medium".to_string()),
        Some(value) => parse_effort(value).ok_or_else(|| AgentRequestError::bad(EFFORT_TOKEN)),
    }
}

fn require_harness(
    value: Option<&Value>,
    ctx: &ValidateCtx<'_>,
) -> Result<Option<String>, AgentRequestError> {
    match parse_harness_id(value) {
        ParsedHarness::Absent => Ok(None),
        ParsedHarness::Bad => Err(AgentRequestError::bad(HARNESS_KNOWN)),
        ParsedHarness::Id(id) => {
            ensure_allowed(id, ctx)?;
            Ok(Some(id.to_string()))
        }
    }
}

fn patch_harness(
    value: Option<&Value>,
    ctx: &ValidateCtx<'_>,
) -> Result<HarnessPatch, AgentRequestError> {
    match parse_harness_id(value) {
        ParsedHarness::Absent => Ok(HarnessPatch::Clear),
        ParsedHarness::Bad => Err(AgentRequestError::bad(HARNESS_KNOWN)),
        ParsedHarness::Id(id) => {
            ensure_allowed(id, ctx)?;
            Ok(HarnessPatch::Set(id.to_string()))
        }
    }
}

fn ensure_allowed(id: &str, ctx: &ValidateCtx<'_>) -> Result<(), AgentRequestError> {
    if let Some(allow) = ctx.allow_harness
        && !allow(id)
    {
        return Err(AgentRequestError::forbidden(id));
    }
    Ok(())
}

fn parse_sort(value: Option<&Value>) -> Result<SortPatch, AgentRequestError> {
    match value {
        Some(Value::Null) | None => Ok(SortPatch::Clear),
        Some(Value::Number(number))
            if crate::validate::json_is_integer(number)
                && crate::preset::number_to_i64(number).is_some_and(|value| {
                    (0..=crate::error::AGENT_SORT_ORDER_MAX).contains(&value)
                }) =>
        {
            Ok(SortPatch::Set(match crate::preset::number_to_i64(number) {
                Some(value) => value,
                None => return Err(AgentRequestError::bad(sort_order_message())),
            }))
        }
        _ => Err(AgentRequestError::bad(sort_order_message())),
    }
}

fn resolve_directory(
    raw: Option<&Value>,
    name: &str,
    ctx: &ValidateCtx<'_>,
) -> Result<String, AgentRequestError> {
    let resolved = match raw {
        None => validate_directory_str(Some(&default_directory_for(ctx.directory_root, name))),
        Some(Value::String(text)) if js_trim(text).is_empty() => {
            validate_directory_str(Some(&default_directory_for(ctx.directory_root, name)))
        }
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            if has_dot_dot(trimmed) {
                None
            } else {
                let expanded = expand_home(trimmed, ctx.home);
                if has_dot_dot(&expanded) {
                    None
                } else {
                    validate_directory_str(Some(&expanded))
                }
            }
        }
        Some(_) => None,
    };
    resolved.ok_or_else(|| AgentRequestError::bad(DIRECTORY_ABS))
}

fn vet_model(
    harness_id: Option<&str>,
    model: &str,
    name: &str,
    ctx: &ValidateCtx<'_>,
    warnings: &mut Vec<String>,
) -> Result<(), AgentRequestError> {
    let Some(harness_id) = harness_id else {
        return Ok(());
    };
    if model.is_empty() || is_codex_default_model(harness_id, model) {
        return Ok(());
    }
    let Some(lookup) = ctx.model_list else {
        return Ok(());
    };
    let Some(list) = lookup(harness_id) else {
        return Ok(());
    };
    if list.ids.is_empty() || list.ids.iter().any(|id| id == model) {
        return Ok(());
    }
    let detail = model_list_message(model, harness_id, &list.source);
    if list.strict {
        return Err(AgentRequestError::bad(detail));
    }
    warnings.push(model_list_warning(name, &detail));
    Ok(())
}
