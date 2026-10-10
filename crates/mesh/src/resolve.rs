use protocol::js::js_trim;

use crate::model::{MeshNode, cmp_last_seen_desc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedRoute {
    pub agent_id: String,
    pub kind: RouteKind,
    pub node: MeshNode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterEntry {
    pub agent_id: String,
    pub local: bool,
    pub remote_nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Affinity {
    Node(String),
    Missing(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPin {
    pub agent_id: String,
    pub node: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinOutcome {
    NotPinned,
    Conflict(String),
    Unhosted(String),
    Pinned { agent_id: String, node: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshDiscovery {
    pub mode: String,
    pub seed_host: Option<String>,
    pub seed_port: Option<u16>,
    pub mdns_service: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshPeer {
    pub name: String,
    pub host: String,
    pub port: Option<u16>,
}

pub fn sync_target(discovery: Option<&MeshDiscovery>) -> Option<(String, u16)> {
    let discovery = discovery?;
    if discovery.mode != "seed" {
        return None;
    }
    let host = discovery
        .seed_host
        .as_deref()
        .filter(|host| !host.is_empty())?;
    Some((
        host.to_string(),
        discovery
            .seed_port
            .unwrap_or(crate::model::DEFAULT_SEED_PORT),
    ))
}

pub fn mesh_host(node: &MeshNode) -> String {
    if node.name.is_empty() {
        node.host.clone()
    } else {
        format!("{}.mesh", node.name)
    }
}

pub fn newest_online_node<'a>(
    nodes: &'a [MeshNode],
    agent_id: &str,
    exclude_name: Option<&str>,
    only_name: Option<&str>,
) -> Option<&'a MeshNode> {
    let mut online: Vec<&MeshNode> = nodes
        .iter()
        .filter(|node| {
            node.status == "online"
                && node.agents.iter().any(|agent| agent == agent_id)
                && exclude_name.map(|name| node.name != name).unwrap_or(true)
                && only_name.map(|name| node.name == name).unwrap_or(true)
        })
        .collect();
    online.sort_by(|left, right| cmp_last_seen_desc(left, right));
    online.first().copied()
}

pub fn resolve_delegation_route(
    agent_id: &str,
    local_agents: &[&str],
    nodes: &[MeshNode],
) -> Option<ResolvedRoute> {
    if local_agents.contains(&agent_id) {
        return Some(ResolvedRoute {
            agent_id: agent_id.to_string(),
            kind: RouteKind::Local,
            node: local_placeholder(),
        });
    }
    newest_online_node(nodes, agent_id, None, None).map(|node| ResolvedRoute {
        agent_id: agent_id.to_string(),
        kind: RouteKind::Remote,
        node: node.clone(),
    })
}

fn local_placeholder() -> MeshNode {
    MeshNode {
        id: "local".to_string(),
        name: "local".to_string(),
        role: None,
        agents: Vec::new(),
        host: "localhost".to_string(),
        port: protocol::JsNumber::from(0_u32),
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: Vec::new(),
        status: "online".to_string(),
        last_seen: protocol::JsNumber::from(0_u32),
        registered_at: protocol::JsNumber::from(0_u32),
        version: String::new(),
        metadata: None,
        ssh_user: None,
        install_root: None,
        platform: None,
        extra: serde_json::Map::new(),
    }
}

pub fn resolve_runtime_agent(
    agent_id: &str,
    node: Option<&str>,
    local_agents: &[&str],
    local_node_name: &str,
    nodes: &[MeshNode],
) -> Option<String> {
    let local = local_agents.contains(&agent_id);
    if local && node.map(|name| name == local_node_name).unwrap_or(true) {
        return Some(local_node_name.to_string());
    }
    newest_online_node(nodes, agent_id, Some(local_node_name), node).map(|node| node.name.clone())
}

pub fn resolve_affinity(
    agent_id: &str,
    local_node_name: &str,
    router_agents: &[&str],
    preset_node: Option<&str>,
    mesh: Option<&[MeshNode]>,
) -> Affinity {
    if router_agents.contains(&agent_id) {
        return Affinity::Node(local_node_name.to_string());
    }
    if let Some(node) = preset_node.filter(|node| !node.is_empty()) {
        return Affinity::Node(node.to_string());
    }
    if let Some(nodes) = mesh {
        if let Some(best) = newest_online_node(nodes, agent_id, Some(local_node_name), None) {
            return Affinity::Node(best.name.clone());
        }
        return Affinity::Missing(format!(
            "agent \"{agent_id}\" not found locally or on the mesh"
        ));
    }
    Affinity::Missing(format!("agent \"{agent_id}\" not found locally"))
}

pub fn parse_agent_pin(raw: &str) -> Option<AgentPin> {
    let trimmed = js_trim(raw);
    let (agent, node) = trimmed.split_once('@')?;
    if agent.is_empty() || node.is_empty() || node.contains('@') {
        return None;
    }
    if has_js_whitespace(agent) || has_js_whitespace(node) {
        return None;
    }
    Some(AgentPin {
        agent_id: agent.to_string(),
        node: node.to_string(),
    })
}

fn has_js_whitespace(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{000B}' | '\u{000C}'))
}

pub fn apply_agent_pin(
    agent_id: &str,
    node_affinity: Option<&str>,
    local_agents: &[&str],
    local_node_name: &str,
    nodes: &[MeshNode],
) -> PinOutcome {
    let Some(pin) = parse_agent_pin(agent_id) else {
        return PinOutcome::NotPinned;
    };
    if let Some(affinity) = node_affinity
        && affinity != pin.node
    {
        return PinOutcome::Conflict(format!(
            "agent \"{}\" pins node \"{}\" but nodeAffinity is \"{affinity}\"",
            js_trim(agent_id),
            pin.node
        ));
    }
    match resolve_runtime_agent(
        &pin.agent_id,
        Some(pin.node.as_str()),
        local_agents,
        local_node_name,
        nodes,
    ) {
        Some(host) => PinOutcome::Pinned {
            agent_id: pin.agent_id,
            node: host,
        },
        None => PinOutcome::Unhosted(format!(
            "runtime agent \"{}\" is not hosted on an online node \"{}\"",
            pin.agent_id, pin.node
        )),
    }
}

pub fn list_reachable_agents(
    local_agents: &[&str],
    node_name: &str,
    nodes: &[MeshNode],
) -> Vec<RosterEntry> {
    let mut entries: Vec<RosterEntry> = local_agents
        .iter()
        .map(|agent_id| RosterEntry {
            agent_id: (*agent_id).to_string(),
            local: true,
            remote_nodes: Vec::new(),
        })
        .collect();
    for node in nodes {
        if node.status != "online" {
            continue;
        }
        if !node_name.is_empty() && node.name == node_name {
            continue;
        }
        for agent_id in &node.agents {
            if let Some(existing) = entries.iter_mut().find(|entry| entry.agent_id == *agent_id) {
                if existing.local {
                    continue;
                }
                if !existing.remote_nodes.iter().any(|name| name == &node.name) {
                    existing.remote_nodes.push(node.name.clone());
                }
            } else {
                entries.push(RosterEntry {
                    agent_id: agent_id.clone(),
                    local: false,
                    remote_nodes: vec![node.name.clone()],
                });
            }
        }
    }
    entries
}

pub fn format_roster(entries: &[RosterEntry], preset_roster: &str) -> String {
    let lines = if entries.is_empty() {
        "(no agents currently reachable)".to_string()
    } else {
        entries
            .iter()
            .map(|entry| {
                if entry.local {
                    format!("- {} (this node — local, in-process)", entry.agent_id)
                } else {
                    format!(
                        "- {} (remote: {})",
                        entry.agent_id,
                        entry.remote_nodes.join(", ")
                    )
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    if preset_roster.is_empty() {
        lines
    } else {
        format!("{lines}\n\nAgents (RivetHub presets):\n{preset_roster}")
    }
}

pub fn delegation_tool_description(roster_text: &str) -> String {
    format!(
        "Delegate a task to another agent — use when a different model or specialist is better suited (e.g., ask \"opus\" to review code, ask \"grok\" for live web/X search). The delegate runs with its own model and returns the result. Works across the mesh — targets on other nodes are reached automatically.\n\nAgents you can delegate to right now (pass one as `to_agent`):\n{roster_text}\n\nPick the agent whose model/strengths fit the task; \"local\" runs a fresh context on this node."
    )
}

pub fn should_take_remote(local: Option<&MeshNode>, remote: &MeshNode) -> bool {
    match local {
        None => true,
        Some(local) => remote.last_seen.as_f64() > local.last_seen.as_f64(),
    }
}
