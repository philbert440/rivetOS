use serde_json::{Map, Value};

use super::Issues;
use super::keys::{self, removed_postgres};
use super::patterns::{invalid_regex_message, is_hardcoded_api_key, is_redos_pattern};
use super::token::{TokenFields, validate_token_fields};
use super::value::{is_falsy, is_int_between, js_i64, js_trim, trimmed_nonempty};

const EMBED_FIELDS: TokenFields = TokenFields {
    command: "embed_token_command",
    ttl: "embed_token_ttl_ms",
    timeout: "embed_token_command_timeout_ms",
};

const TAGGER_FIELDS: TokenFields = TokenFields {
    command: "tagger_token_command",
    ttl: "tagger_token_ttl_ms",
    timeout: "tagger_token_command_timeout_ms",
};

pub(crate) fn validate_memory(memory: &Map<String, Value>, issues: &mut Issues) {
    for key in memory.keys() {
        if !keys::has(keys::KNOWN_MEMORY, key) {
            issues.warning(
                format!("memory.{key}"),
                format!(
                    "Unknown memory key \"{key}\" — supported: \"postgres\" / \"sqlite\" (backend), \"capture\" (write-path options)"
                ),
            );
        }
    }

    let postgres_set = memory.get("postgres").is_some_and(|value| !is_falsy(value));
    let sqlite_set = memory.get("sqlite").is_some_and(|value| !is_falsy(value));
    if postgres_set && sqlite_set {
        issues.error(
            "memory",
            "\"postgres\" and \"sqlite\" cannot both be set — pick one memory backend",
        );
    }

    if postgres_set {
        match memory.get("postgres").and_then(Value::as_object) {
            None => issues.error("memory.postgres", "\"memory.postgres\" must be an object"),
            Some(pg) => validate_postgres(pg, issues),
        }
    }

    if sqlite_set && let Some(raw) = memory.get("sqlite") {
        validate_sqlite(raw, issues)
    }

    if let Some(capture) = memory.get("capture") {
        validate_capture(capture, issues);
    }
}

fn validate_postgres(pg: &Map<String, Value>, issues: &mut Issues) {
    for key in pg.keys() {
        if let Some(message) = removed_postgres(key) {
            issues.error(format!("memory.postgres.{key}"), message);
        } else if !keys::has(keys::KNOWN_MEMORY_POSTGRES, key) {
            issues.warning(
                format!("memory.postgres.{key}"),
                format!("Unknown memory.postgres key \"{key}\""),
            );
        }
    }

    if let Some(value) = pg.get("delegation_tracking")
        && !value.is_boolean()
    {
        issues.error(
            "memory.postgres.delegation_tracking",
            "\"delegation_tracking\" must be a boolean (true/false)",
        );
    }

    validate_token_fields(
        pg,
        "memory.postgres",
        "memory.postgres",
        issues,
        EMBED_FIELDS,
    );

    if let Some(shape) = pg.get("embed_wire_shape") {
        let ok = shape
            .as_str()
            .is_some_and(|text| text == "openai" || text == "native");
        if !ok {
            issues.error(
                "memory.postgres.embed_wire_shape",
                "\"embed_wire_shape\" must be \"openai\" or \"native\"",
            );
        }
    }

    if let Some(dims) = pg.get("embed_expected_dims") {
        let ok = dims
            .as_f64()
            .is_some_and(|number| number == keys::EMBEDDING_COLUMN_DIMS);
        if !ok {
            issues.error(
                "memory.postgres.embed_expected_dims",
                "\"embed_expected_dims\" must equal the embedding column width (1024); any other value bricks halfvec inserts and vector search",
            );
        }
    }

    if let Some(key) = pg.get("embed_api_key").and_then(Value::as_str)
        && !key.is_empty()
        && is_hardcoded_api_key(key)
    {
        issues.warning(
                "memory.postgres.embed_api_key",
                "memory.postgres.embed_api_key appears hardcoded — prefer environment variables or embed_token_command",
            );
    }

    if let Some(embedded) = pg.get("embedded") {
        validate_embedded(pg, embedded, issues);
    }
}

fn validate_sqlite(raw: &Value, issues: &mut Issues) {
    let Some(sqlite) = raw.as_object() else {
        issues.error("memory.sqlite", "\"memory.sqlite\" must be an object");
        return;
    };
    for key in sqlite.keys() {
        if !keys::has(keys::KNOWN_MEMORY_SQLITE_KEYS, key) {
            issues.warning(
                format!("memory.sqlite.{key}"),
                format!("Unknown memory.sqlite key \"{key}\""),
            );
        }
    }
    validate_token_fields(
        sqlite,
        "memory.sqlite",
        "memory.sqlite",
        issues,
        TAGGER_FIELDS,
    );
    if let Some(value) = sqlite.get("tagger_allow_protected_removals")
        && !value.is_boolean()
    {
        issues.error(
            "memory.sqlite.tagger_allow_protected_removals",
            "\"tagger_allow_protected_removals\" must be a boolean",
        );
    }
    match sqlite.get("path") {
        None => issues.error(
            "memory.sqlite.path",
            "\"memory.sqlite.path\" is required (file path or \":memory:\")",
        ),
        Some(path) if path.as_str().is_some_and(|text| !js_trim(text).is_empty()) => {}
        Some(_) => issues.error(
            "memory.sqlite.path",
            "\"memory.sqlite.path\" must be a non-empty file path",
        ),
    }
}

fn validate_capture(capture: &Value, issues: &mut Issues) {
    let Some(cap) = capture.as_object() else {
        issues.error("memory.capture", "\"memory.capture\" must be an object");
        return;
    };
    for key in cap.keys() {
        if !keys::has(keys::KNOWN_MEMORY_CAPTURE, key) {
            issues.warning(
                format!("memory.capture.{key}"),
                format!("Unknown memory.capture key \"{key}\""),
            );
        }
    }
    if let Some(redaction) = cap.get("redaction") {
        validate_redaction(redaction, issues);
    }
}

fn validate_redaction(redaction: &Value, issues: &mut Issues) {
    let Some(red) = redaction.as_object() else {
        issues.error(
            "memory.capture.redaction",
            "\"memory.capture.redaction\" must be an object",
        );
        return;
    };
    for key in red.keys() {
        if !keys::has(keys::KNOWN_MEMORY_CAPTURE_REDACTION, key) {
            issues.warning(
                format!("memory.capture.redaction.{key}"),
                format!("Unknown memory.capture.redaction key \"{key}\""),
            );
        }
    }
    if let Some(enabled) = red.get("enabled")
        && !enabled.is_boolean()
    {
        issues.error(
            "memory.capture.redaction.enabled",
            "\"enabled\" must be a boolean",
        );
    }
    if red.get("enabled") == Some(&Value::Bool(true)) {
        issues.warning(
            "memory.capture.redaction.enabled",
            "memory.capture.redaction is validated but not yet injected into harness hook processes; set RIVETOS_CAPTURE_REDACTION or pass CaptureWriterOptions.redaction to enable at runtime",
        );
    }
    if let Some(builtins) = red.get("builtins")
        && !builtins.is_boolean()
    {
        issues.error(
            "memory.capture.redaction.builtins",
            "\"builtins\" must be a boolean",
        );
    }
    if let Some(patterns) = red.get("patterns") {
        validate_patterns(patterns, issues);
    }
}

fn validate_patterns(patterns: &Value, issues: &mut Issues) {
    let Some(items) = patterns.as_array() else {
        issues.error(
            "memory.capture.redaction.patterns",
            "\"patterns\" must be an array of regex source strings",
        );
        return;
    };
    for (index, source) in items.iter().enumerate() {
        let path = format!("memory.capture.redaction.patterns[{index}]");
        let Some(text) = source.as_str().filter(|text| !text.is_empty()) else {
            issues.error(
                path,
                "Each pattern must be a non-empty string (JS regex source)",
            );
            continue;
        };
        if is_redos_pattern(text) {
            issues.error(
                path,
                "Pattern looks ReDoS-prone (nested quantifiers); rewrite without nested +/* groups",
            );
            continue;
        }
        if let Some(message) = invalid_regex_message(text) {
            issues.error(path, message);
        }
    }
}

fn validate_embedded(pg: &Map<String, Value>, embedded: &Value, issues: &mut Issues) {
    let Some(embedded) = embedded.as_object() else {
        issues.error(
            "memory.postgres.embedded",
            "\"memory.postgres.embedded\" must be an object",
        );
        return;
    };
    if pg.contains_key("connection_string") {
        issues.error(
            "memory.postgres",
            "\"embedded\" and \"connection_string\" cannot both be set — embedded owns the loopback URL",
        );
    }
    for key in embedded.keys() {
        if !keys::has(keys::KNOWN_MEMORY_EMBEDDED, key) {
            issues.warning(
                format!("memory.postgres.embedded.{key}"),
                format!("Unknown memory.postgres.embedded key \"{key}\""),
            );
        }
    }
    if let Some(data_dir) = embedded.get("data_dir")
        && !trimmed_nonempty(data_dir)
    {
        issues.error(
            "memory.postgres.embedded.data_dir",
            "\"data_dir\" must be a non-empty string",
        );
    }
    if let Some(port) = embedded.get("port")
        && !is_int_between(port, 1, 65535)
    {
        issues.error(
            "memory.postgres.embedded.port",
            "\"port\" must be an integer between 1 and 65535",
        );
    }
    if let Some(flag) = embedded.get("auto_migrate")
        && !flag.is_boolean()
    {
        issues.error(
            "memory.postgres.embedded.auto_migrate",
            "\"auto_migrate\" must be a boolean",
        );
    }
    if let Some(max_connections) = embedded.get("max_connections")
        && !js_i64(max_connections).is_some_and(|number| number >= 1)
    {
        issues.error(
            "memory.postgres.embedded.max_connections",
            "\"max_connections\" must be a positive integer",
        );
    }
}
