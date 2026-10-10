use mesh::{
    Affinity, AgentPin, JsNumber, MeshDiscovery, MeshNode, PinOutcome, RouteKind, apply_agent_pin,
    delegation_tool_description, format_roster, list_reachable_agents, mesh_host,
    newest_online_node, parse_agent_pin, resolve_affinity, resolve_delegation_route,
    resolve_runtime_agent, should_take_remote, sync_target,
};
use serde_json::Map;

fn node(name: &str, agents: &[&str], status: &str, last_seen: u64) -> MeshNode {
    MeshNode {
        id: name.to_string(),
        name: name.to_string(),
        role: None,
        agents: agents.iter().map(|agent| (*agent).to_string()).collect(),
        host: "192.0.2.10".to_string(),
        port: JsNumber::from(3100_u32),
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: Vec::new(),
        status: status.to_string(),
        last_seen: JsNumber::from(last_seen),
        registered_at: JsNumber::from(1_u32),
        version: "0.7.0".to_string(),
        metadata: None,
        ssh_user: None,
        install_root: None,
        platform: None,
        extra: Map::new(),
    }
}

#[test]
fn newest_online_node_picks_the_latest_last_seen() {
    let nodes = vec![
        node("old", &["opus"], "online", 10),
        node("new", &["opus"], "online", 50),
        node("off", &["opus"], "offline", 90),
        node("other", &["grok"], "online", 80),
    ];
    assert_eq!(
        newest_online_node(&nodes, "opus", None, None).unwrap().name,
        "new"
    );
    assert!(
        newest_online_node(&nodes, "opus", None, Some("old"))
            .unwrap()
            .name
            == "old"
    );
    assert!(
        newest_online_node(&nodes, "opus", Some("new"), None)
            .unwrap()
            .name
            == "old"
    );
}

#[test]
fn equal_last_seen_keeps_the_earlier_node() {
    let nodes = vec![
        node("a", &["opus"], "online", 10),
        node("b", &["opus"], "online", 10),
    ];
    assert_eq!(
        newest_online_node(&nodes, "opus", None, None).unwrap().name,
        "a"
    );
}

#[test]
fn delegation_route_is_local_first_then_newest_remote() {
    let nodes = vec![
        node("node-f", &["opus"], "online", 5),
        node("node-c", &["opus"], "online", 9),
    ];
    let local = resolve_delegation_route("opus", &["opus"], &nodes).unwrap();
    assert_eq!(local.kind, RouteKind::Local);
    assert_eq!(local.node.id, "local");
    assert_eq!(local.node.name, "local");
    assert_eq!(local.node.host, "localhost");
    assert_eq!(local.node.port.as_f64(), 0.0);
    let remote = resolve_delegation_route("opus", &["local"], &nodes).unwrap();
    assert_eq!(remote.kind, RouteKind::Remote);
    assert_eq!(remote.node.name, "node-c");
    assert!(resolve_delegation_route("missing", &[], &nodes).is_none());
}

#[test]
fn roster_lists_local_agents_and_remote_nodes_excluding_self() {
    let nodes = vec![
        node("node-e", &["local", "grok"], "online", 1),
        node("node-f", &["opus", "grok"], "online", 2),
        node("node-c", &["grok", "grok-fast"], "online", 3),
        node("node-d", &["local"], "online", 4),
    ];
    let entries = list_reachable_agents(&["local", "grok"], "node-e", &nodes);
    let local = entries
        .iter()
        .find(|entry| entry.agent_id == "local")
        .unwrap();
    let grok = entries
        .iter()
        .find(|entry| entry.agent_id == "grok")
        .unwrap();
    let opus = entries
        .iter()
        .find(|entry| entry.agent_id == "opus")
        .unwrap();
    let fast = entries
        .iter()
        .find(|entry| entry.agent_id == "grok-fast")
        .unwrap();
    assert!(local.local);
    assert!(grok.local);
    assert!(!grok.remote_nodes.iter().any(|name| name == "node-e"));
    assert!(!opus.local);
    assert!(opus.remote_nodes.iter().any(|name| name == "node-f"));
    assert!(!fast.local);
    assert!(fast.remote_nodes.iter().any(|name| name == "node-c"));
}

#[test]
fn roster_ignores_offline_nodes() {
    let nodes = vec![
        node("node-e", &["local", "grok"], "online", 1),
        node("node-f", &["opus"], "offline", 2),
    ];
    let entries = list_reachable_agents(&["local", "grok"], "node-e", &nodes);
    assert!(!entries.iter().any(|entry| entry.agent_id == "opus"));
}

#[test]
fn delegation_description_contains_the_typescript_roster_prefix() {
    let nodes = vec![
        node("node-e", &["local", "grok"], "online", 1),
        node("node-f", &["opus"], "online", 2),
    ];
    let entries = list_reachable_agents(&["local", "grok"], "node-e", &nodes);
    let roster = format_roster(&entries, "");
    assert!(roster.contains("- local (this node — local, in-process)"));
    assert!(roster.contains("- opus (remote: node-f)"));
    let description = delegation_tool_description(&roster);
    assert!(description.contains("is better suited"));
    assert!(description.contains("delegate to right now"));
    assert!(description.contains("remote: node-f"));
    assert!(description.contains("local"));
}

#[test]
fn empty_roster_and_preset_roster_text() {
    assert_eq!(format_roster(&[], ""), "(no agents currently reachable)");
    let with_preset = format_roster(&[], "- reviewer");
    assert!(with_preset.contains("(no agents currently reachable)"));
    assert!(with_preset.contains("Agents (RivetHub presets):\n- reviewer"));
}

#[test]
fn agent_pin_parse_and_conflict_and_unhosted_texts() {
    let pin = parse_agent_pin("  opus@node-f  ").unwrap();
    assert_eq!(
        pin,
        AgentPin {
            agent_id: "opus".to_string(),
            node: "node-f".to_string(),
        }
    );
    assert!(parse_agent_pin("opus @node-f").is_none());
    assert!(parse_agent_pin("opus@").is_none());
    assert!(parse_agent_pin("@node").is_none());
    assert!(parse_agent_pin("a@b@c").is_none());
    assert!(matches!(
        apply_agent_pin("plain", None, &[], "node-e", &[]),
        PinOutcome::NotPinned
    ));
    match apply_agent_pin("opus@node-f", Some("node-c"), &[], "node-e", &[]) {
        PinOutcome::Conflict(text) => {
            assert_eq!(
                text,
                "agent \"opus@node-f\" pins node \"node-f\" but nodeAffinity is \"node-c\""
            );
        }
        other => panic!("expected conflict, got {other:?}"),
    }
    match apply_agent_pin("opus@node-f", None, &[], "node-e", &[]) {
        PinOutcome::Unhosted(text) => {
            assert_eq!(
                text,
                "runtime agent \"opus\" is not hosted on an online node \"node-f\""
            );
        }
        other => panic!("expected unhosted, got {other:?}"),
    }
    let nodes = vec![node("node-f", &["opus"], "online", 4)];
    match apply_agent_pin("opus@node-f", None, &[], "node-e", &nodes) {
        PinOutcome::Pinned { agent_id, node } => {
            assert_eq!(agent_id, "opus");
            assert_eq!(node, "node-f");
        }
        other => panic!("expected pinned, got {other:?}"),
    }
}

#[test]
fn runtime_agent_and_affinity_texts() {
    let nodes = vec![
        node("node-e", &["opus"], "online", 1),
        node("node-f", &["opus"], "online", 9),
        node("node-c", &["opus"], "online", 3),
    ];
    assert_eq!(
        resolve_runtime_agent("opus", None, &["opus"], "node-e", &nodes).as_deref(),
        Some("node-e")
    );
    assert_eq!(
        resolve_runtime_agent("opus", Some("node-c"), &["opus"], "node-e", &nodes).as_deref(),
        Some("node-c")
    );
    assert_eq!(
        resolve_runtime_agent("opus", None, &[], "node-e", &nodes).as_deref(),
        Some("node-f")
    );
    assert!(resolve_runtime_agent("missing", None, &[], "node-e", &nodes).is_none());
    assert_eq!(
        resolve_affinity("router", "node-e", &["router"], None, Some(&nodes)),
        Affinity::Node("node-e".to_string())
    );
    assert_eq!(
        resolve_affinity("opus", "node-e", &[], Some("preset-node"), Some(&nodes)),
        Affinity::Node("preset-node".to_string())
    );
    assert_eq!(
        resolve_affinity("opus", "node-e", &[], None, Some(&nodes)),
        Affinity::Node("node-f".to_string())
    );
    assert_eq!(
        resolve_affinity("missing", "node-e", &[], None, Some(&nodes)),
        Affinity::Missing("agent \"missing\" not found locally or on the mesh".to_string())
    );
    assert_eq!(
        resolve_affinity("missing", "node-e", &[], None, None),
        Affinity::Missing("agent \"missing\" not found locally".to_string())
    );
}

#[test]
fn sync_target_defaults_the_seed_port_to_3000_and_ignores_other_modes() {
    let seed = MeshDiscovery {
        mode: "seed".to_string(),
        seed_host: Some("10.0.0.1".to_string()),
        seed_port: None,
        mdns_service: None,
    };
    assert_eq!(
        sync_target(Some(&seed)),
        Some(("10.0.0.1".to_string(), 3000))
    );
    let explicit = MeshDiscovery {
        seed_port: Some(3100),
        ..seed.clone()
    };
    assert_eq!(
        sync_target(Some(&explicit)),
        Some(("10.0.0.1".to_string(), 3100))
    );
    let mdns = MeshDiscovery {
        mode: "mdns".to_string(),
        seed_host: Some("10.0.0.1".to_string()),
        seed_port: Some(9),
        mdns_service: Some("_rivetos._tcp".to_string()),
    };
    assert_eq!(sync_target(Some(&mdns)), None);
    let static_mode = MeshDiscovery {
        mode: "static".to_string(),
        seed_host: Some("10.0.0.1".to_string()),
        seed_port: None,
        mdns_service: None,
    };
    assert_eq!(sync_target(Some(&static_mode)), None);
    assert_eq!(sync_target(None), None);
}

#[test]
fn remote_take_and_mesh_host() {
    let older = node("a", &[], "online", 1);
    let newer = node("b", &[], "online", 2);
    let same = node("c", &[], "online", 2);
    assert!(should_take_remote(None, &older));
    assert!(should_take_remote(Some(&older), &newer));
    assert!(!should_take_remote(Some(&newer), &older));
    assert!(!should_take_remote(Some(&newer), &same));
    assert_eq!(mesh_host(&older), "a.mesh");
    let mut bare = older.clone();
    bare.name.clear();
    bare.host = "192.0.2.8".to_string();
    assert_eq!(mesh_host(&bare), "192.0.2.8");
}
