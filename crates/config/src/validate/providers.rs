use serde_json::{Map, Value};

use super::Issues;
use super::keys::{self, removed_provider};
use super::patterns::{api_key_env_hint, is_hardcoded_api_key};
use super::token::{TokenFields, validate_token_fields};
use super::value::{is_falsy, is_int_between, is_positive_number, js_to_string};

const TOKEN_FIELDS: TokenFields = TokenFields {
    command: "token_command",
    ttl: "token_ttl_ms",
    timeout: "token_command_timeout_ms",
};

pub(crate) fn validate_providers(providers: &Map<String, Value>, issues: &mut Issues) {
    if providers.is_empty() {
        issues.error(
            "providers",
            "\"providers\" is empty — define at least one provider",
        );
        return;
    }
    for (name, provider_cfg) in providers {
        let path = format!("providers.{name}");
        let Some(provider) = provider_cfg.as_object() else {
            issues.error(&path, format!("Provider \"{name}\" must be an object"));
            continue;
        };
        if let Some(message) = removed_provider(name) {
            issues.error(&path, message);
            continue;
        }
        validate_provider(name, &path, provider, issues);
    }
}

fn validate_provider(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    match keys::provider_known_keys(name) {
        None => issues.warning(
            path,
            format!("Unknown provider type \"{name}\" — make sure a registrar handles it"),
        ),
        Some(known) => {
            for key in provider.keys() {
                if !keys::has(known, key) {
                    issues.warning(
                        format!("{path}.{key}"),
                        format!("Unknown key \"{key}\" for provider type \"{name}\""),
                    );
                }
            }
        }
    }

    check_model(name, path, provider, issues);
    check_claude(name, path, provider, issues);
    check_base_url(name, path, provider, issues);
    check_api_key(name, path, provider, issues);
    if keys::has(keys::TOKEN_COMMAND_PROVIDERS, name) {
        validate_token_fields(
            provider,
            path,
            &format!("Provider \"{name}\""),
            issues,
            TOKEN_FIELDS,
        );
    }
    if keys::has(keys::MODEL_CATALOG_PROVIDERS, name) {
        check_models(name, path, provider, issues);
    }
    check_max_tokens(name, path, provider, issues);
    check_temperature(name, path, provider, issues);
}

fn check_model(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    let model = provider.get("model");
    if model.is_none_or(is_falsy) {
        if !keys::has(keys::CLI_HARNESS_PROVIDERS, name) {
            issues.error(
                format!("{path}.model"),
                format!("Provider \"{name}\" is missing required field \"model\""),
            );
        }
    } else if !model.is_some_and(Value::is_string) {
        issues.error(
            format!("{path}.model"),
            format!("Provider \"{name}\" model must be a string"),
        );
    }
}

fn check_claude(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    if name != "claude-cli" {
        return;
    }
    if let Some(mode) = provider.get("permission_prompts") {
        let ok = mode
            .as_str()
            .is_some_and(|text| text == "ui" || text == "none");
        if !ok {
            issues.error(
                format!("{path}.permission_prompts"),
                "permission_prompts must be \"ui\" or \"none\" (omit the key to leave spawns unchanged)",
            );
        }
    }
    if let Some(raw) = provider.get("permission_timeout_ms")
        && !is_int_between(raw, 1, keys::PERMISSION_PROMPT_TIMEOUT_MAX_MS)
    {
        issues.error(
            format!("{path}.permission_timeout_ms"),
            format!(
                "permission_timeout_ms must be a positive integer of at most {} (default {})",
                keys::PERMISSION_PROMPT_TIMEOUT_MAX_MS,
                keys::PERMISSION_PROMPT_TIMEOUT_MS
            ),
        );
    }
    if let Some(raw) = provider.get("allowed_api_key_sources") {
        let ok = raw.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| item.as_str().is_some_and(|text| !text.is_empty()))
        });
        if !ok {
            issues.error(
                format!("{path}.allowed_api_key_sources"),
                "allowed_api_key_sources must be an array of non-empty strings",
            );
        }
    }
}

fn check_base_url(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    if matches!(name, "ollama" | "vllm" | "llama-server")
        && provider.get("base_url").is_none_or(is_falsy)
    {
        issues.error(
            format!("{path}.base_url"),
            format!("Provider \"{name}\" requires \"base_url\""),
        );
    }
}

fn check_api_key(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    let Some(key) = provider.get("api_key").and_then(Value::as_str) else {
        return;
    };
    if key.is_empty() || !is_hardcoded_api_key(key) {
        return;
    }
    let hint = api_key_env_hint(name);
    issues.warning(
        format!("{path}.api_key"),
        format!(
            "Provider \"{name}\" appears to have a hardcoded API key — use environment variables instead (e.g., ${{{hint}_API_KEY}})"
        ),
    );
}

fn check_models(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    if let Some(models) = provider.get("models") {
        let ok = models.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| item.as_str().is_some_and(|text| !text.is_empty()))
        });
        if !ok {
            issues.error(
                format!("{path}.models"),
                format!(
                    "Provider \"{name}\" models must be an array of non-empty strings (static catalog floor)"
                ),
            );
        }
    }
    if let Some(ttl) = provider.get("models_ttl_ms")
        && !is_positive_number(ttl)
    {
        issues.error(
            format!("{path}.models_ttl_ms"),
            format!("Provider \"{name}\" models_ttl_ms must be a positive number"),
        );
    }
}

fn check_max_tokens(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    if let Some(value) = provider.get("max_tokens")
        && !is_positive_number(value)
    {
        issues.error(
            format!("{path}.max_tokens"),
            format!("Provider \"{name}\" max_tokens must be a positive number"),
        );
    }
}

fn check_temperature(name: &str, path: &str, provider: &Map<String, Value>, issues: &mut Issues) {
    let Some(value) = provider.get("temperature") else {
        return;
    };
    let out = match value.as_f64() {
        Some(number) => number < 0.0 || number > 2.0,
        None => true,
    };
    if out {
        issues.warning(
            format!("{path}.temperature"),
            format!(
                "Provider \"{name}\" temperature {} is outside typical range (0-2)",
                js_to_string(value)
            ),
        );
    }
}
