use serde_json::{Map, Value};

use super::Issues;
use super::keys;
use super::value::{is_falsy, js_to_string};

pub(crate) fn validate_deployment(deployment: &Map<String, Value>, issues: &mut Issues) {
    for key in deployment.keys() {
        if !keys::has(keys::KNOWN_DEPLOYMENT, key) {
            issues.warning(
                format!("deployment.{key}"),
                format!("Unknown deployment key \"{key}\""),
            );
        }
    }
    match deployment.get("target") {
        Some(value) if !is_falsy(value) => {
            let ok = value
                .as_str()
                .is_some_and(|text| keys::has(keys::VALID_DEPLOYMENT_TARGETS, text));
            if !ok {
                issues.error(
                    "deployment.target",
                    format!(
                        "Invalid deployment target \"{}\" — must be one of: {}",
                        js_to_string(value),
                        keys::join(keys::VALID_DEPLOYMENT_TARGETS)
                    ),
                );
            }
        }
        _ => issues.error(
            "deployment.target",
            "Missing required field \"deployment.target\" — must be one of: docker, proxmox, kubernetes, manual",
        ),
    }
}

#[cfg(test)]
mod number_text {
    use serde_json::json;

    use crate::{format_validation_result, validate_config};

    #[test]
    fn scientific_deployment_target_renders_like_javascript() {
        let value = json!({
            "runtime": {"workspace": "/tmp/ws", "default_agent": "main"},
            "agents": {"main": {"provider": "anthropic"}},
            "providers": {"anthropic": {"model": "claude-opus", "temperature": 1e21}},
            "deployment": {"target": 1e21}
        });
        let result = validate_config(&value);
        let rendered = format_validation_result(&result);
        assert!(
            rendered.contains(
                "  \u{274c} [deployment.target] Invalid deployment target \"1e+21\" — must be one of: docker, proxmox, kubernetes, manual"
            ),
            "{rendered}"
        );
        assert!(
            rendered.contains(
                "  \u{26a0}\u{fe0f}  [providers.anthropic.temperature] Provider \"anthropic\" temperature 1e+21 is outside typical range (0-2)"
            ),
            "{rendered}"
        );
        assert!(rendered.starts_with("Errors:\n"), "{rendered}");
        assert!(rendered.contains("\nWarnings:\n"), "{rendered}");
    }
}
