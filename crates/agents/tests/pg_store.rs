mod common;
pub use common::contract::*;
pub use common::*;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use agents::{AgentPresetPatch, AgentPresetStore, HarnessPatch, PgAgentPresetStore, SortPatch};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

const NOW: i64 = 1_700_000_000_000;
const MIGRATION_0017: &str =
    include_str!("../../../plugins/memory/postgres/src/schema/migrations/0017_agent_presets.sql");
const MIGRATION_0018: &str = include_str!(
    "../../../plugins/memory/postgres/src/schema/migrations/0018_agent_preset_sort_order.sql"
);

static SCHEMA_SEQ: AtomicU64 = AtomicU64::new(0);

fn pg_url() -> Option<String> {
    match std::env::var("RIVETOS_PG_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ => None,
    }
}

fn schema_name(kind: &str) -> String {
    let n = SCHEMA_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("ros_agent_presets_{kind}_{}_{n}", std::process::id())
}

fn millis(ms: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap()
}

struct SchemaGuard {
    url: String,
    names: Vec<String>,
}

impl SchemaGuard {
    fn new(url: &str, names: Vec<String>) -> Self {
        Self {
            url: url.to_string(),
            names,
        }
    }
}

impl Drop for SchemaGuard {
    fn drop(&mut self) {
        let url = self.url.clone();
        let names = self.names.clone();
        let handle = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let Ok(runtime) = runtime else {
                return;
            };
            runtime.block_on(async move {
                let Ok(pool) = PgPoolOptions::new().max_connections(1).connect(&url).await else {
                    return;
                };
                for name in &names {
                    let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {name} CASCADE"))
                        .execute(&pool)
                        .await;
                }
            });
        });
        let _ = handle.join();
    }
}

async fn admin_pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .unwrap()
}

async fn schema_pool(url: &str, schema: &str) -> PgPool {
    let schema = schema.to_string();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |conn, _meta| {
            let schema = schema.clone();
            Box::pin(async move {
                sqlx::query(&format!("SET search_path TO {schema}"))
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .unwrap()
}

async fn apply(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.unwrap();
}

struct PgHooks {
    pool: PgPool,
}

impl StoreHooks for PgHooks {
    fn reset(&self) -> agents::BoxFuture<'_, ()> {
        let pool = self.pool.clone();
        Box::pin(async move {
            sqlx::query("DELETE FROM ros_agent_presets")
                .execute(&pool)
                .await
                .unwrap();
        })
    }

    fn seed(&self, row: RawSeed) -> agents::BoxFuture<'_, ()> {
        let pool = self.pool.clone();
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO ros_agent_presets (
                    id, name, color, harness_id, model, effort, system_prompt,
                    node, directory, shared_link, node_base_url, created_at, updated_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
            )
            .bind(&row.id)
            .bind(&row.name)
            .bind(&row.color)
            .bind(&row.harness_id)
            .bind(&row.model)
            .bind(&row.effort)
            .bind(&row.system_prompt)
            .bind(&row.node)
            .bind(&row.directory)
            .bind(row.shared_link)
            .bind(&row.node_base_url)
            .bind(millis(row.created_at))
            .bind(millis(row.updated_at))
            .execute(&pool)
            .await
            .unwrap();
        })
    }

    fn read(&self, id: &str) -> agents::BoxFuture<'_, Option<StoredView>> {
        let pool = self.pool.clone();
        let id = id.to_string();
        Box::pin(async move {
            let row: Option<(String, String, Option<String>, bool)> = sqlx::query_as(
                "SELECT name, model, harness_id, shared_link FROM ros_agent_presets WHERE id = $1",
            )
            .bind(&id)
            .fetch_optional(&pool)
            .await
            .unwrap();
            row.map(|(name, model, harness_id, shared_link)| StoredView {
                name,
                model,
                harness_id,
                shared_link,
            })
        })
    }
}

fn clocked(pool: PgPool) -> PgAgentPresetStore {
    PgAgentPresetStore::new(pool, Some(Arc::new(|| NOW)))
}

#[tokio::test]
async fn postgres_store_matches_the_preset_contract() {
    let Some(url) = pg_url() else {
        return;
    };
    let schema = schema_name("test");
    let empty_schema = schema_name("empty");
    let pre_schema = schema_name("pre0018");
    let _guard = SchemaGuard::new(
        &url,
        vec![schema.clone(), empty_schema.clone(), pre_schema.clone()],
    );

    let admin = admin_pool(&url).await;
    for name in [&schema, &empty_schema, &pre_schema] {
        sqlx::query(&format!("CREATE SCHEMA {name}"))
            .execute(&admin)
            .await
            .unwrap();
    }

    let pre_pool = schema_pool(&url, &pre_schema).await;
    apply(&pre_pool, MIGRATION_0017).await;
    let legacy = clocked(pre_pool);
    before_0018_lists_by_creation_and_names_the_migration(&legacy).await;

    let empty_pool = schema_pool(&url, &empty_schema).await;
    let unready = PgAgentPresetStore::new(empty_pool, None);
    assert!(!unready.is_ready().await.unwrap());

    let pool = schema_pool(&url, &schema).await;
    let store = clocked(pool.clone());
    assert!(!store.is_ready().await.unwrap());
    apply(&pool, MIGRATION_0017).await;
    apply(&pool, MIGRATION_0018).await;
    assert!(store.is_ready().await.unwrap());
    assert!(store.is_ready().await.unwrap());
    assert_eq!(store.backend().as_str(), "postgres");
    assert!(store.file().is_none());

    reset(&pool).await;
    fills_defaults_and_round_trips_timestamps(&store, &pool).await;
    reset(&pool).await;
    persists_catalog_model(&store, &pool).await;
    reset(&pool).await;
    resolves_find_by_handle(&store).await;
    reset(&pool).await;
    maps_unique_violations(&store).await;
    reset(&pool).await;
    unsets_harness_without_touching_identity(&store).await;
    reset(&pool).await;
    lands_concurrent_patches(&store).await;
    reset(&pool).await;
    lists_filters_and_deletes(&store).await;
    reset(&pool).await;
    accepts_a_pre_epoch_timestamp(&store).await;
    reset(&pool).await;
    oversized_sort_order_reports_the_database(&store).await;

    reset(&pool).await;
    run_store_contract(&store, &PgHooks { pool: pool.clone() }).await;
}

async fn reset(pool: &PgPool) {
    sqlx::query("DELETE FROM ros_agent_presets")
        .execute(pool)
        .await
        .unwrap();
}

async fn before_0018_lists_by_creation_and_names_the_migration(store: &PgAgentPresetStore) {
    let mut older = input("Older");
    older.created_at = Some(1_000);
    let older = store.create(older).await.unwrap();
    let mut newer = input("Newer");
    newer.created_at = Some(2_000);
    store.create(newer).await.unwrap();
    let names: Vec<_> = store
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|preset| preset.name)
        .collect();
    assert_eq!(names, ["Older", "Newer"]);
    let patch = AgentPresetPatch {
        sort_order: SortPatch::Set(0),
        ..AgentPresetPatch::default()
    };
    let err = store.update(&older.id, patch.clone()).await.unwrap_err();
    assert!(err.is_migration_required());
    assert!(err.to_string().contains("0018_agent_preset_sort_order"));
    let again = store.update(&older.id, patch).await.unwrap_err();
    assert!(again.is_migration_required());
    assert!(
        store
            .get(&older.id)
            .await
            .unwrap()
            .unwrap()
            .sort_order
            .is_none()
    );
}

async fn accepts_a_pre_epoch_timestamp(store: &PgAgentPresetStore) {
    let mut body = input("Pre");
    body.created_at = Some(-1);
    let created = store.create(body).await.unwrap();
    assert_eq!(created.created_at, -1_i64);
    assert_eq!(created.updated_at, NOW);
    let got = store.get(&created.id).await.unwrap().unwrap();
    assert_eq!(got.created_at, -1_i64);
    assert_eq!(got.updated_at, NOW);
}

async fn oversized_sort_order_reports_the_database(store: &PgAgentPresetStore) {
    let created = store.create(input("Wide")).await.unwrap();
    let err = store
        .update(
            &created.id,
            AgentPresetPatch {
                sort_order: SortPatch::Set(i64::from(i32::MAX) + 1),
                ..AgentPresetPatch::default()
            },
        )
        .await
        .unwrap_err();
    let text = err.to_string();
    assert!(
        text.contains("integer out of range"),
        "database error was {text}"
    );
    assert!(!text.contains("sortOrder must be an integer"));
}

async fn fills_defaults_and_round_trips_timestamps(store: &PgAgentPresetStore, pool: &PgPool) {
    let mut body = input("  Reviewer  ");
    body.created_at = Some(1_600_000_000_000);
    let created = store.create(body).await.unwrap();
    assert_eq!(created.name, "Reviewer");
    assert_eq!(created.color, "");
    assert_eq!(created.model, "");
    assert_eq!(created.effort, "medium");
    assert_eq!(created.system_prompt, "");
    assert_eq!(created.shared_link, Some(true));
    assert_eq!(created.node_base_url.as_deref(), Some(""));
    assert_eq!(created.node.as_deref(), Some("node-f"));
    assert_eq!(created.directory.as_deref(), Some("/tmp/agents/reviewer"));
    assert_eq!(created.created_at, 1_600_000_000_000_i64);
    assert_eq!(created.updated_at, NOW);
    let got = store.get(&created.id).await.unwrap().unwrap();
    assert_eq!(got.created_at, 1_600_000_000_000_i64);
    assert_eq!(got.updated_at, NOW);
    let raw: (DateTime<Utc>, DateTime<Utc>) =
        sqlx::query_as("SELECT created_at, updated_at FROM ros_agent_presets WHERE id = $1")
            .bind(&created.id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(raw.0.timestamp_millis(), 1_600_000_000_000);
    assert_eq!(raw.1.timestamp_millis(), NOW);
}

async fn persists_catalog_model(store: &PgAgentPresetStore, pool: &PgPool) {
    let mut body = input("Legacy");
    body.model = Some("claude".to_string());
    let created = store.create(body).await.unwrap();
    assert_eq!(created.harness_id.as_deref(), Some("claude-code"));
    assert_eq!(created.model, "");
    let raw: (String, Option<String>) =
        sqlx::query_as("SELECT model, harness_id FROM ros_agent_presets WHERE id = $1")
            .bind(&created.id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(raw.0, "");
    assert_eq!(raw.1.as_deref(), Some("claude-code"));
}

async fn resolves_find_by_handle(store: &PgAgentPresetStore) {
    let mut beta = input("Alpha");
    beta.id = Some("beta".to_string());
    beta.directory = "/a".to_string();
    store.create(beta).await.unwrap();
    let mut id_b = input("beta");
    id_b.id = Some("id-b".to_string());
    id_b.directory = "/b".to_string();
    store.create(id_b).await.unwrap();
    let mut id_c = input("Gamma");
    id_c.id = Some("id-c".to_string());
    id_c.directory = "/c".to_string();
    store.create(id_c).await.unwrap();
    assert_eq!(
        store.find_by_handle("beta").await.unwrap().unwrap().id,
        "beta"
    );
    assert_eq!(
        store.find_by_handle("Alpha").await.unwrap().unwrap().id,
        "beta"
    );
    assert_eq!(
        store.find_by_handle("gamma").await.unwrap().unwrap().id,
        "id-c"
    );
    assert_eq!(
        store.find_by_handle("  gamma  ").await.unwrap().unwrap().id,
        "id-c"
    );
    assert!(store.find_by_handle("missing").await.unwrap().is_none());
}

async fn maps_unique_violations(store: &PgAgentPresetStore) {
    store.create(input("Reviewer")).await.unwrap();
    let err = store.create(input(" reviewer ")).await.unwrap_err();
    assert!(err.is_conflict());
    assert_eq!(err.code(), Some("preset_conflict"));
    let mut other = input("Other");
    other.directory = "/tmp/agents/other".to_string();
    let other = store.create(other).await.unwrap();
    let rename = AgentPresetPatch {
        name: Some("REVIEWER".to_string()),
        ..AgentPresetPatch::default()
    };
    let err = store.update(&other.id, rename).await.unwrap_err();
    assert!(err.is_conflict());
    let mut one = input("One");
    one.id = Some("same".to_string());
    one.directory = "/one".to_string();
    assert_eq!(store.create(one).await.unwrap().id, "same");
    let mut two = input("Two");
    two.id = Some("same".to_string());
    two.directory = "/two".to_string();
    let err = store.create(two).await.unwrap_err();
    assert!(err.is_conflict());
    assert!(err.is_id_conflict());
}

async fn unsets_harness_without_touching_identity(store: &PgAgentPresetStore) {
    let mut body = input("Reviewer");
    body.harness_id = Some("codex".to_string());
    body.model = Some("opus".to_string());
    body.created_at = Some(1_500_000_000_000);
    let created = store.create(body).await.unwrap();
    let patch = AgentPresetPatch {
        harness: HarnessPatch::Clear,
        ..AgentPresetPatch::default()
    };
    let updated = store.update(&created.id, patch).await.unwrap().unwrap();
    assert!(updated.harness_id.is_none());
    assert_eq!(updated.model, "opus");
    assert_eq!(updated.id, created.id);
    assert_eq!(updated.node.as_deref(), Some("node-f"));
    assert_eq!(updated.created_at, 1_500_000_000_000_i64);
    assert_eq!(updated.updated_at, NOW);
}

async fn lands_concurrent_patches(store: &PgAgentPresetStore) {
    let mut body = input("Orig");
    body.color = Some("#111111".to_string());
    let created = store.create(body).await.unwrap();
    let name = AgentPresetPatch {
        name: Some("FromA".to_string()),
        ..AgentPresetPatch::default()
    };
    let color = AgentPresetPatch {
        color: Some("#abcdef".to_string()),
        ..AgentPresetPatch::default()
    };
    let (left, right) = tokio::join!(
        store.update(&created.id, name),
        store.update(&created.id, color)
    );
    assert!(left.unwrap().is_some());
    assert!(right.unwrap().is_some());
    let got = store.get(&created.id).await.unwrap().unwrap();
    assert_eq!(got.name, "FromA");
    assert_eq!(got.color, "#abcdef");
}

async fn lists_filters_and_deletes(store: &PgAgentPresetStore) {
    let mut b = input("B");
    b.id = Some("b".to_string());
    b.created_at = Some(2_000);
    b.directory = "/b".to_string();
    store.create(b).await.unwrap();
    let mut c = input("C");
    c.id = Some("c".to_string());
    c.created_at = Some(1_000);
    c.directory = "/c".to_string();
    c.node = "other".to_string();
    store.create(c).await.unwrap();
    let mut a = input("A");
    a.id = Some("a".to_string());
    a.created_at = Some(1_000);
    a.directory = "/a".to_string();
    store.create(a).await.unwrap();
    let ids: Vec<_> = store
        .list(None)
        .await
        .unwrap()
        .into_iter()
        .map(|preset| preset.id)
        .collect();
    assert_eq!(ids, ["a", "c", "b"]);
    let filtered: Vec<_> = store
        .list(Some("node-f"))
        .await
        .unwrap()
        .into_iter()
        .map(|preset| preset.id)
        .collect();
    assert_eq!(filtered, ["a", "b"]);
    assert!(!store.delete("missing").await.unwrap());
    assert!(store.delete("a").await.unwrap());
    assert!(store.get("a").await.unwrap().is_none());
    let missing = AgentPresetPatch {
        name: Some("nope".to_string()),
        ..AgentPresetPatch::default()
    };
    assert!(store.update("missing", missing).await.unwrap().is_none());
}
