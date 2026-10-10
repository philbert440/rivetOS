use serde_json::{Map, Value};

use super::Issues;

pub(crate) fn validate_cross_references(cfg: &Map<String, Value>, issues: &mut Issues) {
    let agents = cfg.get("agents").and_then(Value::as_object);
    let providers = cfg.get("providers").and_then(Value::as_object);
    let runtime = cfg.get("runtime").and_then(Value::as_object);
    let provider_ids = keys_of(providers);
    let agent_ids = keys_of(agents);

    if let Some(agents) = agents {
        for (name, agent) in agents {
            let Some(provider) = agent
                .as_object()
                .and_then(|entry| entry.get("provider"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if !provider_ids.iter().any(|id| id == provider) {
                issues.error(
                    format!("agents.{name}.provider"),
                    format!(
                        "Provider \"{provider}\" referenced by agent \"{name}\" is not defined in [providers]. Available: {}",
                        available(&provider_ids)
                    ),
                );
            }
        }
    }

    if let Some(runtime) = runtime {
        if let Some(name) = runtime.get("default_agent").and_then(Value::as_str)
            && !name.is_empty()
            && !agent_ids.iter().any(|id| id == name)
        {
            issues.error(
                "runtime.default_agent",
                format!(
                    "Default agent \"{name}\" is not defined in [agents]. Available: {}",
                    available(&agent_ids)
                ),
            );
        }
        if let Some(heartbeats) = runtime.get("heartbeats").and_then(Value::as_array) {
            for (index, hb) in heartbeats.iter().enumerate() {
                let Some(agent) = hb
                    .as_object()
                    .and_then(|entry| entry.get("agent"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if !agent_ids.iter().any(|id| id == agent) {
                    issues.error(
                        format!("runtime.heartbeats[{index}].agent"),
                        format!(
                            "Heartbeat agent \"{agent}\" is not defined in [agents]. Available: {}",
                            available(&agent_ids)
                        ),
                    );
                }
            }
        }
    }
}

fn keys_of(map: Option<&Map<String, Value>>) -> Vec<String> {
    map.map(|entries| entries.keys().cloned().collect())
        .unwrap_or_default()
}

fn available(ids: &[String]) -> String {
    if ids.is_empty() {
        "(none)".to_string()
    } else {
        ids.join(", ")
    }
}
