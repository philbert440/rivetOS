use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use mesh::{
    MeshFile, MeshNode, MeshParseOptions, OnInvalidNode, cli_mesh_paths, den_url_for, home_dir,
    install_root, install_root_from, load_mesh_file_blocking, local_mesh_identity,
    mesh_den_origins, mesh_file_paths, path_join, shared_dir, shared_dir_from, shared_path,
};
use serde_json::{Map, json};

#[test]
fn shared_dir_from_matches_the_typescript_rules() {
    assert_eq!(shared_dir_from(None), "/rivet-shared");
    assert_eq!(shared_dir_from(Some("")), "/rivet-shared");
    assert_eq!(shared_dir_from(Some("   ")), "/rivet-shared");
    assert_eq!(shared_dir_from(Some("  /mnt/shared  ")), "/mnt/shared");
    assert_eq!(shared_dir_from(Some("/mnt/shared/")), "/mnt/shared/");
    assert_eq!(shared_dir_from(Some("/custom/shared")), "/custom/shared");
}

#[test]
fn path_join_preserves_an_empty_root_and_collapses_a_trailing_slash() {
    assert_eq!(path_join("/rivet-shared", &[]), "/rivet-shared");
    assert_eq!(path_join("/mnt/shared/", &[]), "/mnt/shared/");
    assert_eq!(
        path_join("/rivet-shared", &["mesh.json"]),
        "/rivet-shared/mesh.json"
    );
    assert_eq!(
        path_join("/rivet-shared", &["workflows", "runs"]),
        "/rivet-shared/workflows/runs"
    );
    assert_eq!(
        path_join("/mnt/shared/", &["mesh.json"]),
        "/mnt/shared/mesh.json"
    );
    assert_eq!(
        path_join("/custom/shared", &["rivetos", "users.json"]),
        "/custom/shared/rivetos/users.json"
    );
}

#[test]
fn install_root_from_matches_the_typescript_rules() {
    assert_eq!(install_root_from(None), "/opt/rivetos");
    assert_eq!(install_root_from(Some("")), "/opt/rivetos");
    assert_eq!(install_root_from(Some("   ")), "/opt/rivetos");
    assert_eq!(install_root_from(Some("  /mnt/rivetos  ")), "/mnt/rivetos");
    assert_eq!(install_root_from(Some("/mnt/rivetos/")), "/mnt/rivetos/");
    assert_eq!(
        path_join(
            &install_root_from(None),
            &["infra", "scripts", "setup-mesh-hosts.sh"]
        ),
        "/opt/rivetos/infra/scripts/setup-mesh-hosts.sh"
    );
    assert_eq!(
        path_join(&install_root_from(Some("/mnt/rivetos/")), &["package.json"]),
        "/mnt/rivetos/package.json"
    );
    assert_eq!(path_join(&install_root_from(None), &[]), "/opt/rivetos");
}

#[test]
fn live_dir_functions_agree_with_the_join_helpers() {
    assert_eq!(shared_path(&[]), shared_dir());
    assert_eq!(
        shared_path(&["mesh.json"]),
        path_join(&shared_dir(), &["mesh.json"])
    );
    assert_eq!(mesh::install_path(&[]), install_root());
    assert_eq!(
        mesh::install_path(&["packages", "cli"]),
        path_join(&install_root(), &["packages", "cli"])
    );
}

#[test]
fn mesh_file_paths_follow_the_den_search_order() {
    let home = home_dir();
    assert!(!home.is_empty());
    assert_eq!(
        mesh_file_paths("", Some("/gateway/shared")),
        vec![
            "/gateway/shared/mesh.json".to_string(),
            format!("{home}/.rivetos/mesh.json"),
        ]
    );
    assert_eq!(
        mesh_file_paths("/x/mesh.json", Some("/ignored")),
        vec!["/x/mesh.json".to_string()]
    );
    let live = mesh_file_paths("", None);
    assert_eq!(live[0], path_join(&shared_dir(), &["mesh.json"]));
    assert_eq!(live[1], format!("{home}/.rivetos/mesh.json"));
}

#[test]
fn cli_mesh_paths_start_at_the_shared_file() {
    let paths = cli_mesh_paths(None);
    assert_eq!(paths, vec![shared_path(&["mesh.json"])]);
    let with_root = cli_mesh_paths(Some("/tmp/rr7m-root"));
    assert_eq!(with_root[0], shared_path(&["mesh.json"]));
    assert!(with_root[1].ends_with("/tmp/rr7m-root/mesh.json"));
    assert!(Path::new(&with_root[1]).is_absolute());
}

#[test]
fn local_mesh_identity_reads_the_roster_entry() {
    let node = identity_node("node-g", "192.0.2.116", Some("user"));
    let nodes = vec![("node-g".to_string(), node)];
    let identity = local_mesh_identity(Some(&nodes), "node-g", "fallback");
    assert_eq!(identity.host, "192.0.2.116");
    assert_eq!(identity.ssh_user, "user");
}

#[test]
fn local_mesh_identity_defaults_when_the_node_is_missing() {
    let missing = local_mesh_identity(None, "node-g", "box");
    assert_eq!(missing.host, "box");
    assert_eq!(missing.ssh_user, "rivet");
    let other = identity_node("other", "192.0.2.10", None);
    let nodes = vec![("other".to_string(), other)];
    let identity = local_mesh_identity(Some(&nodes), "node-g", "box");
    assert_eq!(identity.host, "box");
    assert_eq!(identity.ssh_user, "rivet");
}

#[test]
fn local_mesh_identity_matches_by_node_id_when_the_key_differs() {
    let node = identity_node("node-g", "192.0.2.10", Some("rivet"));
    let nodes = vec![("alias".to_string(), node)];
    let identity = local_mesh_identity(Some(&nodes), "node-g", "box");
    assert_eq!(identity.host, "192.0.2.10");
    assert_eq!(identity.ssh_user, "rivet");
}

#[test]
fn den_url_for_covers_explicit_port_capability_and_rejects_non_http() {
    let mut ftp = named("evil", "192.0.2.9");
    ftp.metadata = Some(meta_url("ftp://192.0.2.9/pub"));
    let rejected = den_url_for("evil", &ftp);
    assert!(rejected.url.is_none());
    assert!(rejected.warning.unwrap().contains("is not http(s)"));

    let mut junk = named("junk", "192.0.2.9");
    junk.metadata = Some(meta_url("not a url"));
    assert!(den_url_for("junk", &junk).url.is_none());

    let mut tls = named("tls", "tls.example");
    tls.metadata = Some(meta_url("https://tls.example:5174/"));
    assert_eq!(
        den_url_for("tls", &tls).url.as_deref(),
        Some("https://tls.example:5174")
    );

    let mut port = named("port", "192.0.2.20");
    let mut metadata = Map::new();
    metadata.insert("denPort".to_string(), json!(5175));
    port.metadata = Some(metadata);
    assert_eq!(
        den_url_for("port", &port).url.as_deref(),
        Some("http://192.0.2.20:5175")
    );

    let mut tagged = named("tag", "192.0.2.30");
    tagged.capabilities = vec!["den".to_string()];
    assert_eq!(
        den_url_for("tag", &tagged).url.as_deref(),
        Some("http://192.0.2.30:5174")
    );

    let plain = named("plain", "192.0.2.40");
    assert!(den_url_for("plain", &plain).url.is_none());
}

#[test]
fn mesh_den_origins_lists_every_den_origin() {
    let mut tls = named("tls", "tls.example");
    tls.metadata = Some(meta_url("https://tls.example:5174/"));
    let mut port = named("port", "192.0.2.20");
    let mut metadata = Map::new();
    metadata.insert("denPort".to_string(), json!("5175"));
    port.metadata = Some(metadata);
    let mut tagged = named("tag", "192.0.2.30");
    tagged.capabilities = vec!["den".to_string()];
    let plain = named("plain", "192.0.2.40");
    let file = MeshFile {
        version: mesh::JsNumber::from(1_u32),
        nodes: vec![
            ("plain".to_string(), plain),
            ("tls".to_string(), tls),
            ("port".to_string(), port),
            ("tag".to_string(), tagged),
        ],
        updated_at: mesh::JsNumber::from(1_u32),
        extra: Map::new(),
    };
    let mut origins = mesh_den_origins(&file);
    origins.sort();
    assert_eq!(
        origins,
        vec![
            "http://192.0.2.20:5175".to_string(),
            "http://192.0.2.30:5174".to_string(),
            "https://192.0.2.20:5175".to_string(),
            "https://192.0.2.30:5174".to_string(),
            "https://tls.example:5174".to_string(),
        ]
    );
}

#[test]
fn load_mesh_file_uses_the_first_readable_candidate() {
    let scratch = Scratch::new();
    let missing = scratch.path().join("a.json");
    let present = scratch.path().join("b.json");
    std::fs::write(
        &present,
        json!({ "version": 1, "updatedAt": 22, "nodes": {} }).to_string(),
    )
    .unwrap();
    let paths = vec![missing.display().to_string(), present.display().to_string()];
    let loaded = load_mesh_file_blocking(&paths, MeshParseOptions::default())
        .unwrap()
        .unwrap();
    assert_eq!(loaded.file.updated_at.as_f64(), 22.0);
    std::fs::write(
        scratch.path().join("a.json"),
        json!({ "version": 1, "updatedAt": 11, "nodes": {} }).to_string(),
    )
    .unwrap();
    let loaded = load_mesh_file_blocking(&paths, MeshParseOptions::default())
        .unwrap()
        .unwrap();
    assert_eq!(loaded.file.updated_at.as_f64(), 11.0);
    let none = load_mesh_file_blocking(
        &[scratch.path().join("nope.json").display().to_string()],
        MeshParseOptions::default(),
    )
    .unwrap();
    assert!(none.is_none());
}

#[test]
fn load_mesh_file_skips_invalid_json_and_throws_on_a_flat_array() {
    let scratch = Scratch::new();
    let bad = scratch.path().join("bad.json");
    let good = scratch.path().join("good.json");
    std::fs::write(&bad, "{nope").unwrap();
    std::fs::write(
        &good,
        json!({ "version": 1, "updatedAt": 3, "nodes": {} }).to_string(),
    )
    .unwrap();
    let loaded = load_mesh_file_blocking(
        &[bad.display().to_string(), good.display().to_string()],
        MeshParseOptions::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(loaded.file.updated_at.as_f64(), 3.0);

    let flat = scratch.path().join("flat.json");
    std::fs::write(
        &flat,
        json!({
            "nodes": [{ "name": "legacy-node", "ip": "192.0.2.1" }],
            "updatedAt": 99
        })
        .to_string(),
    )
    .unwrap();
    let err = load_mesh_file_blocking(&[flat.display().to_string()], MeshParseOptions::default())
        .unwrap_err();
    assert!(err.to_string().contains("pre-capabilities flat-array"));
}

#[test]
fn load_mesh_file_skip_keeps_the_rest_of_the_roster() {
    let scratch = Scratch::new();
    let file = scratch.path().join("mesh.json");
    std::fs::write(
        &file,
        json!({
            "version": 1,
            "updatedAt": 1,
            "nodes": {
                "good": { "id": "good", "host": "192.0.2.1", "port": 3100 },
                "bad": { "host": "h", "port": "3100" }
            }
        })
        .to_string(),
    )
    .unwrap();
    let loaded = load_mesh_file_blocking(
        &[file.display().to_string()],
        MeshParseOptions {
            on_invalid_node: OnInvalidNode::Skip,
        },
    )
    .unwrap()
    .unwrap();
    assert!(loaded.file.get("good").is_some());
    assert!(loaded.file.get("bad").is_none());
    assert_eq!(loaded.warnings.len(), 1);
    assert!(loaded.warnings[0].contains("\"bad\""));
}

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

fn identity_node(id: &str, host: &str, ssh_user: Option<&str>) -> MeshNode {
    let mut node = named(id, host);
    node.ssh_user = ssh_user.map(str::to_string);
    node
}

fn named(id: &str, host: &str) -> MeshNode {
    let mut node = mesh::build_local_node(mesh::BuildLocalNodeArgs {
        existing_id: None,
        name: Some(id.to_string()),
        role: None,
        agents: Vec::new(),
        host: host.to_string(),
        port: 3100,
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: None,
        metadata: None,
        version: "0.7.0".to_string(),
    });
    node.id = id.to_string();
    node.host = host.to_string();
    node
}

fn meta_url(url: &str) -> Map<String, serde_json::Value> {
    let mut metadata = Map::new();
    metadata.insert("denUrl".to_string(), json!(url));
    metadata
}
