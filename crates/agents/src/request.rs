use protocol::js::{JsObject, JsString, JsValue, js_trim, js_trim_units};
use serde_json::Value;

use crate::error::{
    AgentRequestError, COLOR_HEX, DIRECTORY_ABS, EFFORT_TOKEN, HARNESS_KNOWN, INVALID_JSON,
    MODEL_MAX, NAME_MAX, NODE_BASE_URL_MAX, NODE_IMMUTABLE, SYSTEM_PROMPT_MAX_CHARS, UNNAMED_AGENT,
    hosted_elsewhere_message, hosting_node_message, model_list_message, model_list_warning,
    sort_order_message,
};
use crate::preset::{AgentPreset, AgentPresetInput, AgentPresetPatch, HarnessPatch, SortPatch};
use crate::validate::{
    ParsedHarness, cap_units, default_directory_for, directory_warnings, expand_home, has_dot_dot,
    is_codex_default_model, parse_color, parse_effort, parse_harness_id, validate_directory_str,
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
    pub name: JsString,
    pub input: AgentPresetInput,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct ValidatedPatch {
    pub name: JsString,
    pub patch: AgentPresetPatch,
    pub warnings: Vec<String>,
    pub materialize: bool,
}

pub fn validate_create(
    raw: &JsValue,
    ctx: &ValidateCtx<'_>,
) -> Result<ValidatedCreate, AgentRequestError> {
    let raw = object(raw)?;
    let name = create_name(raw.get("name"));
    let color = require_color(raw.get("color"))?;
    let effort = require_effort(raw.get("effort"))?;
    let harness_id = require_harness(raw.get("harnessId"), ctx)?;
    let model = trimmed_units(raw.get("model"), MODEL_MAX);
    let system_prompt = trimmed_units(raw.get("systemPrompt"), SYSTEM_PROMPT_MAX_CHARS);
    let node_base_url = trimmed_units(raw.get("nodeBaseUrl"), NODE_BASE_URL_MAX);
    if let Some(node) = raw.get("node").and_then(JsValue::as_js_string) {
        let trimmed = js_trim(node.to_utf8());
        if !trimmed.is_empty() && trimmed != ctx.node_name {
            return Err(AgentRequestError::bad(hosting_node_message(ctx.node_name)));
        }
    }
    let shared_link = raw
        .get("sharedLink")
        .and_then(JsValue::as_bool)
        .unwrap_or(true);
    let directory = resolve_directory(raw.get("directory"), name.to_utf8(), ctx)?;
    let mut warnings = directory_warnings(&directory, ctx.shared_dir);
    vet_model(
        harness_id.as_deref(),
        model.to_utf8(),
        name.to_utf8(),
        ctx,
        &mut warnings,
    )?;
    Ok(ValidatedCreate {
        name: name.clone(),
        input: AgentPresetInput {
            name,
            color: Some(color.into()),
            harness_id: harness_id.map(JsString::from),
            model: Some(model),
            effort: Some(effort.into()),
            system_prompt: Some(system_prompt),
            node: JsString::from_text(ctx.node_name),
            directory: JsString::from_text(&directory),
            shared_link: Some(shared_link),
            node_base_url: Some(node_base_url),
            id: None,
            created_at: None,
            source: None,
        },
        warnings,
    })
}

pub fn validate_patch(
    raw: &JsValue,
    existing: &AgentPreset,
    ctx: &ValidateCtx<'_>,
) -> Result<ValidatedPatch, AgentRequestError> {
    let raw = object(raw)?;
    let stored_owned = existing
        .node
        .as_ref()
        .map(|node| js_trim(node.to_utf8()).to_string())
        .filter(|value| !value.is_empty());
    let stored_node = stored_owned.as_deref().unwrap_or(ctx.node_name);
    if let Some(node) = raw.get("node") {
        let next = node.as_js_string().map(|text| js_trim(text.to_utf8()));
        if next != Some(stored_node) {
            return Err(AgentRequestError::bad(NODE_IMMUTABLE));
        }
    }
    let mut patch = AgentPresetPatch::default();
    let mut name = existing.name.clone();
    if let Some(raw_name) = raw.get("name").and_then(JsValue::as_js_string) {
        let trimmed = js_trim_units(raw_name.units());
        if !trimmed.is_empty() {
            name = cap_units(trimmed, NAME_MAX);
            patch.name = Some(name.clone());
        }
    }
    if raw.contains_key("color") {
        patch.color = Some(require_color(raw.get("color"))?.into());
    }
    if let Some(text) = raw.get("model").and_then(JsValue::as_js_string) {
        patch.model = Some(cap_units(js_trim_units(text.units()), MODEL_MAX));
    }
    if raw.contains_key("effort") {
        patch.effort = Some(require_effort(raw.get("effort"))?.into());
    }
    if raw.contains_key("harnessId") {
        patch.harness = patch_harness(raw.get("harnessId"), ctx)?;
    }
    if let Some(text) = raw.get("systemPrompt").and_then(JsValue::as_js_string) {
        patch.system_prompt = Some(cap_units(
            js_trim_units(text.units()),
            SYSTEM_PROMPT_MAX_CHARS,
        ));
    }
    if raw.contains_key("sortOrder") {
        patch.sort_order = parse_sort(raw.get("sortOrder"))?;
    }
    let stored_directory = match &existing.directory {
        Some(value) => value.clone(),
        None => JsString::from_text(""),
    };
    let stored_shared = existing.shared_link != Some(false);
    let directory_changed = match raw.get("directory") {
        None => false,
        Some(JsValue::String(text)) => js_trim_units(text.units()) != stored_directory.units(),
        Some(_) => true,
    };
    let shared_changed = match raw.get("sharedLink").and_then(JsValue::as_bool) {
        Some(value) => value != stored_shared,
        None => false,
    };
    let placement = directory_changed || shared_changed;
    let hosted_on = existing
        .node
        .as_ref()
        .map(|node| js_trim(node.to_utf8()).to_string())
        .unwrap_or_default();
    if placement && !hosted_on.is_empty() && hosted_on != ctx.node_name {
        return Err(AgentRequestError::conflict(hosted_elsewhere_message(
            existing.name.to_utf8(),
            &hosted_on,
        )));
    }
    let mut warnings = Vec::new();
    let mut materialize = false;
    if placement {
        apply_placement(
            raw,
            existing,
            name.to_utf8(),
            &mut patch,
            ctx,
            &mut warnings,
        )?;
        materialize = true;
    }
    let next_harness = match &patch.harness {
        HarnessPatch::Clear => None,
        HarnessPatch::Set(id) => Some(id.as_str()),
        HarnessPatch::Unchanged => existing.harness_id.as_ref().map(JsString::to_utf8),
    };
    let next_model = patch
        .model
        .clone()
        .unwrap_or_else(|| existing.model.clone());
    let pair_changed = next_harness != existing.harness_id.as_ref().map(JsString::to_utf8)
        || next_model != existing.model;
    if pair_changed {
        vet_model(
            next_harness,
            next_model.to_utf8(),
            name.to_utf8(),
            ctx,
            &mut warnings,
        )?;
    }
    Ok(ValidatedPatch {
        name,
        patch,
        warnings,
        materialize,
    })
}

fn apply_placement(
    raw: &JsObject,
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
        let directory_js = JsString::from_text(&directory);
        if existing.directory.as_ref() != Some(&directory_js) {
            patch.directory = Some(directory_js.clone());
        }
        next_directory = Some(directory_js);
    }
    if let Some(value) = raw.get("sharedLink").and_then(JsValue::as_bool)
        && value != next_shared
    {
        patch.shared_link = Some(value);
    }
    if next_directory.as_ref().is_none_or(JsString::is_empty) {
        let fallback = resolve_directory(None, name, ctx)?;
        patch.directory = Some(JsString::from_text(&fallback));
    }
    if let Some(directory) = patch.directory.as_ref().or(next_directory.as_ref()) {
        warnings.extend(directory_warnings(directory.to_utf8(), ctx.shared_dir));
    }
    Ok(())
}

fn object(raw: &JsValue) -> Result<&JsObject, AgentRequestError> {
    raw.as_object()
        .ok_or_else(|| AgentRequestError::bad(INVALID_JSON))
}

fn create_name(value: Option<&JsValue>) -> JsString {
    match value.and_then(JsValue::as_js_string) {
        Some(text) => {
            let trimmed = js_trim_units(text.units());
            if trimmed.is_empty() {
                JsString::from_text(UNNAMED_AGENT)
            } else {
                cap_units(trimmed, NAME_MAX)
            }
        }
        None => JsString::from_text(UNNAMED_AGENT),
    }
}

fn trimmed_units(value: Option<&JsValue>, max_units: usize) -> JsString {
    match value.and_then(JsValue::as_js_string) {
        Some(text) => cap_units(js_trim_units(text.units()), max_units),
        None => JsString::from_text(""),
    }
}

fn json_atom(value: &JsValue) -> Value {
    match value {
        JsValue::Null => Value::Null,
        JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        _ => Value::Array(Vec::new()),
    }
}

fn require_color(value: Option<&JsValue>) -> Result<String, AgentRequestError> {
    match value {
        None => Ok(String::new()),
        Some(value) => {
            parse_color(&json_atom(value)).ok_or_else(|| AgentRequestError::bad(COLOR_HEX))
        }
    }
}

fn require_effort(value: Option<&JsValue>) -> Result<String, AgentRequestError> {
    match value {
        None => Ok("medium".to_string()),
        Some(value) => {
            parse_effort(&json_atom(value)).ok_or_else(|| AgentRequestError::bad(EFFORT_TOKEN))
        }
    }
}

fn require_harness(
    value: Option<&JsValue>,
    ctx: &ValidateCtx<'_>,
) -> Result<Option<String>, AgentRequestError> {
    let adapted = value.map(json_atom);
    match parse_harness_id(adapted.as_ref()) {
        ParsedHarness::Absent => Ok(None),
        ParsedHarness::Bad => Err(AgentRequestError::bad(HARNESS_KNOWN)),
        ParsedHarness::Id(id) => {
            ensure_allowed(id, ctx)?;
            Ok(Some(id.to_string()))
        }
    }
}

fn patch_harness(
    value: Option<&JsValue>,
    ctx: &ValidateCtx<'_>,
) -> Result<HarnessPatch, AgentRequestError> {
    let adapted = value.map(json_atom);
    match parse_harness_id(adapted.as_ref()) {
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

fn parse_sort(value: Option<&JsValue>) -> Result<SortPatch, AgentRequestError> {
    let Some(value) = value else {
        return Ok(SortPatch::Clear);
    };
    if value.is_null() {
        return Ok(SortPatch::Clear);
    }
    let Some(number) = value.as_f64() else {
        return Err(AgentRequestError::bad(sort_order_message()));
    };
    let max = crate::error::AGENT_SORT_ORDER_MAX as f64;
    if number.is_finite() && number.fract() == 0.0 && (0.0..=max).contains(&number) {
        return Ok(SortPatch::Set(number as i64));
    }
    Err(AgentRequestError::bad(sort_order_message()))
}

fn resolve_directory(
    raw: Option<&JsValue>,
    name: &str,
    ctx: &ValidateCtx<'_>,
) -> Result<String, AgentRequestError> {
    let resolved = match raw {
        None => validate_directory_str(Some(&default_directory_for(ctx.directory_root, name))),
        Some(JsValue::String(text)) if js_trim(text.to_utf8()).is_empty() => {
            validate_directory_str(Some(&default_directory_for(ctx.directory_root, name)))
        }
        Some(JsValue::String(text)) => {
            let trimmed = js_trim(text.to_utf8());
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
