use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Map, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgConnection, PgPool, Row};

use crate::cowork::{pick_cowork_hook_rewrite, CoworkHookRow};
use crate::error::{now_ms, StoreError};
use crate::get_full::{
    extract_full_from_line, file_missing_message, is_capture_sqlite_path, is_capture_transcript_path,
    missing_pointer_message, path_exists, read_jsonl_line, read_opencode_part, render_extracted,
    render_stored_row,
};
use crate::project::{plan_project_rule_tag, ProjectHit};
use crate::report::{
    assemble_stats, browse_sql, compaction_sql, embedding_probe_reason, en_us, fmt_date,
    fmt_queue_age, format_embedding_queue, format_js_iso, format_queue_health, format_unsummarized,
    health_cached, history_limit, is_missing_schema_code, time_since, QueueRow, EMBEDDING_HEALTH_SQL,
    FULL_WINDOW, IDLE_MINUTES, MIN_BATCH_SIZE, OWNER_COLUMN_PROBE_SQL, QUEUE_HEALTH_SQL,
    STALE_MIN_BATCH, STALE_MINUTES,
};
use crate::slug::{normalize_tag_key, normalize_tag_value, PROJECT_RULE_NAME};
use crate::store::{
    BrowseFilter, CaptureBatch, CaptureMessage, CaptureOptions, CaptureResult, HealthReport,
    HistoryMessage, IngestInput, IngestOutput, MemoryEntry, MemoryStore, ProjectChoice, SearchOptions,
    StatsReport, ToolDescriptor,
};
use crate::text::{capture_cap, ingest_event_id, resolve_memory_write_tags, truncate_content};
use crate::window::apply_window_args;
use crate::writers::{append_result_value, prepare_append};

const POOL_MAX: u32 = 5;

fn db_message(err: &sqlx::Error) -> String {
    err.as_database_error()
        .map(|db| db.message().to_string())
        .unwrap_or_else(|| err.to_string())
}

fn query_failed(err: sqlx::Error) -> StoreError {
    let message = db_message(&err);
    StoreError::Memory {
        code: protocol::MemoryErrorCode::MemoryQueryFailed,
        message: message.clone(),
        cause: Some(message),
    }
}

fn append_failed(err: sqlx::Error) -> StoreError {
    StoreError::query(db_message(&err))
}

fn connect_failed(err: sqlx::Error) -> StoreError {
    eprintln!("[PostgresMemory] Pool error: {err}");
    StoreError::connection(err)
}

fn missing_schema(err: &sqlx::Error) -> bool {
    let code = err.as_database_error().and_then(|db| db.code().map(|c| c.to_string()));
    is_missing_schema_code(code.as_deref())
}

fn missing_tag_tables(message: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)relation "?ros_tag[a-z_]*"? does not exist"#).ok())
        .as_ref()
        .is_some_and(|re| re.is_match(message))
}

fn permission_denied(message: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)EACCES|EPERM|permission denied").ok())
        .as_ref()
        .is_some_and(|re| re.is_match(message))
}

fn spool_name(name: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d+-[^/]+\.json$").ok())
        .as_ref()
        .is_some_and(|re| re.is_match(name))
}

pub fn capture_conversation_upsert_sql(owner: bool) -> &'static str {
    if owner {
        "INSERT INTO ros_conversations (session_key, agent, channel, title, settings, task_id, created_at, updated_at, owner_user_id)
       VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()), $12)
       ON CONFLICT (session_key, agent) DO UPDATE SET
         updated_at = GREATEST(ros_conversations.updated_at, EXCLUDED.updated_at),
         owner_user_id = COALESCE(ros_conversations.owner_user_id, EXCLUDED.owner_user_id),
         title = CASE WHEN $7 THEN EXCLUDED.title ELSE ros_conversations.title END,
         settings = CASE WHEN $8 THEN EXCLUDED.settings ELSE ros_conversations.settings END,
         task_id = CASE WHEN $9 THEN EXCLUDED.task_id ELSE ros_conversations.task_id END
       RETURNING id"
    } else {
        "INSERT INTO ros_conversations (session_key, agent, channel, title, settings, task_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()))
       ON CONFLICT (session_key, agent) DO UPDATE SET
         updated_at = GREATEST(ros_conversations.updated_at, EXCLUDED.updated_at),
         title = CASE WHEN $7 THEN EXCLUDED.title ELSE ros_conversations.title END,
         settings = CASE WHEN $8 THEN EXCLUDED.settings ELSE ros_conversations.settings END,
         task_id = CASE WHEN $9 THEN EXCLUDED.task_id ELSE ros_conversations.task_id END
       RETURNING id"
    }
}

pub fn capture_message_insert_sql(owner: bool) -> &'static str {
    if owner {
        "INSERT INTO ros_messages
          (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, COALESCE($10::timestamptz, now()), $11)"
    } else {
        "INSERT INTO ros_messages
          (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, COALESCE($10::timestamptz, now()))"
    }
}

fn ensure_upsert_sql(owner: bool) -> &'static str {
    if owner {
        "INSERT INTO ros_conversations
           (session_key, agent, channel, title, created_at, updated_at, owner_user_id)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)
         ON CONFLICT (session_key, agent) DO UPDATE
           SET updated_at = NOW(), active = true, owner_user_id = COALESCE(ros_conversations.owner_user_id, EXCLUDED.owner_user_id)
         RETURNING id"
    } else {
        "INSERT INTO ros_conversations
           (session_key, agent, channel, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (session_key, agent) DO UPDATE
           SET updated_at = NOW(), active = true
         RETURNING id"
    }
}

fn ensure_insert_sql(owner: bool) -> &'static str {
    if owner {
        "INSERT INTO ros_conversations
         (session_key, agent, channel, title, created_at, updated_at, owner_user_id)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)
       RETURNING id"
    } else {
        "INSERT INTO ros_conversations
         (session_key, agent, channel, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id"
    }
}

fn append_insert_sql(owner: bool) -> &'static str {
    if owner {
        "INSERT INTO ros_messages
           (conversation_id, agent, channel, role, content,
            tool_name, tool_args, tool_result, metadata, created_at, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()), $11)
         RETURNING id"
    } else {
        "INSERT INTO ros_messages
           (conversation_id, agent, channel, role, content,
            tool_name, tool_args, tool_result, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))
         RETURNING id"
    }
}

fn parse_timestamptz(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw).ok().map(|dt| dt.with_timezone(&Utc))
}

fn parse_ordinal(raw: &str) -> Option<i64> {
    let mut chars = raw.chars().peekable();
    let neg = chars.peek() == Some(&'-');
    if neg {
        chars.next();
    }
    let mut digits = String::new();
    for ch in chars {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    let value: i64 = digits.parse().ok()?;
    Some(if neg { -value } else { value })
}

fn json_index(value: &Value) -> Option<usize> {
    if let Some(n) = value.as_u64() {
        return usize::try_from(n).ok();
    }
    if let Some(n) = value.as_i64() {
        return usize::try_from(n).ok();
    }
    let n = value.as_f64()?;
    if n.is_finite() && n >= 0.0 && n.fract() == 0.0 {
        usize::try_from(n as u64).ok()
    } else {
        None
    }
}

fn i64_cell(value: &str) -> i64 {
    value.parse().unwrap_or(0)
}

pub struct PostgresMemory {
    pool: PgPool,
    owns_pool: bool,
    user_id: Option<String>,
    embed_endpoint: Option<String>,
    owner_column: AtomicBool,
    unique_index: AtomicBool,
    task_id_column: AtomicBool,
    tags_warned: AtomicBool,
    last_probe_ms: AtomicI64,
    last_connected: AtomicBool,
    last_bump_log_ms: AtomicI64,
}

impl PostgresMemory {
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(POOL_MAX)
            .acquire_timeout(Duration::from_secs(10))
            .idle_timeout(Duration::from_secs(30))
            .connect(url)
            .await
            .map_err(connect_failed)?;
        let mut memory = Self::from_pool(pool, true);
        if let Ok(endpoint) = std::env::var("RIVETOS_EMBED_URL") {
            memory.embed_endpoint = Some(endpoint);
        }
        Ok(memory)
    }

    pub fn from_pool(pool: PgPool, owns_pool: bool) -> Self {
        Self {
            pool,
            owns_pool,
            user_id: None,
            embed_endpoint: None,
            owner_column: AtomicBool::new(false),
            unique_index: AtomicBool::new(false),
            task_id_column: AtomicBool::new(false),
            tags_warned: AtomicBool::new(false),
            last_probe_ms: AtomicI64::new(0),
            last_connected: AtomicBool::new(false),
            last_bump_log_ms: AtomicI64::new(0),
        }
    }

    pub fn with_user_id(mut self, user_id: impl Into<String>) -> Self {
        self.user_id = Some(user_id.into());
        self
    }

    pub fn with_embed_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.embed_endpoint = Some(endpoint.into());
        self
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn close(&self) {
        if self.owns_pool {
            self.pool.close().await;
        }
    }

    pub async fn is_healthy(&self) -> bool {
        let now = now_ms();
        if let Some(hit) = health_cached(
            now,
            self.last_probe_ms.load(Ordering::Relaxed),
            self.last_connected.load(Ordering::Relaxed),
        ) {
            return hit;
        }
        let ok = sqlx::query("SELECT 1").execute(&self.pool).await.is_ok();
        self.last_probe_ms.store(now, Ordering::Relaxed);
        self.last_connected.store(ok, Ordering::Relaxed);
        ok
    }

    async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<sqlx::Postgres>, StoreError> {
        self.pool.acquire().await.map_err(connect_failed)
    }

    pub async fn bump_access(&self, message_ids: &[uuid::Uuid], summary_ids: &[uuid::Uuid]) {
        let outcome = async {
            if !message_ids.is_empty() {
                sqlx::query(
                    "UPDATE ros_messages
           SET access_count = access_count + 1, last_accessed_at = NOW()
           WHERE id = ANY($1::uuid[])",
                )
                .bind(message_ids)
                .execute(&self.pool)
                .await?;
            }
            if !summary_ids.is_empty() {
                sqlx::query(
                    "UPDATE ros_summaries
           SET access_count = access_count + 1, last_accessed_at = NOW()
           WHERE id = ANY($1::uuid[])",
                )
                .bind(summary_ids)
                .execute(&self.pool)
                .await?;
            }
            Ok::<(), sqlx::Error>(())
        }
        .await;
        if let Err(err) = outcome {
            let now = now_ms();
            let last = self.last_bump_log_ms.load(Ordering::Relaxed);
            if now.saturating_sub(last) >= 60_000 {
                eprintln!("[memory-search] access bump skipped: {err}");
                self.last_bump_log_ms.store(now, Ordering::Relaxed);
            }
        }
    }

    async fn owner_id(&self, conn: &mut PgConnection) -> Result<Option<String>, StoreError> {
        let Some(id) = self.user_id.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        if self.owner_present(conn).await? {
            Ok(Some(id.to_string()))
        } else {
            Ok(None)
        }
    }

    async fn owner_present(&self, conn: &mut PgConnection) -> Result<bool, StoreError> {
        if self.owner_column.load(Ordering::Relaxed) {
            return Ok(true);
        }
        let n: i32 = sqlx::query_scalar(OWNER_COLUMN_PROBE_SQL)
            .fetch_one(&mut *conn)
            .await
            .map_err(query_failed)?;
        if n == 2 {
            self.owner_column.store(true, Ordering::Relaxed);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn unique_present(&self, conn: &mut PgConnection) -> Result<bool, StoreError> {
        if self.unique_index.load(Ordering::Relaxed) {
            return Ok(true);
        }
        let present: bool = sqlx::query_scalar(
            "SELECT to_regclass('ux_ros_conversations_session_agent') IS NOT NULL",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(query_failed)?;
        if present {
            self.unique_index.store(true, Ordering::Relaxed);
        }
        Ok(present)
    }

    async fn task_column_present(&self, conn: &mut PgConnection) -> Result<bool, StoreError> {
        if self.task_id_column.load(Ordering::Relaxed) {
            return Ok(true);
        }
        let present: bool = sqlx::query_scalar(
            "SELECT EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('ros_conversations')
            AND attname = 'task_id'
            AND NOT attisdropped
       )",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(query_failed)?;
        if present {
            self.task_id_column.store(true, Ordering::Relaxed);
        }
        Ok(present)
    }

    pub async fn capture_on_connection(
        &self,
        conn: &mut PgConnection,
        batch: &CaptureBatch,
        options: &CaptureOptions,
    ) -> Result<CaptureResult, StoreError> {
        let (allow_filesystem, disabled) = match options.project {
            ProjectChoice::Disabled => (false, true),
            ProjectChoice::BasenameOnly => (false, false),
            ProjectChoice::Default => (options.allow_filesystem, false),
        };
        let project = plan_project_rule_tag(
            batch.settings.as_ref(),
            allow_filesystem,
            disabled,
            batch.channel.as_deref(),
        );
        sqlx::query("BEGIN").execute(&mut *conn).await.map_err(query_failed)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(&batch.session_key)
            .execute(&mut *conn)
            .await
            .map_err(query_failed)?;
        let outcome = self.capture_locked(conn, batch, options, project.as_ref()).await;
        if outcome.is_err() {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
        }
        outcome
    }

    async fn capture_locked(
        &self,
        conn: &mut PgConnection,
        batch: &CaptureBatch,
        options: &CaptureOptions,
        project: Option<&ProjectHit>,
    ) -> Result<CaptureResult, StoreError> {
        let wanted = options
            .owner_user_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let owner = if wanted.is_some() && self.owner_present(conn).await? {
            wanted
        } else {
            None
        };
        let channel = batch.channel.as_deref().unwrap_or("unknown");
        let settings = batch.settings.as_ref().map(|map| Value::Object(map.clone()));
        let conversation_id = self
            .insert_capture_conversation(conn, batch, channel, settings.as_ref(), owner.as_deref())
            .await?;
        if let Some(hit) = project {
            self.apply_project_rule(conn, conversation_id, hit).await;
        }
        let mut event_ids = self.existing_event_ids(conn, conversation_id, batch).await?;
        let mut hook_rows = Vec::new();
        let needs_hook = batch.messages.iter().any(|message| {
            message.metadata.as_ref().and_then(|meta| meta.get("source")).and_then(Value::as_str)
                == Some("cowork-transcript")
                && (message.role == "user" || message.role == "assistant")
        });
        if needs_hook {
            hook_rows = self.hook_rows(conn, conversation_id).await?;
        }
        let mut consumed = Vec::new();
        let mut inserted: u64 = 0;
        for message in &batch.messages {
            if self
                .capture_one(
                    conn,
                    batch,
                    conversation_id,
                    message,
                    channel,
                    owner.as_deref(),
                    &mut event_ids,
                    &hook_rows,
                    &mut consumed,
                )
                .await?
            {
                inserted += 1;
            }
        }
        if batch.finalize {
            sqlx::query(
                "UPDATE ros_conversations
            SET active=false,
                updated_at = GREATEST(updated_at, COALESCE($2::timestamptz, now()))
          WHERE id=$1 AND active=true",
            )
            .bind(conversation_id)
            .bind(batch.updated_at.as_deref())
            .execute(&mut *conn)
            .await
            .map_err(query_failed)?;
        }
        sqlx::query("COMMIT").execute(&mut *conn).await.map_err(query_failed)?;
        Ok(CaptureResult {
            ok: true,
            conversation_id: conversation_id.to_string(),
            inserted,
            skipped: u64::try_from(batch.messages.len()).unwrap_or(u64::MAX).saturating_sub(inserted),
        })
    }

    async fn insert_capture_conversation(
        &self,
        conn: &mut PgConnection,
        batch: &CaptureBatch,
        channel: &str,
        settings: Option<&Value>,
        owner: Option<&str>,
    ) -> Result<uuid::Uuid, StoreError> {
        let title_set = batch.title.is_some();
        let settings_set = batch.settings.is_some();
        let task_set = batch.task_id.is_some();
        if let Some(owner) = owner {
            sqlx::query_scalar(capture_conversation_upsert_sql(true))
                .bind(&batch.session_key)
                .bind(&batch.agent)
                .bind(channel)
                .bind(batch.title.as_deref())
                .bind(settings.cloned())
                .bind(batch.task_id.as_deref())
                .bind(title_set)
                .bind(settings_set)
                .bind(task_set)
                .bind(batch.created_at.as_deref())
                .bind(batch.updated_at.as_deref())
                .bind(owner)
                .fetch_one(&mut *conn)
                .await
                .map_err(query_failed)
        } else {
            sqlx::query_scalar(capture_conversation_upsert_sql(false))
                .bind(&batch.session_key)
                .bind(&batch.agent)
                .bind(channel)
                .bind(batch.title.as_deref())
                .bind(settings.cloned())
                .bind(batch.task_id.as_deref())
                .bind(title_set)
                .bind(settings_set)
                .bind(task_set)
                .bind(batch.created_at.as_deref())
                .bind(batch.updated_at.as_deref())
                .fetch_one(&mut *conn)
                .await
                .map_err(query_failed)
        }
    }

    async fn existing_event_ids(
        &self,
        conn: &mut PgConnection,
        conversation_id: uuid::Uuid,
        batch: &CaptureBatch,
    ) -> Result<HashSet<String>, StoreError> {
        let ids: Vec<String> = batch.messages.iter().map(|message| message.event_id.clone()).collect();
        let rows = sqlx::query(
            "SELECT metadata->>'event_id' AS event_id FROM ros_messages
      WHERE conversation_id = $1 AND metadata->>'event_id' = ANY($2::text[])",
        )
        .bind(conversation_id)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(query_failed)?;
        let mut out = HashSet::new();
        for row in rows {
            if let Ok(Some(id)) = row.try_get::<Option<String>, _>("event_id") {
                out.insert(id);
            }
        }
        Ok(out)
    }

    async fn hook_rows(
        &self,
        conn: &mut PgConnection,
        conversation_id: uuid::Uuid,
    ) -> Result<Vec<CoworkHookRow>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, role, content, metadata->>'event_id' AS hook_event_id
           FROM ros_messages
          WHERE conversation_id = $1
            AND role IN ('user', 'assistant')
            AND metadata->>'source' = 'cowork-hook'
          ORDER BY created_at, id",
        )
        .bind(conversation_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(query_failed)?;
        let mut out = Vec::new();
        for row in rows {
            let id: uuid::Uuid = row.try_get("id").map_err(query_failed)?;
            let role: String = row.try_get("role").map_err(query_failed)?;
            let content: String = row.try_get("content").map_err(query_failed)?;
            let event_id: Option<String> = row.try_get("hook_event_id").map_err(query_failed)?;
            out.push(CoworkHookRow {
                id: id.to_string(),
                role,
                content,
                event_id: event_id.unwrap_or_default(),
            });
        }
        Ok(out)
    }

    async fn capture_one(
        &self,
        conn: &mut PgConnection,
        batch: &CaptureBatch,
        conversation_id: uuid::Uuid,
        message: &CaptureMessage,
        channel: &str,
        owner: Option<&str>,
        event_ids: &mut HashSet<String>,
        hook_rows: &[CoworkHookRow],
        consumed: &mut Vec<String>,
    ) -> Result<bool, StoreError> {
        let mut metadata = message.metadata.clone().unwrap_or_default();
        metadata.insert("event_id".to_string(), Value::String(message.event_id.clone()));
        let content = capture_cap(&message.content, &mut metadata, "content");
        let tool_result = message
            .tool_result
            .as_ref()
            .map(|text| capture_cap(text, &mut metadata, "tool_result"));
        if event_ids.contains(&message.event_id) {
            if let Some(result) = tool_result.as_deref().filter(|text| !text.is_empty()) {
                metadata.insert("pending_result".to_string(), Value::Bool(false));
                sqlx::query(
                    "UPDATE ros_messages
                SET tool_result = $3,
                    content = $4,
                    metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
                    tool_name = COALESCE(tool_name, $6),
                    tool_args = COALESCE(tool_args, $7::jsonb)
              WHERE conversation_id = $1
                AND metadata->>'event_id' = $2
                AND (tool_result IS NULL OR tool_result = '')",
                )
                .bind(conversation_id)
                .bind(&message.event_id)
                .bind(result)
                .bind(&content)
                .bind(Value::Object(metadata))
                .bind(message.tool_name.as_deref())
                .bind(message.tool_args.clone())
                .execute(&mut *conn)
                .await
                .map_err(query_failed)?;
            }
            return Ok(false);
        }
        let source = message.metadata.as_ref().and_then(|meta| meta.get("source")).and_then(Value::as_str);
        let replaces = message
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("replaces_event_id"))
            .and_then(Value::as_str);
        if let Some(claim) = pick_cowork_hook_rewrite(&message.role, &content, source, replaces, hook_rows, consumed) {
            sqlx::query(
                "UPDATE ros_messages
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('event_id', $2::text, 'source', 'cowork-transcript')
            WHERE id = $1",
            )
            .bind(uuid::Uuid::parse_str(&claim.id).map_err(|err| StoreError::Request(err.to_string()))?)
            .bind(&message.event_id)
            .execute(&mut *conn)
            .await
            .map_err(query_failed)?;
            consumed.push(claim.id);
            event_ids.insert(message.event_id.clone());
            return Ok(false);
        }
        self.insert_capture_message(conn, batch, conversation_id, message, channel, owner, &content, tool_result.as_deref(), &metadata)
            .await?;
        event_ids.insert(message.event_id.clone());
        Ok(true)
    }

    async fn insert_capture_message(
        &self,
        conn: &mut PgConnection,
        _batch: &CaptureBatch,
        conversation_id: uuid::Uuid,
        message: &CaptureMessage,
        channel: &str,
        owner: Option<&str>,
        content: &str,
        tool_result: Option<&str>,
        metadata: &Map<String, Value>,
    ) -> Result<(), StoreError> {
        let meta = Value::Object(metadata.clone());
        if let Some(owner) = owner {
            sqlx::query(capture_message_insert_sql(true))
                .bind(conversation_id)
                .bind(&_batch.agent)
                .bind(channel)
                .bind(&message.role)
                .bind(content)
                .bind(message.tool_name.as_deref())
                .bind(message.tool_args.clone())
                .bind(tool_result)
                .bind(meta)
                .bind(message.created_at.as_deref())
                .bind(owner)
                .execute(&mut *conn)
                .await
                .map_err(query_failed)?;
        } else {
            sqlx::query(capture_message_insert_sql(false))
                .bind(conversation_id)
                .bind(&_batch.agent)
                .bind(channel)
                .bind(&message.role)
                .bind(content)
                .bind(message.tool_name.as_deref())
                .bind(message.tool_args.clone())
                .bind(tool_result)
                .bind(meta)
                .bind(message.created_at.as_deref())
                .execute(&mut *conn)
                .await
                .map_err(query_failed)?;
        }
        Ok(())
    }

    async fn apply_project_rule(&self, conn: &mut PgConnection, conversation_id: uuid::Uuid, hit: &ProjectHit) {
        let savepoint = sqlx::query("SAVEPOINT rivet_project_rule").execute(&mut *conn).await.is_ok();
        let wrote = async {
            let existing = sqlx::query(
                "SELECT 1 FROM ros_tags
        WHERE entity_type = 'conversation' AND entity_id = $1
          AND key = $2 AND (source = 'rule' OR proposed_by = $3)
        LIMIT 1",
            )
            .bind(conversation_id)
            .bind(&hit.key)
            .bind(PROJECT_RULE_NAME)
            .fetch_optional(&mut *conn)
            .await?;
            if existing.is_some() {
                return Ok::<bool, sqlx::Error>(false);
            }
            let vocab = sqlx::query(
                "SELECT value, display, state FROM ros_tag_taxonomy
          WHERE key = $1 AND (value = $2 OR $2 = ANY(aliases))
          ORDER BY (state = 'accepted') DESC, (value = $2) DESC, value
          LIMIT 1",
            )
            .bind(&hit.key)
            .bind(&hit.value)
            .fetch_optional(&mut *conn)
            .await?;
            let (value, display) = if let Some(row) = vocab {
                let state: String = row.try_get("state")?;
                if state == "rejected" {
                    return Ok(false);
                }
                let value: String = row.try_get("value")?;
                let display: String = row.try_get("display")?;
                if value != hit.value {
                    (value, display)
                } else {
                    (hit.value.clone(), hit.display.clone())
                }
            } else {
                (hit.value.clone(), hit.display.clone())
            };
            let result = sqlx::query(
                "INSERT INTO ros_tags
             (entity_type, entity_id, key, value, display, source, state,
              proposed_by, reason, decided_by, decided_at)
           VALUES ('conversation', $1, $2, $3, $4, 'rule', 'accepted', $5, $6, $5, now())
           ON CONFLICT (entity_type, entity_id, key, value) DO NOTHING",
            )
            .bind(conversation_id)
            .bind(&hit.key)
            .bind(&value)
            .bind(&display)
            .bind(PROJECT_RULE_NAME)
            .bind(&hit.reason)
            .execute(&mut *conn)
            .await?;
            Ok(result.rows_affected() > 0)
        }
        .await;
        match wrote {
            Ok(_) => {
                let _ = sqlx::query("RELEASE SAVEPOINT rivet_project_rule").execute(&mut *conn).await;
            }
            Err(err) => {
                if savepoint {
                    let _ = sqlx::query("ROLLBACK TO SAVEPOINT rivet_project_rule").execute(&mut *conn).await;
                    let _ = sqlx::query("RELEASE SAVEPOINT rivet_project_rule").execute(&mut *conn).await;
                }
                let message = db_message(&err);
                self.warn_project(&conversation_id.to_string(), &message);
            }
        }
    }

    fn warn_project(&self, conversation_id: &str, message: &str) {
        if missing_tag_tables(message) {
            if !self.tags_warned.swap(true, Ordering::Relaxed) {
                eprintln!("[memory] project rule tags are off: tag tables missing (apply migration 0019)");
            }
            return;
        }
        let prefix: String = conversation_id.chars().take(8).collect();
        eprintln!("[memory] project rule tag skipped for {prefix}: {message}");
    }

    pub async fn append_locked(
        &self,
        args: &Map<String, Value>,
        env: &std::collections::BTreeMap<String, String>,
    ) -> Result<Value, StoreError> {
        let prepared = prepare_append(args, env).map_err(StoreError::Request)?;
        let mut conn = self.acquire().await?;
        sqlx::query("BEGIN").execute(&mut *conn).await.map_err(append_failed)?;
        let outcome = async {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(&prepared.session_id)
                .execute(&mut *conn)
                .await
                .map_err(append_failed)?;
            let existing: Option<uuid::Uuid> = sqlx::query_scalar(
                "SELECT m.id
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE c.session_key = $1 AND c.agent = $2
              AND m.metadata->>'event_id' = $3
            LIMIT 1",
            )
            .bind(&prepared.session_id)
            .bind(&prepared.tags.agent)
            .bind(&prepared.event_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(append_failed)?;
            if let Some(id) = existing {
                sqlx::query("COMMIT").execute(&mut *conn).await.map_err(append_failed)?;
                return Ok(append_result_value(&prepared, &id.to_string(), true));
            }
            let entry = MemoryEntry {
                session_id: prepared.session_id.clone(),
                agent: prepared.tags.agent.clone(),
                channel: prepared.tags.channel.clone(),
                role: prepared.role.clone(),
                content: prepared.content.clone(),
                tool_name: prepared.tool_name.clone(),
                tool_args: prepared.tool_args.clone(),
                tool_result: prepared.tool_result.clone(),
                metadata: Some(prepared.metadata.clone()),
                created_at: None,
            };
            let id = self.append_in_tx(&mut conn, &entry).await?;
            sqlx::query("COMMIT").execute(&mut *conn).await.map_err(append_failed)?;
            Ok(append_result_value(&prepared, &id, false))
        }
        .await;
        if outcome.is_err() {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
        }
        outcome
    }

    async fn append_owned(&self, entry: &MemoryEntry) -> Result<String, StoreError> {
        let mut conn = self.acquire().await?;
        sqlx::query("BEGIN").execute(&mut *conn).await.map_err(append_failed)?;
        let outcome = self.append_in_tx(&mut conn, entry).await;
        match outcome {
            Ok(id) => match sqlx::query("COMMIT").execute(&mut *conn).await {
                Ok(_) => Ok(id),
                Err(err) => {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    Err(append_failed(err))
                }
            },
            Err(err) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(err)
            }
        }
    }

    async fn append_in_tx(&self, conn: &mut PgConnection, entry: &MemoryEntry) -> Result<String, StoreError> {
        let owner = self.owner_id(conn).await.map_err(|err| match err {
            StoreError::Memory { message, .. } => StoreError::query(message),
            other => other,
        })?;
        let conversation_id = self
            .ensure_conversation(conn, &entry.session_id, &entry.agent, &entry.channel, owner.as_deref())
            .await?;
        let metadata = entry.metadata.clone().map(Value::Object).unwrap_or_else(|| Value::Object(Map::new()));
        let created = match entry.created_at.as_deref() {
            Some(raw) => {
                Some(parse_timestamptz(raw).ok_or_else(|| StoreError::query(format!("invalid created_at: {raw}")))?)
            }
            None => None,
        };
        let id = self
            .insert_append_message(conn, conversation_id, entry, owner.as_deref(), &metadata, created)
            .await?;
        sqlx::query("UPDATE ros_conversations SET updated_at = NOW() WHERE id = $1")
            .bind(conversation_id)
            .execute(&mut *conn)
            .await
            .map_err(append_failed)?;
        if entry.role == "assistant"
            && protocol::js::js_trim(&entry.content).is_empty()
            && entry.tool_name.as_deref().is_some_and(|name| !name.is_empty())
        {
            if let Err(err) = sqlx::query(
                "SELECT graphile_worker.add_job(
               'synthesize-tool-call',
               json_build_object('messageId', $1::text),
               job_key := 'tool-synth-' || $1::text,
               job_key_mode := 'preserve_run_at',
               max_attempts := 3
             )",
            )
            .bind(&id)
            .execute(&mut *conn)
            .await
            {
                eprintln!("[PostgresMemory] Failed to enqueue tool-synth for msg {id}: {err}");
            }
        }
        Ok(id)
    }

    async fn insert_append_message(
        &self,
        conn: &mut PgConnection,
        conversation_id: uuid::Uuid,
        entry: &MemoryEntry,
        owner: Option<&str>,
        metadata: &Value,
        created: Option<DateTime<Utc>>,
    ) -> Result<String, StoreError> {
        let tool_args = entry.tool_args.clone().map(Value::Object);
        let id: uuid::Uuid = if let Some(owner) = owner {
            sqlx::query_scalar(append_insert_sql(true))
                .bind(conversation_id)
                .bind(&entry.agent)
                .bind(&entry.channel)
                .bind(&entry.role)
                .bind(&entry.content)
                .bind(entry.tool_name.as_deref())
                .bind(tool_args)
                .bind(entry.tool_result.as_deref())
                .bind(metadata)
                .bind(created)
                .bind(owner)
                .fetch_one(&mut *conn)
                .await
                .map_err(append_failed)?
        } else {
            sqlx::query_scalar(append_insert_sql(false))
                .bind(conversation_id)
                .bind(&entry.agent)
                .bind(&entry.channel)
                .bind(&entry.role)
                .bind(&entry.content)
                .bind(entry.tool_name.as_deref())
                .bind(tool_args)
                .bind(entry.tool_result.as_deref())
                .bind(metadata)
                .bind(created)
                .fetch_one(&mut *conn)
                .await
                .map_err(append_failed)?
        };
        Ok(id.to_string())
    }

    async fn ensure_conversation(
        &self,
        conn: &mut PgConnection,
        session_id: &str,
        agent: &str,
        channel: &str,
        owner: Option<&str>,
    ) -> Result<uuid::Uuid, StoreError> {
        let channel = if channel.is_empty() { "unknown" } else { channel };
        let title = format!("Session {session_id}");
        if self.unique_present(conn).await? {
            return if let Some(owner) = owner {
                sqlx::query_scalar(ensure_upsert_sql(true))
                    .bind(session_id)
                    .bind(agent)
                    .bind(channel)
                    .bind(&title)
                    .bind(owner)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(append_failed)
            } else {
                sqlx::query_scalar(ensure_upsert_sql(false))
                    .bind(session_id)
                    .bind(agent)
                    .bind(channel)
                    .bind(&title)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(append_failed)
            };
        }
        let existing: Option<uuid::Uuid> = sqlx::query_scalar(
            "SELECT id FROM ros_conversations
       WHERE session_key = $1 AND agent = $2 AND active = true
       ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(session_id)
        .bind(agent)
        .fetch_optional(&mut *conn)
        .await
        .map_err(append_failed)?;
        if let Some(id) = existing {
            if let Some(owner) = owner {
                sqlx::query(
                    "UPDATE ros_conversations SET owner_user_id = $2 WHERE id = $1 AND owner_user_id IS NULL",
                )
                .bind(id)
                .bind(owner)
                .execute(&mut *conn)
                .await
                .map_err(append_failed)?;
            }
            return Ok(id);
        }
        if let Some(owner) = owner {
            sqlx::query_scalar(ensure_insert_sql(true))
                .bind(session_id)
                .bind(agent)
                .bind(channel)
                .bind(&title)
                .bind(owner)
                .fetch_one(&mut *conn)
                .await
                .map_err(append_failed)
        } else {
            sqlx::query_scalar(ensure_insert_sql(false))
                .bind(session_id)
                .bind(agent)
                .bind(channel)
                .bind(&title)
                .fetch_one(&mut *conn)
                .await
                .map_err(append_failed)
        }
    }

    async fn ingest_in_pool(&self, input: &IngestInput) -> Result<IngestOutput, StoreError> {
        let session_id = protocol::js::js_trim(&input.session_id).to_string();
        if session_id.is_empty() {
            return Err(StoreError::Request("memory_ingest_session: session_id is required".to_string()));
        }
        if input.messages.is_empty() {
            return Err(StoreError::Request(
                "memory_ingest_session: messages must be a non-empty array".to_string(),
            ));
        }
        for message in &input.messages {
            if message.role.is_empty() {
                return Err(StoreError::Request(
                    "memory_ingest_session: role is required for each message".to_string(),
                ));
            }
            if !matches!(message.role.as_str(), "user" | "assistant" | "system" | "tool") {
                return Err(StoreError::Request("memory_ingest_session: invalid role".to_string()));
            }
        }
        let tags = resolve_memory_write_tags(
            input.source.as_deref(),
            input.agent.as_deref(),
            input.persona.as_deref(),
            input.channel.as_deref(),
            &input.env,
        );
        let mut conn = self.acquire().await?;
        sqlx::query("BEGIN").execute(&mut *conn).await.map_err(append_failed)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(&session_id)
            .execute(&mut *conn)
            .await
            .map_err(append_failed)?;
        let outcome = self.ingest_locked(&mut conn, input, &session_id, &tags).await;
        match &outcome {
            Ok(_) => {
                if let Err(err) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(append_failed(err));
                }
            }
            Err(_) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            }
        }
        outcome
    }

    async fn ingest_locked(
        &self,
        conn: &mut PgConnection,
        input: &IngestInput,
        session_id: &str,
        tags: &crate::text::MemoryWriteTags,
    ) -> Result<IngestOutput, StoreError> {
        let rows = sqlx::query(
            "SELECT m.metadata->>'ordinal' AS ordinal,
            m.metadata->>'event_id' AS event_id
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
      WHERE c.session_key = $1 AND c.agent = $2",
        )
        .bind(session_id)
        .bind(&tags.agent)
        .fetch_all(&mut *conn)
        .await
        .map_err(append_failed)?;
        let mut seen_ordinals = HashSet::new();
        let mut seen_events = HashSet::new();
        for row in rows {
            if let Ok(Some(ordinal)) = row.try_get::<Option<String>, _>("ordinal") {
                if let Some(n) = parse_ordinal(&ordinal) {
                    seen_ordinals.insert(n);
                }
            }
            if let Ok(Some(event_id)) = row.try_get::<Option<String>, _>("event_id") {
                seen_events.insert(event_id);
            }
        }
        let mut ids = Vec::new();
        let mut skipped: u64 = 0;
        let mut any_truncated = false;
        let mut max_full: u64 = 0;
        for (index, item) in input.messages.iter().enumerate() {
            let ordinal = i64::try_from(index).unwrap_or(i64::MAX);
            if item.content.is_empty() && item.tool_calls.is_empty() {
                skipped += 1;
                continue;
            }
            let tool_name = item.tool_calls.first().map(|call| call.name.clone());
            let event_id = ingest_event_id(
                session_id,
                &tags.agent,
                &item.role,
                &item.content,
                u64::try_from(index).unwrap_or(u64::MAX),
                tool_name.as_deref(),
            );
            if seen_events.contains(&event_id) {
                skipped += 1;
                seen_ordinals.insert(ordinal);
                continue;
            }
            if seen_ordinals.contains(&ordinal) {
                eprintln!(
                    "[ingestSession] Ordinal {index} already exists in session {session_id} but event_id differs. Skipping to preserve existing data."
                );
                skipped += 1;
                continue;
            }
            if let Some(raw) = item.created_at.as_deref() {
                if parse_timestamptz(raw).is_none() {
                    eprintln!(
                        "[ingestSession] Invalid createdAt for message {index} in session {session_id}: {raw}"
                    );
                    skipped += 1;
                    continue;
                }
            }
            let mut metadata = Map::new();
            metadata.insert("source".to_string(), Value::String(tags.source.clone()));
            metadata.insert("ordinal".to_string(), Value::from(ordinal));
            metadata.insert("event_id".to_string(), Value::String(event_id.clone()));
            if let Some(persona) = &tags.persona {
                metadata.insert("persona".to_string(), Value::String(persona.clone()));
            }
            let content = truncate_content(&item.content, &mut metadata, "");
            if metadata.get("truncated") == Some(&Value::Bool(true)) {
                any_truncated = true;
            }
            if let Some(full) = metadata.get("full_content_length").and_then(Value::as_u64) {
                max_full = max_full.max(full);
            }
            if !item.tool_calls.is_empty() {
                let mut calls = Vec::new();
                for call in &item.tool_calls {
                    let mut obj = Map::new();
                    if let Some(id) = &call.id {
                        obj.insert("id".to_string(), Value::String(id.clone()));
                    }
                    obj.insert("name".to_string(), Value::String(call.name.clone()));
                    if let Some(input) = &call.input {
                        obj.insert("input".to_string(), input.clone());
                    }
                    calls.push(Value::Object(obj));
                }
                metadata.insert("tool_calls".to_string(), Value::Array(calls));
            }
            let primary = item.tool_calls.first();
            let entry = MemoryEntry {
                session_id: session_id.to_string(),
                agent: tags.agent.clone(),
                channel: tags.channel.clone(),
                role: item.role.clone(),
                content,
                tool_name: primary.map(|call| call.name.clone()),
                tool_args: primary.and_then(|call| call.input.as_ref()).and_then(Value::as_object).cloned(),
                tool_result: None,
                metadata: Some(metadata),
                created_at: item.created_at.clone(),
            };
            let id = self.append_in_tx(conn, &entry).await?;
            ids.push(id);
            seen_ordinals.insert(ordinal);
            seen_events.insert(event_id);
        }
        Ok(IngestOutput {
            session_id: session_id.to_string(),
            ingested: u64::try_from(ids.len()).unwrap_or(u64::MAX),
            skipped,
            ids,
            source: tags.source.clone(),
            agent: tags.agent.clone(),
            channel: tags.channel.clone(),
            persona: tags.persona.clone(),
            truncated: any_truncated,
            full_content_length: if any_truncated && max_full > 0 { Some(max_full) } else { None },
        })
    }

    async fn history(
        &self,
        sql: &str,
        binds: HistoryBinds<'_>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        let mut query = sqlx::query(sql);
        query = match binds {
            HistoryBinds::Session { session_id, limit } => query.bind(session_id).bind(limit),
            HistoryBinds::Legacy { legacy_key, limit } => query.bind(legacy_key).bind(limit),
            HistoryBinds::Task { task_id, legacy_key, limit } => query.bind(task_id).bind(legacy_key).bind(limit),
        };
        let rows = query.fetch_all(&self.pool).await.map_err(query_failed)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(HistoryMessage {
                role: row.try_get("role").map_err(query_failed)?,
                content: row.try_get("content").map_err(query_failed)?,
            });
        }
        out.reverse();
        Ok(out)
    }
}

enum HistoryBinds<'a> {
    Session { session_id: &'a str, limit: i64 },
    Legacy { legacy_key: String, limit: i64 },
    Task { task_id: &'a str, legacy_key: String, limit: i64 },
}

impl MemoryStore for PostgresMemory {
    async fn append(&self, entry: &MemoryEntry) -> Result<String, StoreError> {
        self.append_owned(entry).await
    }

    async fn search(&self, _query: &str, _options: &SearchOptions) -> Result<Value, StoreError> {
        Err(StoreError::NotYetImplemented("search"))
    }

    async fn get_context_for_turn(
        &self,
        _query: &str,
        _agent: &str,
        _user_id: Option<&str>,
    ) -> Result<String, StoreError> {
        Err(StoreError::NotYetImplemented("getContextForTurn"))
    }

    async fn get_session_history(
        &self,
        session_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        self.history(
            "SELECT m.role, m.content
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.active = true
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $2",
            HistoryBinds::Session {
                session_id,
                limit: history_limit(limit),
            },
        )
        .await
    }

    async fn get_task_history(
        &self,
        task_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        let limit = history_limit(limit);
        let legacy_key = format!("task:{task_id}");
        let mut conn = self.acquire().await?;
        let joined = uuid::Uuid::parse_str(task_id).is_ok() && self.task_column_present(&mut conn).await?;
        drop(conn);
        if joined {
            self.history(
                "SELECT m.role, m.content
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE c.task_id = $1::uuid OR c.session_key = $2
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $3",
                HistoryBinds::Task {
                    task_id,
                    legacy_key,
                    limit,
                },
            )
            .await
        } else {
            self.history(
                "SELECT m.role, m.content
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE c.session_key = $1
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $2",
                HistoryBinds::Legacy { legacy_key, limit },
            )
            .await
        }
    }

    async fn save_session_settings(
        &self,
        session_id: &str,
        settings: &Map<String, Value>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE ros_conversations SET settings = $1
       WHERE session_key = $2 AND active = true",
        )
        .bind(Value::Object(settings.clone()))
        .bind(session_id)
        .execute(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(())
    }

    async fn load_session_settings(
        &self,
        session_id: &str,
    ) -> Result<Option<Map<String, Value>>, StoreError> {
        let row = sqlx::query(
            "SELECT settings FROM ros_conversations
       WHERE session_key = $1 AND active = true
       ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(query_failed)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let settings: Value = row.try_get("settings").map_err(query_failed)?;
        Ok(match settings {
            Value::Object(map) => Some(map),
            _ => None,
        })
    }

    async fn capture(&self, batch: &CaptureBatch, options: &CaptureOptions) -> Result<CaptureResult, StoreError> {
        let mut conn = self.acquire().await?;
        self.capture_on_connection(&mut conn, batch, options).await
    }

    async fn browse(&self, filter: &BrowseFilter) -> Result<Value, StoreError> {
        let (since, before) = apply_window_args(
            filter.window.as_deref(),
            filter.since.as_deref(),
            filter.before.as_deref(),
            chrono::Local::now(),
        )
        .map_err(StoreError::Request)?;
        let built = browse_sql(filter, since.as_deref(), before.as_deref()).map_err(StoreError::Request)?;
        let mut query = sqlx::query(&built.sql);
        for param in &built.params {
            query = query.bind(param);
        }
        let rows = query.fetch_all(&self.pool).await.map_err(query_failed)?;
        let mut messages = Vec::new();
        let mut ids = Vec::new();
        for row in rows {
            let id: uuid::Uuid = row.try_get("id").map_err(query_failed)?;
            let conversation_id: uuid::Uuid = row.try_get("conversation_id").map_err(query_failed)?;
            let created: DateTime<Utc> = row.try_get("created_at").map_err(query_failed)?;
            let session_key: Option<String> = row.try_get("session_key").map_err(query_failed)?;
            let tool_name: Option<String> = row.try_get("tool_name").map_err(query_failed)?;
            ids.push(conversation_id);
            let mut obj = Map::new();
            obj.insert("id".to_string(), Value::String(id.to_string()));
            obj.insert("role".to_string(), Value::String(row.try_get::<String, _>("role").map_err(query_failed)?));
            obj.insert("agent".to_string(), Value::String(row.try_get::<String, _>("agent").map_err(query_failed)?));
            obj.insert(
                "content".to_string(),
                Value::String(row.try_get::<String, _>("content").map_err(query_failed)?),
            );
            obj.insert("createdAt".to_string(), Value::String(format_js_iso(created)));
            obj.insert("conversationId".to_string(), Value::String(conversation_id.to_string()));
            obj.insert(
                "sessionId".to_string(),
                session_key.map(Value::String).unwrap_or(Value::Null),
            );
            obj.insert("toolName".to_string(), tool_name.map(Value::String).unwrap_or(Value::Null));
            messages.push((conversation_id.to_string(), obj));
        }
        let tags = self.conversation_tags(&ids).await?;
        let mut list = Vec::new();
        for (conversation_id, mut obj) in messages {
            if let Some(found) = tags.get(&conversation_id) {
                if !found.is_empty() {
                    obj.insert(
                        "tags".to_string(),
                        Value::Array(found.iter().cloned().map(Value::String).collect()),
                    );
                }
            }
            list.push(Value::Object(obj));
        }
        let mut body = Map::new();
        body.insert("messages".to_string(), Value::Array(list));
        Ok(Value::Object(body))
    }

    async fn stats(&self) -> Result<StatsReport, StoreError> {
        match self.stats_report().await {
            Ok(report) => Ok(report),
            Err(err) => Ok(StatsReport {
                dashboard: Value::Null,
                markdown: format!("Stats query failed: {err}"),
            }),
        }
    }

    async fn health(&self, owner: bool) -> Result<HealthReport, StoreError> {
        let _ = self.is_healthy().await;
        let observed = format_js_iso(Utc::now());
        let reason = embedding_probe_reason(self.embed_endpoint.as_deref());
        let counts = self.embedding_counts().await;
        let (msg_queue, sum_queue, unembeddable, failed, recent_failed, counts_ok) = match counts {
            Ok(row) => row,
            Err(err) if missing_schema(&err) => (0, 0, 0, 0, 0, false),
            Err(err) => return Err(query_failed(err)),
        };
        let compaction = match self.compaction_counts().await {
            Ok(row) => row,
            Err(err) if missing_schema(&err) => (0, 0, 0),
            Err(err) => return Err(query_failed(err)),
        };
        let queues = if owner {
            self.queue_rows().await.map_err(query_failed)?
        } else {
            None
        };
        let recent_dead = queues.as_ref().is_some_and(|rows| rows.iter().any(|row| row.recent_dead > 0));
        let embedding_available = false;
        let status = if counts_ok && embedding_available && recent_failed == 0 && !recent_dead {
            "ok"
        } else {
            "degraded"
        };
        let mut embeddings = Map::new();
        embeddings.insert("status".to_string(), Value::String("unavailable".to_string()));
        embeddings.insert("checkedAt".to_string(), Value::String(observed.clone()));
        embeddings.insert("error".to_string(), Value::String(reason.to_string()));
        embeddings.insert(
            "impact".to_string(),
            Value::String("Keyword matching still works; meaning-based ranking is offline.".to_string()),
        );
        let mut body = Map::new();
        body.insert("status".to_string(), Value::String(status.to_string()));
        body.insert("observedAt".to_string(), Value::String(observed));
        body.insert("embeddings".to_string(), Value::Object(embeddings));
        body.insert("embedQueueDepth".to_string(), Value::from(msg_queue + sum_queue));
        body.insert("failedEmbeddings".to_string(), Value::from(failed));
        body.insert("skippedEmbeddings".to_string(), Value::from(unembeddable));
        if !owner {
            body.insert("queueStatus".to_string(), Value::String("restricted".to_string()));
        } else if let Some(rows) = queues {
            body.insert("queueStatus".to_string(), Value::String("available".to_string()));
            let mut list = Vec::new();
            for row in rows {
                let mut item = Map::new();
                item.insert("task".to_string(), Value::String(row.task));
                item.insert("pending".to_string(), Value::from(row.pending));
                item.insert("running".to_string(), Value::from(row.running.unwrap_or(0)));
                item.insert("scheduled".to_string(), Value::from(row.scheduled.unwrap_or(0)));
                item.insert("dead".to_string(), Value::from(row.dead));
                item.insert(
                    "oldestPendingMinutes".to_string(),
                    row.oldest_pending_age_min.map(|n| Value::from(n)).unwrap_or(Value::Null),
                );
                list.push(Value::Object(item));
            }
            body.insert("queues".to_string(), Value::Array(list));
        } else {
            body.insert("queueStatus".to_string(), Value::String("unavailable".to_string()));
        }
        let mut compaction_body = Map::new();
        compaction_body.insert("eligible".to_string(), Value::from(compaction.0));
        compaction_body.insert("activeTail".to_string(), Value::from(compaction.1));
        compaction_body.insert("belowFloor".to_string(), Value::from(compaction.2));
        body.insert("compaction".to_string(), Value::Object(compaction_body));
        let mut capture = Map::new();
        capture.insert("status".to_string(), Value::String("unknown".to_string()));
        capture.insert(
            "impact".to_string(),
            Value::String("Capture progress is not measured by this endpoint yet.".to_string()),
        );
        body.insert("capture".to_string(), Value::Object(capture));
        Ok(HealthReport { body: Value::Object(body) })
    }

    fn tools(&self) -> Vec<ToolDescriptor> {
        vec![
            ToolDescriptor {
                name: "memory_browse".to_string(),
                description: "Browse conversation messages chronologically. Unlike memory_search (which ranks by relevance), this returns messages in time order. By default excludes role=tool rows so limit budget goes to user/assistant/system (pass include_tools=true to see tool calls/results). Use to review what happened in a session, catch up on recent activity, or read a specific conversation. For time-bounded questions (\"today\", \"yesterday\", \"this morning\"), prefer window= over raw since/before so local-timezone midnights convert correctly to UTC. Display-truncated or capture-truncated payloads: call memory_get_full with the row id.".to_string(),
            },
            ToolDescriptor {
                name: "memory_stats".to_string(),
                description: "Memory system health check — alerts first (stuck jobs, orphans, per-task queue health), then embedding queue, compaction status, then census breakdowns by agent/role/kind. Use to diagnose memory issues or check if background jobs are keeping up.".to_string(),
            },
            ToolDescriptor {
                name: "memory_get_full".to_string(),
                description: "Fetch the complete, untruncated payload for a memory row whose content or tool_result was elided at capture time (rows marked \"…[truncated]\" by memory_search/memory_browse). Reads the original line back from the capture JSONL (or OpenCode SQLite part) on disk. Capture paths are host-local — if the file is not on this machine, the tool explains multi-host recovery instead of claiming the data is gone.".to_string(),
            },
            ToolDescriptor {
                name: "memory_append".to_string(),
                description: "Append one message to RivetOS memory. Tags source/agent/persona from args or env. Optional event_id for idempotency. Content and tool_result are capped at 16,000 chars; the elided tail is unrecoverable. Returns truncated+full_content_length when truncation occurs.".to_string(),
            },
            ToolDescriptor {
                name: "memory_ingest_session".to_string(),
                description: "Ingest a session into RivetOS memory. Skips ordinals and event_ids already stored for that session. Content is capped at 16,000 chars; the elided tail is unrecoverable. Returns truncated+full_content_length when truncation occurs.".to_string(),
            },
        ]
    }

    async fn tags(&self) -> Result<(), StoreError> {
        Err(StoreError::NotYetImplemented("tags"))
    }

    fn wiki(&self) -> Option<String> {
        None
    }

    async fn ingest_session(&self, input: &IngestInput) -> Result<IngestOutput, StoreError> {
        self.ingest_in_pool(input).await
    }

    async fn get_full(&self, id: &str) -> Result<String, StoreError> {
        if id.is_empty() {
            return Ok("memory_get_full: id is required (string).".to_string());
        }
        let parsed = match uuid::Uuid::parse_str(id) {
            Ok(value) => value,
            Err(err) => return Ok(format!("memory_get_full failed: {err}")),
        };
        let row = match sqlx::query(
            "SELECT id, content, tool_name, tool_result, agent, metadata
           FROM ros_messages WHERE id = $1",
        )
        .bind(parsed)
        .fetch_optional(&self.pool)
        .await
        {
            Ok(row) => row,
            Err(err) => return Ok(format!("memory_get_full failed: {}", db_message(&err))),
        };
        let Some(row) = row else {
            return Ok(format!("No message with id {id}."));
        };
        let content: String = row.try_get("content").unwrap_or_default();
        let tool_name: Option<String> = row.try_get("tool_name").unwrap_or(None);
        let tool_result: Option<String> = row.try_get("tool_result").unwrap_or(None);
        let agent: Option<String> = row.try_get("agent").unwrap_or(None);
        let metadata: Value = row.try_get("metadata").unwrap_or(Value::Null);
        let meta = metadata.as_object().cloned().unwrap_or_default();
        if meta.get("truncated") != Some(&Value::Bool(true)) {
            return Ok(render_stored_row(id, &content, tool_name.as_deref(), tool_result.as_deref()));
        }
        if let (Some(sqlite_path), Some(part_id)) = (
            meta.get("session_sqlite_path").and_then(Value::as_str),
            meta.get("session_sqlite_part_id").and_then(Value::as_str),
        ) {
            if !is_capture_sqlite_path(sqlite_path) {
                return Ok(format!(
                    "Source SQLite is gone or invalid ({sqlite_path}) — the elided tail is unrecoverable."
                ));
            }
            if !path_exists(sqlite_path) {
                return Ok(file_missing_message(sqlite_path, agent.as_deref()));
            }
            let Some(extracted) = read_opencode_part(sqlite_path, part_id) else {
                return Ok(format!("Part {part_id} not found in {sqlite_path} (db rotated/rewritten?)."));
            };
            return Ok(render_extracted(
                id,
                &format!("{sqlite_path} part {part_id}"),
                &meta,
                &extracted,
                tool_name.as_deref(),
            ));
        }
        let file = meta.get("session_jsonl_path").and_then(Value::as_str);
        let line = meta.get("session_jsonl_line").and_then(json_index);
        let (Some(file), Some(line)) = (file, line) else {
            return Ok(missing_pointer_message().to_string());
        };
        if !is_capture_transcript_path(file) {
            return Ok(format!("Source JSONL is gone or invalid ({file}) — the elided tail is unrecoverable."));
        }
        if !path_exists(file) {
            return Ok(file_missing_message(file, agent.as_deref()));
        }
        let raw = match read_jsonl_line(file, line) {
            Ok(value) => value,
            Err(message) => {
                if permission_denied(&message) {
                    return Ok(format!(
                        "{}\n\n(underlying error: {message})",
                        file_missing_message(file, agent.as_deref())
                    ));
                }
                return Ok(format!("Failed reading {file}:{line}: {message}"));
            }
        };
        let Some(raw) = raw else {
            return Ok(format!("Line {line} not found in {file} (file rotated/rewritten?)."));
        };
        let mut enriched = meta.clone();
        if let Some(name) = tool_name.as_deref() {
            if !enriched.contains_key("tool_name") {
                enriched.insert("tool_name".to_string(), Value::String(name.to_string()));
            }
        }
        let extracted = extract_full_from_line(&raw, Some(&enriched));
        Ok(render_extracted(id, &format!("{file}:{line}"), &meta, &extracted, tool_name.as_deref()))
    }
}

impl PostgresMemory {
    async fn conversation_tags(&self, ids: &[uuid::Uuid]) -> Result<HashMap<String, Vec<String>>, StoreError> {
        let mut out = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let rows = sqlx::query(
            "SELECT t.key, t.value, t.display, COALESCE(c.id, s.conversation_id)::text AS conversation_id
           FROM ros_tags t
           LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
           LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
          WHERE COALESCE(c.id, s.conversation_id) = ANY($1::uuid[]) AND t.state = 'accepted'
          ORDER BY (t.entity_type = 'conversation') DESC, t.key, t.value",
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(err) if missing_schema(&err) || missing_tag_tables(&db_message(&err)) => return Ok(out),
            Err(err) => return Err(query_failed(err)),
        };
        for row in rows {
            let key: String = row.try_get("key").map_err(query_failed)?;
            let value: String = row.try_get("value").map_err(query_failed)?;
            let display: String = row.try_get("display").unwrap_or_default();
            let conversation_id: String = row.try_get("conversation_id").map_err(query_failed)?;
            let shown_display = protocol::js::js_trim(&display);
            let shown = if !shown_display.is_empty() && normalize_tag_value(shown_display) == value {
                shown_display.to_string()
            } else {
                value.clone()
            };
            let literal = format!("{}:{shown}", normalize_tag_key(&key));
            let list = out.entry(conversation_id).or_default();
            if !list.iter().any(|item| item == &literal) {
                list.push(literal);
            }
        }
        Ok(out)
    }

    async fn stats_report(&self) -> Result<StatsReport, sqlx::Error> {
        let totals = sqlx::query(
            "SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM ros_messages",
        )
        .fetch_one(&self.pool)
        .await?;
        let total: i64 = totals.try_get("total")?;
        let oldest: Option<DateTime<Utc>> = totals.try_get("oldest")?;
        let newest: Option<DateTime<Utc>> = totals.try_get("newest")?;
        let headline = format!(
            "\n**Messages:** {}\n**Date range:** {} → {}",
            en_us(total),
            fmt_date(oldest.map(|dt| format_js_iso(dt)).as_deref()),
            fmt_date(newest.map(|dt| format_js_iso(dt)).as_deref())
        );
        let by_agent_rows = sqlx::query(
            "SELECT agent, COUNT(*) AS count FROM ros_messages GROUP BY agent ORDER BY count DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let by_agent = if by_agent_rows.is_empty() {
            None
        } else {
            let mut lines = vec!["\n**By agent:**".to_string()];
            for row in &by_agent_rows {
                let agent: String = row.try_get("agent")?;
                let count: i64 = row.try_get("count")?;
                lines.push(format!("  {agent}: {}", en_us(count)));
            }
            Some(lines.join("\n"))
        };
        let by_role_rows =
            sqlx::query("SELECT role, COUNT(*) AS count FROM ros_messages GROUP BY role ORDER BY count DESC")
                .fetch_all(&self.pool)
                .await?;
        let by_role = if by_role_rows.is_empty() {
            None
        } else {
            let mut lines = vec!["\n**By role:**".to_string()];
            for row in &by_role_rows {
                let role: String = row.try_get("role")?;
                let count: i64 = row.try_get("count")?;
                lines.push(format!("  {role}: {}", en_us(count)));
            }
            Some(lines.join("\n"))
        };
        let conversations_row = sqlx::query(
            "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM ros_conversations",
        )
        .fetch_one(&self.pool)
        .await?;
        let conv_total: i64 = conversations_row.try_get("total")?;
        let conv_active: i64 = conversations_row.try_get("active")?;
        let conversations = format!("\n**Conversations:** {conv_total} total, {conv_active} active");
        let kind_rows = sqlx::query(
            "SELECT kind, COUNT(*) AS count, MAX(depth) AS max_depth FROM ros_summaries GROUP BY kind ORDER BY count DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let summaries = if kind_rows.is_empty() {
            "\n**Summaries:** 0 ⚠️ No summaries — compactor may not be running".to_string()
        } else {
            let mut total_summaries = 0_i64;
            let mut lines = Vec::new();
            for row in &kind_rows {
                let kind: String = row.try_get("kind")?;
                let count: i64 = row.try_get("count")?;
                let depth: Option<i32> = row.try_get("max_depth").unwrap_or(None);
                total_summaries += count;
                lines.push(format!("  {kind}: {} (max depth: {})", en_us(count), depth.unwrap_or(0)));
            }
            format!("\n**Summaries:** {} total\n{}", en_us(total_summaries), lines.join("\n"))
        };
        let embed = self.embedding_counts().await?;
        let embedding_queue = if embed.5 {
            format_embedding_queue(embed.0, embed.1, embed.2, embed.3)
        } else {
            "\n**Embedding queue:** ⚠️ unavailable (embedding schema incomplete)".to_string()
        };
        let msg_embed = sqlx::query("SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM ros_messages")
            .fetch_one(&self.pool)
            .await?;
        let sum_embed = sqlx::query("SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM ros_summaries")
            .fetch_one(&self.pool)
            .await?;
        let msg_total: i64 = msg_embed.try_get("total")?;
        let msg_embedded: i64 = msg_embed.try_get("embedded")?;
        let sum_total: i64 = sum_embed.try_get("total")?;
        let sum_embedded: i64 = sum_embed.try_get("embedded")?;
        let embedding_coverage = format!(
            "\n**Embedding coverage:**\n  Messages: {}/{} ({}%)\n  Summaries: {}/{} ({}%)",
            en_us(msg_embedded),
            en_us(msg_total),
            pct(msg_embedded, msg_total),
            en_us(sum_embedded),
            en_us(sum_total),
            pct(sum_embedded, sum_total)
        );
        let buckets = self.compaction_bucket().await?;
        let unsummarized = format_unsummarized(buckets.0, buckets.1, buckets.2, buckets.3, buckets.4, buckets.5);
        let eligible_rows = sqlx::query(&format!(
            "SELECT c.id::text AS conversation_id, c.agent, COUNT(m.id)::bigint AS unsummarized,
                  CASE WHEN COUNT(m.id) >= $1 THEN 'full_window'
                       WHEN COUNT(m.id) >= $2 THEN 'idle_floor'
                       ELSE 'stale_partial' END AS trigger
             FROM ros_conversations c
             JOIN ros_messages m ON m.conversation_id = c.id
             LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
            WHERE ss.summary_id IS NULL
              AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL)
              AND {}
            GROUP BY c.id, c.agent, c.updated_at
           HAVING (COUNT(m.id) >= $2 AND (COUNT(m.id) >= $1 OR c.updated_at < NOW() - ($3 || ' minutes')::interval))
               OR (COUNT(m.id) >= $4 AND c.updated_at < NOW() - ($5 || ' minutes')::interval)
            ORDER BY c.updated_at ASC LIMIT 5",
            crate::report::sql_not_heartbeat_conversation("c")
        ))
        .bind(FULL_WINDOW)
        .bind(MIN_BATCH_SIZE)
        .bind(IDLE_MINUTES.to_string())
        .bind(STALE_MIN_BATCH)
        .bind(STALE_MINUTES.to_string())
        .fetch_all(&self.pool)
        .await?;
        let eligible = if eligible_rows.is_empty() {
            None
        } else {
            let mut lines = vec!["\n**Top conversations eligible for compaction:**".to_string()];
            for row in &eligible_rows {
                let agent: String = row.try_get("agent")?;
                let count: i64 = row.try_get("unsummarized")?;
                let trigger: String = row.try_get("trigger")?;
                let conversation_id: String = row.try_get("conversation_id")?;
                let prefix: String = conversation_id.chars().take(8).collect();
                lines.push(format!(
                    "  {agent}: {} unsummarized [{trigger}] (conv: {prefix}…)",
                    en_us(count)
                ));
            }
            Some(lines.join("\n"))
        };
        let present: bool = sqlx::query_scalar(
            "SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema='graphile_worker' AND table_name='_private_jobs'
           )",
        )
        .fetch_one(&self.pool)
        .await?;
        let mut stuck_jobs = None;
        let mut queue_health = None;
        if present {
            let stuck = sqlx::query(
                "SELECT t.identifier AS task, COUNT(*)::bigint AS count, MIN(j.run_at) AS oldest_run_at, LEFT(MAX(j.last_error), 120) AS sample_error
               FROM graphile_worker._private_jobs j
               JOIN graphile_worker._private_tasks t ON t.id = j.task_id
              WHERE j.attempts >= j.max_attempts
              GROUP BY t.identifier
              ORDER BY COUNT(*) DESC",
            )
            .fetch_all(&self.pool)
            .await?;
            if !stuck.is_empty() {
                let mut lines = vec!["\n**⚠️ Stuck queue jobs (at max attempts, won't retry):**".to_string()];
                for row in &stuck {
                    let task: String = row.try_get("task")?;
                    let count: i64 = row.try_get("count")?;
                    let oldest: Option<DateTime<Utc>> = row.try_get("oldest_run_at")?;
                    let sample: Option<String> = row.try_get("sample_error")?;
                    let err = sample.map(|text| format!(" — {text}")).unwrap_or_default();
                    lines.push(format!(
                        "  {task}: {} dead since {}{err}",
                        en_us(count),
                        fmt_date(oldest.map(|dt| format_js_iso(dt)).as_deref())
                    ));
                }
                stuck_jobs = Some(lines.join("\n"));
            }
            if let Some(rows) = self.queue_rows().await? {
                queue_health = Some(format_queue_health(&rows));
            }
        }
        let orphan_row = sqlx::query(
            "SELECT COUNT(*) AS count FROM ros_summaries s
          LEFT JOIN ros_summary_sources ss ON ss.summary_id = s.id
          WHERE ss.summary_id IS NULL AND s.kind = 'leaf'",
        )
        .fetch_one(&self.pool)
        .await?;
        let orphan_count: i64 = orphan_row.try_get("count")?;
        let orphans = if orphan_count > 0 {
            Some(format!("\n**⚠️ Orphan leaf summaries (no source messages):** {orphan_count}"))
        } else {
            None
        };
        let tree_row = sqlx::query(
            "SELECT MAX(depth) AS max_depth,
                 COUNT(*) FILTER (WHERE parent_id IS NULL AND kind != 'leaf') AS root_count,
                 COUNT(*) FILTER (WHERE parent_id IS NOT NULL) AS child_count
          FROM ros_summaries",
        )
        .fetch_one(&self.pool)
        .await?;
        let max_depth: Option<i32> = tree_row.try_get("max_depth").unwrap_or(None);
        let root_count: i64 = tree_row.try_get("root_count")?;
        let child_count: i64 = tree_row.try_get("child_count")?;
        let tree = format!(
            "\n**Summary tree:**\n  Max depth: {}\n  Root summaries: {root_count}\n  Child summaries: {child_count}",
            max_depth.unwrap_or(0)
        );
        let fresh = sqlx::query(
            "SELECT (SELECT MAX(created_at) FROM ros_messages) AS newest_message, (SELECT MAX(created_at) FROM ros_summaries) AS newest_summary",
        )
        .fetch_one(&self.pool)
        .await?;
        let newest_message: Option<DateTime<Utc>> = fresh.try_get("newest_message")?;
        let newest_summary: Option<DateTime<Utc>> = fresh.try_get("newest_summary")?;
        let now = now_ms();
        let freshness = format!(
            "\n**Freshness:**\n  Newest message: {}\n  Newest summary: {}",
            newest_message
                .map(|dt| time_since(dt.timestamp_millis(), now))
                .unwrap_or_else(|| "never".to_string()),
            newest_summary
                .map(|dt| time_since(dt.timestamp_millis(), now))
                .unwrap_or_else(|| "never".to_string())
        );
        let capture_spool = read_capture_spool().map(|(waiting, oldest, dead)| format_capture_spool(waiting, oldest, dead, now));
        let parts = [
            Some(headline.as_str()),
            stuck_jobs.as_deref(),
            orphans.as_deref(),
            queue_health.as_deref(),
            capture_spool.as_deref(),
            Some(embedding_queue.as_str()),
            Some(unsummarized.as_str()),
            eligible.as_deref(),
            by_agent.as_deref(),
            by_role.as_deref(),
            Some(conversations.as_str()),
            Some(summaries.as_str()),
            Some(embedding_coverage.as_str()),
            Some(tree.as_str()),
            Some(freshness.as_str()),
        ];
        let markdown = assemble_stats(&parts);
        let dashboard = self.dashboard().await?;
        Ok(StatsReport { dashboard, markdown })
    }

    async fn dashboard(&self) -> Result<Value, sqlx::Error> {
        let conversations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ros_conversations").fetch_one(&self.pool).await?;
        let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ros_messages").fetch_one(&self.pool).await?;
        let tool_calls: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ros_messages WHERE role = 'tool' OR tool_name IS NOT NULL",
        )
        .fetch_one(&self.pool)
        .await?;
        let summaries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ros_summaries").fetch_one(&self.pool).await?;
        let embed = self.embedding_counts().await.unwrap_or((0, 0, 0, 0, 0, false));
        let embedded: i64 =
            sqlx::query_scalar("SELECT COUNT(embedding) FROM ros_messages").fetch_one(&self.pool).await?;
        let tools = sqlx::query(
            "SELECT tool_name AS tool, COUNT(*)::bigint AS n FROM ros_messages WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY COUNT(*) DESC LIMIT 12",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut top_tools = Vec::new();
        for row in tools {
            let mut item = Map::new();
            item.insert("tool".to_string(), Value::String(row.try_get::<String, _>("tool")?));
            item.insert("count".to_string(), Value::from(row.try_get::<i64, _>("n")?));
            top_tools.push(Value::Object(item));
        }
        let recent = sqlx::query(
            "SELECT c.session_key, c.title, c.agent, c.updated_at AS last_active, COUNT(m.id)::bigint AS messages
        FROM ros_conversations c
        LEFT JOIN ros_messages m ON m.conversation_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT 12",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut recent_sessions = Vec::new();
        for row in recent {
            let mut item = Map::new();
            item.insert("sessionId".to_string(), Value::String(row.try_get("session_key")?));
            let title: Option<String> = row.try_get("title")?;
            item.insert("title".to_string(), title.map(Value::String).unwrap_or(Value::Null));
            item.insert("agent".to_string(), Value::String(row.try_get("agent")?));
            let last: DateTime<Utc> = row.try_get("last_active")?;
            item.insert("lastActive".to_string(), Value::String(format_js_iso(last)));
            item.insert("messages".to_string(), Value::from(row.try_get::<i64, _>("messages")?));
            recent_sessions.push(Value::Object(item));
        }
        let mut body = Map::new();
        body.insert("conversations".to_string(), Value::from(conversations));
        body.insert("messages".to_string(), Value::from(messages));
        body.insert("toolCalls".to_string(), Value::from(tool_calls));
        body.insert("summaries".to_string(), Value::from(summaries));
        body.insert("embedQueueDepth".to_string(), Value::from(embed.0 + embed.1));
        body.insert("embeddedMessages".to_string(), Value::from(embedded));
        body.insert("failedEmbeddings".to_string(), Value::from(embed.3));
        body.insert("topTools".to_string(), Value::Array(top_tools));
        body.insert("recentSessions".to_string(), Value::Array(recent_sessions));
        Ok(Value::Object(body))
    }

    async fn embedding_counts(&self) -> Result<(i64, i64, i64, i64, i64, bool), sqlx::Error> {
        let row = sqlx::query(EMBEDDING_HEALTH_SQL).fetch_one(&self.pool).await?;
        Ok((
            row.try_get("msg_queue")?,
            row.try_get("sum_queue")?,
            row.try_get("unembeddable")?,
            row.try_get("failed")?,
            row.try_get("recent_failed")?,
            true,
        ))
    }

    async fn compaction_counts(&self) -> Result<(i64, i64, i64), sqlx::Error> {
        let bucket = self.compaction_bucket().await?;
        Ok((bucket.0, bucket.2, bucket.4))
    }

    async fn compaction_bucket(&self) -> Result<(i64, i64, i64, i64, i64, i64), sqlx::Error> {
        let sql = format!(
            "SELECT eligible_msgs::bigint AS eligible_msgs, eligible_convs::bigint AS eligible_convs, active_tail_msgs::bigint AS active_tail_msgs, active_tail_convs::bigint AS active_tail_convs, below_floor_msgs::bigint AS below_floor_msgs, below_floor_convs::bigint AS below_floor_convs FROM ({}) b",
            compaction_sql()
        );
        let row = sqlx::query(&sql)
            .bind(FULL_WINDOW)
            .bind(MIN_BATCH_SIZE)
            .bind(IDLE_MINUTES.to_string())
            .bind(STALE_MIN_BATCH)
            .bind(STALE_MINUTES.to_string())
            .fetch_one(&self.pool)
            .await?;
        Ok((
            row.try_get("eligible_msgs")?,
            row.try_get("eligible_convs")?,
            row.try_get("active_tail_msgs")?,
            row.try_get("active_tail_convs")?,
            row.try_get("below_floor_msgs")?,
            row.try_get("below_floor_convs")?,
        ))
    }

    async fn queue_rows(&self) -> Result<Option<Vec<QueueRow>>, sqlx::Error> {
        let sql = format!(
            "SELECT task, pending, dead, recent_dead, running, scheduled, oldest_pending_age_min::float8 AS oldest_pending_age_min, last_error FROM ({QUEUE_HEALTH_SQL}) q"
        );
        let rows = match sqlx::query(&sql).fetch_all(&self.pool).await {
            Ok(rows) => rows,
            Err(err) if missing_schema(&err) => return Ok(None),
            Err(err) => return Err(err),
        };
        let mut out = Vec::new();
        for row in rows {
            let pending: String = row.try_get("pending")?;
            let dead: String = row.try_get("dead")?;
            let recent_dead: String = row.try_get("recent_dead")?;
            let running: String = row.try_get("running")?;
            let scheduled: String = row.try_get("scheduled")?;
            let age: Option<f64> = row.try_get("oldest_pending_age_min")?;
            let last_error: Option<String> = row.try_get("last_error")?;
            out.push(QueueRow {
                task: row.try_get("task")?,
                pending: i64_cell(pending.as_str()),
                dead: i64_cell(dead.as_str()),
                running: Some(i64_cell(running.as_str())),
                scheduled: Some(i64_cell(scheduled.as_str())),
                oldest_pending_age_min: age,
                last_error,
                recent_dead: i64_cell(recent_dead.as_str()),
            });
        }
        Ok(Some(out))
    }
}

fn pct(embedded: i64, total: i64) -> String {
    if total <= 0 {
        "0".to_string()
    } else {
        format!("{:.1}", (embedded as f64 / total as f64) * 100.0)
    }
}

fn list_spool(dir: &std::path::Path) -> Result<Vec<String>, std::io::Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if spool_name(&name) {
            names.push(name);
        }
    }
    Ok(names)
}

fn read_capture_spool() -> Option<(i64, Option<i64>, i64)> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::path::Path::new(&home).join(".rivetos").join("capture-spool");
    let waiting = list_spool(&dir).ok()?;
    let dead = list_spool(&dir.join("dead")).ok()?;
    let oldest = waiting
        .iter()
        .filter_map(|name| name.split('-').next())
        .filter_map(|prefix| prefix.parse::<i64>().ok())
        .min();
    Some((i64::try_from(waiting.len()).unwrap_or(i64::MAX), oldest, i64::try_from(dead.len()).unwrap_or(i64::MAX)))
}

fn format_capture_spool(waiting: i64, oldest_ms: Option<i64>, dead: i64, now_ms: i64) -> String {
    if waiting == 0 && dead == 0 {
        return "\n**Capture spool:** ✅ empty".to_string();
    }
    let mut parts = Vec::new();
    if waiting > 0 {
        let age_min = oldest_ms.map(|then| ((now_ms.saturating_sub(then)) as f64 / 60_000.0).max(0.0)).unwrap_or(0.0);
        parts.push(format!("{waiting} batch(es) waiting (oldest {})", fmt_queue_age(age_min)));
    }
    if dead > 0 {
        parts.push(format!("{dead} dead-lettered"));
    }
    let hint = if waiting > 0 {
        "\n  Hooks could not deliver to the den; they replay on their next fire once it answers. Check RIVET_DEN_URL (scheme must match den TLS) and `rivetos doctor`."
    } else {
        "\n  Dead-lettered batches exhausted replay; inspect ~/.rivetos/capture-spool/dead."
    };
    format!("\n**Capture spool:** ⚠️ {}{hint}", parts.join(", "))
}
