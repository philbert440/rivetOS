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
