use serde_json::{Map, Value};

use super::Issues;
use super::keys;
use super::patterns::has_control_char;
use super::value::{is_non_negative_int, js_trim, non_null_objectish, trimmed_nonempty, utf16_len};

pub(crate) fn validate_tasks(tasks: &Map<String, Value>, issues: &mut Issues) {
    for key in tasks.keys() {
        if !keys::has(keys::KNOWN_TASKS, key) {
            issues.warning(
                format!("tasks.{key}"),
                format!("Unknown tasks key \"{key}\""),
            );
        }
    }
    if let Some(enabled) = tasks.get("enabled")
        && !enabled.is_boolean()
    {
        issues.error("tasks.enabled", "\"tasks.enabled\" must be a boolean");
    }
    if let Some(path) = tasks.get("sqlite_path")
        && !trimmed_nonempty(path)
    {
        issues.error(
            "tasks.sqlite_path",
            "\"tasks.sqlite_path\" must be a non-empty file path",
        );
    }
    if let Some(eval) = tasks.get("eval") {
        if !eval.is_object() {
            issues.error("tasks.eval", "\"tasks.eval\" must be an object");
        } else if let Some(eval) = eval.as_object() {
            validate_eval(eval, issues);
        }
    }
    if let Some(harnesses) = tasks.get("harnesses") {
        if !harnesses.is_object() {
            issues.error(
                "tasks.harnesses",
                "\"tasks.harnesses\" must be an object keyed by harness id",
            );
        } else if let Some(harnesses) = harnesses.as_object() {
            validate_harnesses(harnesses, issues);
        }
    }
}

pub(crate) fn validate_workflows(workflows: &Map<String, Value>, issues: &mut Issues) {
    for key in workflows.keys() {
        if !keys::has(keys::KNOWN_WORKFLOWS, key) {
            issues.warning(
                format!("workflows.{key}"),
                format!("Unknown workflows key \"{key}\""),
            );
        }
    }
    if let Some(enabled) = workflows.get("enabled")
        && !enabled.is_boolean()
    {
        issues.error(
            "workflows.enabled",
            "\"workflows.enabled\" must be a boolean",
        );
    }
    if let Some(runs_dir) = workflows.get("runs_dir")
        && !runs_dir.is_string()
    {
        issues.error(
            "workflows.runs_dir",
            "\"workflows.runs_dir\" must be a string path",
        );
    }
    if let Some(roots) = workflows.get("defs_roots") {
        match roots.as_array() {
            None => issues.error(
                "workflows.defs_roots",
                "\"workflows.defs_roots\" must be an array of paths",
            ),
            Some(items) => {
                for (index, item) in items.iter().enumerate() {
                    if !item.is_string() {
                        issues.error(
                            format!("workflows.defs_roots[{index}]"),
                            "\"workflows.defs_roots\" entries must be strings",
                        );
                    }
                }
            }
        }
    }
    if let Some(allow) = workflows.get("agent_allowlist") {
        validate_allowlist(allow, issues);
    }
}

fn validate_allowlist(allow: &Value, issues: &mut Issues) {
    let Some(items) = allow.as_array() else {
        issues.error(
            "workflows.agent_allowlist",
            "\"workflows.agent_allowlist\" must be an array of workflow ids (or [\"*\"]). Empty/absent = agents may start nothing.",
        );
        return;
    };
    for (index, entry) in items.iter().enumerate() {
        let ok = entry.as_str().is_some_and(|text| !js_trim(text).is_empty());
        if !ok {
            issues.error(
                format!("workflows.agent_allowlist[{index}]"),
                "\"workflows.agent_allowlist\" entries must be non-empty strings",
            );
        }
    }
}

fn validate_harnesses(harnesses: &Map<String, Value>, issues: &mut Issues) {
    for (harness_id, value) in harnesses {
        let path = format!("tasks.harnesses.{harness_id}");
        if !protocol::HARNESS_IDS.contains(&harness_id.as_str()) {
            issues.warning(
                &path,
                format!(
                    "Unknown harness id \"{harness_id}\" — expected one of: {}",
                    keys::harness_csv()
                ),
            );
        }
        let Some(section) = value.as_object() else {
            issues.error(&path, format!("\"{path}\" must be an object"));
            continue;
        };
        validate_harness(&path, harness_id, section, issues);
    }
}

fn validate_harness(
    path: &str,
    harness_id: &str,
    section: &Map<String, Value>,
    issues: &mut Issues,
) {
    for key in section.keys() {
        if !keys::has(keys::KNOWN_TASKS_HARNESS, key) {
            issues.warning(format!("{path}.{key}"), format!("Unknown key \"{key}\""));
        }
    }
    for key in keys::HARNESS_STRING_FIELDS {
        if let Some(value) = section.get(*key)
            && !value.is_string()
        {
            issues.error(
                format!("{path}.{key}"),
                format!("\"{path}.{key}\" must be a string"),
            );
        }
    }
    if let Some(effort) = section.get("effort") {
        let low = protocol::ThinkingLevel::Low.as_str();
        let medium = protocol::ThinkingLevel::Medium.as_str();
        let high = protocol::ThinkingLevel::High.as_str();
        let ok = effort
            .as_str()
            .is_some_and(|text| text == low || text == medium || text == high);
        if !ok {
            issues.error(
                format!("{path}.effort"),
                format!("\"{path}.effort\" must be '{low}', '{medium}' or '{high}'"),
            );
        }
    }
    if let Some(isolation) = section.get("isolation") {
        let ok = isolation
            .as_str()
            .is_some_and(|text| matches!(text, "inherit" | "isolated"));
        if !ok {
            issues.error(
                format!("{path}.isolation"),
                format!("\"{path}.isolation\" must be 'inherit' or 'isolated'"),
            );
        }
    }
    if let Some(rules) = section.get("allowed_tools")
        && !allowed_tools_ok(rules)
    {
        issues.error(
                format!("{path}.allowed_tools"),
                format!(
                    "\"{path}.allowed_tools\" must be an array of permission rules: non-empty strings of at most 200 characters, not starting with \"-\", with no control characters"
                ),
            );
    }
    if harness_id != "claude-code"
        && (section.contains_key("isolation") || section.contains_key("allowed_tools"))
    {
        issues.warning(
            path,
            format!(
                "\"isolation\" / \"allowed_tools\" are read by the claude-code executor only; ignored for \"{harness_id}\""
            ),
        );
    }
    validate_models_mode(path, section, issues);
    validate_model_lists(path, section, issues);
}

fn validate_models_mode(path: &str, section: &Map<String, Value>, issues: &mut Issues) {
    let Some(mode) = section.get("models_mode") else {
        return;
    };
    let mode_text = mode.as_str();
    let known = mode_text.is_some_and(|text| matches!(text, "discover" | "replace" | "merge"));
    if !known {
        issues.error(
            format!("{path}.models_mode"),
            format!("\"{path}.models_mode\" must be 'discover', 'replace' or 'merge'"),
        );
        return;
    }
    if mode_text == Some("discover")
        && (section.contains_key("models") || section.contains_key("efforts"))
    {
        issues.warning(
            format!("{path}.models_mode"),
            format!(
                "\"{path}.models_mode\" is 'discover', so \"models\" / \"efforts\" are ignored"
            ),
        );
    }
    if let Some(shown @ ("replace" | "merge")) = mode_text
        && !section.contains_key("models")
        && !section.contains_key("efforts")
    {
        issues.warning(
                format!("{path}.models_mode"),
                format!(
                    "\"{path}.models_mode\" is '{shown}' but no \"models\" or \"efforts\" list is set — the discovered list is kept"
                ),
            );
    }
}

fn validate_model_lists(path: &str, section: &Map<String, Value>, issues: &mut Issues) {
    match section.get("models") {
        Some(models) if !models.is_array() => issues.error(
            format!("{path}.models"),
            format!("\"{path}.models\" must be an array"),
        ),
        Some(models) if models.as_array().is_some_and(|items| items.is_empty()) => issues.warning(
            format!("{path}.models"),
            format!("\"{path}.models\" is empty and will be ignored (sheet list is kept)"),
        ),
        _ => {}
    }
    match section.get("efforts") {
        Some(efforts) if !efforts.is_array() => issues.error(
            format!("{path}.efforts"),
            format!("\"{path}.efforts\" must be an array"),
        ),
        Some(efforts) if efforts.as_array().is_some_and(|items| items.is_empty()) => {
            issues.warning(
                format!("{path}.efforts"),
                format!("\"{path}.efforts\" is empty and will be ignored (sheet list is kept)"),
            );
        }
        _ => {}
    }
}

fn allowed_tools_ok(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(rule_ok))
}

fn rule_ok(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let trimmed = js_trim(text);
    !trimmed.is_empty()
        && utf16_len(trimmed) <= 200
        && !trimmed.starts_with('-')
        && !has_control_char(trimmed)
}

fn validate_eval(eval_section: &Map<String, Value>, issues: &mut Issues) {
    for key in eval_section.keys() {
        if !keys::has(keys::KNOWN_TASKS_EVAL, key) {
            issues.warning(
                format!("tasks.eval.{key}"),
                format!("Unknown tasks.eval key \"{key}\""),
            );
        }
    }
    for flag in keys::EVAL_BOOLS {
        if let Some(value) = eval_section.get(*flag)
            && !value.is_boolean()
        {
            issues.error(
                format!("tasks.eval.{flag}"),
                format!("\"tasks.eval.{flag}\" must be a boolean"),
            );
        }
    }
    if let Some(retries) = eval_section.get("max_retries")
        && !is_non_negative_int(retries)
    {
        issues.error(
            "tasks.eval.max_retries",
            "\"tasks.eval.max_retries\" must be a non-negative integer",
        );
    }
    if let Some(origins) = eval_section.get("skip_origins") {
        let ok = origins
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string));
        if !ok {
            issues.error(
                "tasks.eval.skip_origins",
                "\"tasks.eval.skip_origins\" must be an array of strings",
            );
        }
    }
    validate_verifier(eval_section, issues);
    validate_escalation(eval_section, issues);
}

fn validate_verifier(eval_section: &Map<String, Value>, issues: &mut Issues) {
    let Some(verifier) = eval_section.get("verifier") else {
        return;
    };
    if !non_null_objectish(verifier) {
        issues.error(
            "tasks.eval.verifier",
            "\"tasks.eval.verifier\" must be an object",
        );
    }
    let Some(executor) = verifier.as_object().and_then(|map| map.get("executor")) else {
        return;
    };
    let chat_loop = protocol::TaskExecutorKind::ChatLoop.as_str();
    let harness_session = protocol::TaskExecutorKind::HarnessSession.as_str();
    let ok = executor
        .as_str()
        .is_some_and(|text| text == chat_loop || text == harness_session);
    if !ok {
        issues.error(
            "tasks.eval.verifier.executor",
            format!(
                "\"tasks.eval.verifier.executor\" must be '{chat_loop}' or '{harness_session}'"
            ),
        );
    }
}

fn validate_escalation(eval_section: &Map<String, Value>, issues: &mut Issues) {
    let Some(escalation) = eval_section.get("escalation") else {
        return;
    };
    if !non_null_objectish(escalation) {
        issues.error(
            "tasks.eval.escalation",
            "\"tasks.eval.escalation\" must be an object",
        );
        return;
    }
    let Some(channel) = escalation.as_object().and_then(|map| map.get("channel")) else {
        return;
    };
    if !channel.is_string() {
        issues.error(
            "tasks.eval.escalation.channel",
            "\"tasks.eval.escalation.channel\" must be a string",
        );
    }
}
