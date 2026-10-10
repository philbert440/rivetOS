use std::path::Path;

use indexmap::IndexMap;
use protocol::JsNumber;
use protocol::js::js_trim;
use serde_json::{Map, Value};

use crate::error::WorkflowError;
use crate::io_fs::{self, read_string, try_exists};
use crate::manifest::load_manifest_file;
use crate::pathutil::{node_join_paths, path_text};
use crate::types::{AgentConfig, AgentDef, LoadedWorkflow};

const RUN_CANDIDATES: &[&str] = &["run.js", "run.mjs", "run.ts"];

pub async fn load_workflow_dir(dir: &Path) -> Result<LoadedWorkflow, WorkflowError> {
    let manifest = load_manifest_file(dir).await?;
    let run_path = resolve_run_path(dir).await?;
    let agents = load_agents(&node_join_paths(dir, "agents")).await?;
    Ok(LoadedWorkflow {
        dir: path_text(dir),
        manifest,
        run_path: path_text(&run_path),
        agents,
    })
}

async fn resolve_run_path(dir: &Path) -> Result<std::path::PathBuf, WorkflowError> {
    for name in RUN_CANDIDATES {
        let path = node_join_paths(dir, name);
        if try_exists(&path).await? {
            return Ok(path);
        }
    }
    Err(WorkflowError::message(format!(
        "No run.ts/run.js found in {}",
        path_text(dir)
    )))
}

async fn load_agents(agents_dir: &Path) -> Result<IndexMap<String, AgentDef>, WorkflowError> {
    let mut agents = IndexMap::new();
    if !try_exists(agents_dir).await? {
        return Ok(agents);
    }
    let entries = io_fs::read_dir(agents_dir).await?;
    for entry in entries {
        if !entry.is_file || !entry.name.ends_with(".md") {
            continue;
        }
        let name = entry.name[..entry.name.len() - 3].to_string();
        let path = node_join_paths(agents_dir, &entry.name);
        let text = read_string(&path).await?;
        let path_string = path_text(&path);
        let (config, body) = parse_frontmatter(&text, &path_string)?;
        if js_trim(&body).is_empty() {
            return Err(WorkflowError::message(format!(
                "Agent \"{name}\" has an empty prompt body in {path_string}"
            )));
        }
        agents.insert(
            name.clone(),
            AgentDef {
                name,
                path: path_string,
                prompt: body,
                config,
            },
        );
    }
    Ok(agents)
}

pub fn parse_frontmatter(text: &str, path: &str) -> Result<(AgentConfig, String), WorkflowError> {
    let without_bom = text.strip_prefix('\u{feff}').unwrap_or(text);
    let src = strip_leading_ws_if_fence(without_bom);
    if !opening_fence(src) {
        return Ok((AgentConfig::default(), without_bom.to_string()));
    }
    let Some((close_index, close_len)) = find_close(src) else {
        return Err(WorkflowError::message(format!(
            "Unterminated frontmatter (missing closing ---) in {path}"
        )));
    };
    let Some(newline) = src.find('\n') else {
        return Err(WorkflowError::message(format!(
            "Unterminated frontmatter (missing closing ---) in {path}"
        )));
    };
    let raw_yaml = &src[newline + 1..close_index];
    let body = src[close_index + close_len..].to_string();
    let config = if js_trim(raw_yaml).is_empty() {
        AgentConfig::default()
    } else {
        let value: Value = serde_saphyr::from_str(raw_yaml)
            .map_err(|err| WorkflowError::message(err.to_string()))?;
        agent_config_from_value(&value)
    };
    Ok((config, body))
}

fn agent_config_from_value(value: &Value) -> AgentConfig {
    let Some(map) = value.as_object() else {
        return AgentConfig::default();
    };
    let tools = match map.get("tools") {
        Some(Value::Array(items)) => Some(items.clone()),
        _ => None,
    };
    let model = map.get("model").and_then(Value::as_str).map(str::to_string);
    let max_turns = map
        .get("maxTurns")
        .and_then(Value::as_f64)
        .map(JsNumber::from);
    let mut extra = Map::new();
    for (key, item) in map {
        if key != "tools" && key != "model" && key != "maxTurns" {
            extra.insert(key.clone(), item.clone());
        }
    }
    AgentConfig {
        tools,
        model,
        max_turns,
        extra,
    }
}

fn strip_leading_ws_if_fence(text: &str) -> &str {
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() {
            end = index + ch.len_utf8();
        } else {
            break;
        }
    }
    if text[end..].starts_with("---") {
        &text[end..]
    } else {
        text
    }
}

fn opening_fence(src: &str) -> bool {
    let Some(rest) = src.strip_prefix("---") else {
        return false;
    };
    let rest = rest.trim_start_matches([' ', '\t']);
    rest.starts_with("\n") || rest.starts_with("\r\n")
}

fn find_close(src: &str) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let newline_len = if bytes[index] == b'\n' {
            1
        } else if bytes[index] == b'\r' && index + 1 < bytes.len() && bytes[index + 1] == b'\n' {
            2
        } else {
            index += 1;
            continue;
        };
        let after = index + newline_len;
        if src[after..].starts_with("---") {
            let mut cursor = after + 3;
            while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
                cursor += 1;
            }
            if cursor == bytes.len() {
                return Some((index, cursor - index));
            }
            if bytes[cursor] == b'\n' {
                return Some((index, cursor + 1 - index));
            }
            if bytes[cursor] == b'\r' && cursor + 1 < bytes.len() && bytes[cursor + 1] == b'\n' {
                return Some((index, cursor + 2 - index));
            }
        }
        index += 1;
    }
    None
}

pub async fn resolve_workflow_dir(
    reference: &str,
    workflow_dirs: &[(String, std::path::PathBuf)],
    workflows_roots: &[std::path::PathBuf],
) -> Result<std::path::PathBuf, WorkflowError> {
    if reference.contains('/') || reference.starts_with('.') {
        let candidate = std::path::PathBuf::from(reference);
        if try_exists(&node_join_paths(&candidate, "workflow.yaml")).await? {
            return Ok(candidate);
        }
    }
    if let Some((_, dir)) = workflow_dirs.iter().find(|(key, _)| key == reference) {
        if try_exists(&node_join_paths(dir, "workflow.yaml")).await? {
            return Ok(dir.clone());
        }
        return Err(WorkflowError::workflow_not_found(
            reference,
            Some(format!(
                "Mapped dir missing workflow.yaml: {}",
                path_text(dir)
            )),
        ));
    }
    for root in workflows_roots {
        let candidate = node_join_paths(root, reference);
        if try_exists(&node_join_paths(&candidate, "workflow.yaml")).await? {
            return Ok(candidate);
        }
    }
    let direct = std::path::PathBuf::from(reference);
    if try_exists(&node_join_paths(&direct, "workflow.yaml")).await? {
        return Ok(direct);
    }
    Err(WorkflowError::workflow_not_found(
        reference,
        Some(format!(
            "Could not resolve workflow ref \"{reference}\" (checked workflowDirs + workflowsRoots)"
        )),
    ))
}
