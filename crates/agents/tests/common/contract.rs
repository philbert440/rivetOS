use agents::{AgentPresetPatch, AgentPresetStore, BoxFuture, HarnessPatch, SortPatch};

use super::input;

#[derive(Clone)]
pub struct RawSeed {
    pub id: String,
    pub name: String,
    pub model: String,
    pub harness_id: Option<String>,
    pub node: String,
    pub directory: String,
    pub shared_link: bool,
    pub color: String,
    pub effort: String,
    pub system_prompt: String,
    pub node_base_url: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredView {
    pub name: String,
    pub model: String,
    pub harness_id: Option<String>,
    pub shared_link: bool,
}

pub trait StoreHooks: Send + Sync {
    fn reset(&self) -> BoxFuture<'_, ()>;
    fn seed(&self, row: RawSeed) -> BoxFuture<'_, ()>;
    fn read(&self, id: &str) -> BoxFuture<'_, Option<StoredView>>;
}

pub fn legacy_seed(id: &str, name: &str) -> RawSeed {
    RawSeed {
        id: id.into(),
        name: name.into(),
        model: "claude".into(),
        harness_id: None,
        node: "node-f".into(),
        directory: "/tmp/agents/legacy".into(),
        shared_link: true,
        color: String::new(),
        effort: "medium".into(),
        system_prompt: String::new(),
        node_base_url: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

pub fn canonical_seed(id: &str, name: &str) -> RawSeed {
    let mut row = legacy_seed(id, name);
    row.model = "claude".into();
    row.harness_id = Some("codex".into());
    row.directory = "/tmp/agents/canonical-row".into();
    row
}

pub async fn run_store_contract(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    create_catalog_migrates(store, hooks).await;
    legacy_read_does_not_rewrite(store, hooks).await;
    legacy_model_patch_keeps_harness(store, hooks).await;
    legacy_clear_harness_clears_model(store, hooks).await;
    legacy_set_harness_stores_empty_model(store, hooks).await;
    canonical_clear_migrates_model(store, hooks).await;
    canonical_set_harness_keeps_model(store, hooks).await;
    canonical_model_keeps_harness(store, hooks).await;
    model_patch_catalog_on_plain_row(store, hooks).await;
    model_patch_harness_id_on_plain_row(store, hooks).await;
    model_patch_keeps_existing_harness(store, hooks).await;
    clear_harness_migrates_stored_catalog_model(store, hooks).await;
    clear_harness_with_kimi_migrates_the_patch(store, hooks).await;
    set_harness_with_catalog_model_does_not_migrate(store, hooks).await;
    persists_shared_link_false(store, hooks).await;
    rejects_blank_names(store, hooks).await;
    lists_by_sort_order(store, hooks).await;
    clears_sort_order(store, hooks).await;
}

async fn create_catalog_migrates(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let mut body = input("Catalog");
    body.directory = "/tmp/agents/catalog".into();
    body.model = Some("claude".into());
    let created = store.create(body).await.unwrap();
    assert_eq!(
        created.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(created.model.to_utf8(), "");
    let stored = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored.harness_id.as_deref(), Some("claude-code"));
    assert_eq!(stored.model, "");
}

async fn legacy_read_does_not_rewrite(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    hooks.seed(legacy_seed("legacy-read", "Legacy")).await;
    let before = hooks.read("legacy-read").await.unwrap();
    assert_eq!(before.model, "claude");
    assert!(before.harness_id.is_none());
    let row = store.get("legacy-read").await.unwrap().unwrap();
    assert_eq!(
        row.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(row.model.to_utf8(), "");
    let after = hooks.read("legacy-read").await.unwrap();
    assert_eq!(after.model, "claude");
    assert!(after.harness_id.is_none());
}

async fn legacy_model_patch_keeps_harness(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    hooks.seed(legacy_seed("legacy-patch", "LegacyPatch")).await;
    let updated = store
        .update("legacy-patch", model_patch("opus"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(updated.model.to_utf8(), "opus");
    let stored = hooks.read("legacy-patch").await.unwrap();
    assert_eq!(stored.harness_id.as_deref(), Some("claude-code"));
    assert_eq!(stored.model, "opus");
}

async fn legacy_clear_harness_clears_model(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    hooks
        .seed(legacy_seed("legacy-clear-harness", "LegacyClear"))
        .await;
    let updated = store
        .update("legacy-clear-harness", clear_harness())
        .await
        .unwrap()
        .unwrap();
    assert!(updated.harness_id.is_none());
    assert_eq!(updated.model.to_utf8(), "");
    assert_eq!(
        hooks.read("legacy-clear-harness").await.unwrap(),
        stored("LegacyClear", "", None, true)
    );
}

async fn legacy_set_harness_stores_empty_model(
    store: &dyn AgentPresetStore,
    hooks: &dyn StoreHooks,
) {
    hooks.reset().await;
    hooks
        .seed(legacy_seed("legacy-set-harness", "LegacyHarness"))
        .await;
    let updated = store
        .update("legacy-set-harness", harness_patch("codex"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(updated.model.to_utf8(), "");
    assert_eq!(
        hooks.read("legacy-set-harness").await.unwrap(),
        stored("LegacyHarness", "", Some("codex"), true)
    );
}

async fn canonical_clear_migrates_model(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    hooks
        .seed(canonical_seed("canonical-clear-harness", "CanonicalClear"))
        .await;
    let updated = store
        .update("canonical-clear-harness", clear_harness())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(updated.model.to_utf8(), "");
    assert_eq!(
        hooks.read("canonical-clear-harness").await.unwrap(),
        stored("CanonicalClear", "", Some("claude-code"), true)
    );
}

async fn canonical_set_harness_keeps_model(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    hooks
        .seed(canonical_seed("canonical-set-harness", "CanonicalHarness"))
        .await;
    let updated = store
        .update("canonical-set-harness", harness_patch("codex"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(updated.model.to_utf8(), "claude");
    assert_eq!(
        hooks.read("canonical-set-harness").await.unwrap(),
        stored("CanonicalHarness", "claude", Some("codex"), true)
    );
}

async fn canonical_model_keeps_harness(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    hooks
        .seed(canonical_seed("canonical-model", "CanonicalModel"))
        .await;
    let updated = store
        .update("canonical-model", model_patch("opus"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(updated.model.to_utf8(), "opus");
    assert_eq!(
        hooks.read("canonical-model").await.unwrap(),
        stored("CanonicalModel", "opus", Some("codex"), true)
    );
}

async fn model_patch_catalog_on_plain_row(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let mut body = input("Plain");
    body.directory = "/tmp/agents/plain".into();
    body.model = Some("gpt-4".into());
    let created = store.create(body).await.unwrap();
    assert!(created.harness_id.is_none());
    let updated = store
        .update(created.id.to_utf8(), model_patch("claude"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(updated.model.to_utf8(), "");
    let stored_row = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored_row.harness_id.as_deref(), Some("claude-code"));
    assert_eq!(stored_row.model, "");
}

async fn model_patch_harness_id_on_plain_row(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let mut body = input("Canonical");
    body.directory = "/tmp/agents/canonical".into();
    body.model = Some("gpt-4".into());
    let created = store.create(body).await.unwrap();
    let updated = store
        .update(created.id.to_utf8(), model_patch("codex"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(updated.model.to_utf8(), "");
    let stored_row = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored_row.harness_id.as_deref(), Some("codex"));
    assert_eq!(stored_row.model, "");
}

async fn model_patch_keeps_existing_harness(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let mut body = input("Kept");
    body.directory = "/tmp/agents/kept".into();
    body.harness_id = Some("codex".into());
    body.model = Some("opus".into());
    let created = store.create(body).await.unwrap();
    let updated = store
        .update(created.id.to_utf8(), model_patch("claude"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(updated.model.to_utf8(), "claude");
    let stored_row = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored_row.harness_id.as_deref(), Some("codex"));
    assert_eq!(stored_row.model, "claude");
}

async fn clear_harness_migrates_stored_catalog_model(
    store: &dyn AgentPresetStore,
    hooks: &dyn StoreHooks,
) {
    hooks.reset().await;
    let mut body = input("ClearCatalog");
    body.directory = "/tmp/agents/clear-catalog".into();
    body.harness_id = Some("codex".into());
    body.model = Some("claude".into());
    let created = store.create(body).await.unwrap();
    assert_eq!(
        created.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(created.model.to_utf8(), "claude");
    let updated = store
        .update(created.id.to_utf8(), clear_harness())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("claude-code")
    );
    assert_eq!(updated.model.to_utf8(), "");
    let stored_row = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored_row.harness_id.as_deref(), Some("claude-code"));
    assert_eq!(stored_row.model, "");
}

async fn clear_harness_with_kimi_migrates_the_patch(
    store: &dyn AgentPresetStore,
    hooks: &dyn StoreHooks,
) {
    hooks.reset().await;
    let mut body = input("Swap");
    body.directory = "/tmp/agents/swap".into();
    body.harness_id = Some("codex".into());
    body.model = Some("opus".into());
    let created = store.create(body).await.unwrap();
    let mut patch = clear_harness();
    patch.model = Some("kimi".into());
    let updated = store
        .update(created.id.to_utf8(), patch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("kimi-code")
    );
    assert_eq!(updated.model.to_utf8(), "");
    let stored_row = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored_row.harness_id.as_deref(), Some("kimi-code"));
    assert_eq!(stored_row.model, "");
}

async fn set_harness_with_catalog_model_does_not_migrate(
    store: &dyn AgentPresetStore,
    hooks: &dyn StoreHooks,
) {
    hooks.reset().await;
    let mut body = input("Explicit");
    body.directory = "/tmp/agents/explicit".into();
    body.harness_id = Some("grok-build".into());
    body.model = Some("real-model".into());
    let created = store.create(body).await.unwrap();
    let mut patch = harness_patch("codex");
    patch.model = Some("claude".into());
    let updated = store
        .update(created.id.to_utf8(), patch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        updated.harness_id.as_ref().map(agents::JsString::to_utf8),
        Some("codex")
    );
    assert_eq!(updated.model.to_utf8(), "claude");
    let stored_row = hooks.read(created.id.to_utf8()).await.unwrap();
    assert_eq!(stored_row.harness_id.as_deref(), Some("codex"));
    assert_eq!(stored_row.model, "claude");
}

async fn persists_shared_link_false(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let mut body = input("Solo");
    body.directory = "/tmp/agents/solo".into();
    body.shared_link = Some(false);
    let created = store.create(body).await.unwrap();
    assert_eq!(created.shared_link, Some(false));
    assert_eq!(
        store
            .get(created.id.to_utf8())
            .await
            .unwrap()
            .unwrap()
            .shared_link,
        Some(false)
    );
    assert!(!hooks.read(created.id.to_utf8()).await.unwrap().shared_link);
}

async fn rejects_blank_names(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    for name in ["", "   ", "\t"] {
        let mut body = input(name);
        body.directory = "/tmp/agents/named".into();
        let err = store.create(body).await.unwrap_err();
        assert_eq!(err.to_string(), "agent name is required");
    }
    let mut body = input("Named");
    body.directory = "/tmp/agents/named".into();
    let created = store.create(body).await.unwrap();
    for name in ["", " \n "] {
        let patch = AgentPresetPatch {
            name: Some(name.into()),
            ..AgentPresetPatch::default()
        };
        let err = store.update(created.id.to_utf8(), patch).await.unwrap_err();
        assert_eq!(err.to_string(), "agent name is required");
    }
    assert_eq!(
        store
            .get(created.id.to_utf8())
            .await
            .unwrap()
            .unwrap()
            .name
            .to_utf8(),
        "Named"
    );
    assert_eq!(
        hooks.read(created.id.to_utf8()).await.unwrap().name,
        "Named"
    );
}

async fn lists_by_sort_order(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let names = ["A", "B", "C", "D"];
    let mut ids = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let mut body = input(name);
        body.directory = "/tmp/agents/order".into();
        body.created_at = Some((index as i64 + 1) * 1_000);
        ids.push(store.create(body).await.unwrap().id);
    }
    assert_eq!(names_of(store, None).await, ["A", "B", "C", "D"]);
    store
        .update(ids[2].to_utf8(), sort_set(0))
        .await
        .unwrap()
        .unwrap();
    store
        .update(ids[0].to_utf8(), sort_set(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(names_of(store, None).await, ["C", "A", "B", "D"]);
    assert_eq!(
        store
            .get(ids[2].to_utf8())
            .await
            .unwrap()
            .unwrap()
            .sort_order,
        Some(0)
    );
    store
        .update(ids[3].to_utf8(), sort_set(0))
        .await
        .unwrap()
        .unwrap();
    store
        .update(ids[2].to_utf8(), sort_set(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(names_of(store, None).await, ["D", "A", "C", "B"]);
    assert_eq!(names_of(store, Some("node-f")).await, ["D", "A", "C", "B"]);
    assert!(
        store
            .get(ids[1].to_utf8())
            .await
            .unwrap()
            .unwrap()
            .sort_order
            .is_none()
    );
}

async fn clears_sort_order(store: &dyn AgentPresetStore, hooks: &dyn StoreHooks) {
    hooks.reset().await;
    let mut first_body = input("First");
    first_body.directory = "/tmp/agents/order-clear".into();
    first_body.created_at = Some(1_000);
    let first = store.create(first_body).await.unwrap();
    let mut second_body = input("Second");
    second_body.directory = "/tmp/agents/order-clear".into();
    second_body.created_at = Some(2_000);
    let second = store.create(second_body).await.unwrap();
    store
        .update(second.id.to_utf8(), sort_set(5))
        .await
        .unwrap()
        .unwrap();
    let color = AgentPresetPatch {
        color: Some("#3b82f6".into()),
        ..AgentPresetPatch::default()
    };
    store
        .update(second.id.to_utf8(), color)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .get(second.id.to_utf8())
            .await
            .unwrap()
            .unwrap()
            .sort_order,
        Some(5)
    );
    assert_eq!(names_of(store, None).await, ["Second", "First"]);
    let cleared = store
        .update(second.id.to_utf8(), sort_clear())
        .await
        .unwrap()
        .unwrap();
    assert!(cleared.sort_order.is_none());
    assert!(
        store
            .get(second.id.to_utf8())
            .await
            .unwrap()
            .unwrap()
            .sort_order
            .is_none()
    );
    assert_eq!(names_of(store, None).await, ["First", "Second"]);
    assert!(
        store
            .get(first.id.to_utf8())
            .await
            .unwrap()
            .unwrap()
            .sort_order
            .is_none()
    );
}

fn model_patch(model: &str) -> AgentPresetPatch {
    AgentPresetPatch {
        model: Some(model.into()),
        ..AgentPresetPatch::default()
    }
}

fn harness_patch(id: &str) -> AgentPresetPatch {
    AgentPresetPatch {
        harness: HarnessPatch::Set(id.into()),
        ..AgentPresetPatch::default()
    }
}

fn clear_harness() -> AgentPresetPatch {
    AgentPresetPatch {
        harness: HarnessPatch::Clear,
        ..AgentPresetPatch::default()
    }
}

fn sort_set(value: i64) -> AgentPresetPatch {
    AgentPresetPatch {
        sort_order: SortPatch::Set(value),
        ..AgentPresetPatch::default()
    }
}

fn sort_clear() -> AgentPresetPatch {
    AgentPresetPatch {
        sort_order: SortPatch::Clear,
        ..AgentPresetPatch::default()
    }
}

fn stored(name: &str, model: &str, harness_id: Option<&str>, shared_link: bool) -> StoredView {
    StoredView {
        name: name.into(),
        model: model.into(),
        harness_id: harness_id.map(str::to_string),
        shared_link,
    }
}

async fn names_of(store: &dyn AgentPresetStore, node: Option<&str>) -> Vec<String> {
    store
        .list(node)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.name.to_utf8().into())
        .collect()
}
