mod common;
pub use common::contract::*;
pub use common::*;

use std::sync::Arc;

use agents::{
    AgentPresetStore, DelegationTarget, FileAgentPresetStore, JsString, JsValue, ValidateCtx,
    resolve_delegation_target, validate_create,
};
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
            .insert("harnessId".into(), Value::String(harness.clone()));
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
        name: row.get("name")?.as_str()?.into(),
        model: row.get("model")?.as_str()?.into(),
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
    assert_eq!(created.name.to_utf8(), "Recovered");
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
    assert_eq!(loaded[0].id.to_utf8(), "a");
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
    body.color = Some("#111111".into());
    let created = registry.create(body).await.unwrap();
    let name = agents::AgentPresetPatch {
        name: Some("FromA".into()),
        ..agents::AgentPresetPatch::default()
    };
    let color = agents::AgentPresetPatch {
        color: Some("#abcdef".into()),
        ..agents::AgentPresetPatch::default()
    };
    let (left, right) = tokio::join!(
        registry.update(created.id.to_utf8(), name),
        registry.update(created.id.to_utf8(), color)
    );
    assert_eq!(left.unwrap().unwrap().id, created.id);
    assert_eq!(right.unwrap().unwrap().id, created.id);
    let got = registry.get(created.id.to_utf8()).await.unwrap().unwrap();
    assert_eq!(got.name.to_utf8(), "FromA");
    assert_eq!(got.color.to_utf8(), "#abcdef");
}

#[tokio::test]
async fn fills_create_defaults_and_trims_the_name() {
    let dir = TempDir::new("agent-registry-file");
    let registry = store_at(&dir.path_str("agents.json"), 5_000);
    let created = registry.create(input("  Reviewer  ")).await.unwrap();
    assert_eq!(created.name.to_utf8(), "Reviewer");
    assert_eq!(created.color.to_utf8(), "");
    assert_eq!(created.model.to_utf8(), "");
    assert_eq!(created.effort.to_utf8(), "medium");
    assert_eq!(created.system_prompt.to_utf8(), "");
    assert_eq!(created.shared_link, Some(true));
    assert_eq!(
        created
            .node_base_url
            .as_ref()
            .map(agents::JsString::to_utf8),
        Some("")
    );
    assert_eq!(
        created.node.as_ref().map(agents::JsString::to_utf8),
        Some("node-f")
    );
    assert_eq!(
        created.directory.as_ref().map(agents::JsString::to_utf8),
        Some("/tmp/agents/reviewer")
    );
    assert_eq!(created.created_at, 5_000);
    assert_eq!(created.updated_at, 5_000);
    assert!(looks_like_id(created.id.to_utf8()));
    assert!(created.harness_id.is_none());
    let mut solo = input("Solo");
    solo.shared_link = Some(false);
    solo.directory = "/tmp/agents/solo".into();
    let unlinked = registry.create(solo).await.unwrap();
    assert_eq!(unlinked.shared_link, Some(false));
}

#[tokio::test]
async fn resolves_find_by_handle_in_priority_order() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    let mut beta = input("Alpha");
    beta.id = Some("beta".into());
    beta.directory = "/a".into();
    registry.create(beta).await.unwrap();
    let mut named = input("beta");
    named.id = Some("id-b".into());
    named.directory = "/b".into();
    registry.create(named).await.unwrap();
    let mut gamma = input("Gamma");
    gamma.id = Some("id-c".into());
    gamma.directory = "/c".into();
    registry.create(gamma).await.unwrap();
    assert_eq!(
        registry
            .find_by_handle(&JsString::from_text("beta"))
            .await
            .unwrap()
            .unwrap()
            .id
            .to_utf8(),
        "beta"
    );
    assert_eq!(
        registry
            .find_by_handle(&JsString::from_text("Alpha"))
            .await
            .unwrap()
            .unwrap()
            .id
            .to_utf8(),
        "beta"
    );
    assert_eq!(
        registry
            .find_by_handle(&JsString::from_text("gamma"))
            .await
            .unwrap()
            .unwrap()
            .id
            .to_utf8(),
        "id-c"
    );
    assert_eq!(
        registry
            .find_by_handle(&JsString::from_text("  gamma  "))
            .await
            .unwrap()
            .unwrap()
            .id
            .to_utf8(),
        "id-c"
    );
    assert!(
        registry
            .find_by_handle(&JsString::from_text("missing"))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn rejects_duplicate_names_and_ids() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    registry.create(input("Reviewer")).await.unwrap();
    let err = registry.create(input(" reviewer ")).await.unwrap_err();
    assert!(err.is_conflict());
    assert_eq!(err.code(), Some("preset_conflict"));
    assert_eq!(err.to_string(), "agent name already exists: reviewer");
    let mut other = input("Other");
    other.directory = "/tmp/agents/other".into();
    let other = registry.create(other).await.unwrap();
    let rename = agents::AgentPresetPatch {
        name: Some("REVIEWER".into()),
        ..agents::AgentPresetPatch::default()
    };
    let rename_err = registry
        .update(other.id.to_utf8(), rename)
        .await
        .unwrap_err();
    assert!(rename_err.is_conflict());
    assert_eq!(
        rename_err.to_string(),
        "agent name already exists: REVIEWER"
    );
    assert_eq!(
        registry
            .get(other.id.to_utf8())
            .await
            .unwrap()
            .unwrap()
            .name
            .to_utf8(),
        "Other"
    );
    let mut same = input("One");
    same.id = Some("same".into());
    registry.create(same).await.unwrap();
    let mut again = input("Two");
    again.id = Some("same".into());
    again.directory = "/tmp/agents/two".into();
    assert!(registry.create(again).await.unwrap_err().is_conflict());
}

#[tokio::test]
async fn clash_keeps_submitted_casing_and_distinct_truncated_surrogates() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    let mut lower = input("alice");
    lower.directory = "/tmp/agents/alice".into();
    registry.create(lower).await.unwrap();
    let mut upper = input("Alice");
    upper.directory = "/tmp/agents/alice-2".into();
    let err = registry.create(upper).await.unwrap_err();
    assert_eq!(err.to_string(), "agent name already exists: Alice");
    let mut smile = vec![u16::from(b'a'); 127];
    smile.push(0xD83D);
    let mut robot = vec![u16::from(b'a'); 127];
    robot.push(0xD83E);
    let mut first = input("placeholder");
    first.name = agents::JsString::from_units(smile);
    first.id = Some("sur-1".into());
    first.directory = "/tmp/agents/sur-1".into();
    registry.create(first).await.unwrap();
    let mut second = input("placeholder");
    second.name = agents::JsString::from_units(robot);
    second.id = Some("sur-2".into());
    second.directory = "/tmp/agents/sur-2".into();
    let created = registry.create(second).await.unwrap();
    assert_eq!(created.name.units()[127], 0xD83E);
}

#[tokio::test]
async fn handle_lookup_keeps_a_capped_surrogate_and_rejects_the_lookalike() {
    let ctx = ValidateCtx {
        node_name: "node-f",
        directory_root: "/home/user/agents",
        home: "/home/user",
        shared_dir: None,
        allow_harness: None,
        model_list: None,
    };
    let mut units = vec![u16::from(b'a'); 127];
    units.extend("😀".encode_utf16());
    let mut object = protocol::js::JsObject::new();
    object.insert("name", JsValue::String(JsString::from_units(units)));
    let validated = validate_create(&JsValue::Object(object), &ctx).unwrap();
    assert_eq!(validated.name.len(), 128);
    assert_eq!(validated.name.units()[127], 0xD83D);
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    let mut first = validated.input;
    first.id = Some("sur-1".into());
    first.directory = "/tmp/agents/sur-1".into();
    let stored = registry.create(first).await.unwrap();
    assert_eq!(stored.name.units(), validated.name.units());
    let found = registry
        .find_by_handle(&stored.name)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id.to_utf8(), "sur-1");
    let mut replacement = vec![u16::from(b'a'); 127];
    replacement.push(0xFFFD);
    let replacement = JsString::from_units(replacement);
    assert!(
        registry
            .find_by_handle(&replacement)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        resolve_delegation_target(&stored.name, &[], std::slice::from_ref(&stored)),
        Some(DelegationTarget::Preset(row)) if row.id.to_utf8() == "sur-1"
    ));
    assert!(resolve_delegation_target(&replacement, &[], &[stored]).is_none());
    let mut other = vec![u16::from(b'a'); 127];
    other.push(0xD83E);
    let mut second = input("placeholder");
    second.name = JsString::from_units(other);
    second.id = Some("sur-2".into());
    second.directory = "/tmp/agents/sur-2".into();
    let created = registry.create(second).await.unwrap();
    let found_other = registry
        .find_by_handle(&created.name)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found_other.id.to_utf8(), "sur-2");
    let rows = registry.list(None).await.unwrap();
    assert!(
        registry
            .find_by_handle(&replacement)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        resolve_delegation_target(&created.name, &[], &rows),
        Some(DelegationTarget::Preset(row)) if row.id.to_utf8() == "sur-2"
    ));
    assert!(resolve_delegation_target(&replacement, &[], &rows).is_none());
    assert!(matches!(
        resolve_delegation_target(&validated.name, &[], &rows),
        Some(DelegationTarget::Preset(row)) if row.id.to_utf8() == "sur-1"
    ));
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
    body.harness_id = Some("codex".into());
    body.model = Some("opus".into());
    let created = registry.create(body).await.unwrap();
    now.store(2_000, std::sync::atomic::Ordering::SeqCst);
    let patch = agents::AgentPresetPatch {
        harness: agents::HarnessPatch::Clear,
        ..agents::AgentPresetPatch::default()
    };
    let updated = registry
        .update(created.id.to_utf8(), patch)
        .await
        .unwrap()
        .unwrap();
    assert!(updated.harness_id.is_none());
    assert_eq!(updated.model.to_utf8(), "opus");
    assert_eq!(updated.id, created.id);
    assert_eq!(
        updated.node.as_ref().map(agents::JsString::to_utf8),
        Some("node-f")
    );
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
    assert_eq!(loaded[0].id.to_utf8(), "keep-me");
    assert!(loaded[0].sort_order.is_none());
    let patch = agents::AgentPresetPatch {
        color: Some("#fff".into()),
        ..agents::AgentPresetPatch::default()
    };
    let updated = registry.update("keep-me", patch).await.unwrap().unwrap();
    assert_eq!(updated.name.to_utf8(), "Alpha");
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
    assert_eq!(
        row.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(row.model.to_utf8(), "");
    assert!(row.node.is_none());
    assert!(row.directory.is_none());
    assert_eq!(
        row.node_base_url.as_ref().map(agents::JsString::to_utf8),
        Some("http://127.0.0.1:9")
    );
}

#[tokio::test]
async fn lists_by_created_at_then_id_and_deletes() {
    let dir = TempDir::new("agent-registry-file");
    let registry = FileAgentPresetStore::new(dir.path_str("agents.json"));
    let mut b = input("B");
    b.id = Some("b".into());
    b.created_at = Some(2);
    b.directory = "/b".into();
    registry.create(b).await.unwrap();
    let mut c = input("C");
    c.id = Some("c".into());
    c.created_at = Some(1);
    c.directory = "/c".into();
    c.node = "other".into();
    registry.create(c).await.unwrap();
    let mut a = input("A");
    a.id = Some("a".into());
    a.created_at = Some(1);
    a.directory = "/a".into();
    registry.create(a).await.unwrap();
    let ids: Vec<_> = registry
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.id.to_utf8().to_string())
        .collect();
    assert_eq!(ids, ["a", "c", "b"]);
    let filtered: Vec<_> = registry
        .list(Some("node-f"))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.id.to_utf8().to_string())
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
    body.id = Some("fixed".into());
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
    assert_eq!(loaded[0].model.to_utf8(), "");
    assert_eq!(
        loaded[0].harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert!(loaded[0].document_json().contains("displayMetadata"));
    assert!(loaded[0].document_json().contains(r"\ud83d"));
    let encoded = serde_json::to_string(&loaded[0]).unwrap();
    assert!(encoded.contains(r"\ud83d"));
    assert!(encoded.contains("displayMetadata"));
    let decoded: agents::AgentPreset = serde_json::from_str(&encoded).unwrap();
    assert!(decoded.document_json().contains(r"\ud83d"));
    assert!(decoded.document_json().contains("displayMetadata"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), legacy);
    let mut second = input("Second");
    second.id = Some("second".into());
    second.directory = "/tmp/agents/second".into();
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
    one.directory = "/left".into();
    let mut two = input("Right");
    two.directory = "/right".into();
    let (first, second) = tokio::join!(left.create(one), right.create(two));
    first.unwrap();
    second.unwrap();
    let mut names: Vec<_> = left
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.name.to_utf8().to_string())
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
