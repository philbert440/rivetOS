use std::collections::BTreeMap;

use memory::{MemoryEntry, MemoryStore, PostgresMemory};
use sqlx::{PgPool, Row};

mod common;

const SCRATCH_DDL: &str = r#"
CREATE TABLE ros_conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key   TEXT NOT NULL,
    agent         TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'unknown',
    channel_id    TEXT,
    bot_identity  TEXT,
    title         TEXT,
    settings      JSONB DEFAULT '{}'::jsonb,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ros_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ros_conversations(id) ON DELETE CASCADE,
    agent           TEXT NOT NULL,
    channel         TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    tool_name       TEXT,
    tool_args       JSONB,
    tool_result     TEXT,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ros_summaries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES ros_conversations(id),
    content         TEXT NOT NULL
);
CREATE TABLE ros_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID,
    session_key     TEXT
);
CREATE TABLE ros_wiki_provenance (
    topic_slug      TEXT NOT NULL,
    source_kind     TEXT NOT NULL CHECK (source_kind IN ('summary','message','conversation','task')),
    source_id       UUID NOT NULL,
    conversation_id UUID,
    PRIMARY KEY (topic_slug, source_kind, source_id)
);
"#;

const HISTORY_DDL: &str = r#"
CREATE TABLE ros_conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key   TEXT NOT NULL,
    agent         TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'unknown',
    title         TEXT,
    settings      JSONB DEFAULT '{}'::jsonb,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ros_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ros_conversations(id) ON DELETE CASCADE,
    agent           TEXT NOT NULL,
    channel         TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
"#;

const A_OLD: &str = "11111111-1111-1111-1111-111111111111";
const A_NEW: &str = "11111111-1111-1111-1111-111111111112";
const B_OLD: &str = "22222222-2222-2222-2222-222222222221";
const B_NEW: &str = "22222222-2222-2222-2222-222222222222";
const SOLO: &str = "44444444-4444-4444-4444-444444444444";
const SOLO_OTHER_AGENT: &str = "44444444-4444-4444-4444-444444444445";
const TASK: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_TASK: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

fn fixtures() -> String {
    format!(
        r#"
INSERT INTO ros_conversations (id, session_key, agent, channel, active, created_at, updated_at, title, settings)
VALUES ('{A_OLD}','sess-a','opus','unknown',   true, '2026-03-13 22:37:14+00','2026-03-13 22:37:14+00', NULL,          '{{}}'),
       ('{A_NEW}','sess-a','opus','telegram',  true, '2026-03-14 01:08:06+00','2026-03-14 01:08:07+00', 'Later title', '{{"k":1}}');
INSERT INTO ros_conversations (id, session_key, agent, channel, active, created_at, updated_at, title)
VALUES ('{B_OLD}','sess-b','rivet-hermes','hermes-telegram', false, '2026-05-23 21:40:18+00','2026-05-23 21:43:38+00','B old'),
       ('{B_NEW}','sess-b','rivet-hermes','hermes-telegram', true,  '2026-05-26 03:48:00+00','2026-05-26 03:48:00+00','B new');
INSERT INTO ros_conversations (id, session_key, agent, active, created_at, updated_at)
VALUES ('{SOLO}','sess-d','a4', true, '2026-02-01','2026-02-02');
INSERT INTO ros_conversations (id, session_key, agent)
VALUES ('{SOLO_OTHER_AGENT}','sess-d','a5');
INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
SELECT id, agent, 'c', 'user', 'm-' || id FROM ros_conversations;
INSERT INTO ros_summaries (conversation_id, content) SELECT id, 's-' || id FROM ros_conversations;
INSERT INTO ros_tasks (conversation_id) SELECT id FROM ros_conversations;
INSERT INTO ros_wiki_provenance (topic_slug, source_kind, source_id, conversation_id)
SELECT 'topic-x', 'summary', gen_random_uuid(), id FROM ros_conversations;
INSERT INTO ros_wiki_provenance (topic_slug, source_kind, source_id) VALUES
  ('topic-y','conversation','{A_OLD}'),
  ('topic-y','conversation','{A_NEW}'),
  ('topic-z','conversation','{B_NEW}');
"#
    )
}

fn task_fixtures() -> String {
    format!(
        r#"
INSERT INTO ros_conversations (id, session_key, agent, task_id, active) VALUES
  ('11111111-0000-4000-8000-000000000001', 'task:{TASK}',            'rivet-claude', NULL,          true),
  ('11111111-0000-4000-8000-000000000002', 'claude-code:spawn-two',   'rivet-claude', '{TASK}',     true),
  ('11111111-0000-4000-8000-000000000003', 'claude-code:spawn-three', 'rivet-claude', '{TASK}',     false),
  ('11111111-0000-4000-8000-000000000004', 'claude-code:unrelated',   'rivet-claude', '{OTHER_TASK}', true),
  ('11111111-0000-4000-8000-000000000005', 'task:{OTHER_TASK}',      'rivet-claude', NULL,          true);
INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at) VALUES
  ('11111111-0000-4000-8000-000000000001','rivet-claude','claude-code','user',     'legacy-1','2026-08-01 10:00:00+00'),
  ('11111111-0000-4000-8000-000000000002','rivet-claude','claude-code','assistant','canon-2', '2026-08-01 10:01:00+00'),
  ('11111111-0000-4000-8000-000000000001','rivet-claude','claude-code','assistant','legacy-3','2026-08-01 10:02:00+00'),
  ('11111111-0000-4000-8000-000000000003','rivet-claude','claude-code','user',     'canon-4', '2026-08-01 10:03:00+00'),
  ('11111111-0000-4000-8000-000000000004','rivet-claude','claude-code','user',     'other-task','2026-08-01 10:04:00+00'),
  ('11111111-0000-4000-8000-000000000005','rivet-claude','claude-code','user',     'other-legacy','2026-08-01 10:05:00+00');
"#
    )
}

fn strip_line_comments(sql: &str) -> String {
    sql.lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_word(sql: &str, word: &str) -> bool {
    sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|token| token.eq_ignore_ascii_case(word))
}

fn migration_names() -> Vec<String> {
    let mut names = Vec::new();
    let entries = std::fs::read_dir(common::migrations_dir()).unwrap();
    for entry in entries {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        if name.ends_with(".sql") {
            names.push(name);
        }
    }
    names.sort();
    names
}

async fn exec(pool: &PgPool, sql: &str) -> Result<(), String> {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

async fn seed_dedup(pool: &PgPool, sql: &[&str]) -> Result<(), String> {
    exec(pool, SCRATCH_DDL).await?;
    exec(pool, &fixtures()).await?;
    for stmt in sql {
        let mut conn = pool.acquire().await.map_err(|err| err.to_string())?;
        common::apply_file(&mut conn, stmt).await?;
    }
    Ok(())
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

async fn conversation_id(pool: &PgPool, session: &str, agent: &str) -> Result<String, String> {
    sqlx::query_scalar(
        "SELECT id::text FROM ros_conversations WHERE session_key = $1 AND agent = $2 ORDER BY created_at, id",
    )
    .bind(session)
    .bind(agent)
    .fetch_one(pool)
    .await
    .map_err(|err| err.to_string())
}

#[test]
fn conversation_dedup_files_match_the_typescript_shape() {
    let names = migration_names();
    let original = "0009_conversation_session_key_unique.sql";
    let locked = "0010_conversation_dedup_locked.sql";
    let task = "0011_conversation_task_id.sql";
    let original_at = names.iter().position(|name| name == original).unwrap();
    let locked_at = names.iter().position(|name| name == locked).unwrap();
    let task_at = names.iter().position(|name| name == task).unwrap();
    assert!(locked_at > original_at);
    assert!(task_at > locked_at);
    for name in [original, locked] {
        let sql = common::read_migration(name).unwrap();
        let start = sql
            .find("CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_conversations_session_agent")
            .unwrap();
        let end = sql[start..].find(';').unwrap();
        let stmt = &sql[start..start + end];
        assert!(stmt.contains("ON ros_conversations (session_key, agent)"));
        assert!(!stmt.contains("WHERE"));
        let delete_at = sql.find("DELETE FROM ros_conversations c").unwrap();
        let before = &sql[..delete_at];
        for table in [
            "ros_messages",
            "ros_summaries",
            "ros_tasks",
            "ros_wiki_provenance",
        ] {
            assert!(before.contains(&format!("UPDATE {table}")));
        }
        assert!(sql.contains("unhandled foreign key reference(s)"));
    }
    let locked_sql = common::read_migration(locked).unwrap();
    let lock_at = locked_sql
        .find("LOCK TABLE ros_conversations IN ACCESS EXCLUSIVE MODE;")
        .unwrap();
    assert!(locked_sql.find("CREATE TEMP TABLE").unwrap() > lock_at);
    assert!(locked_sql.contains("LOCK TABLE ros_tasks IN ACCESS EXCLUSIVE MODE"));
    assert!(locked_sql.contains("LOCK TABLE ros_wiki_provenance IN ACCESS EXCLUSIVE MODE"));
    assert!(locked_sql.contains("_ros_conv_dedup_map_0010"));
    assert!(!locked_sql.contains("_ros_conv_dedup_map "));
    let task_sql = common::read_migration(task).unwrap();
    assert!(task_sql.contains("ADD COLUMN IF NOT EXISTS task_id UUID;"));
    assert!(task_sql.contains(
        "CREATE INDEX IF NOT EXISTS idx_ros_conversations_task\n    ON ros_conversations (task_id, created_at)\n    WHERE task_id IS NOT NULL;"
    ));
    assert!(
        !task_sql
            .to_ascii_lowercase()
            .contains("references ros_tasks")
    );
    let body = strip_line_comments(&task_sql);
    assert!(!has_word(&body, "UPDATE"));
    assert!(!has_word(&body, "INSERT"));
    assert!(!has_word(&body, "DELETE"));
}

#[tokio::test]
async fn session_history_orders_ties_by_id() {
    common::with_db(
        "session_history_orders_ties_by_id",
        "rr2a_hist",
        false,
        4,
        |db| async move {
            exec(&db.pool, HISTORY_DDL).await?;
            exec(
                &db.pool,
                r#"
INSERT INTO ros_conversations (id, session_key, agent, active) VALUES
  ('33333333-0000-4000-8000-000000000001', 'claude-code:order-probe', 'rivet-claude', true);
INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at) VALUES
  ('33333333-0000-4000-8000-000000000001','rivet-claude','claude-code','user',     'turn-1','2026-08-01 10:00:00+00'),
  ('33333333-0000-4000-8000-000000000001','rivet-claude','claude-code','assistant','turn-2','2026-08-01 10:01:00+00');
INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at)
SELECT '33333333-0000-4000-8000-000000000001', 'rivet-claude', 'claude-code', 'user', 'tied-' || c,
       '2026-08-01 10:02:00+00'
  FROM generate_series(1, 5) AS c;
"#,
            )
            .await?;
            let tied: Vec<String> = sqlx::query_scalar(
                "SELECT content FROM ros_messages WHERE content LIKE 'tied-%' ORDER BY id ASC",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let mut runs = Vec::new();
            for _ in 0..3 {
                let history = MemoryStore::get_session_history(&store, "claude-code:order-probe", None)
                    .await
                    .map_err(|err| err.to_string())?;
                runs.push(
                    history
                        .into_iter()
                        .map(|row| row.content)
                        .collect::<Vec<_>>(),
                );
            }
            assert_eq!(runs[1], runs[0]);
            assert_eq!(runs[2], runs[0]);
            assert_eq!(&runs[0][..2], ["turn-1".to_string(), "turn-2".to_string()]);
            assert_eq!(runs[0][2..], tied);
            let limited = MemoryStore::get_session_history(&store, "claude-code:order-probe", Some(3))
                .await
                .map_err(|err| err.to_string())?;
            let limited: Vec<_> = limited.into_iter().map(|row| row.content).collect();
            assert_eq!(limited, tied[tied.len() - 3..]);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn task_history_unions_legacy_and_canonical() {
    common::with_db(
        "task_history_unions_legacy_and_canonical",
        "rr2a_task",
        false,
        4,
        |db| async move {
            let sql = common::read_migration("0011_conversation_task_id.sql")?;
            exec(&db.pool, HISTORY_DDL).await?;
            exec(&db.pool, &sql).await?;
            exec(&db.pool, &task_fixtures()).await?;
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let history = MemoryStore::get_task_history(&store, TASK, None)
                .await
                .map_err(|err| err.to_string())?;
            let contents: Vec<_> = history.iter().map(|row| row.content.as_str()).collect();
            let roles: Vec<_> = history.iter().map(|row| row.role.as_str()).collect();
            assert_eq!(contents, ["legacy-1", "canon-2", "legacy-3", "canon-4"]);
            assert_eq!(roles, ["user", "assistant", "assistant", "user"]);
            let legacy = MemoryStore::get_session_history(&store, &format!("task:{TASK}"), None)
                .await
                .map_err(|err| err.to_string())?;
            let legacy: Vec<_> = legacy
                .into_iter()
                .map(|row| row.content)
                .collect::<Vec<_>>();
            assert_eq!(legacy, ["legacy-1".to_string(), "legacy-3".to_string()]);
            assert!(!contents.contains(&"other-task"));
            assert!(!contents.contains(&"other-legacy"));
            let other = MemoryStore::get_task_history(&store, OTHER_TASK, None)
                .await
                .map_err(|err| err.to_string())?;
            let other: Vec<_> = other.into_iter().map(|row| row.content).collect::<Vec<_>>();
            assert_eq!(
                other,
                ["other-task".to_string(), "other-legacy".to_string()]
            );
            let limited = MemoryStore::get_task_history(&store, TASK, Some(2))
                .await
                .map_err(|err| err.to_string())?;
            let limited: Vec<_> = limited
                .into_iter()
                .map(|row| row.content)
                .collect::<Vec<_>>();
            assert_eq!(limited, ["legacy-3".to_string(), "canon-4".to_string()]);
            exec(
                &db.pool,
                r#"
INSERT INTO ros_messages (conversation_id, agent, channel, role, content, created_at)
SELECT ('11111111-0000-4000-8000-00000000000' || c)::uuid, 'rivet-claude', 'claude-code', 'user',
       'tied-' || c, '2026-08-01 11:00:00+00'
  FROM generate_series(1, 3) AS c;
"#,
            )
            .await?;
            let mut runs = Vec::new();
            for _ in 0..3 {
                let rows = MemoryStore::get_task_history(&store, TASK, None)
                    .await
                    .map_err(|err| err.to_string())?;
                runs.push(rows.into_iter().map(|row| row.content).collect::<Vec<_>>());
            }
            assert_eq!(runs[1], runs[0]);
            assert_eq!(runs[2], runs[0]);
            assert_eq!(
                &runs[0][..4],
                [
                    "legacy-1".to_string(),
                    "canon-2".to_string(),
                    "legacy-3".to_string(),
                    "canon-4".to_string()
                ]
            );
            let tied: Vec<String> = sqlx::query_scalar(
                "SELECT content FROM ros_messages WHERE content LIKE 'tied-%' ORDER BY id ASC",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(runs[0][4..], tied);
            exec(
                &db.pool,
                "DELETE FROM ros_messages WHERE content LIKE 'tied-%'",
            )
            .await?;
            let plain = MemoryStore::get_task_history(&store, "task-env-check", None)
                .await
                .map_err(|err| err.to_string())?;
            assert!(plain.is_empty());
            exec(&db.pool, &sql).await?;
            let again = MemoryStore::get_task_history(&store, TASK, None)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(again.len(), 4);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn task_history_before_task_id_column() {
    common::with_db(
        "task_history_before_task_id_column",
        "rr2a_pretask",
        false,
        4,
        |db| async move {
            exec(&db.pool, HISTORY_DDL).await?;
            exec(
                &db.pool,
                &format!(
                    r#"
INSERT INTO ros_conversations (id, session_key, agent)
VALUES ('22222222-0000-4000-8000-000000000001', 'task:{TASK}', 'rivet-claude');
INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
VALUES ('22222222-0000-4000-8000-000000000001','rivet-claude','claude-code','user','pre-migration');
"#
                ),
            )
            .await?;
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let before = MemoryStore::get_task_history(&store, TASK, None)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(
                before.into_iter().map(|row| row.content).collect::<Vec<_>>(),
                ["pre-migration".to_string()]
            );
            let sql = common::read_migration("0011_conversation_task_id.sql")?;
            exec(&db.pool, &sql).await?;
            exec(
                &db.pool,
                &format!(
                    r#"
INSERT INTO ros_conversations (id, session_key, agent, task_id)
VALUES ('22222222-0000-4000-8000-000000000002', 'claude-code:late', 'rivet-claude', '{TASK}');
INSERT INTO ros_messages (conversation_id, agent, channel, role, content)
VALUES ('22222222-0000-4000-8000-000000000002','rivet-claude','claude-code','assistant','post-migration');
"#
                ),
            )
            .await?;
            let after = MemoryStore::get_task_history(&store, TASK, None)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(
                after.into_iter().map(|row| row.content).collect::<Vec<_>>(),
                ["pre-migration".to_string(), "post-migration".to_string()]
            );
            Ok(())
        },
    )
    .await;
}

async fn child_counts(pool: &PgPool, table: &str) -> Result<BTreeMap<String, i64>, String> {
    let sql = format!(
        "SELECT conversation_id::text AS conversation_id, count(*)::bigint AS n FROM {table} GROUP BY 1 ORDER BY 1"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;
    let mut out = BTreeMap::new();
    for row in rows {
        let id: String = row
            .try_get("conversation_id")
            .map_err(|err| err.to_string())?;
        let n: i64 = row.try_get("n").map_err(|err| err.to_string())?;
        out.insert(id, n);
    }
    Ok(out)
}

fn expected_children() -> BTreeMap<String, i64> {
    BTreeMap::from([
        (A_OLD.to_string(), 2),
        (B_OLD.to_string(), 2),
        (SOLO.to_string(), 1),
        (SOLO_OTHER_AGENT.to_string(), 1),
    ])
}

#[tokio::test]
async fn dedup_0009_keeps_oldest_and_repoints() {
    common::with_db(
        "dedup_0009_keeps_oldest_and_repoints",
        "rr2a_d9",
        false,
        4,
        |db| async move {
            let sql = common::read_migration("0009_conversation_session_key_unique.sql")?;
            seed_dedup(&db.pool, &[sql.as_str()]).await?;
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT id::text FROM ros_conversations ORDER BY session_key, agent",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(ids, [A_OLD, B_OLD, SOLO, SOLO_OTHER_AGENT]);
            let row = sqlx::query("SELECT channel, title, settings FROM ros_conversations WHERE id = $1::uuid")
                .bind(A_OLD)
                .fetch_one(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            let channel: String = row.try_get("channel").map_err(|err| err.to_string())?;
            let title: String = row.try_get("title").map_err(|err| err.to_string())?;
            let settings: serde_json::Value = row.try_get("settings").map_err(|err| err.to_string())?;
            assert_eq!(channel, "telegram");
            assert_eq!(title, "Later title");
            assert_eq!(settings, serde_json::json!({"k": 1}));
            let row = sqlx::query(
                "SELECT active, created_at, updated_at, title FROM ros_conversations WHERE id = $1::uuid",
            )
            .bind(B_OLD)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let active: bool = row.try_get("active").map_err(|err| err.to_string())?;
            let created: chrono::DateTime<chrono::Utc> =
                row.try_get("created_at").map_err(|err| err.to_string())?;
            let updated: chrono::DateTime<chrono::Utc> =
                row.try_get("updated_at").map_err(|err| err.to_string())?;
            let title: String = row.try_get("title").map_err(|err| err.to_string())?;
            assert!(active);
            assert_eq!(
                created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "2026-05-23T21:40:18.000Z"
            );
            assert_eq!(
                updated.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "2026-05-26T03:48:00.000Z"
            );
            assert_eq!(title, "B old");
            for table in ["ros_messages", "ros_summaries", "ros_tasks"] {
                assert_eq!(child_counts(&db.pool, table).await?, expected_children());
            }
            let prov = sqlx::query(
                "SELECT conversation_id::text AS conversation_id, count(*)::bigint AS n FROM ros_wiki_provenance WHERE conversation_id IS NOT NULL GROUP BY 1",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let mut by_conv = BTreeMap::new();
            for row in prov {
                by_conv.insert(
                    row.try_get::<String, _>("conversation_id")
                        .map_err(|err| err.to_string())?,
                    row.try_get::<i64, _>("n").map_err(|err| err.to_string())?,
                );
            }
            assert_eq!(by_conv, expected_children());
            let kinds = sqlx::query(
                "SELECT topic_slug, source_id::text AS source_id FROM ros_wiki_provenance WHERE source_kind = 'conversation' ORDER BY topic_slug",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let mut seen = Vec::new();
            for row in kinds {
                seen.push((
                    row.try_get::<String, _>("topic_slug")
                        .map_err(|err| err.to_string())?,
                    row.try_get::<String, _>("source_id")
                        .map_err(|err| err.to_string())?,
                ));
            }
            assert_eq!(
                seen,
                [
                    ("topic-y".to_string(), A_OLD.to_string()),
                    ("topic-z".to_string(), B_OLD.to_string())
                ]
            );
            let dangling: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM (
                     SELECT conversation_id FROM ros_messages
                     UNION ALL SELECT conversation_id FROM ros_summaries
                     UNION ALL SELECT conversation_id FROM ros_tasks
                     UNION ALL SELECT conversation_id FROM ros_wiki_provenance
                   ) r WHERE r.conversation_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM ros_conversations c WHERE c.id = r.conversation_id)"#,
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(dangling, 0);
            let duplicate = sqlx::query(
                "INSERT INTO ros_conversations (session_key, agent) VALUES ('sess-d', 'a4')",
            )
            .execute(&db.pool)
            .await;
            let err = duplicate.expect_err("duplicate insert");
            assert_eq!(common::pg_code(&err).as_deref(), Some("23505"));
            sqlx::query("INSERT INTO ros_conversations (session_key, agent) VALUES ('sess-d', 'a6')")
                .execute(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            let before: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_conversations")
                .fetch_one(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            let mut conn = db.pool.acquire().await.map_err(|err| err.to_string())?;
            common::apply_file(&mut conn, &sql).await?;
            drop(conn);
            let after: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_conversations")
                .fetch_one(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(after, before);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn dedup_0010_without_0009_and_noop_after() {
    common::with_db(
        "dedup_0010_without_0009_and_noop_after",
        "rr2a_d10",
        false,
        4,
        |db| async move {
            let original = common::read_migration("0009_conversation_session_key_unique.sql")?;
            let locked = common::read_migration("0010_conversation_dedup_locked.sql")?;
            seed_dedup(&db.pool, &[locked.as_str()]).await?;
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT id::text FROM ros_conversations ORDER BY session_key, agent",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(ids, [A_OLD, B_OLD, SOLO, SOLO_OTHER_AGENT]);
            let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_messages")
                .fetch_one(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            assert_eq!(messages, 6);
            let dangling: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_messages m WHERE NOT EXISTS (SELECT 1 FROM ros_conversations c WHERE c.id = m.conversation_id)",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(dangling, 0);
            let indexes: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = $1 AND indexname = 'ux_ros_conversations_session_agent'",
            )
            .bind(&db.name)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(indexes, 1);

            exec(&db.pool, &format!("DROP SCHEMA {} CASCADE", db.name)).await?;
            exec(&db.pool, &format!("CREATE SCHEMA {}", db.name)).await?;
            seed_dedup(&db.pool, &[original.as_str(), locked.as_str()]).await?;
            let before = dedup_counts(&db.pool).await?;
            assert_eq!(before.0, 4);
            for _ in 0..2 {
                let mut conn = db.pool.acquire().await.map_err(|err| err.to_string())?;
                common::apply_file(&mut conn, &locked).await?;
            }
            assert_eq!(dedup_counts(&db.pool).await?, before);
            Ok(())
        },
    )
    .await;
}

async fn dedup_counts(pool: &PgPool) -> Result<(i64, i64, i64, i64), String> {
    let conversations: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_conversations")
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?;
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_messages")
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?;
    let summaries: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_summaries")
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?;
    let provenance: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_wiki_provenance")
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?;
    Ok((conversations, messages, summaries, provenance))
}

fn split_at_delete(sql: &str) -> Result<(&str, &str), String> {
    let cut = sql
        .find("DELETE FROM ros_conversations c")
        .ok_or_else(|| "DELETE cut missing".to_string())?;
    Ok((&sql[..cut], &sql[cut..]))
}

#[tokio::test]
async fn dedup_0009_cascade_deletes_racing_write() {
    common::with_db(
        "dedup_0009_cascade_deletes_racing_write",
        "rr2a_race9",
        false,
        4,
        |db| async move {
            let sql = common::read_migration("0009_conversation_session_key_unique.sql")?;
            let (head, tail) = split_at_delete(&sql)?;
            seed_dedup(&db.pool, &[]).await?;
            let mut migrator = db.pool.acquire().await.map_err(|err| err.to_string())?;
            let mut writer = db.pool.acquire().await.map_err(|err| err.to_string())?;
            sqlx::query("BEGIN")
                .execute(&mut *migrator)
                .await
                .map_err(|err| err.to_string())?;
            let raced = async {
                sqlx::raw_sql(sqlx::AssertSqlSafe(head.to_string()))
                    .execute(&mut *migrator)
                    .await
                    .map_err(|err| err.to_string())?;
                sqlx::query(
                    "INSERT INTO ros_messages (conversation_id, agent, channel, role, content) VALUES ($1::uuid, 'opus', 'c', 'user', 'racing capture write')",
                )
                .bind(A_NEW)
                .execute(&mut *writer)
                .await
                .map_err(|err| err.to_string())?;
                sqlx::raw_sql(sqlx::AssertSqlSafe(tail.to_string()))
                    .execute(&mut *migrator)
                    .await
                    .map_err(|err| err.to_string())?;
                sqlx::query("COMMIT")
                    .execute(&mut *migrator)
                    .await
                    .map_err(|err| err.to_string())?;
                Ok::<(), String>(())
            }
            .await;
            if raced.is_err() {
                let _ = sqlx::query("ROLLBACK").execute(&mut *migrator).await;
            }
            raced?;
            let survived: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_messages WHERE content = 'racing capture write'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(survived, 0);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn dedup_0010_blocks_racing_write() {
    common::with_db(
        "dedup_0010_blocks_racing_write",
        "rr2a_race10",
        false,
        4,
        |db| async move {
            let sql = common::read_migration("0010_conversation_dedup_locked.sql")?;
            let (head, _) = split_at_delete(&sql)?;
            seed_dedup(&db.pool, &[]).await?;
            let mut migrator = db.pool.acquire().await.map_err(|err| err.to_string())?;
            let mut writer = db.pool.acquire().await.map_err(|err| err.to_string())?;
            sqlx::query("BEGIN")
                .execute(&mut *migrator)
                .await
                .map_err(|err| err.to_string())?;
            let raced = async {
                sqlx::raw_sql(sqlx::AssertSqlSafe(head.to_string()))
                    .execute(&mut *migrator)
                    .await
                    .map_err(|err| err.to_string())?;
                sqlx::raw_sql(sqlx::AssertSqlSafe(
                    "SET statement_timeout = '1500ms'".to_string(),
                ))
                .execute(&mut *writer)
                .await
                .map_err(|err| err.to_string())?;
                let inserted = sqlx::query(
                    "INSERT INTO ros_messages (conversation_id, agent, channel, role, content) VALUES ($1::uuid, 'opus', 'c', 'user', 'racing capture write')",
                )
                .bind(A_NEW)
                .execute(&mut *writer)
                .await;
                let err = inserted.expect_err("lock wait");
                assert_eq!(common::pg_code(&err).as_deref(), Some("57014"));
                let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM ros_messages")
                    .fetch_one(&mut *writer)
                    .await
                    .map_err(|err| err.to_string())?;
                assert!(visible > 0);
                Ok::<(), String>(())
            }
            .await;
            let _ = sqlx::query("ROLLBACK").execute(&mut *migrator).await;
            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(
                "RESET statement_timeout".to_string(),
            ))
            .execute(&mut *writer)
            .await;
            raced
        },
    )
    .await;
}

#[tokio::test]
async fn ensure_conversation_upsert_under_unique_index() {
    common::with_db(
        "ensure_conversation_upsert_under_unique_index",
        "rr2a_ens",
        false,
        4,
        |db| async move {
            let sql = common::read_migration("0009_conversation_session_key_unique.sql")?;
            seed_dedup(&db.pool, &[sql.as_str()]).await?;
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            let first = entry("sess-race", "agent-race", "m1");
            let second = entry("sess-race", "agent-race", "m2");
            let third = entry("sess-race", "agent-race", "m3");
            let fourth = entry("sess-race", "agent-race", "m4");
            let (a, b, c, d) = tokio::join!(
                MemoryStore::append(&store, &first),
                MemoryStore::append(&store, &second),
                MemoryStore::append(&store, &third),
                MemoryStore::append(&store, &fourth),
            );
            a.map_err(|err| err.to_string())?;
            b.map_err(|err| err.to_string())?;
            c.map_err(|err| err.to_string())?;
            d.map_err(|err| err.to_string())?;
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_conversations WHERE session_key = 'sess-race' AND agent = 'agent-race'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(n, 1);
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT conversation_id::text FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = 'sess-race'",
            )
            .fetch_all(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(ids.len(), 1);

            MemoryStore::append(&store, &entry("sess-resume", "agent-resume", "first"))
                .await
                .map_err(|err| err.to_string())?;
            let first = conversation_id(&db.pool, "sess-resume", "agent-resume").await?;
            sqlx::query("UPDATE ros_conversations SET active = false WHERE id = $1::uuid")
                .bind(&first)
                .execute(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            MemoryStore::append(&store, &entry("sess-resume", "agent-resume", "second"))
                .await
                .map_err(|err| err.to_string())?;
            let second = conversation_id(&db.pool, "sess-resume", "agent-resume").await?;
            assert_eq!(second, first);
            let active: bool = sqlx::query_scalar(
                "SELECT active FROM ros_conversations WHERE id = $1::uuid",
            )
            .bind(&first)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert!(active);

            MemoryStore::append(&store, &entry("sess-shared", "agent-one", "a"))
                .await
                .map_err(|err| err.to_string())?;
            MemoryStore::append(&store, &entry("sess-shared", "agent-two", "b"))
                .await
                .map_err(|err| err.to_string())?;
            let one = conversation_id(&db.pool, "sess-shared", "agent-one").await?;
            let two = conversation_id(&db.pool, "sess-shared", "agent-two").await?;
            assert_ne!(one, two);
            Ok(())
        },
    )
    .await;
}

#[tokio::test]
async fn ensure_conversation_switches_and_legacy_forks() {
    common::with_db(
        "ensure_conversation_switches_and_legacy_forks",
        "rr2a_ens2",
        false,
        4,
        |db| async move {
            exec(&db.pool, SCRATCH_DDL).await?;
            let store = PostgresMemory::from_pool(db.pool.clone(), false);
            MemoryStore::append(&store, &entry("sess-midflight", "agent-midflight", "first"))
                .await
                .map_err(|err| err.to_string())?;
            let first = conversation_id(&db.pool, "sess-midflight", "agent-midflight").await?;
            let locked = common::read_migration("0010_conversation_dedup_locked.sql")?;
            let mut conn = db.pool.acquire().await.map_err(|err| err.to_string())?;
            common::apply_file(&mut conn, &locked).await?;
            drop(conn);
            sqlx::query("UPDATE ros_conversations SET active = false WHERE id = $1::uuid")
                .bind(&first)
                .execute(&db.pool)
                .await
                .map_err(|err| err.to_string())?;
            MemoryStore::append(
                &store,
                &entry("sess-midflight", "agent-midflight", "second"),
            )
            .await
            .map_err(|err| err.to_string())?;
            let second = conversation_id(&db.pool, "sess-midflight", "agent-midflight").await?;
            assert_eq!(second, first);
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_conversations WHERE session_key = 'sess-midflight'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(n, 1);

            sqlx::raw_sql(sqlx::AssertSqlSafe(
                "DROP INDEX ux_ros_conversations_session_agent".to_string(),
            ))
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            let legacy = PostgresMemory::from_pool(db.pool.clone(), false);
            MemoryStore::append(&legacy, &entry("sess-legacy", "agent-legacy", "one"))
                .await
                .map_err(|err| err.to_string())?;
            let again = MemoryStore::append(&legacy, &entry("sess-legacy", "agent-legacy", "two"))
                .await
                .map_err(|err| err.to_string())?;
            let first_legacy = conversation_id(&db.pool, "sess-legacy", "agent-legacy").await?;
            let shared: String = sqlx::query_scalar(
                "SELECT conversation_id::text FROM ros_messages WHERE id = $1::uuid",
            )
            .bind(&again)
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(shared, first_legacy);
            sqlx::query(
                "UPDATE ros_conversations SET active = false WHERE session_key = 'sess-legacy'",
            )
            .execute(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            MemoryStore::append(&legacy, &entry("sess-legacy", "agent-legacy", "three"))
                .await
                .map_err(|err| err.to_string())?;
            let forked: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM ros_conversations WHERE session_key = 'sess-legacy'",
            )
            .fetch_one(&db.pool)
            .await
            .map_err(|err| err.to_string())?;
            assert_eq!(forked, 2);
            Ok(())
        },
    )
    .await;
}
