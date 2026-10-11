mod common;
pub use common::contract::*;
pub use common::*;

use std::sync::Arc;

use agents::{AgentPresetStore, FileAgentPresetStore};
use serde_json::{Value, json};

struct FileHooks {
    file: String,
}

impl StoreHooks for FileHooks {
    fn reset(&self) -> agents::BoxFuture<'_, ()> {
        let file = self.file.clone();
        Box::pin(async move {
            let _ = std::fs::remove_file(&file);
        })
    }

    fn seed(&self, row: RawSeed) -> agents::BoxFuture<'_, ()> {
        let file = self.file.clone();
        Box::pin(async move {
            std::fs::write(
                &file,
                serde_json::to_string(&json!({"agents": [seed_json(&row)]})).unwrap(),
            )
            .unwrap();
        })
    }

    fn read(&self, id: &str) -> agents::BoxFuture<'_, Option<StoredView>> {
        let file = self.file.clone();
        let id = id.to_string();
        Box::pin(async move { read_row(&file, &id) })
    }
}

fn seed_json(row: &RawSeed) -> Value {
    let mut value = json!({
        "id": row.id,
        "name": row.name,
        "color": row.color,
        "model": row.model,
        "effort": row.effort,
        "systemPrompt": row.system_prompt,
        "nodeBaseUrl": row.node_base_url,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "node": row.node,
        "directory": row.directory,
        "sharedLink": row.shared_link,
    });
    if let Some(harness) = &row.harness_id {
        value
            .as_object_mut()
            .unwrap()
            .insert("harnessId".to_string(), Value::String(harness.clone()));
    }
    value
}

fn read_row(file: &str, id: &str) -> Option<StoredView> {
    let text = std::fs::read_to_string(file).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let agents = parsed.get("agents")?.as_array()?;
    let row = agents
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))?;
    Some(StoredView {
        name: row.get("name")?.as_str()?.to_string(),
        model: row.get("model")?.as_str()?.to_string(),
        harness_id: row
            .get("harnessId")
            .and_then(Value::as_str)
            .map(str::to_string),
        shared_link: row
            .get("sharedLink")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    })
}

fn store_at(file: &str, now: i64) -> FileAgentPresetStore {
    FileAgentPresetStore::with_now(file, Arc::new(move || now))
}

#[tokio::test]
async fn quarantines_non_json_and_still_accepts_writes() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    std::fs::write(&file, "{not json").unwrap();
    let registry = FileAgentPresetStore::new(&file);
    assert!(registry.list(None).await.unwrap().is_empty());
    let leftovers: Vec<_> = std::fs::read_dir(&dir.path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("agents.json.corrupt-"))
        .collect();
    assert_eq!(leftovers.len(), 1);
    assert!(!std::path::Path::new(&file).exists());
    let saved = std::fs::read_to_string(dir.join(&leftovers[0])).unwrap();
    assert_eq!(saved, "{not json");
    let body = input("Recovered");
    let created = registry.create(body).await.unwrap();
    assert_eq!(created.name, "Recovered");
    assert!(std::path::Path::new(&file).exists());
    assert_eq!(
        std::fs::read_to_string(dir.join(&leftovers[0])).unwrap(),
        "{not json"
    );
}

#[tokio::test]
async fn loads_a_file_whose_utf8_readfilesync_would_replace() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    let mut bytes = br#"{"agents":[{"id":"a","name":"n","color":"","model":"m","effort":"medium","systemPrompt":"","nodeBaseUrl":"","createdAt":1,"updatedAt":1,"note":"x"#.to_vec();
    bytes.push(0xff);
    bytes.extend_from_slice(br#"y"}]}"#);
    std::fs::write(&file, &bytes).unwrap();
    let registry = FileAgentPresetStore::new(&file);
    let loaded = registry.list(None).await.unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "a");
    assert!(loaded[0].document_json().contains("note"));
    assert!(std::path::Path::new(&file).exists());
}

#[tokio::test]
async fn quarantines_a_non_array_agents_field() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({"agents": {"nope": true}})).unwrap(),
    )
    .unwrap();
    let registry = FileAgentPresetStore::new(&file);
    assert!(registry.list(None).await.unwrap().is_empty());
    let found = std::fs::read_dir(&dir.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("agents.json.corrupt-")
    });
    assert!(found);
}

#[tokio::test]
async fn serializes_concurrent_updates() {
    let dir = TempDir::new("agent-registry-file");
    let registry = store_at(&dir.path_str("agents.json"), 5_000);
    let mut body = input("Orig");
    body.color = Some("#111111".to_string());
    let created = registry.create(body).await.unwrap();
    let name = agents::AgentPresetPatch {
        name: Some("FromA".to_string()),
        ..agents::AgentPresetPatch::default()
    };
    let color = agents::AgentPresetPatch {
        color: Some("#abcdef".to_string()),
        ..agents::AgentPresetPatch::default()
    };
    let (left, right) = tokio::join!(
        registry.update(&created.id, name),
        registry.update(&created.id, color)
    );
    assert_eq!(left.unwrap().unwrap().id, created.id);
    assert_eq!(right.unwrap().unwrap().id, created.id);
    let got = registry.get(&created.id).await.unwrap().unwrap();
    assert_eq!(got.name, "FromA");
    assert_eq!(got.color, "#abcdef");
}

#[tokio::test]
async fn fills_create_defaults_and_trims_the_name() {
    let dir = TempDir::new("agent-registry-file");
    let registry = store_at(&dir.path_str("agents.json"), 5_000);
    let created = registry.create(input("  Reviewer  ")).await.unwrap();
    assert_eq!(created.name, "Reviewer");
    assert_eq!(created.color, "");
    assert_eq!(created.model, "");
    assert_eq!(created.effort, "medium");
    assert_eq!(created.system_prompt, "");
    assert_eq!(created.shared_link, Some(true));
    assert_eq!(created.node_base_url.as_deref(), Some(""));
    assert_eq!(created.node.as_deref(), Some("node-f"));
    assert_eq!(created.directory.as_deref(), Some("/tmp/agents/reviewer"));
    assert_eq!(created.created_at, 5_000);
    assert_eq!(created.updated_at, 5_000);
    assert!(looks_like_id(&created.id));
    assert!(created.harness_id.is_none());
    let mut solo = input("Solo");
    solo.shared_link = Some(false);
    solo.directory = "/tmp/agents/solo".to_string();
    let unlinked = registry.create(solo).await.unwrap();
    assert_eq!(unlinked.shared_link, Some(false));
}

#[tokio::test]
async fn resolves_find_by_handle_in_priority_order() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    let mut beta = input("Alpha");
    beta.id = Some("beta".to_string());
    beta.directory = "/a".to_string();
    registry.create(beta).await.unwrap();
    let mut named = input("beta");
    named.id = Some("id-b".to_string());
    named.directory = "/b".to_string();
    registry.create(named).await.unwrap();
    let mut gamma = input("Gamma");
    gamma.id = Some("id-c".to_string());
    gamma.directory = "/c".to_string();
    registry.create(gamma).await.unwrap();
    assert_eq!(
        registry.find_by_handle("beta").await.unwrap().unwrap().id,
        "beta"
    );
    assert_eq!(
        registry.find_by_handle("Alpha").await.unwrap().unwrap().id,
        "beta"
    );
    assert_eq!(
        registry.find_by_handle("gamma").await.unwrap().unwrap().id,
        "id-c"
    );
    assert_eq!(
        registry
            .find_by_handle("  gamma  ")
            .await
            .unwrap()
            .unwrap()
            .id,
        "id-c"
    );
    assert!(registry.find_by_handle("missing").await.unwrap().is_none());
}

#[tokio::test]
async fn rejects_duplicate_names_and_ids() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    registry.create(input("Reviewer")).await.unwrap();
    let err = registry.create(input(" reviewer ")).await.unwrap_err();
    assert!(err.is_conflict());
    assert_eq!(err.code(), Some("preset_conflict"));
    let mut other = input("Other");
    other.directory = "/tmp/agents/other".to_string();
    let other = registry.create(other).await.unwrap();
    let rename = agents::AgentPresetPatch {
        name: Some("REVIEWER".to_string()),
        ..agents::AgentPresetPatch::default()
    };
    assert!(
        registry
            .update(&other.id, rename)
            .await
            .unwrap_err()
            .is_conflict()
    );
    assert_eq!(
        registry.get(&other.id).await.unwrap().unwrap().name,
        "Other"
    );
    let mut same = input("One");
    same.id = Some("same".to_string());
    registry.create(same).await.unwrap();
    let mut again = input("Two");
    again.id = Some("same".to_string());
    again.directory = "/tmp/agents/two".to_string();
    assert!(registry.create(again).await.unwrap_err().is_conflict());
}

#[tokio::test]
async fn unsets_harness_without_changing_identity() {
    let dir = TempDir::new("agent-registry-file");
    let now = Arc::new(std::sync::atomic::AtomicI64::new(1_000));
    let clock = Arc::clone(&now);
    let registry = FileAgentPresetStore::with_now(
        dir.path_str("agents.json"),
        Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)),
    );
    let mut body = input("Reviewer");
    body.harness_id = Some("codex".to_string());
    body.model = Some("opus".to_string());
    let created = registry.create(body).await.unwrap();
    now.store(2_000, std::sync::atomic::Ordering::SeqCst);
    let patch = agents::AgentPresetPatch {
        harness: agents::HarnessPatch::Clear,
        ..agents::AgentPresetPatch::default()
    };
    let updated = registry.update(&created.id, patch).await.unwrap().unwrap();
    assert!(updated.harness_id.is_none());
    assert_eq!(updated.model, "opus");
    assert_eq!(updated.id, created.id);
    assert_eq!(updated.node.as_deref(), Some("node-f"));
    assert_eq!(updated.created_at, 1_000);
    assert_eq!(updated.updated_at, 2_000);
}

#[tokio::test]
async fn drops_a_non_integer_sort_order() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [{
                "id": "keep-me",
                "name": "Alpha",
                "color": "",
                "model": "fable",
                "effort": "medium",
                "systemPrompt": "",
                "nodeBaseUrl": "",
                "node": "node-f",
                "directory": "/tmp/agents/alpha",
                "sharedLink": true,
                "createdAt": 1,
                "updatedAt": 1,
                "sortOrder": "1"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let registry = store_at(&file, 2);
    let loaded = registry.list(None).await.unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "keep-me");
    assert!(loaded[0].sort_order.is_none());
    let patch = agents::AgentPresetPatch {
        color: Some("#fff".to_string()),
        ..agents::AgentPresetPatch::default()
    };
    let updated = registry.update("keep-me", patch).await.unwrap().unwrap();
    assert_eq!(updated.name, "Alpha");
    assert!(updated.sort_order.is_none());
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    let saved = parsed.get("agents").unwrap().as_array().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].get("id").and_then(Value::as_str), Some("keep-me"));
    assert!(saved[0].get("sortOrder").is_none());
}

#[tokio::test]
async fn loads_a_legacy_row_and_migrates_a_catalog_model() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [{
                "id": "11111111-1111-4111-8111-111111111111",
                "name": "Legacy",
                "color": "",
                "model": "claude",
                "effort": "medium",
                "systemPrompt": "",
                "nodeBaseUrl": "http://127.0.0.1:9",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let registry = FileAgentPresetStore::new(&file);
    let row = registry
        .get("11111111-1111-4111-8111-111111111111")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.harness_id.as_deref(), Some("claude-code"));
    assert_eq!(row.model, "");
    assert!(row.node.is_none());
    assert!(row.directory.is_none());
    assert_eq!(row.node_base_url.as_deref(), Some("http://127.0.0.1:9"));
}

#[tokio::test]
async fn lists_by_created_at_then_id_and_deletes() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    let mut b = input("B");
    b.id = Some("b".to_string());
    b.created_at = Some(2);
    b.directory = "/b".to_string();
    registry.create(b).await.unwrap();
    let mut c = input("C");
    c.id = Some("c".to_string());
    c.created_at = Some(1);
    c.directory = "/c".to_string();
    c.node = "other".to_string();
    registry.create(c).await.unwrap();
    let mut a = input("A");
    a.id = Some("a".to_string());
    a.created_at = Some(1);
    a.directory = "/a".to_string();
    registry.create(a).await.unwrap();
    let ids: Vec<_> = registry
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect();
    assert_eq!(ids, ["a", "c", "b"]);
    let filtered: Vec<_> = registry
        .list(Some("node-f"))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect();
    assert_eq!(filtered, ["a", "b"]);
    assert!(registry.delete("a").await.unwrap());
    assert!(!registry.delete("a").await.unwrap());
    assert!(registry.get("a").await.unwrap().is_none());
}

#[tokio::test]
async fn writes_create_order_and_preserves_surrogate_rows() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    let registry = store_at(&file, 5_000);
    let mut body = input("Reviewer");
    body.id = Some("fixed".to_string());
    let created = registry.create(body).await.unwrap();
    assert_eq!(
        created.document_json(),
        r#"{"id":"fixed","name":"Reviewer","color":"","model":"","effort":"medium","systemPrompt":"","nodeBaseUrl":"","createdAt":5000,"updatedAt":5000,"sharedLink":true,"node":"node-f","directory":"/tmp/agents/reviewer"}"#
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "{\n  \"agents\": [\n    {\n      \"id\": \"fixed\",\n      \"name\": \"Reviewer\",\n      \"color\": \"\",\n      \"model\": \"\",\n      \"effort\": \"medium\",\n      \"systemPrompt\": \"\",\n      \"nodeBaseUrl\": \"\",\n      \"createdAt\": 5000,\n      \"updatedAt\": 5000,\n      \"sharedLink\": true,\n      \"node\": \"node-f\",\n      \"directory\": \"/tmp/agents/reviewer\"\n    }\n  ]\n}"
    );
    let decoy = format!("{file}.tmp-{}", std::process::id());
    std::fs::write(&decoy, "keep").unwrap();
    let legacy = r#"{"agents":[{"id":"legacy","name":"Old","color":"","model":"claude","effort":"medium","systemPrompt":"\ud83d","nodeBaseUrl":"","createdAt":1,"updatedAt":1,"displayMetadata":{"k":1}}]}"#;
    std::fs::write(&file, legacy).unwrap();
    let loaded = registry.list(None).await.unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].model, "");
    assert_eq!(loaded[0].harness_id.as_deref(), Some("claude-code"));
    assert!(loaded[0].document_json().contains("displayMetadata"));
    assert!(loaded[0].document_json().contains(r"\ud83d"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), legacy);
    let mut second = input("Second");
    second.id = Some("second".to_string());
    second.directory = "/tmp/agents/second".to_string();
    registry.create(second).await.unwrap();
    let saved = std::fs::read_to_string(&file).unwrap();
    assert!(saved.contains(r"\ud83d"));
    assert!(saved.contains("displayMetadata"));
    assert!(saved.contains("\"harnessId\": \"claude-code\""));
    assert!(saved.contains("\"model\": \"\""));
    assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "keep");
    assert!(!std::fs::read_dir(&dir.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("corrupt")
    }));
}

#[tokio::test]
async fn a_write_persists_catalog_migration_of_every_loaded_row() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        serde_json::to_string(&json!({
            "agents": [
                {
                    "id": "a",
                    "name": "Legacy",
                    "color": "",
                    "model": "claude",
                    "effort": "medium",
                    "systemPrompt": "",
                    "nodeBaseUrl": "",
                    "createdAt": 1,
                    "updatedAt": 1
                },
                {
                    "id": "b",
                    "name": "Other",
                    "color": "",
                    "model": "opus",
                    "effort": "medium",
                    "systemPrompt": "",
                    "nodeBaseUrl": "",
                    "createdAt": 2,
                    "updatedAt": 2
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let registry = store_at(&file, 9);
    assert!(registry.delete("b").await.unwrap());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    let row = &saved["agents"][0];
    assert_eq!(row["model"], "");
    assert_eq!(row["harnessId"], "claude-code");
    assert_eq!(row["id"], "a");
}

#[tokio::test]
async fn two_stores_keep_both_rows() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    let left = FileAgentPresetStore::new(file.clone());
    let right = FileAgentPresetStore::new(format!("{}/./agents.json", dir.path.display()));
    let mut one = input("Left");
    one.directory = "/left".to_string();
    let mut two = input("Right");
    two.directory = "/right".to_string();
    let (first, second) = tokio::join!(left.create(one), right.create(two));
    first.unwrap();
    second.unwrap();
    let mut names: Vec<_> = left
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.name)
        .collect();
    names.sort();
    assert_eq!(names, ["Left", "Right"]);
}

#[tokio::test]
async fn accepts_a_negative_created_at() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("agents.json");
    std::fs::write(
        &file,
        r#"{"agents":[{"id":"pre","name":"Pre","color":"","model":"m","effort":"medium","systemPrompt":"","nodeBaseUrl":"","createdAt":-5,"updatedAt":-5}]}"#,
    )
    .unwrap();
    let registry = FileAgentPresetStore::new(&file);
    let row = registry.get("pre").await.unwrap().unwrap();
    assert_eq!(row.created_at, -5);
    assert_eq!(row.updated_at, -5);
    assert!(std::path::Path::new(&file).exists());
}

#[tokio::test]
async fn file_store_matches_the_shared_contract() {
    let dir = TempDir::new("agent-registry-file");
    let file = dir.path_str("contract.json");
    let registry = store_at(&file, 5_000);
    let hooks = FileHooks { file };
    run_store_contract(&registry, &hooks).await;
}
