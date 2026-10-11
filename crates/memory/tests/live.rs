use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use memory::{
    BrowseFilter, CaptureBatch, CaptureMessage, CaptureOptions, IngestInput, IngestMessage,
    MemoryEntry, MemoryStore, MigrateClient, MigrateFault, MigrateRows, PostgresMemory, StoreError,
};
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection, PgPool, Row};

mod common;

fn msg(event: &str, role: &str, content: &str) -> CaptureMessage {
    CaptureMessage {
        event_id: event.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        metadata: None,
        created_at: None,
    }
}

fn batch(session: &str, agent: &str, messages: Vec<CaptureMessage>) -> CaptureBatch {
    CaptureBatch {
        session_key: session.to_string(),
        agent: agent.to_string(),
        channel: Some("cli".to_string()),
        title: None,
        settings: None,
        task_id: None,
        finalize: false,
        created_at: None,
        updated_at: None,
        messages,
    }
}

fn entry(session: &str, agent: &str, content: &str) -> MemoryEntry {
    MemoryEntry {
        session_id: session.to_string(),
        agent: agent.to_string(),
        channel: "cli".to_string(),
        role: "user".to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        metadata: None,
        created_at: None,
    }
}

fn cwd_settings(path: &str) -> Map<String, Value> {
    let mut settings = Map::new();
    settings.insert("cwd".to_string(), Value::String(path.to_string()));
    settings
}

fn no_fs() -> CaptureOptions {
    CaptureOptions {
        allow_filesystem: false,
        ..CaptureOptions::default()
    }
}

struct PgMigrate {
    conn: PgConnection,
}

fn migrate_fault(err: sqlx::Error) -> MigrateFault {
    if let Some(db) = err.as_database_error() {
        return MigrateFault {
            message: db.message().to_string(),
            code: db.code().map(|code| code.into_owned()),
        };
    }
    MigrateFault::new(err.to_string())
}

impl PgMigrate {
    async fn exec(&mut self, sql: &str, param: Option<&str>) -> Result<MigrateRows, MigrateFault> {
        let select =
            sql.trim_start().len() >= 6 && sql.trim_start()[..6].eq_ignore_ascii_case("select");
        if param.is_some() || select {
            let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
            if let Some(value) = param {
                query = query.bind(value);
            }
            let fetched = query
                .fetch_all(&mut self.conn)
                .await
                .map_err(migrate_fault)?;
            let mut rows = Vec::new();
            for row in fetched {
                let mut cells = Vec::new();
                for index in 0..row.columns().len() {
                    cells.push(row.try_get::<Option<String>, _>(index).ok().flatten());
                }
                rows.push(cells);
            }
            return Ok(MigrateRows { rows });
        }
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut self.conn)
            .await
            .map_err(migrate_fault)?;
        Ok(MigrateRows::default())
    }
}

impl MigrateClient for PgMigrate {
    async fn query(&mut self, sql: &str) -> Result<MigrateRows, MigrateFault> {
        self.exec(sql, None).await
    }

    async fn query_bind(&mut self, sql: &str, param: &str) -> Result<MigrateRows, MigrateFault> {
        self.exec(sql, Some(param)).await
    }
}

async fn capture_three(
    store: &PostgresMemory,
    session: &str,
    events: &[String],
) -> Result<(u64, u64), String> {
    let messages = events
        .iter()
        .map(|event| msg(event, "user", event))
        .collect();
    let result = MemoryStore::capture(
        store,
        &batch(session, "iso-agent", messages),
        &CaptureOptions::default(),
    )
    .await
    .map_err(|err| err.to_string())?;
    Ok((result.inserted, result.skipped))
}

#[tokio::test]
async fn repeated_capture_stays_inside_its_schema() {
    let pid = std::process::id();
    let session = format!("rr2a-fix2-repeat-{pid}");
    let events = vec![
        format!("fix2-e1-{pid}"),
        format!("fix2-e2-{pid}"),
        format!("fix2-e3-{pid}"),
    ];
    let session_a = session.clone();
    let events_a = events.clone();
    common::with_db(
        "repeated_capture_stays_inside_its_schema",
        "rr2a_iso",
        true,
        4,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let (inserted, skipped) = capture_three(&store, &session_a, &events_a).await?;
            assert_eq!((inserted, skipped), (3, 0));
            let (inserted, skipped) = capture_three(&store, &session_a, &events_a).await?;
            assert_eq!((inserted, skipped), (0, 3));
            let scoped: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = $1",
            )
            .bind(&session_a)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(scoped, 3);
            Ok(())
        },
    )
    .await;
    common::with_db(
        "repeated_capture_second_schema",
        "rr2a_iso",
        true,
        4,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let (inserted, skipped) = capture_three(&store, &session, &events).await?;
            assert_eq!((inserted, skipped), (3, 0));
            let url = std::env::var("RIVETOS_PG_URL").map_err(|err| err.to_string())?;
            let mut conn = PgConnection::connect(&url)
                .await
                .map_err(|err| err.to_string())?;
            let leaked: Result<i64, sqlx::Error> = sqlx::query_scalar(
                "SELECT COUNT(*) FROM public.ros_messages m JOIN public.ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = $1",
            )
            .bind(&session)
            .fetch_one(&mut conn)
            .await;
            match leaked {
                Ok(count) => assert_eq!(count, 0),
                Err(err) => assert_eq!(common::pg_code(&err).as_deref(), Some("42P01")),
            }
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn capture_owner_finalize_pending_tool_and_cowork() {
    common::with_db(
        "capture_owner_finalize_pending_tool_and_cowork",
        "rr2a_cap",
        true,
        4,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let mut owned = batch("sess-owner", "agent-owner", vec![msg("own-1", "user", "owned")]);
            owned.task_id = Some("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa".to_string());
            let owner_opts = CaptureOptions {
                owner_user_id: Some("owner-1".to_string()),
                allow_filesystem: false,
                ..CaptureOptions::default()
            };
            let owned_result = MemoryStore::capture(&store, &owned, &owner_opts)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(owned_result.inserted, 1);
            let owner: String = sqlx::query_scalar(
                "SELECT owner_user_id FROM ros_conversations WHERE id = $1::uuid",
            )
            .bind(&owned_result.conversation_id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(owner, "owner-1");
            let message_owner: String = sqlx::query_scalar(
                "SELECT owner_user_id FROM ros_messages WHERE conversation_id = $1::uuid",
            )
            .bind(&owned_result.conversation_id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(message_owner, "owner-1");

            let plain = MemoryStore::capture(
                &store,
                &batch("sess-plain", "agent-plain", vec![msg("plain-1", "user", "plain")]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(plain.inserted, 1);
            let again = MemoryStore::capture(
                &store,
                &batch("sess-plain", "agent-plain", vec![msg("plain-1", "user", "plain")]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!((again.inserted, again.skipped), (0, 1));

            let mut done = batch(
                "sess-final",
                "agent-final",
                vec![msg("fin-1", "user", "bye")],
            );
            done.finalize = true;
            MemoryStore::capture(&store, &done, &CaptureOptions::default())
                .await
                .map_err(|err| err.to_string())?;
            let history = MemoryStore::get_session_history(&store, "sess-final", None)
                .await
                .map_err(|err| err.to_string())?;
            assert!(history.is_empty());
            let active: bool = sqlx::query_scalar(
                "SELECT active FROM ros_conversations WHERE session_key = 'sess-final'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert!(!active);

            let mut pending = msg("tool-1", "tool", "");
            pending.tool_name = Some("Bash".to_string());
            MemoryStore::capture(
                &store,
                &batch("sess-tool", "agent-tool", vec![pending]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            let mut filled = msg("tool-1", "tool", "ran");
            filled.tool_name = Some("Bash".to_string());
            filled.tool_result = Some("ok".to_string());
            let filled_result = MemoryStore::capture(
                &store,
                &batch("sess-tool", "agent-tool", vec![filled]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!((filled_result.inserted, filled_result.skipped), (0, 1));
            let tool_result: String = sqlx::query_scalar(
                "SELECT tool_result FROM ros_messages WHERE metadata->>'event_id' = 'tool-1'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(tool_result, "ok");

            let mut hook = msg("hook-1", "user", "hello from the hook");
            let mut hook_meta = Map::new();
            hook_meta.insert("source".to_string(), Value::String("cowork-hook".to_string()));
            hook.metadata = Some(hook_meta);
            MemoryStore::capture(
                &store,
                &batch("sess-cowork", "agent-cowork", vec![hook]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            let mut transcript = msg("transcript-1", "user", "hello from the hook");
            let mut transcript_meta = Map::new();
            transcript_meta.insert(
                "source".to_string(),
                Value::String("cowork-transcript".to_string()),
            );
            transcript_meta.insert(
                "replaces_event_id".to_string(),
                Value::String("hook-1".to_string()),
            );
            transcript.metadata = Some(transcript_meta);
            let rewritten = MemoryStore::capture(
                &store,
                &batch("sess-cowork", "agent-cowork", vec![transcript]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(rewritten.inserted, 0);
            let source: String = sqlx::query_scalar(
                "SELECT metadata->>'source' FROM ros_messages WHERE metadata->>'event_id' = 'transcript-1'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(source, "cowork-transcript");
            let rows: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = 'sess-cowork'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(rows, 1);

            let mut bad = batch("sess-bad-task", "agent-bad", vec![msg("bad-1", "user", "nope")]);
            bad.task_id = Some("not-a-uuid".to_string());
            let failed = MemoryStore::capture(&store, &bad, &CaptureOptions::default()).await;
            assert!(failed.is_err());
            let leftover: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_conversations WHERE session_key = 'sess-bad-task'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(leftover, 0);
            MemoryStore::capture(
                &store,
                &batch("sess-after-rollback", "agent-bad", vec![msg("ok-1", "user", "still works")]),
                &CaptureOptions::default(),
            )
            .await
            .map_err(|err| err.to_string())?;
            Ok(())
        },
    )
    .await;
}

async fn tags_of(
    pool: &PgPool,
    conversation_id: &str,
) -> Result<Vec<(String, String, String, Option<String>)>, String> {
    let rows = sqlx::query(
        "SELECT value, state, source, decided_by FROM ros_tags WHERE entity_id = $1::uuid ORDER BY value",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push((
            row.try_get("value").map_err(|err| err.to_string())?,
            row.try_get("state").map_err(|err| err.to_string())?,
            row.try_get("source").map_err(|err| err.to_string())?,
            row.try_get("decided_by").map_err(|err| err.to_string())?,
        ));
    }
    Ok(out)
}

#[tokio::test]
async fn project_rule_capture_matches_the_typescript_cases_rust_can_reach() {
    common::with_db(
        "project_rule_capture_matches_the_typescript_cases_rust_can_reach",
        "rr2a_rule",
        true,
        4,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let mut first = batch("rule-demo", "rule-agent", vec![msg("rule-1", "user", "one")]);
            first.settings = Some(cwd_settings("/work/demo"));
            let wrote = MemoryStore::capture(&store, &first, &no_fs())
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(wrote.inserted, 1);
            assert_eq!(
                tags_of(&db.pool, &wrote.conversation_id).await?,
                [(
                    "demo".to_string(),
                    "accepted".to_string(),
                    "rule".to_string(),
                    Some("cwd-git-root".to_string())
                )]
            );
            let mut second = batch("rule-demo", "rule-agent", vec![msg("rule-2", "user", "two")]);
            second.settings = Some(cwd_settings("/work/demo"));
            MemoryStore::capture(&store, &second, &no_fs())
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(tags_of(&db.pool, &wrote.conversation_id).await?.len(), 1);

            let mut rejected = batch(
                "rule-rejected",
                "rule-agent",
                vec![msg("rule-3", "user", "three")],
            );
            rejected.settings = Some(cwd_settings("/work/demo"));
            let rejected_id = MemoryStore::capture(&store, &rejected, &no_fs())
                .await
                .map_err(|err| err.to_string())?
                .conversation_id;
            sqlx::query("UPDATE ros_tags SET state = 'rejected' WHERE entity_id = $1::uuid")
                .bind(&rejected_id)
                .execute(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            let mut other = batch(
                "rule-rejected",
                "rule-agent",
                vec![msg("rule-4", "user", "four")],
            );
            other.settings = Some(cwd_settings("/work/other-repo"));
            MemoryStore::capture(&store, &other, &no_fs())
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(
                tags_of(&db.pool, &rejected_id).await?,
                [(
                    "demo".to_string(),
                    "rejected".to_string(),
                    "rule".to_string(),
                    Some("cwd-git-root".to_string())
                )]
            );

            sqlx::query(
                "INSERT INTO ros_tag_taxonomy (key, value, display, aliases, state) VALUES ('project', 'rivet-os', 'RivetOS', ARRAY['rivetos'], 'accepted'), ('project', 'scratch', '', '{}', 'rejected')",
            )
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let mut alias = batch("rule-alias", "rule-agent", vec![msg("rule-5", "user", "five")]);
            alias.settings = Some(cwd_settings("/work/rivetos"));
            let alias_id = MemoryStore::capture(&store, &alias, &no_fs())
                .await
                .map_err(|err| err.to_string())?
                .conversation_id;
            let alias_tags = tags_of(&db.pool, &alias_id).await?;
            assert_eq!(alias_tags.len(), 1);
            assert_eq!(alias_tags[0].0, "rivet-os");
            assert_eq!(alias_tags[0].1, "accepted");
            let mut vocab = batch(
                "rule-scratch",
                "rule-agent",
                vec![msg("rule-6", "user", "six")],
            );
            vocab.settings = Some(cwd_settings("/work/scratch"));
            let scratch_id = MemoryStore::capture(&store, &vocab, &no_fs())
                .await
                .map_err(|err| err.to_string())?
                .conversation_id;
            assert!(tags_of(&db.pool, &scratch_id).await?.is_empty());
            let kept: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = 'rule-scratch'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(kept, 1);

            sqlx::query(
                "ALTER TABLE ros_tags ADD CONSTRAINT ros_tags_no_rule CHECK (source <> 'rule') NOT VALID",
            )
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let mut blocked = batch(
                "rule-savepoint",
                "rule-agent",
                vec![msg("rule-7", "user", "seven")],
            );
            blocked.settings = Some(cwd_settings("/work/demo"));
            let blocked_result = MemoryStore::capture(&store, &blocked, &no_fs())
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(blocked_result.inserted, 1);
            assert!(tags_of(&db.pool, &blocked_result.conversation_id).await?.is_empty());
            let stored: String = sqlx::query_scalar(
                "SELECT content FROM ros_messages WHERE metadata->>'event_id' = 'rule-7'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(stored, "seven");
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn append_ingest_settings_and_forced_rollbacks() {
    common::with_db(
        "append_ingest_settings_and_forced_rollbacks",
        "rr2a_app",
        true,
        4,
        |db| async move {
            let owned = PostgresMemory::from_pool(db.pool.clone(), false).with_user_id("owner-2");
            let id = MemoryStore::append(&owned, &entry("append-owner", "append-agent", "owned line"))
                .await
                .map_err(|err| err.to_string())?;
            let owner: String = sqlx::query_scalar(
                "SELECT owner_user_id FROM ros_messages WHERE id = $1::uuid",
            )
            .bind(&id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(owner, "owner-2");
            let plain = PostgresMemory::from_pool(db.pool.clone(), false);
            MemoryStore::append(&plain, &entry("append-plain", "append-agent", "plain line"))
                .await
                .map_err(|err| err.to_string())?;
            let plain_owner: Option<String> = sqlx::query_scalar(
                "SELECT owner_user_id FROM ros_conversations WHERE session_key = 'append-plain'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert!(plain_owner.is_none());

            let mut synth = entry("append-synth", "append-agent", "  ");
            synth.role = "assistant".to_string();
            synth.tool_name = Some("Bash".to_string());
            let synth_id = MemoryStore::append(&plain, &synth)
                .await
                .map_err(|err| err.to_string())?;
            let jobs: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM graphile_worker._private_jobs WHERE key = $1",
            )
            .bind(format!("tool-synth-{synth_id}"))
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(jobs, 1);

            let mut args = Map::new();
            args.insert("session_id".to_string(), Value::String("append-lock".to_string()));
            args.insert("role".to_string(), Value::String("user".to_string()));
            args.insert("content".to_string(), Value::String("locked".to_string()));
            args.insert("event_id".to_string(), Value::String("lock-1".to_string()));
            args.insert("agent".to_string(), Value::String("append-agent".to_string()));
            let env = BTreeMap::new();
            let first = plain
                .append_locked(&args, &env)
                .await
                .map_err(|err| err.to_string())?;
            let second = plain
                .append_locked(&args, &env)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(second.get("skipped"), Some(&Value::Bool(true)));
            assert_eq!(first.get("id"), second.get("id"));

            let input = IngestInput {
                session_id: "ingest-1".to_string(),
                messages: vec![IngestMessage {
                    role: "user".to_string(),
                    content: "ingested".to_string(),
                    created_at: None,
                    tool_calls: Vec::new(),
                }],
                source: Some("mcp".to_string()),
                agent: Some("ingest-agent".to_string()),
                persona: None,
                channel: Some("cli".to_string()),
                env: BTreeMap::new(),
            };
            let ingested = MemoryStore::ingest_session(&plain, &input)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!((ingested.ingested, ingested.skipped), (1, 0));
            let repeat = MemoryStore::ingest_session(&plain, &input)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!((repeat.ingested, repeat.skipped), (0, 1));

            let mut settings = Map::new();
            settings.insert("theme".to_string(), Value::String("dark".to_string()));
            MemoryStore::save_session_settings(&plain, "ingest-1", &settings)
                .await
                .map_err(|err| err.to_string())?;
            let loaded = MemoryStore::load_session_settings(&plain, "ingest-1")
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(loaded.as_ref().and_then(Value::as_object), Some(&settings));
            sqlx::query("UPDATE ros_conversations SET settings = '[]'::jsonb WHERE session_key = 'ingest-1'")
                .execute(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            let cleared = MemoryStore::load_session_settings(&plain, "ingest-1")
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(cleared, Some(json!([])));

            let mut bad = entry("append-bad-time", "append-agent", "dated");
            bad.created_at = Some("not-a-date".to_string());
            let failed = MemoryStore::append(&plain, &bad).await;
            assert!(failed.unwrap_err().to_string().contains("invalid created_at"));
            let dated = IngestInput {
                session_id: "ingest-dates".to_string(),
                messages: vec![
                    IngestMessage {
                        role: "user".to_string(),
                        content: "spaced".to_string(),
                        created_at: Some("2026-10-11 12:00:00Z".to_string()),
                        tool_calls: Vec::new(),
                    },
                    IngestMessage {
                        role: "user".to_string(),
                        content: "day".to_string(),
                        created_at: Some("2026-10-11".to_string()),
                        tool_calls: Vec::new(),
                    },
                ],
                source: Some("mcp".to_string()),
                agent: Some("date-agent".to_string()),
                persona: None,
                channel: Some("cli".to_string()),
                env: BTreeMap::new(),
            };
            let dated_out = MemoryStore::ingest_session(&plain, &dated)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(dated_out.ingested, 2);
            let stored = sqlx::query(
                "SELECT m.content, m.created_at FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = 'ingest-dates' ORDER BY m.content",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let instant = |raw: &str| {
                DateTime::parse_from_rfc3339(raw)
                    .map_err(|err| err.to_string())
                    .map(|dt| dt.with_timezone(&Utc))
            };
            assert_eq!(stored.len(), 2);
            let day: DateTime<Utc> = stored[0]
                .try_get("created_at")
                .map_err(|err| err.to_string())?;
            let spaced: DateTime<Utc> = stored[1]
                .try_get("created_at")
                .map_err(|err| err.to_string())?;
            assert_eq!(stored[0].try_get::<String, _>("content").map_err(|err| err.to_string())?, "day");
            assert_eq!(day, instant("2026-10-11T00:00:00Z")?);
            assert_eq!(spaced, instant("2026-10-11T12:00:00Z")?);

            let mut empty_fields = Map::new();
            empty_fields.insert(
                "session_id".to_string(),
                Value::String("append-empty-fields".to_string()),
            );
            empty_fields.insert("role".to_string(), Value::String("user".to_string()));
            empty_fields.insert("content".to_string(), Value::String("hello".to_string()));
            empty_fields.insert("tool_name".to_string(), Value::String(String::new()));
            empty_fields.insert("tool_result".to_string(), Value::String(String::new()));
            empty_fields.insert(
                "agent".to_string(),
                Value::String("append-agent".to_string()),
            );
            plain
                .append_locked(&empty_fields, &env)
                .await
                .map_err(|err| err.to_string())?;
            let stored_fields = sqlx::query(
                "SELECT m.tool_name, m.tool_result FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = 'append-empty-fields'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let stored_tool_name: String = stored_fields
                .try_get("tool_name")
                .map_err(|err| err.to_string())?;
            let stored_tool_result: Option<String> = stored_fields
                .try_get("tool_result")
                .map_err(|err| err.to_string())?;
            assert_eq!(stored_tool_name, "");
            assert!(stored_tool_result.is_none());

            let created_payload = json!({
                "session_id": "ingest-created-at",
                "agent": "date-agent",
                "messages": [
                    {"role": "user", "content": "blank-created", "created_at": ""},
                    {"role": "user", "content": "epoch-created", "created_at": 1_791_590_400_000_i64},
                    {"role": "user", "content": "space-created", "created_at": " "}
                ]
            });
            let created_raw = MemoryStore::call_tool(&plain, "memory_ingest_session", &created_payload)
                .await
                .map_err(|err| err.to_string())?;
            let created_out: Value =
                serde_json::from_str(&created_raw).map_err(|err| err.to_string())?;
            assert_eq!(created_out.get("ingested").and_then(Value::as_u64), Some(2));
            assert_eq!(created_out.get("skipped").and_then(Value::as_u64), Some(1));
            let created_rows = sqlx::query(
                "SELECT m.content, m.created_at FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = 'ingest-created-at' ORDER BY m.content",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(created_rows.len(), 2);
            let blank_at: DateTime<Utc> = created_rows[0]
                .try_get("created_at")
                .map_err(|err| err.to_string())?;
            let epoch_at: DateTime<Utc> = created_rows[1]
                .try_get("created_at")
                .map_err(|err| err.to_string())?;
            assert_eq!(
                created_rows[0]
                    .try_get::<String, _>("content")
                    .map_err(|err| err.to_string())?,
                "blank-created"
            );
            assert!(blank_at > Utc::now() - chrono::Duration::minutes(5));
            assert_eq!(
                created_rows[1]
                    .try_get::<String, _>("content")
                    .map_err(|err| err.to_string())?,
                "epoch-created"
            );
            assert_eq!(epoch_at, instant("2026-10-10T00:00:00Z")?);
            MemoryStore::append(&plain, &entry("append-after-rollback", "append-agent", "recovered"))
                .await
                .map_err(|err| err.to_string())?;

            sqlx::raw_sql(sqlx::AssertSqlSafe(
                "ALTER TABLE ros_messages RENAME TO ros_messages_held".to_string(),
            ))
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let locked_failed = plain.append_locked(&args, &env).await;
            sqlx::raw_sql(sqlx::AssertSqlSafe(
                "ALTER TABLE ros_messages_held RENAME TO ros_messages".to_string(),
            ))
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert!(locked_failed.is_err());

            sqlx::raw_sql(sqlx::AssertSqlSafe(
                "ALTER TABLE ros_conversations RENAME TO ros_conversations_held".to_string(),
            ))
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let ingest_failed = MemoryStore::ingest_session(&plain, &input).await;
            sqlx::raw_sql(sqlx::AssertSqlSafe(
                "ALTER TABLE ros_conversations_held RENAME TO ros_conversations".to_string(),
            ))
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert!(ingest_failed.is_err());

            sqlx::raw_sql(sqlx::AssertSqlSafe(
                "DROP INDEX ux_ros_conversations_session_agent".to_string(),
            ))
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let fresh = PostgresMemory::from_pool(db.pool.clone(), false).with_user_id("owner-3");
            let created = MemoryStore::append(&fresh, &entry("append-new", "append-agent", "inserted"))
                .await
                .map_err(|err| err.to_string())?;
            let created_owner: String = sqlx::query_scalar(
                "SELECT c.owner_user_id FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE m.id = $1::uuid",
            )
            .bind(&created)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(created_owner, "owner-3");
            MemoryStore::append(&fresh, &entry("append-plain", "append-agent", "backfilled"))
                .await
                .map_err(|err| err.to_string())?;
            let backfill: String = sqlx::query_scalar(
                "SELECT owner_user_id FROM ros_conversations WHERE session_key = 'append-plain'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(backfill, "owner-3");
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn browse_stats_health_bump_and_get_full() {
    common::with_db(
        "browse_stats_health_bump_and_get_full",
        "rr2a_read",
        true,
        4,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let mut seeded = entry("browse-session", "browse-agent", "browse me");
            seeded.tool_name = Some("Bash".to_string());
            seeded.role = "assistant".to_string();
            let message_id = MemoryStore::append(&store, &seeded)
                .await
                .map_err(|err| err.to_string())?;
            let conversation_id: String = sqlx::query_scalar(
                "SELECT conversation_id::text FROM ros_messages WHERE id = $1::uuid",
            )
            .bind(&message_id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            sqlx::query(
                "INSERT INTO ros_tags (entity_type, entity_id, key, value, display, source, state, proposed_by, decided_by, decided_at) VALUES ('conversation', $1::uuid, 'project', 'demo', 'demo', 'user', 'accepted', 'alice', 'alice', now())",
            )
            .bind(&conversation_id)
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let filter = BrowseFilter {
                role: Some("assistant".to_string()),
                agent: Some("browse-agent".to_string()),
                tool_name: Some("Bash".to_string()),
                tag: Some("project:demo".to_string()),
                window: None,
                since: Some("2020-01-01T00:00:00Z".to_string()),
                before: Some("2099-01-01T00:00:00Z".to_string()),
                limit: Some(10),
            };
            let browsed = MemoryStore::browse(&store, &filter)
                .await
                .map_err(|err| err.to_string())?;
            let messages = browsed
                .get("messages")
                .and_then(Value::as_array)
                .ok_or_else(|| "browse messages".to_string())?;
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0]["content"], json!("browse me"));
            assert_eq!(messages[0]["tags"], json!(["project:demo"]));
            let windowed = MemoryStore::browse(
                &store,
                &BrowseFilter {
                    window: Some("today".to_string()),
                    ..BrowseFilter::default()
                },
            )
            .await
            .map_err(|err| err.to_string())?;
            let windowed = windowed
                .get("messages")
                .and_then(Value::as_array)
                .ok_or_else(|| "window messages".to_string())?;
            assert!(windowed.iter().any(|row| row["content"] == json!("browse me")));
            let mut tool_row = entry("browse-session", "browse-agent", "tool noise");
            tool_row.role = "tool".to_string();
            MemoryStore::append(&store, &tool_row)
                .await
                .map_err(|err| err.to_string())?;
            MemoryStore::append(
                &store,
                &entry("other-session", "other-agent", "other body"),
            )
            .await
            .map_err(|err| err.to_string())?;
            let hidden = store
                .call_tool(
                    "memory_browse",
                    &json!({
                        "conversation_id": conversation_id,
                        "include_tools": false,
                        "order": "asc",
                        "limit": 10
                    }),
                )
                .await
                .map_err(|err| err.to_string())?;
            assert!(hidden.contains("browse me"));
            assert!(hidden.contains("oldest first"));
            assert!(hidden.contains("tools excluded"));
            assert!(!hidden.contains("tool noise"));
            let shown = store
                .call_tool(
                    "memory_browse",
                    &json!({
                        "conversation_id": conversation_id,
                        "include_tools": true,
                        "order": "desc"
                    }),
                )
                .await
                .map_err(|err| err.to_string())?;
            assert!(shown.contains("tool noise"));
            assert!(shown.contains("newest first"));
            assert!(!shown.contains("tools excluded"));
            let all_stats = store
                .call_tool("memory_stats", &json!({}))
                .await
                .map_err(|err| err.to_string())?;
            assert!(all_stats.contains("browse-agent"));
            assert!(all_stats.contains("other-agent"));
            let filtered = store
                .call_tool("memory_stats", &json!({"agent": "browse-agent"}))
                .await
                .map_err(|err| err.to_string())?;
            assert!(filtered.contains("browse-agent"));
            assert!(!filtered.contains("other-agent"));
            let empty_agent = store
                .call_tool("memory_stats", &json!({"agent": ""}))
                .await
                .map_err(|err| err.to_string())?;
            assert!(empty_agent.contains("other-agent"));

            let summary_id: String = sqlx::query_scalar(
                "INSERT INTO ros_summaries (conversation_id, content) VALUES ($1::uuid, 'leaf body') RETURNING id::text",
            )
            .bind(&conversation_id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let message_uuid = sqlx::types::Uuid::parse_str(&message_id).map_err(|err| err.to_string())?;
            let summary_uuid = sqlx::types::Uuid::parse_str(&summary_id).map_err(|err| err.to_string())?;
            store.bump_access(&[message_uuid], &[summary_uuid]).await;
            let message_hits: i32 = sqlx::query_scalar(
                "SELECT access_count FROM ros_messages WHERE id = $1::uuid",
            )
            .bind(&message_id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let summary_hits: i32 = sqlx::query_scalar(
                "SELECT access_count FROM ros_summaries WHERE id = $1::uuid",
            )
            .bind(&summary_id)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(message_hits, 1);
            assert_eq!(summary_hits, 1);

            let report = MemoryStore::stats(&store).await.map_err(|err| err.to_string())?;
            assert!(report.markdown.contains("**Messages:**"));
            assert!(!report.markdown.starts_with("Stats query failed"));
            let dash_messages = report
                .dashboard
                .get("messages")
                .and_then(Value::as_i64)
                .ok_or_else(|| "dashboard messages".to_string())?;
            assert!(dash_messages > 0);

            let restricted = MemoryStore::health(&store, false)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(restricted.body["queueStatus"], json!("restricted"));
            assert_eq!(restricted.body["embeddings"]["status"], json!("unavailable"));
            assert_eq!(
                restricted.body["embeddings"]["error"],
                json!("not configured")
            );
            assert_eq!(restricted.body["status"], json!("degraded"));
            let probed = PostgresMemory::from_pool(db.pool.clone(), false)
                .with_embed_endpoint("http://127.0.0.1:9/embed");
            let owner_health = MemoryStore::health(&probed, true)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(owner_health.body["queueStatus"], json!("available"));
            assert_eq!(
                owner_health.body["embeddings"]["error"],
                json!("embedding endpoint probe is deferred to slice 2b")
            );
            assert_eq!(owner_health.body["status"], json!("degraded"));
            assert!(owner_health.body.get("queues").is_some());
            assert!(owner_health.body.get("compaction").is_some());

            let missing = MemoryStore::get_full(
                &store,
                "99999999-9999-4999-8999-999999999999",
            )
            .await
            .map_err(|err| err.to_string())?;
            assert!(missing.contains("No message with id"));
            let bad_id = MemoryStore::get_full(&store, "not-a-uuid")
                .await
                .map_err(|err| err.to_string())?;
            assert!(
                bad_id.contains("invalid input syntax for type uuid"),
                "{bad_id}"
            );
            let complete = MemoryStore::get_full(&store, &message_id)
                .await
                .map_err(|err| err.to_string())?;
            assert!(complete.contains("(row was not truncated — stored payload is complete)"));
            assert!(complete.contains("browse me"));

            let mut truncated = Map::new();
            truncated.insert("truncated".to_string(), Value::Bool(true));
            let bare_id: String = sqlx::query_scalar(
                "INSERT INTO ros_messages (conversation_id, agent, channel, role, content, metadata) VALUES ($1::uuid, 'browse-agent', 'cli', 'user', 'cut', $2::jsonb) RETURNING id::text",
            )
            .bind(&conversation_id)
            .bind(Value::Object(truncated))
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let bare = MemoryStore::get_full(&store, &bare_id)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(bare, memory::full::missing_pointer_message());

            let jsonl = std::env::temp_dir().join(format!("rr2a-{}-{}.jsonl", std::process::id(), db.name));
            std::fs::write(&jsonl, "{\"content\":\"full jsonl body\"}\n").map_err(|err| err.to_string())?;
            let mut pointer = Map::new();
            pointer.insert("truncated".to_string(), Value::Bool(true));
            pointer.insert(
                "session_jsonl_path".to_string(),
                Value::String(jsonl.to_string_lossy().to_string()),
            );
            pointer.insert("session_jsonl_line".to_string(), Value::from(0));
            pointer.insert("full_content_length".to_string(), Value::from(15));
            let jsonl_id: String = sqlx::query_scalar(
                "INSERT INTO ros_messages (conversation_id, agent, channel, role, content, metadata) VALUES ($1::uuid, 'browse-agent', 'cli', 'user', 'cut', $2::jsonb) RETURNING id::text",
            )
            .bind(&conversation_id)
            .bind(Value::Object(pointer))
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let from_jsonl = MemoryStore::get_full(&store, &jsonl_id)
                .await
                .map_err(|err| err.to_string())?;
            assert!(from_jsonl.contains("full jsonl body"));
            let _ = std::fs::remove_file(&jsonl);

            let sqlite_path = std::env::temp_dir().join(format!("rr2a-{}-{}.db", std::process::id(), db.name));
            let sqlite = rusqlite::Connection::open(&sqlite_path).map_err(|err| err.to_string())?;
            sqlite
                .execute(
                    "CREATE TABLE part (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
                    [],
                )
                .map_err(|err| err.to_string())?;
            sqlite
                .execute(
                    "INSERT INTO part (id, data) VALUES ('part-1', ?)",
                    [r#"{"text":"sqlite part body"}"#],
                )
                .map_err(|err| err.to_string())?;
            drop(sqlite);
            let mut part = Map::new();
            part.insert("truncated".to_string(), Value::Bool(true));
            part.insert(
                "session_sqlite_path".to_string(),
                Value::String(sqlite_path.to_string_lossy().to_string()),
            );
            part.insert(
                "session_sqlite_part_id".to_string(),
                Value::String("part-1".to_string()),
            );
            part.insert("full_content_length".to_string(), Value::from(16));
            let part_id: String = sqlx::query_scalar(
                "INSERT INTO ros_messages (conversation_id, agent, channel, role, content, metadata) VALUES ($1::uuid, 'browse-agent', 'cli', 'user', 'cut', $2::jsonb) RETURNING id::text",
            )
            .bind(&conversation_id)
            .bind(Value::Object(part))
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let from_sqlite = MemoryStore::get_full(&store, &part_id)
                .await
                .map_err(|err| err.to_string())?;
            assert!(from_sqlite.contains("sqlite part body"));
            let _ = std::fs::remove_file(&sqlite_path);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn migration_status_baseline_and_capture_guards() {
    common::with_db(
        "migration_status_baseline_and_capture_guards",
        "rr2a_mig",
        false,
        2,
        |db| async move {
            let only = common::scoped_search_path(&db.url, &db.name);
            assert!(common::migrations_dir().join("0001_baseline.sql").is_file());
            let mut scratch = PgConnection::connect(&only)
                .await
                .map_err(|err| err.to_string())?;
            common::apply_file(&mut scratch, "SELECT 1").await?;
            drop(scratch);
            match memory::migration_status(&only)
                .await
                .map_err(|err| err.to_string())?
            {
                memory::MigrationStatus::MissingTable => {}
                memory::MigrationStatus::Empty => {
                    return Err("expected missing migrations table".to_string());
                }
                memory::MigrationStatus::Applied(_) => {
                    return Err("expected missing migrations table".to_string());
                }
            }
            let mut client = PgMigrate {
                conn: PgConnection::connect(&only)
                    .await
                    .map_err(|err| err.to_string())?,
            };
            memory::apply_session_guards(&mut client, memory::MIGRATION_LOCK_TIMEOUT)
                .await
                .map_err(|err| err.to_string())?;
            let lock_timeout: String = sqlx::query_scalar("SHOW lock_timeout")
                .fetch_one(&mut client.conn)
                .await
                .map_err(|err| err.to_string())?;
            assert!(
                matches!(lock_timeout.as_str(), "3s" | "3000ms"),
                "{lock_timeout}"
            );
            memory::reset_session_guards(&mut client)
                .await
                .map_err(|err| err.to_string())?;
            memory::ensure_migrations_table(&mut client)
                .await
                .map_err(|err| err.to_string())?;
            drop(client);
            match memory::migration_status(&only)
                .await
                .map_err(|err| err.to_string())?
            {
                memory::MigrationStatus::Empty => {}
                memory::MigrationStatus::MissingTable => {
                    return Err("expected an empty migrations table".to_string());
                }
                memory::MigrationStatus::Applied(_) => {
                    return Err("expected an empty migrations table".to_string());
                }
            }
            memory::migrate_database(&only, true)
                .await
                .map_err(|err| err.to_string())?;
            let applied = memory::migration_status(&only)
                .await
                .map_err(|err| err.to_string())?;
            let memory::MigrationStatus::Applied(rows) = applied else {
                return Err("baseline did not record migrations".to_string());
            };
            let recorded: Vec<_> = rows.iter().map(|row| row.name.as_str()).collect();
            assert!(recorded.contains(&"0001_baseline.sql"));
            assert!(recorded.contains(&"0020_tag_removals.sql"));
            assert_eq!(rows.len(), memory::embedded_as_migrations().len());
            assert!(common::read_migration("0001_baseline.sql")?.contains("ros_conversations"));
            assert!(common::read_migration("0020_tag_removals.sql")?.contains("ros_tag"));
            let mut check = PgConnection::connect(&only)
                .await
                .map_err(|err| err.to_string())?;
            let conversations: Option<String> =
                sqlx::query_scalar("SELECT to_regclass('ros_conversations')::text")
                    .fetch_one(&mut check)
                    .await
                    .map_err(|err| err.to_string())?;
            assert!(conversations.as_deref().unwrap_or("").is_empty());
            let mut failing = PgMigrate { conn: check };
            let failed = memory::apply_migration(
                &mut failing,
                &memory::Migration {
                    name: "rr2a-fail.sql".to_string(),
                    path: "rr2a-fail.sql".to_string(),
                    sql: "SELECT definitely_missing_rr2a_column".to_string(),
                },
                |ms| async move {
                    if ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    }
                },
                &memory::MIGRATION_LOCK_BACKOFF_MS,
            )
            .await;
            assert!(failed.is_err());
            sqlx::query("SELECT 1")
                .execute(&mut failing.conn)
                .await
                .map_err(|err| err.to_string())?;

            let pool = memory::open_capture_pool(&db.scoped_url)
                .await
                .map_err(|err| err.to_string())?;
            let mut guarded = memory::checkout_capture(&pool)
                .await
                .map_err(|err| err.to_string())?;
            let idle: String = sqlx::query_scalar("SHOW idle_in_transaction_session_timeout")
                .fetch_one(&mut *guarded)
                .await
                .map_err(|err| err.to_string())?;
            let statement: String = sqlx::query_scalar("SHOW statement_timeout")
                .fetch_one(&mut *guarded)
                .await
                .map_err(|err| err.to_string())?;
            if !matches!(idle.as_str(), "30s" | "30000ms") {
                return Err(format!("idle timeout {idle}"));
            }
            if !matches!(statement.as_str(), "60s" | "1min" | "60000ms") {
                return Err(format!("statement timeout {statement}"));
            }
            drop(guarded);
            pool.close().await;
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn migrated_schema_reports_applied_names() {
    common::with_db(
        "migrated_schema_reports_applied_names",
        "rr2a_applied",
        true,
        2,
        |db| async move {
            let status = memory::migration_status(&db.scoped_url)
                .await
                .map_err(|err| err.to_string())?;
            let memory::MigrationStatus::Applied(rows) = status else {
                return Err("migrated schema has no migration table".to_string());
            };
            let names: Vec<_> = rows.iter().map(|row| row.name.as_str()).collect();
            assert!(names.contains(&"0001_baseline.sql"));
            assert!(names.contains(&"0020_tag_removals.sql"));
            assert!(names.len() >= 20);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn unimplemented_reads_and_borrowed_pool_close() {
    common::with_db(
        "unimplemented_reads_and_borrowed_pool_close",
        "rr2a_gap",
        true,
        2,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let agent = format!("gap-agent-{}", std::process::id());
            MemoryStore::append(
                &store,
                &entry(&format!("heartbeat:{agent}"), &agent, "HEARTBEAT_OK"),
            )
            .await
            .map_err(|err| err.to_string())?;
            MemoryStore::append(
                &store,
                &entry(
                    &format!("telegram-{agent}"),
                    &agent,
                    "This is a real user message for testing",
                ),
            )
            .await
            .map_err(|err| err.to_string())?;
            let recent =
                MemoryStore::get_session_history(&store, &format!("telegram-{agent}"), None)
                    .await
                    .map_err(|err| err.to_string())?;
            assert_eq!(recent.len(), 1);
            assert_eq!(recent[0].content, "This is a real user message for testing");
            assert!(
                !recent
                    .iter()
                    .any(|row| row.content.contains("HEARTBEAT_OK"))
            );
            let beat =
                MemoryStore::get_session_history(&store, &format!("heartbeat:{agent}"), None)
                    .await
                    .map_err(|err| err.to_string())?;
            assert_eq!(beat.len(), 1);
            assert_eq!(beat[0].content, "HEARTBEAT_OK");
            let search =
                MemoryStore::search(&store, "hello", &memory::SearchOptions::default()).await;
            assert!(matches!(
                search,
                Err(StoreError::NotYetImplemented("search"))
            ));
            let context =
                MemoryStore::get_context_for_turn(&store, "test query", &agent, None).await;
            assert!(matches!(
                context,
                Err(StoreError::NotYetImplemented("getContextForTurn"))
            ));
            let tags = MemoryStore::tags(&store).await;
            assert!(matches!(tags, Err(StoreError::NotYetImplemented("tags"))));
            assert_eq!(store.wiki(), None);
            store.close().await;
            assert!(store.is_healthy().await);
            let n: i32 = sqlx::query_scalar("SELECT 1")
                .fetch_one(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(n, 1);
            Ok(())
        },
    )
    .await;
}

#[test]
fn extension_skip_ignores_a_vector_mention() {
    assert!(common::skip_missing_extension(
        "extension \"vector\" is not available"
    ));
    assert!(common::skip_missing_extension(
        "could not open extension control file \"/usr/share/postgresql/16/extension/vector.control\""
    ));
    assert!(!common::skip_missing_extension(
        "column \"vector\" does not exist"
    ));
    assert!(!common::skip_missing_extension(
        "syntax error at or near \"vector\""
    ));
    assert!(!common::skip_missing_extension(
        "type \"pg_trgm\" does not exist"
    ));
}

#[tokio::test]
async fn advisory_lock_timeout_returns_the_connection() {
    common::with_db(
        "advisory_lock_timeout_returns_the_connection",
        "rr2a_lock",
        true,
        4,
        |db| async move {
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let key = format!("lock-{}", db.name);
            let mut holder = PgConnection::connect(&db.scoped_url)
                .await
                .map_err(|err| err.to_string())?;
            let pin = format!("SET search_path TO {}, public", db.name);
            sqlx::query(sqlx::AssertSqlSafe(pin.clone()))
                .execute(&mut holder)
                .await
                .map_err(|err| err.to_string())?;
            sqlx::query("BEGIN")
                .execute(&mut holder)
                .await
                .map_err(|err| err.to_string())?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(&key)
                .execute(&mut holder)
                .await
                .map_err(|err| err.to_string())?;
            let mut worker = PgConnection::connect(&db.scoped_url)
                .await
                .map_err(|err| err.to_string())?;
            sqlx::query(sqlx::AssertSqlSafe(pin))
                .execute(&mut worker)
                .await
                .map_err(|err| err.to_string())?;
            sqlx::query("SET statement_timeout = '500ms'")
                .execute(&mut worker)
                .await
                .map_err(|err| err.to_string())?;
            let failed = store
                .capture_on_connection(
                    &mut worker,
                    &batch(&key, "lock-agent", vec![msg("e1", "user", "held")]),
                    &CaptureOptions::default(),
                )
                .await;
            let message = failed.expect_err("lock timeout").to_string();
            assert!(
                message.contains("canceling statement due to statement timeout"),
                "{message}"
            );
            sqlx::query("SELECT 1")
                .execute(&mut worker)
                .await
                .map_err(|err| err.to_string())?;
            let mut held = Vec::new();
            for _ in 0..4 {
                let mut conn = db.pool.acquire().await.map_err(|err| err.to_string())?;
                sqlx::query("SET statement_timeout = '500ms'")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                held.push(conn);
            }
            drop(held);
            let blocked = IngestInput {
                session_id: key.clone(),
                messages: vec![IngestMessage {
                    role: "user".to_string(),
                    content: "blocked".to_string(),
                    created_at: None,
                    tool_calls: Vec::new(),
                }],
                source: None,
                agent: Some("lock-agent".to_string()),
                persona: None,
                channel: None,
                env: BTreeMap::new(),
            };
            let ingest_failed = MemoryStore::ingest_session(&store, &blocked).await;
            let ingest_message = ingest_failed.expect_err("ingest lock").to_string();
            assert!(
                ingest_message.contains("canceling statement due to statement timeout"),
                "{ingest_message}"
            );
            let mut check = db.pool.acquire().await.map_err(|err| err.to_string())?;
            sqlx::query("SELECT 1")
                .execute(&mut *check)
                .await
                .map_err(|err| err.to_string())?;
            drop(check);
            sqlx::query("ROLLBACK")
                .execute(&mut holder)
                .await
                .map_err(|err| err.to_string())?;
            store
                .capture_on_connection(
                    &mut worker,
                    &batch(&key, "lock-agent", vec![msg("e2", "user", "released")]),
                    &CaptureOptions::default(),
                )
                .await
                .map_err(|err| err.to_string())?;
            Ok(())
        },
    )
    .await;
}
