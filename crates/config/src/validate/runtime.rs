use serde_json::{Map, Value};

use super::Issues;
use super::keys::{self, removed_runtime};
use super::value::{hour_ok, is_falsy, is_positive_number};

pub(crate) fn validate_runtime(runtime: &Map<String, Value>, issues: &mut Issues) {
    for key in runtime.keys() {
        if let Some(message) = removed_runtime(key) {
            issues.error(format!("runtime.{key}"), message);
            continue;
        }
        if !keys::has(keys::KNOWN_RUNTIME, key) {
            issues.warning(
                format!("runtime.{key}"),
                format!("Unknown runtime key \"{key}\""),
            );
        }
    }

    require_string(
        runtime,
        "workspace",
        "runtime.workspace",
        "Missing required field \"runtime.workspace\"",
        "\"runtime.workspace\" must be a string path",
        issues,
    );
    require_string(
        runtime,
        "default_agent",
        "runtime.default_agent",
        "Missing required field \"runtime.default_agent\"",
        "\"runtime.default_agent\" must be a string",
        issues,
    );

    if let Some(value) = runtime.get("turn_timeout")
        && !is_positive_number(value)
    {
        issues.error(
            "runtime.turn_timeout",
            "\"runtime.turn_timeout\" must be a positive number (seconds)",
        );
    }

    if let Some(value) = runtime.get("experimental")
        && !value.is_boolean()
    {
        issues.error(
            "runtime.experimental",
            "\"runtime.experimental\" must be a boolean",
        );
    }

    if let Some(value) = runtime.get("skill_dirs") {
        match value.as_array() {
            None => issues.error(
                "runtime.skill_dirs",
                "\"runtime.skill_dirs\" must be an array of paths",
            ),
            Some(items) => {
                for (index, item) in items.iter().enumerate() {
                    if !item.is_string() {
                        issues.error(
                            format!("runtime.skill_dirs[{index}]"),
                            "Each skill_dirs entry must be a string path",
                        );
                    }
                }
            }
        }
    }

    if let Some(value) = runtime.get("heartbeats") {
        match value.as_array() {
            None => issues.error(
                "runtime.heartbeats",
                "\"runtime.heartbeats\" must be an array",
            ),
            Some(items) => {
                for (index, item) in items.iter().enumerate() {
                    validate_heartbeat(item, index, issues);
                }
            }
        }
    }
}

fn require_string(
    runtime: &Map<String, Value>,
    key: &str,
    path: &str,
    missing: &str,
    type_message: &str,
    issues: &mut Issues,
) {
    match runtime.get(key) {
        Some(value) if !is_falsy(value) && value.is_string() => {}
        Some(value) if !is_falsy(value) => issues.error(path, type_message),
        _ => issues.error(path, missing),
    }
}

fn validate_heartbeat(hb: &Value, index: usize, issues: &mut Issues) {
    let path = format!("runtime.heartbeats[{index}]");
    let Some(entry) = hb.as_object() else {
        issues.error(&path, "Each heartbeat entry must be an object");
        return;
    };

    for key in entry.keys() {
        if !keys::has(keys::KNOWN_HEARTBEAT, key) {
            issues.warning(
                format!("{path}.{key}"),
                format!("Unknown heartbeat key \"{key}\""),
            );
        }
    }

    if !nonempty_string(entry.get("agent")) {
        issues.error(
            format!("{path}.agent"),
            "Heartbeat requires a string \"agent\" field",
        );
    }
    if entry.get("schedule").is_none_or(is_falsy) {
        issues.error(
            format!("{path}.schedule"),
            "Heartbeat requires a \"schedule\" field (e.g., \"30m\", \"1h\")",
        );
    }
    if !nonempty_string(entry.get("prompt")) {
        issues.error(
            format!("{path}.prompt"),
            "Heartbeat requires a string \"prompt\" field",
        );
    }

    if let Some(quiet) = entry.get("quiet_hours") {
        validate_quiet_hours(quiet, &path, issues);
    }
}

fn nonempty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

fn validate_quiet_hours(quiet: &Value, path: &str, issues: &mut Issues) {
    let Some(qh) = quiet.as_object() else {
        issues.error(
            format!("{path}.quiet_hours"),
            "\"quiet_hours\" must be an object with \"start\" and \"end\" (0-23)",
        );
        return;
    };
    if qh.get("start").is_none_or(|value| !hour_ok(value)) {
        issues.error(
            format!("{path}.quiet_hours.start"),
            "\"quiet_hours.start\" must be a number 0-23",
        );
    }
    if qh.get("end").is_none_or(|value| !hour_ok(value)) {
        issues.error(
            format!("{path}.quiet_hours.end"),
            "\"quiet_hours.end\" must be a number 0-23",
        );
    }
}
