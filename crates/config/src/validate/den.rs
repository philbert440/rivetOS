use serde_json::{Map, Value};

use super::Issues;
use super::keys;
use super::value::{is_int_between, is_non_negative_int, js_trim, trimmed_nonempty};

const TLS_GATE: &str = "\"den.tls_cert\" (and den.tls_key) is required when den.terminal.enabled is true and den.host is not loopback (127.0.0.1/::1/localhost) — an exposed terminal without TLS would hang an unauthenticated shell on the network. Set den.tls_cert/tls_key, bind den.host to loopback, disable terminals, or set den.terminal.open: true on a trusted private network.";

pub(crate) fn validate_den(den: &Map<String, Value>, issues: &mut Issues) {
    for key in den.keys() {
        if !keys::has(keys::KNOWN_DEN, key) {
            issues.warning(format!("den.{key}"), format!("Unknown den key \"{key}\""));
        }
    }
    if let Some(enabled) = den.get("enabled")
        && !enabled.is_boolean()
    {
        issues.error("den.enabled", "\"den.enabled\" must be a boolean");
    }
    if let Some(host) = den.get("host")
        && !trimmed_nonempty(host)
    {
        issues.error(
            "den.host",
            "\"den.host\" must be a non-empty string (bind address, e.g. 127.0.0.1 or 0.0.0.0)",
        );
    }
    if let Some(port) = den.get("port")
        && !is_int_between(port, 1, 65535)
    {
        issues.error(
            "den.port",
            "\"den.port\" must be an integer between 1 and 65535",
        );
    }
    if let Some(token) = den.get("token")
        && !token.is_string()
    {
        issues.error("den.token", "\"den.token\" must be a string");
    }

    let (terminal_enabled, terminal_open) = validate_terminal(den, issues);
    validate_devices(den, issues);
    validate_string_lists(den, issues);
    validate_harnesses(den, issues);
    validate_paths(den, issues);
    validate_tls_gate(den, terminal_enabled, terminal_open, issues);
}

fn validate_terminal(den: &Map<String, Value>, issues: &mut Issues) -> (bool, bool) {
    let Some(terminal) = den.get("terminal") else {
        return (false, false);
    };
    let Some(terminal) = terminal.as_object() else {
        issues.error(
            "den.terminal",
            "\"den.terminal\" must be an object (e.g. { enabled: true })",
        );
        return (false, false);
    };
    for key in terminal.keys() {
        if !keys::has(keys::KNOWN_DEN_TERMINAL, key) {
            issues.warning(
                format!("den.terminal.{key}"),
                format!("Unknown den.terminal key \"{key}\""),
            );
        }
    }
    if let Some(enabled) = terminal.get("enabled")
        && !enabled.is_boolean()
    {
        issues.error(
            "den.terminal.enabled",
            "\"den.terminal.enabled\" must be a boolean",
        );
    }
    if let Some(open) = terminal.get("open")
        && !open.is_boolean()
    {
        issues.error(
            "den.terminal.open",
            "\"den.terminal.open\" must be a boolean",
        );
    }
    if let Some(idle) = terminal.get("idle_ttl_ms")
        && !is_non_negative_int(idle)
    {
        issues.error(
            "den.terminal.idle_ttl_ms",
            "\"den.terminal.idle_ttl_ms\" must be a non-negative integer (ms; 0 disables)",
        );
    }
    (
        terminal.get("enabled") == Some(&Value::Bool(true)),
        terminal.get("open") == Some(&Value::Bool(true)),
    )
}

fn validate_devices(den: &Map<String, Value>, issues: &mut Issues) {
    let Some(devices) = den.get("devices") else {
        return;
    };
    let Some(devices) = devices.as_object() else {
        issues.error(
            "den.devices",
            "\"den.devices\" must be an object (e.g. { enabled: true })",
        );
        return;
    };
    for key in devices.keys() {
        if !keys::has(keys::KNOWN_DEN_DEVICES, key) {
            issues.warning(
                format!("den.devices.{key}"),
                format!("Unknown den.devices key \"{key}\""),
            );
        }
    }
    for key in keys::DEN_DEVICE_BOOLS {
        if let Some(value) = devices.get(*key)
            && !value.is_boolean()
        {
            issues.error(
                format!("den.devices.{key}"),
                format!("\"den.devices.{key}\" must be a boolean"),
            );
        }
    }
    for key in keys::DEN_DEVICE_STRINGS {
        if let Some(value) = devices.get(*key)
            && !value.is_string()
        {
            issues.error(
                format!("den.devices.{key}"),
                format!("\"den.devices.{key}\" must be a string"),
            );
        }
    }
}

fn validate_string_lists(den: &Map<String, Value>, issues: &mut Issues) {
    for key in ["allowed_origins", "allowed_hosts"] {
        let Some(value) = den.get(key) else {
            continue;
        };
        if !is_trimmed_string_list(value) {
            issues.error(
                format!("den.{key}"),
                format!("\"den.{key}\" must be a list of non-empty strings"),
            );
        }
    }
}

fn validate_harnesses(den: &Map<String, Value>, issues: &mut Issues) {
    let Some(value) = den.get("allowed_harnesses") else {
        return;
    };
    if !is_trimmed_string_list(value) {
        issues.error(
            "den.allowed_harnesses",
            "\"den.allowed_harnesses\" must be a list of non-empty harness ids (omit the key to allow all)",
        );
        return;
    }
    let Some(items) = value.as_array() else {
        return;
    };
    for (index, item) in items.iter().enumerate() {
        let Some(id) = item.as_str().map(js_trim) else {
            continue;
        };
        if !protocol::HARNESS_IDS.contains(&id) {
            issues.warning(
                format!("den.allowed_harnesses[{index}]"),
                format!(
                    "Unknown harness id \"{id}\" — expected one of: {}",
                    keys::harness_csv()
                ),
            );
        }
    }
}

fn validate_paths(den: &Map<String, Value>, issues: &mut Issues) {
    if let Some(value) = den.get("static_dir")
        && !trimmed_nonempty(value)
    {
        issues.error(
            "den.static_dir",
            "\"den.static_dir\" must be a non-empty string path",
        );
    }
    if let Some(value) = den.get("files_root")
        && !value.is_string()
    {
        issues.error(
            "den.files_root",
            "\"den.files_root\" must be a string path (\"\" disables the files browser)",
        );
    }
    if let Some(value) = den.get("files_open")
        && !value.is_boolean()
    {
        issues.error("den.files_open", "\"den.files_open\" must be a boolean");
    }
    if let Some(value) = den.get("advertise_mdns")
        && !value.is_boolean()
    {
        issues.error(
            "den.advertise_mdns",
            "\"den.advertise_mdns\" must be a boolean",
        );
    }
}

fn validate_tls_gate(
    den: &Map<String, Value>,
    terminal_enabled: bool,
    terminal_open: bool,
    issues: &mut Issues,
) {
    let host = den
        .get("host")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("127.0.0.1");
    let has_tls = den
        .get("tls_cert")
        .and_then(Value::as_str)
        .is_some_and(|text| !js_trim(text).is_empty());
    if den.get("enabled") == Some(&Value::Bool(true))
        && terminal_enabled
        && !terminal_open
        && !keys::has(keys::DEN_LOOPBACK_HOSTS, host)
        && !has_tls
    {
        issues.error("den.tls_cert", TLS_GATE);
    }
}

fn is_trimmed_string_list(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        items
            .iter()
            .all(|item| item.as_str().is_some_and(|text| !js_trim(text).is_empty()))
    })
}
