use std::path::Path;

use protocol::js::js_trim;
use serde_json::{Map, Value};

use crate::error::{ContractReason, ContractValidationIssue, WorkflowError};
use crate::io_fs::{read_string, try_exists};
use crate::pathutil::node_join_paths;
use crate::types::{Field, FieldType, OutlineStep, WorkflowBudgets, WorkflowManifest};

const FIELD_TYPES: &[&str] = &["string", "number", "boolean", "json", "file"];

pub fn parse_manifest(raw: &Value) -> Result<WorkflowManifest, WorkflowError> {
    let Some(object) = raw.as_object() else {
        return Err(WorkflowError::message(
            "workflow.yaml: root must be an object",
        ));
    };
    let id = require_string(object, "id")?;
    let version = require_string(object, "version")?;
    let name = require_string(object, "name")?;
    let description = optional_string(object, "description")?;
    let input = parse_fields(object.get("input"), "input")?;
    let output = match object.get("output") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => parse_fields(Some(value), "output")?,
    };
    let outline = parse_outline(object.get("outline"))?;
    let budgets = parse_budgets(object.get("budgets"))?;
    Ok(WorkflowManifest {
        id,
        version,
        name,
        description,
        input,
        output,
        outline,
        budgets,
    })
}

pub async fn load_manifest_file(workflow_dir: &Path) -> Result<WorkflowManifest, WorkflowError> {
    let path = node_join_paths(workflow_dir, "workflow.yaml");
    if !try_exists(&path).await? {
        return Err(WorkflowError::message(format!(
            "workflow.yaml not found in {}",
            workflow_dir.display()
        )));
    }
    let text = read_string(&path).await?;
    let raw: Value =
        serde_saphyr::from_str(&text).map_err(|err| WorkflowError::message(err.to_string()))?;
    parse_manifest(&raw)
}

pub async fn validate_input_contract(
    fields: &[Field],
    input: &Map<String, Value>,
    case_dir: Option<&Path>,
    check_files: bool,
) -> Result<(), WorkflowError> {
    let mut issues = Vec::new();
    for field in fields {
        let value = input.get(&field.name);
        if value.is_none() || value.is_some_and(Value::is_null) {
            if field.is_required() {
                issues.push(missing_issue(field));
            }
            continue;
        }
        let Some(value) = value else {
            continue;
        };
        if let Some(issue) = check_type(field, value) {
            issues.push(issue);
        }
        if field.field_type == FieldType::File
            && check_files
            && let Some(case_dir) = case_dir
            && let Some(rel) = value.as_str()
        {
            let abs = node_join_paths(case_dir, rel);
            if !try_exists(&abs).await? {
                issues.push(ContractValidationIssue {
                    field: field.name.clone(),
                    reason: ContractReason::FileMissing,
                    message: format!(
                        "file field \"{}\" path \"{rel}\" does not exist under caseDir",
                        field.name
                    ),
                });
            }
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::contract(issues))
    }
}

pub fn validate_start_input(
    fields: &[Field],
    input: &Map<String, Value>,
) -> Result<(), WorkflowError> {
    let mut issues = Vec::new();
    for field in fields {
        let value = input.get(&field.name);
        let missing = match value {
            None => true,
            Some(Value::Null) => true,
            Some(Value::String(text)) if text.is_empty() => true,
            Some(_) => false,
        };
        if missing {
            if field.is_required() {
                issues.push(missing_issue(field));
            }
            continue;
        }
        let Some(value) = value else {
            continue;
        };
        if let Some(issue) = check_type(field, value) {
            issues.push(issue);
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(WorkflowError::contract(issues))
    }
}

fn missing_issue(field: &Field) -> ContractValidationIssue {
    ContractValidationIssue {
        field: field.name.clone(),
        reason: ContractReason::Missing,
        message: format!(
            "required {} field \"{}\" is missing",
            field.field_type.as_str(),
            field.name
        ),
    }
}

fn check_type(field: &Field, value: &Value) -> Option<ContractValidationIssue> {
    let got = js_typeof(value);
    let mismatch = |expected: &str| ContractValidationIssue {
        field: field.name.clone(),
        reason: ContractReason::TypeMismatch,
        message: format!("field \"{}\" expected {expected}, got {got}", field.name),
    };
    match field.field_type {
        FieldType::String | FieldType::File => {
            if !value.is_string() {
                Some(mismatch("string"))
            } else {
                None
            }
        }
        FieldType::Number => {
            if !value.is_number() {
                Some(mismatch("number"))
            } else {
                None
            }
        }
        FieldType::Boolean => {
            if !value.is_boolean() {
                Some(mismatch("boolean"))
            } else {
                None
            }
        }
        FieldType::Json => None,
    }
}

pub fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::Null => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) | Value::Object(_) => "object",
    }
}

fn require_string(object: &Map<String, Value>, key: &str) -> Result<String, WorkflowError> {
    match object.get(key) {
        Some(Value::String(value)) if !js_trim(value).is_empty() => Ok(value.clone()),
        _ => Err(WorkflowError::message(format!(
            "workflow.yaml: \"{key}\" must be a non-empty string"
        ))),
    }
}

fn optional_string(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, WorkflowError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(WorkflowError::message(format!(
            "workflow.yaml: \"{key}\" must be a string"
        ))),
    }
}

fn parse_fields(raw: Option<&Value>, path: &str) -> Result<Vec<Field>, WorkflowError> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = raw.as_array() else {
        return Err(WorkflowError::message(format!(
            "workflow.yaml: \"{path}\" must be an array"
        )));
    };
    let mut fields = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            return Err(WorkflowError::message(format!(
                "workflow.yaml: {path}[{index}] must be an object"
            )));
        };
        let name = match object.get("name") {
            Some(Value::String(name)) if !name.is_empty() => name.clone(),
            _ => {
                return Err(WorkflowError::message(format!(
                    "workflow.yaml: {path}[{index}].name must be a non-empty string"
                )));
            }
        };
        let field_type = match object.get("type").and_then(Value::as_str) {
            Some(text) => FieldType::parse(text).ok_or_else(|| {
                WorkflowError::message(format!(
                    "workflow.yaml: {path}[{index}].type must be one of {}",
                    FIELD_TYPES.join("|")
                ))
            })?,
            None => {
                return Err(WorkflowError::message(format!(
                    "workflow.yaml: {path}[{index}].type must be one of {}",
                    FIELD_TYPES.join("|")
                )));
            }
        };
        let required = match object.get("required") {
            Some(Value::Bool(value)) => Some(*value),
            _ => None,
        };
        let description = match object.get("description") {
            Some(Value::String(value)) => Some(value.clone()),
            _ => None,
        };
        fields.push(Field {
            name,
            field_type,
            required,
            description,
        });
    }
    Ok(fields)
}

fn parse_outline(raw: Option<&Value>) -> Result<Option<Vec<OutlineStep>>, WorkflowError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let Some(items) = raw.as_array() else {
        return Err(WorkflowError::message(
            "workflow.yaml: outline must be an array",
        ));
    };
    let mut steps = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            return Err(WorkflowError::message(format!(
                "workflow.yaml: outline[{index}] must be an object"
            )));
        };
        let id = match object.get("id") {
            Some(Value::String(id)) => id.clone(),
            _ => {
                return Err(WorkflowError::message(format!(
                    "workflow.yaml: outline[{index}].id must be a string"
                )));
            }
        };
        steps.push(OutlineStep {
            id,
            label: object
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string),
            kind: object
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_string),
            description: object
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Ok(Some(steps))
}

fn parse_budgets(raw: Option<&Value>) -> Result<Option<WorkflowBudgets>, WorkflowError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let Some(object) = raw.as_object() else {
        return Err(WorkflowError::message(
            "workflow.yaml: budgets must be an object",
        ));
    };
    Ok(Some(WorkflowBudgets {
        max_tokens: number_field(object, "maxTokens"),
        max_cost: number_field(object, "maxCost"),
        max_concurrent_runs: number_field(object, "maxConcurrentRuns"),
    }))
}

fn number_field(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object.get(key).and_then(Value::as_f64)
}
