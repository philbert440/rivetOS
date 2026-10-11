use serde_json::{Map, Value};

use super::Issues;
use super::value::is_positive_number;

pub(crate) struct TokenFields {
    pub command: &'static str,
    pub ttl: &'static str,
    pub timeout: &'static str,
}

pub(crate) fn validate_token_fields(
    obj: &Map<String, Value>,
    path: &str,
    label: &str,
    issues: &mut Issues,
    keys: TokenFields,
) {
    if let Some(raw) = obj.get(keys.command) {
        if raw.is_string() {
            issues.error(
                format!("{path}.{}", keys.command),
                format!(
                    "{label} {} must be an argv array (no shell string)",
                    keys.command
                ),
            );
        } else if !is_argv(raw) {
            issues.error(
                format!("{path}.{}", keys.command),
                format!(
                    "{label} {} must be a non-empty argv array of strings",
                    keys.command
                ),
            );
        }
    }

    check_millis(obj, path, label, issues, keys.ttl);
    check_millis(obj, path, label, issues, keys.timeout);

    if obj.contains_key(keys.command)
        && keys.command == "token_command"
        && obj.contains_key("api_key")
    {
        issues.warning(
            format!("{path}.{}", keys.command),
            format!("{label} has both api_key and token_command — token_command wins"),
        );
    }
    if obj.contains_key(keys.command)
        && keys.command == "embed_token_command"
        && obj.contains_key("embed_api_key")
    {
        issues.warning(
            format!("{path}.{}", keys.command),
            format!(
                "{label} has both embed_api_key and embed_token_command — embed_token_command wins"
            ),
        );
    }
    if obj.contains_key(keys.command)
        && keys.command == "tagger_token_command"
        && obj.contains_key("tagger_api_key")
    {
        issues.warning(
            format!("{path}.{}", keys.command),
            format!(
                "{label} has both tagger_api_key and tagger_token_command — tagger_token_command wins"
            ),
        );
    }
}

fn check_millis(obj: &Map<String, Value>, path: &str, label: &str, issues: &mut Issues, key: &str) {
    if let Some(value) = obj.get(key)
        && !is_positive_number(value)
    {
        issues.error(
            format!("{path}.{key}"),
            format!("{label} {key} must be a positive number"),
        );
    }
}

fn is_argv(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        !items.is_empty()
            && items
                .iter()
                .all(|item| item.as_str().is_some_and(|text| !text.is_empty()))
    })
}
