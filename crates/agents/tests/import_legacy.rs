mod common;
pub use common::contract::*;
pub use common::*;

use std::sync::{Arc, Mutex};

use agents::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentPresetStore, AgentRegistryBackend,
    BoxFuture, FallbackPresetStoreOptions, FileAgentPresetStore, ImportLegacyAgentsArgs,
    PresetError, import_legacy_agents_json,
};
use serde_json::{Value, json};

use agents::create_fallback_preset_store;

const LEGACY_ID: &str = "11111111-1111-4111-8111-111111111111";

fn legacy_row(extra: Value) -> Value {
    let mut row = json!({
        "id": LEGACY_ID,
        "name": "Reviewer",
        "color": "",
        "model": "opus",
        "effort": "medium",
        "systemPrompt": "",
        "nodeBaseUrl": "http://127.0.0.1:9",
        "createdAt": 10,
        "updatedAt": 10,
    });
    if let (Some(base), Some(over)) = (row.as_object_mut(), extra.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    row
}

fn args<'a>(
    file: &'a str,
    store: &'a dyn AgentPresetStore,
    log: Option<&'a (dyn Fn(&str) + Send + Sync)>,
) -> ImportLegacyAgentsArgs<'a> {
    ImportLegacyAgentsArgs {
        file,
        store,
        node: "node-f",
        directory_root: "/home/agents",
        log,
    }
}

#[tokio::test]
async fn imports_rows_with_a_default_directory_and_renames_the_file() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({"agents": [legacy_row(json!({}))]} )).unwrap(),
    )
    .unwrap();
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let result = import_legacy_agents_json(args(&file, &target, None))
        .await
        .unwrap();
    assert_eq!(result.imported, 1);
    assert_eq!(result.skipped, 0);
    let renamed = result.renamed_to.unwrap();
    assert!(renamed.contains("agents.json.imported-"));
    assert!(!std::path::Path::new(&file).exists());
    assert!(std::path::Path::new(&renamed).exists());
    let row = target.get(LEGACY_ID).await.unwrap().unwrap();
    assert_eq!(row.node.as_deref(), Some("node-f"));
    assert_eq!(row.directory.as_deref(), Some("/home/agents/reviewer"));
    assert_eq!(row.created_at, 10);
    assert_eq!(row.name, "Reviewer");
    assert_ne!(row.updated_at, 10);
    assert_eq!(
        result.rows.unwrap()[0].directory.as_deref(),
        Some("/home/agents/reviewer")
    );
}

#[tokio::test]
async fn skips_a_conflicting_id_and_still_renames() {
    let dir = TempDir::new("agent-registry-import");
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let mut existing = common::input("Existing");
    existing.id = Some("taken".to_string());
    existing.node = "n".to_string();
    existing.directory = "/x".to_string();
    existing.created_at = Some(1);
    target.create(existing).await.unwrap();
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [
                legacy_row(json!({"id": "taken", "name": "Other"})),
                legacy_row(json!({"id": "fresh", "name": "Newcomer"})),
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let logs = Mutex::new(Vec::new());
    let result = import_legacy_agents_json(ImportLegacyAgentsArgs {
        file: &file,
        store: &target,
        node: "node-f",
        directory_root: "/home/agents",
        log: Some(&|message| logs.lock().unwrap().push(message.to_string())),
    })
    .await
    .unwrap();
    assert_eq!(result.imported, 1);
    assert_eq!(result.skipped, 1);
    let logged = logs.lock().unwrap().join("\n");
    assert!(logged.contains("taken"));
    assert!(logged.contains("Other"));
    assert!(result.renamed_to.is_some());
    assert!(!std::path::Path::new(&file).exists());
    let archived = std::fs::read_to_string(result.renamed_to.unwrap()).unwrap();
    assert!(archived.contains("taken"));
    assert_eq!(target.get("taken").await.unwrap().unwrap().name, "Existing");
    assert_eq!(
        target
            .get("fresh")
            .await
            .unwrap()
            .unwrap()
            .directory
            .as_deref(),
        Some("/home/agents/newcomer")
    );
}

#[tokio::test]
async fn renames_conflicting_names_with_node_suffixes() {
    let dir = TempDir::new("agent-registry-import");
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    for (id, name, directory) in [
        ("keep", "Reviewer", "/x"),
        ("keep2", "Other", "/y"),
        ("keep3", "Other (node-f)", "/z"),
    ] {
        let mut body = common::input(name);
        body.id = Some(id.to_string());
        body.node = "n".to_string();
        body.directory = directory.to_string();
        body.created_at = Some(1);
        target.create(body).await.unwrap();
    }
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [
                legacy_row(json!({"id": "other", "name": " reviewer "})),
                legacy_row(json!({"id": "second", "name": "Other"})),
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let logs = Mutex::new(Vec::new());
    let result = import_legacy_agents_json(ImportLegacyAgentsArgs {
        file: &file,
        store: &target,
        node: "node-f",
        directory_root: "/home/agents",
        log: Some(&|message| logs.lock().unwrap().push(message.to_string())),
    })
    .await
    .unwrap();
    assert_eq!(result.imported, 2);
    assert_eq!(result.skipped, 0);
    assert_eq!(result.renamed, 2);
    let logged = logs.lock().unwrap().join("\n");
    assert!(logged.contains("legacy agents import: imported=2 skipped=0 renamed=2"));
    assert!(logged.contains("other"));
    assert!(logged.contains("name conflict"));
    assert!(logged.contains("reviewer (node-f)"));
    assert!(logged.contains("Other (node-f 2)"));
    let mut names: Vec<_> = target
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.name)
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "Other",
            "Other (node-f 2)",
            "Other (node-f)",
            "Reviewer",
            "reviewer (node-f)",
        ]
    );
    assert_eq!(
        target.get("other").await.unwrap().unwrap().name,
        "reviewer (node-f)"
    );
    assert_eq!(
        target.get("second").await.unwrap().unwrap().name,
        "Other (node-f 2)"
    );
}

struct ConflictStore {
    rows: Mutex<Vec<AgentPreset>>,
}

impl AgentPresetStore for ConflictStore {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::Postgres
    }
    fn file(&self) -> Option<String> {
        None
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(true) })
    }
    fn list(&self, _: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        let rows = self.rows.lock().unwrap().clone();
        Box::pin(async move { Ok(rows) })
    }
    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let id = id.to_string();
        let rows = self.rows.lock().unwrap().clone();
        Box::pin(async move { Ok(rows.into_iter().find(|row| row.id == id)) })
    }
    fn find_by_handle(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let rows = Arc::new(Mutex::new(()));
        let _ = rows;
        let store_rows = &self.rows;
        Box::pin(async move {
            if input.id.as_deref() == Some("id-clash") {
                return Err(PresetError::conflict(
                    "agent preset conflicts with an existing id or name (ros_agent_presets_pkey)",
                ));
            }
            if input.name == "Same" {
                return Err(PresetError::conflict(
                    "agent preset conflicts with an existing id or name (idx_ros_agent_presets_name)",
                ));
            }
            let mut row = preset(input.id.as_deref().unwrap_or("generated"), &input.name);
            row.directory = Some(input.directory);
            store_rows.lock().unwrap().push(row.clone());
            Ok(row)
        })
    }
    fn update(
        &self,
        _: &str,
        _: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn delete(&self, _: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(false) })
    }
}

#[tokio::test]
async fn skips_only_an_id_conflict_when_postgres_names_the_constraint() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [
                legacy_row(json!({"id": "id-clash", "name": "Kept"})),
                legacy_row(json!({"id": "name-clash", "name": "Same"})),
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let store = ConflictStore {
        rows: Mutex::new(Vec::new()),
    };
    let logs = Mutex::new(Vec::new());
    let result = import_legacy_agents_json(ImportLegacyAgentsArgs {
        file: &file,
        store: &store,
        node: "node-f",
        directory_root: "/home/agents",
        log: Some(&|message| logs.lock().unwrap().push(message.to_string())),
    })
    .await
    .unwrap();
    assert_eq!(result.imported, 1);
    assert_eq!(result.skipped, 1);
    assert_eq!(result.renamed, 1);
    let names: Vec<_> = store
        .rows
        .lock()
        .unwrap()
        .iter()
        .map(|row| row.name.clone())
        .collect();
    assert_eq!(names, ["Same (node-f)"]);
    assert_eq!(store.rows.lock().unwrap()[0].id, "name-clash");
    let logged = logs.lock().unwrap().join("\n");
    assert!(logged.contains("id-clash"));
    assert!(logged.contains("pkey"));
    assert!(logged.contains("idx_ros_agent_presets_name"));
    assert!(logged.contains("Same (node-f)"));
}

#[tokio::test]
async fn keeps_a_valid_directory_and_falls_back_when_one_is_invalid() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [
                legacy_row(json!({"id": "abs", "name": "Abs", "directory": "/srv/agents//abs/"})),
                legacy_row(json!({"id": "rel", "name": "Rel", "directory": "relative/path"})),
                legacy_row(json!({"id": "bad", "name": "Bad", "directory": 12})),
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let logs = Mutex::new(Vec::new());
    let result = import_legacy_agents_json(ImportLegacyAgentsArgs {
        file: &file,
        store: &target,
        node: "node-f",
        directory_root: "/home/agents",
        log: Some(&|message| logs.lock().unwrap().push(message.to_string())),
    })
    .await
    .unwrap();
    assert_eq!(result.imported, 3);
    assert_eq!(result.skipped, 0);
    assert_eq!(
        target
            .get("abs")
            .await
            .unwrap()
            .unwrap()
            .directory
            .as_deref(),
        Some("/srv/agents/abs")
    );
    assert_eq!(
        target
            .get("rel")
            .await
            .unwrap()
            .unwrap()
            .directory
            .as_deref(),
        Some("/home/agents/rel")
    );
    assert_eq!(
        target
            .get("bad")
            .await
            .unwrap()
            .unwrap()
            .directory
            .as_deref(),
        Some("/home/agents/bad")
    );
    let logged = logs.lock().unwrap().join("\n");
    assert!(logged.to_lowercase().contains("rel"));
    assert!(logged.to_lowercase().contains("bad"));
    assert!(!logged.contains("Abs"));
    assert!(logged.contains("missing or invalid"));
}

#[tokio::test]
async fn does_not_rename_when_the_store_file_resolves_to_the_source() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({"agents": [legacy_row(json!({}))]} )).unwrap(),
    )
    .unwrap();
    let store = FileAgentPresetStore::new(format!("{}/./agents.json", dir.path.display()));
    assert_ne!(store.path(), file);
    let result = import_legacy_agents_json(args(&file, &store, None))
        .await
        .unwrap();
    assert_eq!(result.imported, 0);
    assert_eq!(result.skipped, 0);
    assert_eq!(result.renamed, 0);
    assert_eq!(result.reason.as_deref(), Some("store is the source file"));
    assert!(std::path::Path::new(&file).exists());
    assert!(!dir_has_imported(&dir));
    assert!(std::fs::read_to_string(&file).unwrap().contains("Reviewer"));
    assert_eq!(store.list(None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn returns_without_renamed_to_when_the_source_was_quarantined() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(&file, "{not json").unwrap();
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let result = import_legacy_agents_json(args(&file, &target, None))
        .await
        .unwrap();
    assert_eq!(result.imported, 0);
    assert_eq!(result.skipped, 0);
    assert!(result.renamed_to.is_none());
    assert!(result.reason.is_none());
    assert!(!std::path::Path::new(&file).exists());
    assert!(target.list(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn refuses_a_file_mode_wrapper_whose_file_is_the_source() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({"agents": [legacy_row(json!({}))]} )).unwrap(),
    )
    .unwrap();
    let fallback = Arc::new(FileAgentPresetStore::new(format!(
        "{}/./agents.json",
        dir.path.display()
    )));
    let primary = Arc::new(NeverReady);
    let wrapper = create_fallback_preset_store(FallbackPresetStoreOptions {
        primary,
        fallback,
        recheck_ms: None,
        probe_timeout_ms: None,
        now: Some(Arc::new(|| 0)),
        log: None,
    });
    wrapper.list(None).await.unwrap();
    assert_eq!(wrapper.backend(), AgentRegistryBackend::File);
    let result = import_legacy_agents_json(args(&file, &wrapper, None))
        .await
        .unwrap();
    assert_eq!(result.reason.as_deref(), Some("store is the source file"));
    assert_eq!(result.imported, 0);
    assert!(std::path::Path::new(&file).exists());
    assert!(!dir_has_imported(&dir));
}

struct NeverReady;

impl AgentPresetStore for NeverReady {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::Postgres
    }
    fn file(&self) -> Option<String> {
        None
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(false) })
    }
    fn list(&self, _: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn get(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn find_by_handle(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn create(&self, _: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        Box::pin(async { Err(PresetError::message("primary should not be written")) })
    }
    fn update(
        &self,
        _: &str,
        _: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn delete(&self, _: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(false) })
    }
}

#[tokio::test]
async fn imports_through_a_wrapper_once_the_primary_file_is_different() {
    let dir = TempDir::new("agent-registry-import");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({"agents": [legacy_row(json!({}))]} )).unwrap(),
    )
    .unwrap();
    let fallback = Arc::new(FileAgentPresetStore::new(file.clone()));
    let primary = Arc::new(FileAgentPresetStore::new(dir.path_str("target.json")));
    let wrapper = create_fallback_preset_store(FallbackPresetStoreOptions {
        primary: Arc::clone(&primary) as Arc<dyn AgentPresetStore>,
        fallback,
        recheck_ms: None,
        probe_timeout_ms: None,
        now: Some(Arc::new(|| 0)),
        log: None,
    });
    wrapper.list(None).await.unwrap();
    assert_eq!(wrapper.backend(), AgentRegistryBackend::File);
    let result = import_legacy_agents_json(args(&file, &wrapper, None))
        .await
        .unwrap();
    assert_eq!(result.imported, 1);
    assert!(result.renamed_to.unwrap().contains("imported-"));
    assert!(!std::path::Path::new(&file).exists());
    assert_eq!(
        primary
            .get(LEGACY_ID)
            .await
            .unwrap()
            .unwrap()
            .node
            .as_deref(),
        Some("node-f")
    );
}

#[tokio::test]
async fn uses_the_id_suffix_once_numbered_suffixes_are_exhausted() {
    let dir = TempDir::new("agent-registry-import");
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let mut taken = vec!["Reviewer".to_string(), "Reviewer (node-f)".to_string()];
    for n in 2..=19 {
        taken.push(format!("Reviewer (node-f {n})"));
    }
    for (index, name) in taken.iter().enumerate() {
        let mut body = common::input(name);
        body.id = Some(format!("keep-{index}"));
        body.node = "n".to_string();
        body.directory = "/x".to_string();
        body.created_at = Some(1);
        target.create(body).await.unwrap();
    }
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({"agents": [legacy_row(json!({}))]} )).unwrap(),
    )
    .unwrap();
    let logs = Mutex::new(Vec::new());
    let result = import_legacy_agents_json(ImportLegacyAgentsArgs {
        file: &file,
        store: &target,
        node: "node-f",
        directory_root: "/home/agents",
        log: Some(&|message| logs.lock().unwrap().push(message.to_string())),
    })
    .await
    .unwrap();
    assert_eq!(result.imported, 1);
    assert_eq!(result.skipped, 0);
    assert_eq!(result.renamed, 1);
    assert!(result.unresolved.is_none());
    assert_eq!(
        target.get(LEGACY_ID).await.unwrap().unwrap().name,
        "Reviewer (node-f 11111111)"
    );
    assert!(
        logs.lock()
            .unwrap()
            .join("\n")
            .contains("legacy agents import: imported=1 skipped=0 renamed=1")
    );
    assert!(result.renamed_to.is_some());
    assert!(!std::path::Path::new(&file).exists());
}

#[tokio::test]
async fn leaves_the_source_when_the_id_suffix_still_collides() {
    let dir = TempDir::new("agent-registry-import");
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let mut taken = vec![
        "Reviewer".to_string(),
        "Reviewer (node-f)".to_string(),
        "Reviewer (node-f 11111111)".to_string(),
    ];
    for n in 2..=19 {
        taken.push(format!("Reviewer (node-f {n})"));
    }
    for (index, name) in taken.iter().enumerate() {
        let mut body = common::input(name);
        body.id = Some(format!("keep-{index}"));
        body.node = "n".to_string();
        body.directory = "/x".to_string();
        body.created_at = Some(1);
        target.create(body).await.unwrap();
    }
    let file = dir.path_str("agents.json");
    let source = serde_json::to_string(&json!({"agents": [legacy_row(json!({}))]} )).unwrap();
    std::fs::write(&file, &source).unwrap();
    let logs = Mutex::new(Vec::new());
    let result = import_legacy_agents_json(ImportLegacyAgentsArgs {
        file: &file,
        store: &target,
        node: "node-f",
        directory_root: "/home/agents",
        log: Some(&|message| logs.lock().unwrap().push(message.to_string())),
    })
    .await
    .unwrap();
    assert_eq!(result.imported, 0);
    assert_eq!(result.skipped, 0);
    assert_eq!(result.renamed, 0);
    assert!(result.renamed_to.is_none());
    let unresolved = result.unresolved.unwrap();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].id, LEGACY_ID);
    assert_eq!(unresolved[0].name, "Reviewer");
    assert!(std::path::Path::new(&file).exists());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
    assert!(!dir_has_imported(&dir));
    assert!(target.get(LEGACY_ID).await.unwrap().is_none());
    let logged = logs.lock().unwrap().join("\n");
    assert!(logged.contains("source file left in place"));
    assert!(logged.contains("legacy agents import: imported=0 skipped=0 renamed=0"));
}

#[tokio::test]
async fn returns_zeros_when_the_file_is_absent() {
    let dir = TempDir::new("agent-registry-import");
    let target = FileAgentPresetStore::new(dir.path_str("target.json"));
    let missing = dir.path_str("missing.json");
    let result = import_legacy_agents_json(args(&missing, &target, None))
        .await
        .unwrap();
    assert_eq!(result.imported, 0);
    assert_eq!(result.skipped, 0);
    assert_eq!(result.renamed, 0);
    assert!(result.rows.is_none());
    assert!(target.list(None).await.unwrap().is_empty());
}

fn dir_has_imported(dir: &TempDir) -> bool {
    std::fs::read_dir(&dir.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".imported-")
    })
}
