use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mesh::{
    BuildLocalNodeArgs, FileMeshRegistry, JsNumber, MESH_FILE_NAME, MeshNode, MeshNodeEvent,
    RegistryConfig, inherit_operator_fields, operator_host_warning, shared_dir,
};
use serde_json::{Map, Value, json};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "rr7m-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn registry(dir: &Path) -> FileMeshRegistry {
    FileMeshRegistry::new(RegistryConfig {
        storage_dir: dir.display().to_string(),
        heartbeat_interval_ms: Some(60_000),
        stale_threshold_ms: Some(5_000),
        discovery: None,
        on_event: None,
        tls: None,
    })
}

fn sample(name: &str, agents: &[&str], host: &str) -> MeshNode {
    mesh::build_local_node(BuildLocalNodeArgs {
        existing_id: None,
        name: Some(name.to_string()),
        role: None,
        agents: agents.iter().map(|agent| (*agent).to_string()).collect(),
        host: host.to_string(),
        port: 3100,
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: None,
        metadata: None,
        version: "0.7.0".to_string(),
    })
}

#[tokio::test]
async fn registers_and_retrieves_a_node() {
    let scratch = Scratch::new();
    let events = Arc::new(Mutex::new(Vec::<MeshNodeEvent>::new()));
    let seen = Arc::clone(&events);
    let registry = FileMeshRegistry::new(RegistryConfig {
        storage_dir: scratch.path().display().to_string(),
        heartbeat_interval_ms: Some(60_000),
        stale_threshold_ms: Some(5_000),
        discovery: None,
        on_event: Some(Arc::new(move |event| seen.lock().unwrap().push(event))),
        tls: None,
    });
    let node = mesh::build_local_node(BuildLocalNodeArgs {
        existing_id: None,
        name: Some("test-node".to_string()),
        role: None,
        agents: vec!["opus".to_string(), "grok".to_string()],
        host: "192.168.1.101".to_string(),
        port: 3100,
        providers: vec!["anthropic".to_string(), "xai".to_string()],
        models: vec![
            "claude-sonnet-4-20250514".to_string(),
            "grok-4-1-fast-reasoning".to_string(),
        ],
        capabilities: None,
        metadata: None,
        version: "0.7.0".to_string(),
    });
    registry.register(node.clone()).await.unwrap();
    let retrieved = registry.get_node(&node.id).await.unwrap().unwrap();
    assert_eq!(retrieved.name, "test-node");
    assert_eq!(
        retrieved.agents,
        vec!["opus".to_string(), "grok".to_string()]
    );
    assert_eq!(retrieved.status, "online");
    let raw = std::fs::read_to_string(scratch.path().join(MESH_FILE_NAME)).unwrap();
    let data: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(data["version"], json!(1));
    assert_eq!(data["nodes"].as_object().unwrap().len(), 1);
    assert!(!raw.ends_with('\n'));
    let event_type = events.lock().unwrap()[0].event_type.clone();
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(event_type, "node:joined");
    registry.stop().await.unwrap();
}

#[tokio::test]
async fn finds_nodes_by_agent_provider_and_capability() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let mut first = sample("node-1", &["opus"], "192.168.1.101");
    first.providers = vec!["anthropic".to_string()];
    let mut second = sample("node-2", &["grok"], "192.168.1.102");
    second.providers = vec!["xai".to_string()];
    registry.register(first).await.unwrap();
    registry.register(second).await.unwrap();
    assert_eq!(
        registry.find_by_agent("opus").await.unwrap()[0].name,
        "node-1"
    );
    assert_eq!(
        registry.find_by_agent("grok").await.unwrap()[0].name,
        "node-2"
    );
    assert!(registry.find_by_agent("local").await.unwrap().is_empty());
    assert_eq!(
        registry.find_by_provider("anthropic").await.unwrap().len(),
        1
    );
    assert!(
        registry
            .find_by_provider("ollama")
            .await
            .unwrap()
            .is_empty()
    );

    let mut den = sample("den-node", &["opus"], "192.168.1.101");
    den.capabilities = vec!["den".to_string()];
    let mut metadata = Map::new();
    metadata.insert("denPort".to_string(), json!(5199));
    den.metadata = Some(metadata);
    registry.register(den).await.unwrap();
    let found = registry.find_by_capability("den").await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].metadata.as_ref().unwrap().get("denPort"),
        Some(&json!(5199))
    );
}

#[tokio::test]
async fn deregister_marks_the_node_offline() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let node = sample("ephemeral", &["test"], "192.168.1.200");
    registry.register(node.clone()).await.unwrap();
    registry.deregister(&node.id).await.unwrap();
    let retrieved = registry.get_node(&node.id).await.unwrap().unwrap();
    assert_eq!(retrieved.status, "offline");
    assert!(registry.find_by_agent("test").await.unwrap().is_empty());
}

#[tokio::test]
async fn heartbeats_update_last_seen() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let node = sample("heartbeat-test", &["opus"], "192.168.1.101");
    registry.register(node.clone()).await.unwrap();
    let before = registry
        .get_node(&node.id)
        .await
        .unwrap()
        .unwrap()
        .last_seen;
    tokio::time::sleep(Duration::from_millis(10)).await;
    registry.heartbeat(&node.id, Some("online")).await.unwrap();
    let after = registry
        .get_node(&node.id)
        .await
        .unwrap()
        .unwrap()
        .last_seen;
    assert!(after.as_f64() > before.as_f64());
}

#[tokio::test]
async fn prunes_stale_agent_nodes_and_skips_self_and_infrastructure() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let local = sample("local-node", &["opus"], "192.168.1.101");
    registry.start(local).await.unwrap();
    let mut stale = sample("stale-node", &["old"], "192.168.1.200");
    stale.last_seen = JsNumber::from(mesh::now_ms_u64().saturating_sub(100_000));
    registry.register(stale.clone()).await.unwrap();
    let mut infra = sample("datahub", &[], "192.168.1.110");
    infra.role = Some("datahub".to_string());
    infra.last_seen = JsNumber::from(mesh::now_ms_u64().saturating_sub(100_000));
    registry.register(infra.clone()).await.unwrap();
    let pruned = registry.prune(Some(5_000)).await.unwrap();
    assert_eq!(pruned.len(), 1);
    assert_eq!(pruned[0].name, "stale-node");
    assert_eq!(
        registry.get_node(&stale.id).await.unwrap().unwrap().status,
        "offline"
    );
    assert_eq!(
        registry.get_node(&infra.id).await.unwrap().unwrap().status,
        "online"
    );
    registry.stop().await.unwrap();
}

#[tokio::test]
async fn build_local_node_matches_the_typescript_defaults() {
    let generated = sample("test", &["opus"], "192.168.1.101");
    assert!(generated.id.len() == 36);
    assert!(generated.id.as_bytes()[14] == b'4');
    assert_eq!(generated.status, "online");
    assert!(generated.registered_at.as_f64() > 0.0);
    assert!(generated.last_seen.as_f64() > 0.0);
    assert!(generated.capabilities.is_empty());
    assert!(generated.metadata.is_none());
    assert!(generated.platform.is_none());
    let fixed = mesh::build_local_node(BuildLocalNodeArgs {
        existing_id: Some("my-fixed-id".to_string()),
        name: Some("test".to_string()),
        role: None,
        agents: Vec::new(),
        host: "127.0.0.1".to_string(),
        port: 3100,
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: Some(vec!["den".to_string()]),
        metadata: Some({
            let mut metadata = Map::new();
            metadata.insert("denPort".to_string(), json!(5174));
            metadata
        }),
        version: "0.7.0".to_string(),
    });
    assert_eq!(fixed.id, "my-fixed-id");
    assert_eq!(fixed.capabilities, vec!["den".to_string()]);
    assert_eq!(fixed.metadata.unwrap().get("denPort"), Some(&json!(5174)));
    let value = generated.to_value();
    assert!(value.get("metadata").is_none());
    assert!(value.get("platform").is_none());
}

#[tokio::test]
async fn re_registration_keeps_operator_fields_and_an_explicit_value_wins() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let mut node = sample("desk", &["opus"], "192.168.1.50");
    node.port = JsNumber::from(3000_u32);
    registry.register(node.clone()).await.unwrap();
    let mut edited = node.clone();
    edited.ssh_user = Some("deskuser".to_string());
    edited.install_root = Some("/home/deskuser/rivetos".to_string());
    edited.platform = Some("linux".to_string());
    registry.register(edited).await.unwrap();
    let mut restarted = node.clone();
    restarted.version = "0.8.0".to_string();
    registry.register(restarted).await.unwrap();
    let stored = registry.get_node(&node.id).await.unwrap().unwrap();
    assert_eq!(stored.ssh_user.as_deref(), Some("deskuser"));
    assert_eq!(
        stored.install_root.as_deref(),
        Some("/home/deskuser/rivetos")
    );
    assert_eq!(stored.platform.as_deref(), Some("linux"));
    assert_eq!(stored.version, "0.8.0");
    let mut named = node.clone();
    named.ssh_user = Some("rivet".to_string());
    registry.register(named).await.unwrap();
    let mut blank = node.clone();
    blank.install_root = None;
    registry.register(blank).await.unwrap();
    let stored = registry.get_node(&node.id).await.unwrap().unwrap();
    assert_eq!(stored.ssh_user.as_deref(), Some("rivet"));
    assert_eq!(
        stored.install_root.as_deref(),
        Some("/home/deskuser/rivetos")
    );
    let mut empty = node.clone();
    empty.ssh_user = Some(String::new());
    registry.register(empty).await.unwrap();
    assert_eq!(
        registry
            .get_node(&node.id)
            .await
            .unwrap()
            .unwrap()
            .ssh_user
            .as_deref(),
        Some("")
    );
    let fresh = sample("new", &[], "192.168.1.51");
    registry.register(fresh.clone()).await.unwrap();
    assert!(
        registry
            .get_node(&fresh.id)
            .await
            .unwrap()
            .unwrap()
            .ssh_user
            .is_none()
    );
}

#[tokio::test]
async fn start_keeps_a_hand_edited_roster_entry() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let local = mesh::build_local_node(BuildLocalNodeArgs {
        existing_id: Some("desk".to_string()),
        name: Some("desk".to_string()),
        role: None,
        agents: Vec::new(),
        host: "192.168.1.50".to_string(),
        port: 3000,
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: None,
        metadata: None,
        version: "0.8.0".to_string(),
    });
    let mut edited = local.clone();
    edited.ssh_user = Some("deskuser".to_string());
    registry.register(edited).await.unwrap();
    registry.start(local).await.unwrap();
    registry.stop().await.unwrap();
    assert_eq!(
        registry
            .get_node("desk")
            .await
            .unwrap()
            .unwrap()
            .ssh_user
            .as_deref(),
        Some("deskuser")
    );
}

#[test]
fn inherit_operator_fields_leaves_a_node_with_nothing_to_inherit() {
    let node = sample("n", &[], "192.168.1.60");
    assert_eq!(inherit_operator_fields(node.clone(), None), node);
    let mut existing = node.clone();
    existing.host = "192.168.1.61".to_string();
    existing.ssh_user = Some("deskuser".to_string());
    let merged = inherit_operator_fields(node.clone(), Some(&existing));
    assert_eq!(merged.ssh_user.as_deref(), Some("deskuser"));
    assert!(merged.platform.is_none());
    let warning = operator_host_warning(&node, &existing, &merged).unwrap();
    assert_eq!(
        warning,
        format!(
            "Node {}: keeping sshUser recorded for host 192.168.1.61 on new host 192.168.1.60 — check mesh.json",
            node.id
        )
    );
}

#[tokio::test]
async fn get_nodes_returns_every_node() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    registry
        .register(sample("a", &["opus"], "10.0.0.1"))
        .await
        .unwrap();
    registry
        .register(sample("b", &["grok"], "10.0.0.2"))
        .await
        .unwrap();
    assert_eq!(registry.get_nodes().await.unwrap().len(), 2);
}

#[tokio::test]
async fn flat_array_fails_loud_and_invalid_json_is_an_empty_registry() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    std::fs::write(
        scratch.path().join(MESH_FILE_NAME),
        json!({
            "nodes": [{ "name": "legacy-node", "ip": "192.0.2.1", "role": "primary" }],
            "updatedAt": 1
        })
        .to_string(),
    )
    .unwrap();
    let err = registry.get_nodes().await.unwrap_err();
    assert!(err.to_string().contains("pre-capabilities flat-array"));
    std::fs::write(scratch.path().join(MESH_FILE_NAME), "{nope").unwrap();
    assert!(registry.get_nodes().await.unwrap().is_empty());
    let _ = std::fs::remove_file(scratch.path().join(MESH_FILE_NAME));
    assert!(registry.get_nodes().await.unwrap().is_empty());
}

#[tokio::test]
async fn heartbeat_round_trips_unknown_fields() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    std::fs::write(
        scratch.path().join(MESH_FILE_NAME),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "updatedAt": 1,
            "extraRoot": { "future": true },
            "nodes": {
                "n1": {
                    "id": "n1",
                    "name": "n1",
                    "host": "192.0.2.1",
                    "port": 3100,
                    "agents": [],
                    "providers": [],
                    "models": [],
                    "capabilities": [],
                    "status": "online",
                    "lastSeen": 1,
                    "registeredAt": 1,
                    "version": "1",
                    "unknownNodeField": "keep-me"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    registry.heartbeat("n1", Some("online")).await.unwrap();
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(scratch.path().join(MESH_FILE_NAME)).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["extraRoot"], json!({ "future": true }));
    assert_eq!(saved["nodes"]["n1"]["unknownNodeField"], json!("keep-me"));
    assert!(saved["nodes"]["n1"]["lastSeen"].as_f64().unwrap() > 1.0);
}

#[tokio::test]
async fn skips_a_malformed_node_instead_of_failing_the_load() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    std::fs::write(
        scratch.path().join(MESH_FILE_NAME),
        json!({
            "version": 1,
            "updatedAt": 1,
            "nodes": {
                "good": {
                    "id": "good",
                    "name": "good",
                    "host": "192.0.2.1",
                    "port": 3100,
                    "status": "online",
                    "lastSeen": 1,
                    "registeredAt": 1,
                    "version": "1"
                },
                "bad": { "host": "h", "port": "3100" }
            }
        })
        .to_string(),
    )
    .unwrap();
    let nodes = registry.get_nodes().await.unwrap();
    assert_eq!(
        nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["good"]
    );
    let warnings = registry.warnings();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("\"bad\""));
}

#[tokio::test]
async fn save_leaves_the_original_file_when_the_write_is_forced_to_fail() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let node = sample("kept-node", &["opus"], "192.168.1.101");
    registry.register(node.clone()).await.unwrap();
    let mesh_path = scratch.path().join(MESH_FILE_NAME);
    let before = std::fs::read_to_string(&mesh_path).unwrap();
    registry.fail_next_save("ENOSPC: no space left on device");
    let other = sample("other-node", &["grok"], "192.168.1.102");
    let err = registry.register(other).await.unwrap_err();
    assert!(err.to_string().contains("ENOSPC"));
    assert_eq!(std::fs::read_to_string(&mesh_path).unwrap(), before);
    assert!(registry.get_node(&node.id).await.unwrap().unwrap().name == "kept-node");
    assert!(
        !scratch
            .path()
            .join(format!("{MESH_FILE_NAME}.tmp-{}", std::process::id()))
            .exists()
    );
}

#[tokio::test]
async fn heartbeat_on_an_empty_roster_re_registers() {
    let scratch = Scratch::new();
    let registry = registry(scratch.path());
    let node = mesh::build_local_node(BuildLocalNodeArgs {
        existing_id: None,
        name: Some("self-heal-node".to_string()),
        role: None,
        agents: vec!["opus".to_string()],
        host: "192.168.1.101".to_string(),
        port: 3100,
        providers: vec!["anthropic".to_string()],
        models: vec!["claude-sonnet-4-20250514".to_string()],
        capabilities: None,
        metadata: None,
        version: "0.7.0".to_string(),
    });
    registry.start(node.clone()).await.unwrap();
    std::fs::write(
        scratch.path().join(MESH_FILE_NAME),
        json!({ "version": 1, "nodes": {}, "updatedAt": 0 }).to_string(),
    )
    .unwrap();
    assert!(registry.get_node(&node.id).await.unwrap().is_none());
    registry.heartbeat(&node.id, Some("online")).await.unwrap();
    let restored = registry.get_node(&node.id).await.unwrap().unwrap();
    assert_eq!(restored.id, node.id);
    assert_eq!(restored.name, "self-heal-node");
    assert_eq!(restored.agents, vec!["opus".to_string()]);
    assert_eq!(restored.host, "192.168.1.101");
    assert_eq!(restored.status, "online");
    assert!(restored.last_seen.as_f64() > node.last_seen.as_f64());
    registry.stop().await.unwrap();
}

#[tokio::test]
async fn events_run_after_the_file_lock_is_released() {
    let scratch = Scratch::new();
    let slot: Arc<Mutex<Option<FileMeshRegistry>>> = Arc::new(Mutex::new(None));
    let slot_cb = Arc::clone(&slot);
    let saw = Arc::new(AtomicBool::new(false));
    let saw_cb = Arc::clone(&saw);
    let registry = FileMeshRegistry::new(RegistryConfig {
        storage_dir: scratch.path().display().to_string(),
        heartbeat_interval_ms: Some(60_000),
        stale_threshold_ms: Some(5_000),
        discovery: None,
        on_event: Some(Arc::new(move |_| {
            let reg = slot_cb.lock().unwrap().clone().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                let ok = runtime.block_on(reg.get_nodes()).is_ok();
                let _ = tx.send(ok);
            });
            if let Ok(ok) = rx.recv_timeout(Duration::from_secs(3)) {
                saw_cb.store(ok, Ordering::SeqCst);
            }
        })),
        tls: None,
    });
    *slot.lock().unwrap() = Some(registry.clone());
    registry
        .register(sample("locked", &["opus"], "10.0.0.8"))
        .await
        .unwrap();
    assert!(saw.load(Ordering::SeqCst));
}

#[tokio::test]
async fn two_registries_serialize_writes_on_the_same_file() {
    let scratch = Scratch::new();
    let left = registry(scratch.path());
    let right = registry(scratch.path());
    let first = sample("left", &["opus"], "10.0.0.1");
    let second = sample("right", &["grok"], "10.0.0.2");
    let (left_result, right_result) = tokio::join!(left.register(first), right.register(second));
    left_result.unwrap();
    right_result.unwrap();
    assert_eq!(left.get_nodes().await.unwrap().len(), 2);
}

#[test]
fn empty_storage_dir_uses_the_shared_dir_at_construction() {
    let registry = FileMeshRegistry::new(RegistryConfig {
        storage_dir: String::new(),
        heartbeat_interval_ms: None,
        stale_threshold_ms: None,
        discovery: None,
        on_event: None,
        tls: None,
    });
    assert_eq!(
        registry.file_path(),
        std::path::Path::new(&shared_dir()).join(MESH_FILE_NAME)
    );
}
