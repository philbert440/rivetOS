use serde_json::{Map, Value};

use super::Issues;
use super::keys::{self, removed_agent};
use super::value::{is_falsy, js_to_string};

pub(crate) fn validate_agents(agents: &Map<String, Value>, issues: &mut Issues) {
    if agents.is_empty() {
        issues.error("agents", "\"agents\" is empty — define at least one agent");
        return;
    }

    for (name, agent_cfg) in agents {
        let path = format!("agents.{name}");
        let Some(agent) = agent_cfg.as_object() else {
            issues.error(&path, format!("Agent \"{name}\" must be an object"));
            continue;
        };
        validate_agent(name, &path, agent, issues);
    }
}

fn validate_agent(name: &str, path: &str, agent: &Map<String, Value>, issues: &mut Issues) {
    for key in agent.keys() {
        if let Some(message) = removed_agent(key) {
            issues.error(format!("{path}.{key}"), message);
            continue;
        }
        if !keys::has(keys::KNOWN_AGENT, key) {
            issues.warning(
                format!("{path}.{key}"),
                format!("Unknown agent key \"{key}\""),
            );
        }
    }

    match agent.get("provider") {
        Some(value) if !is_falsy(value) && value.is_string() => {}
        Some(value) if !is_falsy(value) => {
            issues.error(
                format!("{path}.provider"),
                format!("Agent \"{name}\" provider must be a string"),
            );
        }
        _ => issues.error(
            format!("{path}.provider"),
            format!("Agent \"{name}\" is missing required field \"provider\""),
        ),
    }

    if let Some(level) = agent.get("default_thinking") {
        let ok = level
            .as_str()
            .is_some_and(|text| keys::has(keys::THINKING_LEVELS, text));
        if !ok {
            issues.error(
                format!("{path}.default_thinking"),
                format!(
                    "Agent \"{name}\" default_thinking must be one of: {} (got \"{}\")",
                    keys::join(keys::THINKING_LEVELS),
                    js_to_string(level)
                ),
            );
        }
    }

    if let Some(tools) = agent.get("tools") {
        validate_tools(name, path, tools, issues);
    }
}

fn validate_tools(name: &str, path: &str, tools: &Value, issues: &mut Issues) {
    let Some(tools_cfg) = tools.as_object() else {
        issues.error(
            format!("{path}.tools"),
            format!(
                "Agent \"{name}\" tools must be an object with optional \"exclude\" and/or \"include\" arrays"
            ),
        );
        return;
    };
    for key in tools_cfg.keys() {
        if key != "exclude" && key != "include" {
            issues.warning(
                format!("{path}.tools.{key}"),
                format!("Unknown tools filter key \"{key}\" — expected \"exclude\" or \"include\""),
            );
        }
    }
    if tools_cfg
        .get("exclude")
        .is_some_and(|value| !value.is_array())
    {
        issues.error(
            format!("{path}.tools.exclude"),
            format!("Agent \"{name}\" tools.exclude must be an array of tool names"),
        );
    }
    if tools_cfg
        .get("include")
        .is_some_and(|value| !value.is_array())
    {
        issues.error(
            format!("{path}.tools.include"),
            format!("Agent \"{name}\" tools.include must be an array of tool names"),
        );
    }
    if tools_cfg
        .get("exclude")
        .is_some_and(|value| !is_falsy(value))
        && tools_cfg
            .get("include")
            .is_some_and(|value| !is_falsy(value))
    {
        issues.warning(
            format!("{path}.tools"),
            format!(
                "Agent \"{name}\" has both \"exclude\" and \"include\" — include takes precedence"
            ),
        );
    }
}
