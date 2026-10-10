use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::TimeZone;
use memory::columns::decide_width_migration;
use memory::columns::WidthMigrationDecision;
use memory::cowork_hash::{cowork_content_hash, pick_cowork_hook_rewrite, CoworkHookRow};
use memory::full::{
    extract_text, file_missing_message, missing_pointer_message, truncation_hint,
};
use memory::migrate::{
    apply_migration, apply_session_guards, embedded_as_migrations, ensure_migrations_table,
    list_migrations_dir, reset_session_guards, MigrateClient, MigrateFault, MigrateRows,
    MIGRATION_LOCK_TIMEOUT,
};
use memory::names::{normalize_tag_value, parse_tag_literal};
use memory::prepare::{append_result_value, prepare_append, validate_ingest_messages};
use memory::rules::{
    origin_url_from_config, plan_project_rule_tag, repo_name_from_remote, resolve_project_from_cwd,
    sanitize_remote, MapFs, PROJECT_RULE_MAX_WALK,
};
use memory::rules::ProjectFs;
use memory::sql_report::{
    browse_sql, capture_cap_placeholder, en_us, format_embedding_queue, format_js_iso, format_queue_health,
    health_cached, QueueRow,
};
use memory::spans::{apply_window_args, resolve_window};
use memory::text_api::{append_event_id, capture_cap, ingest_event_id, truncate_content, utf16_len, MAX_CONTENT};
use memory::{
    user_from_session_key, CaptureOptions, HistoryMessage, IngestInput, IngestOutput, MemoryEntry,
    MemoryStore, PostgresMemory, RoutingMemory, SearchOptions, StoreError, StoreHandle,
    CAPTURE_POOL_MAX, IDLE_IN_TRANSACTION_TIMEOUT, STATEMENT_TIMEOUT,
};
use memory::capture_guard_statements;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

fn sha(material: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(material.as_bytes());
    hex::encode(hasher.finalize())
}

fn fixture(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

struct FakeMigrate {
    sqls: Vec<String>,
    begins: usize,
    regclass: Option<String>,
}

impl MigrateClient for FakeMigrate {
    async fn query(&mut self, sql: &str) -> Result<MigrateRows, MigrateFault> {
        self.sqls.push(sql.to_string());
        if sql == "BEGIN" {
            self.begins += 1;
        }
        if sql.contains("to_regclass") {
            return Ok(MigrateRows {
                rows: vec![vec![self.regclass.clone()]],
            });
        }
        if sql == "some ddl" && self.begins == 1 && self.regclass.as_deref() == Some("55P03") {
            return Err(MigrateFault::coded("lock timeout", "55P03"));
        }
        if sql == "some ddl" && self.regclass.as_deref() == Some("42601") {
            return Err(MigrateFault::coded("syntax", "42601"));
        }
        Ok(MigrateRows::default())
    }

    async fn query_bind(&mut self, sql: &str, param: &str) -> Result<MigrateRows, MigrateFault> {
        self.sqls.push(format!("{sql} [{param}]"));
        Ok(MigrateRows::default())
    }
}

#[tokio::test]
async fn migration_ordering_retry_and_lock_literal() {
    let dir = fixture("tests/fixtures/migrations");
    let listed = list_migrations_dir(&dir).expect("list");
    assert_eq!(listed.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["0001_aaa.sql", "0002_zzz.sql"]);
    assert_eq!(listed[0].sql, "-- first\n");
    let embedded = embedded_as_migrations();
    assert!(embedded.len() >= 20);
    assert_eq!(embedded[0].name, "0001_baseline.sql");
    assert!(embedded[0].sql.contains("ros_messages"));
    let defer = embedded.iter().find(|m| m.name == "0016_defer_embed_enqueue.sql").expect("0016");
    assert!(defer.sql.contains("current_setting('rivet.defer_embed_enqueue', true) = 'on'"));
    assert!(embedded.iter().any(|m| m.name == "0020_tag_removals.sql"));

    let mut guards = FakeMigrate { sqls: Vec::new(), begins: 0, regclass: None };
    apply_session_guards(&mut guards, MIGRATION_LOCK_TIMEOUT).await.expect("guards");
    reset_session_guards(&mut guards).await.expect("reset");
    assert!(guards.sqls[0].contains(&format!("SET lock_timeout = '{MIGRATION_LOCK_TIMEOUT}'")));
    assert!(guards.sqls[1].to_ascii_lowercase().contains("reset lock_timeout"));

    let mut present = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: Some("_rivetos_migrations".to_string()),
    };
    ensure_migrations_table(&mut present).await.expect("present");
    assert!(present.sqls.iter().any(|sql| sql.contains("to_regclass")));
    assert!(present.sqls.iter().all(|sql| !sql.contains("CREATE TABLE")));

    let mut missing = FakeMigrate { sqls: Vec::new(), begins: 0, regclass: None };
    ensure_migrations_table(&mut missing).await.expect("missing");
    assert!(missing.sqls.iter().any(|sql| sql.contains("CREATE TABLE")));

    let mut retry = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: Some("55P03".to_string()),
    };
    apply_migration(
        &mut retry,
        &memory::Migration {
            name: "0001_x.sql".to_string(),
            path: "/x".to_string(),
            sql: "some ddl".to_string(),
        },
        |_ms| async {},
        &[0, 1],
    )
    .await
    .expect("retry");
    assert_eq!(retry.begins, 2);
    assert_eq!(retry.sqls.iter().filter(|sql| sql.as_str() == "COMMIT").count(), 1);

    let mut syntax = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: Some("42601".to_string()),
    };
    let err = apply_migration(
        &mut syntax,
        &memory::Migration {
            name: "0001_x.sql".to_string(),
            path: "/x".to_string(),
            sql: "some ddl".to_string(),
        },
        |_ms| async {},
        &[0, 1],
    )
    .await
    .expect_err("syntax");
    assert_eq!(err.message, "syntax");
    assert_eq!(syntax.begins, 1);

    let mut bad = FakeMigrate { sqls: Vec::new(), begins: 0, regclass: None };
    let err = apply_session_guards(&mut bad, "3s'; DROP TABLE x; --").await.expect_err("lock");
    assert!(err.message.contains("invalid lock_timeout"));
    assert!(bad.sqls.is_empty());
}

#[test]
fn width_decision_matches_probe_cases() {
    assert_eq!(decide_width_migration(None, 4, 128), WidthMigrationDecision::Skip);
    assert_eq!(decide_width_migration(Some(128), 4, 128), WidthMigrationDecision::Skip);
    assert_eq!(decide_width_migration(Some(64), 1, 128), WidthMigrationDecision::Refuse);
    assert_eq!(decide_width_migration(Some(64), 0, 128), WidthMigrationDecision::Alter);
}

#[test]
fn hashes_caps_and_surrogate_boundary() {
    assert_eq!(
        append_event_id("s", "a", "user", "hi", None),
        sha("append\0s\0a\0user\0hi\0")
    );
    assert_eq!(
        ingest_event_id("s", "a", "user", "hi", 3, Some("Bash")),
        sha("s\0a\0user\0hi\03\0Bash")
    );
    assert_eq!(cowork_content_hash("user", "hello"), sha("user\0hello\0\0"));
    let long = format!("{}😀tail", "x".repeat(15999));
    assert_eq!(utf16_len(&long), 16005);
    let mut meta = Map::new();
    let capped = capture_cap(&long, &mut meta, "content");
    assert_eq!(utf16_len(&capped), MAX_CONTENT);
    assert!(!capped.contains('\u{2026}'));
    assert_eq!(capped, "x".repeat(15999));
    assert_eq!(meta.get("truncated"), Some(&Value::Bool(true)));
    assert_eq!(meta.get("full_content_length").and_then(Value::as_u64), Some(16005));
    let mut marked = Map::new();
    let truncated = truncate_content(&long, &mut marked, "");
    assert!(truncated.ends_with("\n…[truncated]"));
    let fixture = std::fs::read_to_string(fixture("tests/fixtures/capture-batches.json")).expect("fixture");
    let parsed: Value = serde_json::from_str(&fixture).expect("json");
    let over = parsed["cases"].as_array().expect("cases").iter().find(|case| case["name"] == "over-cap-surrogate-boundary").expect("case");
    assert_eq!(over["expect_content_len"], 15999);
    assert_eq!(over["expect_full_len"], 16005);
    assert_eq!(over["expect_marker"], false);
}

#[test]
fn windows_slug_and_project_rule() {
    let now = chrono::Local.with_ymd_and_hms(2026, 10, 10, 15, 0, 0).single().expect("now");
    let err = resolve_window("", now).expect_err("empty");
    assert!(err.contains("Invalid window=\"\""));
    let (since, before) = resolve_window("today", now).expect("today");
    assert!(since.unwrap().starts_with("2026-10-10T"));
    assert!(before.is_none());
    let (since, before) = apply_window_args(Some("yesterday"), Some("2026-01-01T00:00:00Z"), None, now).expect("explicit");
    assert_eq!(since.as_deref(), Some("2026-01-01T00:00:00Z"));
    assert!(before.is_none());
    assert_eq!(normalize_tag_value("TenPAL"), "tenpal");
    assert_eq!(normalize_tag_value("My Repo"), "my-repo");
    assert_eq!(parse_tag_literal("project:demo"), Some(("project".to_string(), "demo".to_string())));
    assert_eq!(repo_name_from_remote("git@github.com:philbert440/rivetOS.git").as_deref(), Some("rivetOS"));
    assert_eq!(
        sanitize_remote("git@github.com:philbert440/rivetOS.git").as_deref(),
        Some("github.com/philbert440/rivetOS")
    );
    assert!(sanitize_remote("FILE:/tmp/repo").is_none() || sanitize_remote("h:org/repo").is_none());
    let config = "[REMOTE \"origin\"]\n\turl = git@github.com:philbert440/rivetOS.git\n";
    assert!(origin_url_from_config(config).is_some());
    assert!(origin_url_from_config("[remote \"Origin\"]\n\turl = git@github.com:org/rivetOS.git\n").is_none());
    let mut fs = MapFs::default();
    fs.dirs.insert("/srv/code/rivetos".to_string());
    fs.dirs.insert("/srv/code/rivetos/.git".to_string());
    fs.files.insert(
        "/srv/code/rivetos/.git/config".to_string(),
        "[remote \"origin\"]\n\turl = git@github.com:philbert440/rivetOS.git\n".to_string(),
    );
    let hit = resolve_project_from_cwd("/srv/code/rivetos", &fs).expect("hit");
    assert_eq!(hit.value, "rivetos");
    assert_eq!(hit.display, "rivetOS");
    assert_eq!(hit.rule, "git-remote");
    assert_eq!(hit.reason, "git-remote: github.com/philbert440/rivetOS");
    let mut bare = MapFs::default();
    bare.dirs.insert("/srv/code/My Repo".to_string());
    bare.dirs.insert("/srv/code/My Repo/.git".to_string());
    bare.files.insert("/srv/code/My Repo/.git/config".to_string(), "[core]\n\tbare = false\n".to_string());
    let root = resolve_project_from_cwd("/srv/code/My Repo", &bare).expect("root");
    assert_eq!(root.value, "my-repo");
    assert_eq!(root.display, "My Repo");
    assert_eq!(root.rule, "git-root");
    let mut deep = MapFs::default();
    let mut path = String::new();
    for index in 0..40 {
        path.push_str(&format!("/x{index}"));
        deep.dirs.insert(path.clone());
    }
    let leaf = format!("{path}/leaf");
    deep.dirs.insert(leaf.clone());
    let walked = resolve_project_from_cwd(&leaf, &deep).expect("basename");
    assert_eq!(walked.rule, "cwd-basename");
    assert_eq!(PROJECT_RULE_MAX_WALK, 16);
    let mut settings = Map::new();
    settings.insert("cwd".to_string(), Value::String("/home/someone/work/TenPAL".to_string()));
    let planned = plan_project_rule_tag(Some(&settings), false, false, None).expect("plan");
    assert_eq!(planned.value, "tenpal");
    assert_eq!(planned.display, "TenPAL");
    assert!(plan_project_rule_tag(Some(&settings), true, true, None).is_none());
}

#[test]
fn write_tool_validation_and_sql_shapes() {
    let env = BTreeMap::new();
    let err = prepare_append(&Map::new(), &env).expect_err("session");
    assert_eq!(err, "memory_append: session_id is required");
    let mut args = Map::new();
    args.insert("session_id".to_string(), Value::String("s".to_string()));
    args.insert("role".to_string(), Value::String("nope".to_string()));
    args.insert("content".to_string(), Value::String("hi".to_string()));
    assert_eq!(
        prepare_append(&args, &env).expect_err("role"),
        "memory_append: role must be user|assistant|system|tool"
    );
    args.insert("role".to_string(), Value::String("user".to_string()));
    let prepared = prepare_append(&args, &env).expect("ok");
    let value = append_result_value(&prepared, "id-1", false);
    assert_eq!(value.get("id").and_then(Value::as_str), Some("id-1"));
    assert_eq!(value.get("channel").and_then(Value::as_str), Some("mcp"));
    assert_eq!(
        validate_ingest_messages(&Value::Array(vec![])).expect_err("empty"),
        "memory_ingest_session: messages must be a non-empty array"
    );
    let sql = memory::capture_conversation_upsert_sql(true);
    assert!(sql.contains("ON CONFLICT (session_key, agent) DO UPDATE"));
    assert!(sql.contains("owner_user_id = COALESCE(ros_conversations.owner_user_id, EXCLUDED.owner_user_id)"));
    assert!(!sql.contains("active = true") && !sql.contains("active=true"));
    let plain = memory::capture_conversation_upsert_sql(false);
    assert!(!plain.contains("owner_user_id"));
    let insert = memory::capture_message_insert_sql(false);
    assert!(insert.contains("$7::jsonb"));
    assert!(insert.contains("COALESCE($10::timestamptz, now())"));
    assert_eq!(capture_guard_statements()[0], "SET idle_in_transaction_session_timeout = '30s'");
    assert_eq!(capture_guard_statements()[1], "SET statement_timeout = '60s'");
    assert_eq!(IDLE_IN_TRANSACTION_TIMEOUT, "30s");
    assert_eq!(STATEMENT_TIMEOUT, "60s");
    assert_eq!(CAPTURE_POOL_MAX, 1);
    let filter = memory::BrowseFilter {
        since: None,
        before: None,
        window: None,
        ..memory::BrowseFilter::default()
    };
    let browse = browse_sql(&filter, Some("2026-01-01T00:00:00Z"), None).expect("browse");
    assert!(browse.sql.contains("::timestamptz"));
    assert!(browse.sql.contains("LIMIT 50"));
    assert!(!browse.sql.contains("LIMIT $"));
}

#[test]
fn report_formatters_and_get_full_strings() {
    assert_eq!(en_us(1000), "1,000");
    assert_eq!(en_us(0), "0");
    let iso = format_js_iso(chrono::Utc.with_ymd_and_hms(2026, 10, 10, 19, 4, 6).unwrap().with_nanosecond(92_000_000).unwrap());
    assert_eq!(iso, "2026-10-10T19:04:06.092Z");
    assert!(health_cached(10_000, 0, true).is_none());
    assert_eq!(health_cached(20_000, 10_000, true), Some(true));
    let empty = format_queue_health(&[]);
    assert!(empty.contains("(empty)"));
    let line = format_queue_health(&[QueueRow {
        task: "embed-target".to_string(),
        pending: 1,
        dead: 0,
        running: Some(0),
        scheduled: Some(0),
        oldest_pending_age_min: None,
        last_error: None,
        recent_dead: 0,
    }]);
    assert!(line.contains(", 0 dead"));
    let embed = format_embedding_queue(1, 2, 3, 0);
    assert!(embed.contains("Messages awaiting embedding: 1"));
    assert!(embed.contains("Unembeddable (excluded by design): 3"));
    assert_eq!(extract_text(&Value::String("hello".to_string())), "hello");
    assert!(missing_pointer_message().contains("pre-#196"));
    let mut meta = Map::new();
    meta.insert("full_content_length".to_string(), json!(10));
    assert!(truncation_hint(Some(&meta), "row-9").contains("memory_get_full id=row-9"));
    assert!(file_missing_message("/tmp/missing.jsonl", Some("grok")).contains("/tmp/missing.jsonl"));
    let row = CoworkHookRow {
        id: "1".to_string(),
        role: "user".to_string(),
        content: "hello".to_string(),
        event_id: "h1".to_string(),
    };
    let picked = pick_cowork_hook_rewrite("user", "hello", Some("cowork-transcript"), None, &[row.clone()], &[]);
    assert_eq!(picked.unwrap().id, "1");
    assert!(pick_cowork_hook_rewrite("user", "hello", Some("other"), None, &[row], &[]).is_none());
}

struct Stub(&'static str);

impl MemoryStore for Stub {
    async fn append(&self, _entry: &MemoryEntry) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
    async fn search(&self, _query: &str, _options: &SearchOptions) -> Result<Value, StoreError> {
        Ok(Value::String(self.0.to_string()))
    }
    async fn get_context_for_turn(&self, _query: &str, _agent: &str, _user_id: Option<&str>) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
    async fn get_session_history(&self, _session_id: &str, _limit: Option<i64>) -> Result<Vec<HistoryMessage>, StoreError> {
        Ok(vec![HistoryMessage { role: self.0.to_string(), content: String::new() }])
    }
    async fn get_task_history(&self, _task_id: &str, _limit: Option<i64>) -> Result<Vec<HistoryMessage>, StoreError> {
        Ok(vec![HistoryMessage { role: self.0.to_string(), content: String::new() }])
    }
    async fn save_session_settings(&self, _session_id: &str, _settings: &Map<String, Value>) -> Result<(), StoreError> {
        Ok(())
    }
    async fn load_session_settings(&self, _session_id: &str) -> Result<Option<Map<String, Value>>, StoreError> {
        Ok(None)
    }
    async fn capture(&self, _batch: &memory::CaptureBatch, _options: &CaptureOptions) -> Result<memory::CaptureResult, StoreError> {
        Ok(memory::CaptureResult { ok: true, conversation_id: self.0.to_string(), inserted: 0, skipped: 0 })
    }
    async fn browse(&self, _filter: &memory::BrowseFilter) -> Result<Value, StoreError> {
        Ok(Value::String(self.0.to_string()))
    }
    async fn stats(&self) -> Result<memory::StatsReport, StoreError> {
        Ok(memory::StatsReport { dashboard: Value::Null, markdown: self.0.to_string() })
    }
    async fn health(&self, _owner: bool) -> Result<memory::HealthReport, StoreError> {
        Ok(memory::HealthReport { body: Value::String(self.0.to_string()) })
    }
    fn tools(&self) -> Vec<memory::ToolDescriptor> {
        Vec::new()
    }
    async fn tags(&self) -> Result<(), StoreError> {
        Err(StoreError::NotYetImplemented("tags"))
    }
    fn wiki(&self) -> Option<String> {
        None
    }
    async fn ingest_session(&self, _input: &IngestInput) -> Result<IngestOutput, StoreError> {
        Ok(IngestOutput {
            session_id: self.0.to_string(),
            ingested: 0,
            skipped: 0,
            ids: Vec::new(),
            source: String::new(),
            agent: String::new(),
            channel: String::new(),
            persona: None,
            truncated: false,
            full_content_length: None,
        })
    }
    async fn get_full(&self, _id: &str) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
}

#[tokio::test]
async fn routing_follows_session_suffix_and_blocks() {
    assert_eq!(user_from_session_key("claude-code:phil"), Some("phil"));
    assert_eq!(user_from_session_key("task:abc"), None);
    assert_eq!(user_from_session_key("noseparator"), None);
    assert_eq!(user_from_session_key("ends:"), None);
    let routed = RoutingMemory {
        main: StoreHandle::Live(Stub("main")),
        by_user: vec![
            ("phil".to_string(), StoreHandle::Live(Stub("phil"))),
            ("blocked".to_string(), StoreHandle::Blocked("blocked".to_string())),
        ],
    };
    assert_eq!(routed.append(&entry("claude-code:phil")).await.unwrap(), "phil");
    assert_eq!(routed.append(&entry("claude-code:other")).await.unwrap(), "main");
    assert_eq!(routed.append(&entry("task:abc")).await.unwrap(), "main");
    let err = routed.append(&entry("claude-code:blocked")).await.expect_err("blocked");
    assert_eq!(
        err.to_string(),
        "memory for user \"blocked\" is unavailable (store failed to initialize)"
    );
    let blocked_main = RoutingMemory {
        main: StoreHandle::Blocked("owner".to_string()),
        by_user: Vec::new(),
    };
    assert!(blocked_main.get_task_history("abc", None).await.unwrap().is_empty());
    assert_eq!(routed.ingest_session(&ingest("codex:phil")).await.unwrap().session_id, "phil");
    assert_eq!(routed.get_full("id").await.unwrap(), "main");
    assert!(routed.tags().await.unwrap_err().to_string().contains("tags"));
    assert!(routed.wiki().is_none());
}

fn entry(session_id: &str) -> MemoryEntry {
    MemoryEntry {
        session_id: session_id.to_string(),
        agent: "rivet".to_string(),
        channel: "test".to_string(),
        role: "user".to_string(),
        content: "hi".to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        metadata: None,
        created_at: None,
    }
}

fn ingest(session_id: &str) -> IngestInput {
    IngestInput {
        session_id: session_id.to_string(),
        messages: vec![memory::IngestMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            created_at: None,
            tool_calls: Vec::new(),
        }],
        source: None,
        agent: None,
        persona: None,
        channel: None,
        env: BTreeMap::new(),
    }
}

#[tokio::test]
async fn deferred_methods_do_not_open_a_database() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://127.0.0.1/rivetos_rr2a")
        .expect("lazy");
    let store = PostgresMemory::from_pool(pool, true);
    let err = store.search("q", &SearchOptions::default()).await.expect_err("search");
    assert!(err.to_string().contains("search"));
    let err = store.get_context_for_turn("q", "rivet", None).await.expect_err("context");
    assert!(err.to_string().contains("getContextForTurn"));
    assert!(store.tags().await.expect_err("tags").to_string().contains("tags"));
    assert!(store.wiki().is_none());
    let names: Vec<_> = store.tools().into_iter().map(|tool| tool.name).collect();
    assert_eq!(
        names,
        ["memory_browse", "memory_stats", "memory_get_full", "memory_append", "memory_ingest_session"]
    );
}

#[test]
fn capture_cap_placeholder_is_not_required() {
    let _ = capture_cap_placeholder;
}
