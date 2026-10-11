use std::collections::BTreeMap;

use memory::{
    CaptureBatch, CaptureMessage, CaptureOptions, EmbedCall, EmbedResponse, EngineOptions,
    MemoryStore, PostgresMemory, ProjectChoice, migrate_connection, utf16_len, utf16_prefix,
};
use serde_json::{Map, Value, json};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool, Row};

fn audited(sql: String) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(sql)
}

fn skip(test_name: &str, reason: &str) {
    eprintln!("rr-2a db test {test_name} skipped: {reason}");
}

fn fixture(path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

async fn drop_schema(url: &str, schema: &str) {
    let Ok(mut conn) = PgConnection::connect(url).await else {
        return;
    };
    let ids: Vec<String> = sqlx::query_scalar(audited(format!(
        "SELECT id::text FROM {schema}.ros_messages"
    )))
    .fetch_all(&mut conn)
    .await
    .unwrap_or_default();
    if !ids.is_empty() {
        let keys: Vec<String> = ids
            .iter()
            .map(|id| format!("embed-ros_messages-{id}"))
            .collect();
        let _ =
            sqlx::query("DELETE FROM graphile_worker._private_jobs WHERE key = ANY($1::text[])")
                .bind(&keys)
                .execute(&mut conn)
                .await;
    }
    let _ = sqlx::query(audited(format!("DROP SCHEMA IF EXISTS {schema} CASCADE")))
        .execute(&mut conn)
        .await;
}

async fn with_schema<F, Fut>(test_name: &str, prefix: &str, body: F)
where
    F: FnOnce(PgPool) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let url = match std::env::var("RIVETOS_PG_URL") {
        Ok(value) if !value.is_empty() => value,
        _ => {
            skip(
                test_name,
                "RIVETOS_PG_URL is unset; this runner cannot reach a database",
            );
            return;
        }
    };
    let schema = format!("{prefix}_{}", std::process::id());
    let mut admin = PgConnection::connect(&url).await.expect("connect");
    let graphile: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('graphile_worker._private_jobs')::text")
            .fetch_one(&mut admin)
            .await
            .expect("graphile probe");
    if graphile.as_deref().unwrap_or("").is_empty() {
        skip(
            test_name,
            "graphile_worker._private_jobs does not exist (graphile-worker SQL is not in this repository)",
        );
        return;
    }
    sqlx::query(audited(format!("DROP SCHEMA IF EXISTS {schema} CASCADE")))
        .execute(&mut admin)
        .await
        .expect("drop leftover schema");
    sqlx::query(audited(format!("CREATE SCHEMA {schema}")))
        .execute(&mut admin)
        .await
        .expect("create schema");
    sqlx::query(audited(format!("SET search_path TO {schema}, public")))
        .execute(&mut admin)
        .await
        .expect("search_path");
    if let Err(err) = migrate_connection(&mut admin, false).await {
        drop(admin);
        drop_schema(&url, &schema).await;
        let message = err.to_string();
        let lower = message.to_ascii_lowercase();
        if lower.contains("extension") || lower.contains("vector") || lower.contains("pg_trgm") {
            skip(
                test_name,
                &format!("migration extension is unavailable ({message})"),
            );
            return;
        }
        panic!("{test_name}: migrate failed: {message}");
    }
    drop(admin);
    let schema_for_pool = schema.clone();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |conn, _meta| {
            let schema_for_pool = schema_for_pool.clone();
            Box::pin(async move {
                sqlx::query(audited(format!(
                    "SET search_path TO {schema_for_pool}, public"
                )))
                .execute(&mut *conn)
                .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .expect("pool");
    let outcome = body(pool.clone()).await;
    pool.close().await;
    drop_schema(&url, &schema).await;
    if let Err(err) = outcome {
        panic!("{test_name}: {err}");
    }
}

fn opt_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn parse_message(value: &Value) -> CaptureMessage {
    CaptureMessage {
        event_id: value["event_id"].as_str().unwrap_or("").to_string(),
        role: value["role"].as_str().unwrap_or("").to_string(),
        content: value["content"].as_str().unwrap_or("").to_string(),
        tool_name: opt_string(value, "tool_name"),
        tool_args: value
            .get("tool_args")
            .filter(|item| !item.is_null())
            .cloned(),
        tool_result: opt_string(value, "tool_result"),
        metadata: value.get("metadata").and_then(Value::as_object).cloned(),
        created_at: opt_string(value, "created_at"),
    }
}

fn parse_batch(value: &Value) -> CaptureBatch {
    CaptureBatch {
        session_key: value["session_key"].as_str().unwrap_or("").to_string(),
        agent: value["agent"].as_str().unwrap_or("").to_string(),
        channel: opt_string(value, "channel"),
        title: opt_string(value, "title"),
        settings: value.get("settings").and_then(Value::as_object).cloned(),
        task_id: opt_string(value, "task_id"),
        finalize: value
            .get("finalize")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        created_at: opt_string(value, "created_at"),
        updated_at: opt_string(value, "updated_at"),
        messages: value
            .get("messages")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(parse_message).collect())
            .unwrap_or_default(),
    }
}

fn parse_options(value: &Value) -> CaptureOptions {
    let mut options = CaptureOptions::default();
    if let Some(owner) = opt_string(value, "ownerUserId") {
        options.owner_user_id = Some(owner);
    }
    if value.get("allowFilesystem").and_then(Value::as_bool) == Some(false) {
        options.allow_filesystem = false;
    }
    options
}

fn iso_millis(raw: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|dt| memory::sql_report::format_js_iso(dt.with_timezone(&chrono::Utc)))
        .unwrap_or_else(|_| raw.to_string())
}

fn abbreviate(text: &str) -> String {
    let len = utf16_len(text);
    if len > 40 {
        format!("{}…[{len}]", utf16_prefix(text, 40))
    } else {
        text.to_string()
    }
}

fn conv_label(seen: &mut Vec<String>, id: &str) -> String {
    if let Some(index) = seen.iter().position(|item| item == id) {
        return format!("conv-{}", index + 1);
    }
    seen.push(id.to_string());
    format!("conv-{}", seen.len())
}

fn string_cell(row: &sqlx::postgres::PgRow, name: &str) -> Result<String, String> {
    row.try_get::<String, _>(name)
        .map_err(|err| err.to_string())
}

fn opt_cell(row: &sqlx::postgres::PgRow, name: &str) -> Result<Option<String>, String> {
    row.try_get::<Option<String>, _>(name)
        .map_err(|err| err.to_string())
}

fn mask_times(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "created_at".to_string(),
            Value::String("<masked>".to_string()),
        );
        object.insert(
            "updated_at".to_string(),
            Value::String("<masked>".to_string()),
        );
    }
}

async fn golden_capture_batch_body(pool: PgPool) -> Result<(), String> {
    let raw = std::fs::read_to_string(fixture("tests/golden/capture-batch.json"))
        .map_err(|err| err.to_string())?;
    let golden: Value = serde_json::from_str(&raw).map_err(|err| err.to_string())?;
    let store = PostgresMemory::from_pool_with(
        pool.clone(),
        false,
        &memory::MemoryEmbedConfig {
            embed_endpoint: Some(String::new()),
            ..memory::MemoryEmbedConfig::default()
        },
    )
    .map_err(|err| err.to_string())?;
    let calls = golden["results"].as_array().ok_or("golden results")?;
    let mut seen = Vec::new();
    let mut actual_results = Vec::new();
    for call in calls {
        let batch = parse_batch(&call["batch"]);
        let options = parse_options(&call["opts"]);
        let result = MemoryStore::capture(&store, &batch, &options)
            .await
            .map_err(|err| err.to_string())?;
        actual_results.push(json!({
            "ok": result.ok,
            "conversation_id": conv_label(&mut seen, &result.conversation_id),
            "inserted": result.inserted,
            "skipped": result.skipped,
        }));
    }
    let expected_results: Vec<Value> = calls.iter().map(|call| call["result"].clone()).collect();
    if actual_results != expected_results {
        return Err(format!(
            "results\nactual {actual_results:?}\nexpected {expected_results:?}"
        ));
    }

    let conv_rows = sqlx::query(
        "SELECT id::text AS id, session_key, agent, channel, title, settings, task_id::text AS task_id, active, owner_user_id, created_at, updated_at FROM ros_conversations",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;
    let mut conversations = Vec::new();
    for row in &conv_rows {
        let id = string_cell(row, "id")?;
        let created: chrono::DateTime<chrono::Utc> =
            row.try_get("created_at").map_err(|err| err.to_string())?;
        let updated: chrono::DateTime<chrono::Utc> =
            row.try_get("updated_at").map_err(|err| err.to_string())?;
        let settings: Value = row.try_get("settings").map_err(|err| err.to_string())?;
        let mut item = json!({
            "id": conv_label(&mut seen, &id),
            "session_key": string_cell(row, "session_key")?,
            "agent": string_cell(row, "agent")?,
            "channel": string_cell(row, "channel")?,
            "title": opt_cell(row, "title")?,
            "settings": settings,
            "task_id": opt_cell(row, "task_id")?,
            "active": row.try_get::<bool, _>("active").map_err(|err| err.to_string())?,
            "owner_user_id": opt_cell(row, "owner_user_id")?,
            "created_at": memory::sql_report::format_js_iso(created),
            "updated_at": memory::sql_report::format_js_iso(updated),
        });
        mask_times(&mut item);
        conversations.push(item);
    }
    conversations.sort_by(|left, right| {
        (left["session_key"].as_str(), left["agent"].as_str())
            .cmp(&(right["session_key"].as_str(), right["agent"].as_str()))
    });
    let mut expected_conversations = golden["conversations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for item in &mut expected_conversations {
        mask_times(item);
    }
    expected_conversations.sort_by(|left, right| {
        (left["session_key"].as_str(), left["agent"].as_str())
            .cmp(&(right["session_key"].as_str(), right["agent"].as_str()))
    });
    if conversations != expected_conversations {
        return Err(format!(
            "conversations\nactual {}\nexpected {}",
            serde_json::to_string(&conversations).unwrap_or_default(),
            serde_json::to_string(&expected_conversations).unwrap_or_default()
        ));
    }

    let message_rows = sqlx::query(
        "SELECT id::text AS id, conversation_id::text AS conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at, owner_user_id, content_hash FROM ros_messages",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;
    let mut id_to_event: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut messages = Vec::new();
    for row in &message_rows {
        let id = string_cell(row, "id")?;
        let conversation_id = string_cell(row, "conversation_id")?;
        let content: String = string_cell(row, "content")?;
        let tool_result: Option<String> = opt_cell(row, "tool_result")?;
        let metadata: Value = row.try_get("metadata").map_err(|err| err.to_string())?;
        let created: chrono::DateTime<chrono::Utc> =
            row.try_get("created_at").map_err(|err| err.to_string())?;
        let tool_args: Option<Value> = row.try_get("tool_args").map_err(|err| err.to_string())?;
        let event_id = metadata
            .get("event_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let label = conv_label(&mut seen, &conversation_id);
        id_to_event.insert(id, (label.clone(), event_id));
        messages.push(json!({
            "conversation_id": label,
            "agent": string_cell(row, "agent")?,
            "channel": string_cell(row, "channel")?,
            "role": string_cell(row, "role")?,
            "content": abbreviate(&content),
            "tool_name": opt_cell(row, "tool_name")?,
            "tool_args": tool_args.unwrap_or(Value::Null),
            "tool_result": tool_result.map(|text| abbreviate(&text)).map(Value::String).unwrap_or(Value::Null),
            "metadata": metadata,
            "created_at": memory::sql_report::format_js_iso(created),
            "owner_user_id": opt_cell(row, "owner_user_id")?,
            "content_hash": opt_cell(row, "content_hash")?,
            "content_len": utf16_len(&content),
        }));
    }
    let sort_message = |value: &Value| {
        (
            value["conversation_id"].as_str().unwrap_or("").to_string(),
            value["created_at"].as_str().unwrap_or("").to_string(),
            value["metadata"]["event_id"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        )
    };
    messages.sort_by_key(sort_message);
    let mut expected_messages = Vec::new();
    for item in golden["messages"].as_array().cloned().unwrap_or_default() {
        let mut item = item;
        if let Some(created) = item.get("created_at").and_then(Value::as_str) {
            let normalized = iso_millis(created);
            item["created_at"] = Value::String(normalized);
        }
        expected_messages.push(item);
    }
    expected_messages.sort_by_key(sort_message);
    if messages != expected_messages {
        return Err(format!(
            "messages\nactual {}\nexpected {}",
            serde_json::to_string(&messages).unwrap_or_default(),
            serde_json::to_string(&expected_messages).unwrap_or_default()
        ));
    }

    let golden_messages = golden["messages"].as_array().cloned().unwrap_or_default();
    let mut msg_to_pair = BTreeMap::new();
    for (index, item) in golden_messages.iter().enumerate() {
        msg_to_pair.insert(
            format!("msg-{}", index + 1),
            (
                item["conversation_id"].as_str().unwrap_or("").to_string(),
                item["metadata"]["event_id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
            ),
        );
    }
    let mut expected_jobs = Vec::new();
    for job in golden["jobs"].as_array().cloned().unwrap_or_default() {
        let target = job["payload"]["targetId"].as_str().unwrap_or("");
        let Some((conv, event_id)) = msg_to_pair.get(target) else {
            return Err(format!("golden job target {target} is not a message"));
        };
        expected_jobs.push(json!({
            "task": job["task"].as_str().unwrap_or(""),
            "conv": conv,
            "event_id": event_id,
            "key": "embed-ros_messages-uuid",
            "max_attempts": job["max_attempts"].as_i64().unwrap_or(0),
            "priority": job["priority"].as_i64().unwrap_or(0),
            "target_table": job["payload"]["targetTable"].as_str().unwrap_or(""),
        }));
    }
    let job_rows = sqlx::query(
        "SELECT t.identifier AS task, j.payload, j.key, j.max_attempts, j.priority
           FROM graphile_worker._private_jobs j
           JOIN graphile_worker._private_tasks t ON t.id = j.task_id",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;
    let mut actual_jobs = Vec::new();
    for row in &job_rows {
        let payload: Value = row.try_get("payload").map_err(|err| err.to_string())?;
        let target = payload
            .get("targetId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some((conv, event_id)) = id_to_event.get(target) else {
            continue;
        };
        let key: Option<String> = row.try_get("key").map_err(|err| err.to_string())?;
        let normalized = match key.as_deref() {
            Some(value) if value.starts_with("embed-ros_messages-") => "embed-ros_messages-uuid",
            Some(value) => value,
            None => "",
        };
        let max_attempts: i16 = row.try_get("max_attempts").map_err(|err| err.to_string())?;
        let priority: i16 = row.try_get("priority").map_err(|err| err.to_string())?;
        actual_jobs.push(json!({
            "task": string_cell(row, "task")?,
            "conv": conv,
            "event_id": event_id,
            "key": normalized,
            "max_attempts": i64::from(max_attempts),
            "priority": i64::from(priority),
            "target_table": payload.get("targetTable").and_then(Value::as_str).unwrap_or(""),
        }));
    }
    let sort_job = |value: &Value| {
        (
            value["task"].as_str().unwrap_or("").to_string(),
            value["conv"].as_str().unwrap_or("").to_string(),
            value["event_id"].as_str().unwrap_or("").to_string(),
        )
    };
    actual_jobs.sort_by_key(sort_job);
    expected_jobs.sort_by_key(sort_job);
    if actual_jobs != expected_jobs {
        return Err(format!(
            "jobs\nactual {}\nexpected {}",
            serde_json::to_string(&actual_jobs).unwrap_or_default(),
            serde_json::to_string(&expected_jobs).unwrap_or_default()
        ));
    }

    let tag_rows = sqlx::query(
        "SELECT entity_type, key, value, state, source FROM ros_tags ORDER BY entity_type, key, value",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;
    let mut tags = Vec::new();
    for row in &tag_rows {
        tags.push(json!({
            "entity_type": string_cell(row, "entity_type")?,
            "key": string_cell(row, "key")?,
            "value": string_cell(row, "value")?,
            "state": string_cell(row, "state")?,
            "source": string_cell(row, "source")?,
        }));
    }
    let mut expected_tags = golden["tags"].as_array().cloned().unwrap_or_default();
    let sort_tag = |value: &Value| {
        (
            value["entity_type"].as_str().unwrap_or("").to_string(),
            value["key"].as_str().unwrap_or("").to_string(),
            value["value"].as_str().unwrap_or("").to_string(),
        )
    };
    tags.sort_by_key(sort_tag);
    expected_tags.sort_by_key(sort_tag);
    if tags != expected_tags {
        return Err(format!(
            "tags\nactual {}\nexpected {}",
            serde_json::to_string(&tags).unwrap_or_default(),
            serde_json::to_string(&expected_tags).unwrap_or_default()
        ));
    }
    Ok(())
}

async fn fixture_capture_batches_body(pool: PgPool) -> Result<(), String> {
    let raw = std::fs::read_to_string(fixture("tests/fixtures/capture-batches.json"))
        .map_err(|err| err.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|err| err.to_string())?;
    let cases = parsed["cases"].as_array().ok_or("cases")?;
    let store = PostgresMemory::from_pool_with(
        pool.clone(),
        false,
        &memory::MemoryEmbedConfig {
            embed_endpoint: Some(String::new()),
            ..memory::MemoryEmbedConfig::default()
        },
    )
    .map_err(|err| err.to_string())?;
    for case in cases {
        let name = case["name"].as_str().unwrap_or("");
        match name {
            "finalize" => {
                let batch = CaptureBatch {
                    session_key: case["session_key"].as_str().unwrap_or("").to_string(),
                    agent: case["agent"].as_str().unwrap_or("").to_string(),
                    channel: Some("claude-code".to_string()),
                    title: None,
                    settings: None,
                    task_id: None,
                    finalize: true,
                    created_at: None,
                    updated_at: None,
                    messages: Vec::new(),
                };
                let result = MemoryStore::capture(&store, &batch, &CaptureOptions::default())
                    .await
                    .map_err(|err| err.to_string())?;
                if result.inserted != 0 {
                    return Err(format!("finalize inserted {}", result.inserted));
                }
                let active: bool = sqlx::query_scalar(
                    "SELECT active FROM ros_conversations WHERE session_key = $1",
                )
                .bind(&batch.session_key)
                .fetch_one(&pool)
                .await
                .map_err(|err| err.to_string())?;
                if active {
                    return Err("finalize left the conversation active".to_string());
                }
            }
            "duplicate-event-id" => {
                let batch = parse_batch(case);
                let first = MemoryStore::capture(&store, &batch, &CaptureOptions::default())
                    .await
                    .map_err(|err| err.to_string())?;
                if first.inserted != 1 || first.skipped != 1 {
                    return Err(format!(
                        "duplicate first pass inserted {} skipped {}",
                        first.inserted, first.skipped
                    ));
                }
                let second = MemoryStore::capture(&store, &batch, &CaptureOptions::default())
                    .await
                    .map_err(|err| err.to_string())?;
                if second.inserted
                    != case["expect_inserted_second_pass"]
                        .as_u64()
                        .unwrap_or(u64::MAX)
                    || second.skipped
                        != case["expect_skipped_second_pass"]
                            .as_u64()
                            .unwrap_or(u64::MAX)
                {
                    return Err(format!(
                        "duplicate second pass inserted {} skipped {}",
                        second.inserted, second.skipped
                    ));
                }
            }
            "routed-user" => {
                let batch = parse_batch(case);
                let options = CaptureOptions {
                    owner_user_id: opt_string(case, "owner_user_id"),
                    ..CaptureOptions::default()
                };
                let _ = MemoryStore::capture(&store, &batch, &options)
                    .await
                    .map_err(|err| err.to_string())?;
                let owner: Option<String> = sqlx::query_scalar(
                    "SELECT owner_user_id FROM ros_messages WHERE metadata->>'event_id' = 'o1'",
                )
                .fetch_one(&pool)
                .await
                .map_err(|err| err.to_string())?;
                if owner.as_deref() != Some("phil") {
                    return Err(format!("routed owner {owner:?}"));
                }
            }
            "over-cap-surrogate-boundary" => {
                let content = format!("{}😀tail", "x".repeat(15999));
                let mut metadata = Map::new();
                metadata.insert("source".to_string(), Value::String("fixture".to_string()));
                let batch = CaptureBatch {
                    session_key: "claude-code:over-cap".to_string(),
                    agent: "rivet-claude".to_string(),
                    channel: Some("claude-code".to_string()),
                    title: None,
                    settings: None,
                    task_id: None,
                    finalize: false,
                    created_at: None,
                    updated_at: None,
                    messages: vec![CaptureMessage {
                        event_id: "cap".to_string(),
                        role: "assistant".to_string(),
                        content,
                        tool_name: None,
                        tool_args: None,
                        tool_result: None,
                        metadata: Some(metadata),
                        created_at: None,
                    }],
                };
                let _ = MemoryStore::capture(&store, &batch, &CaptureOptions::default())
                    .await
                    .map_err(|err| err.to_string())?;
                let row = sqlx::query(
                    "SELECT content, metadata FROM ros_messages WHERE metadata->>'event_id' = 'cap'",
                )
                .fetch_one(&pool)
                .await
                .map_err(|err| err.to_string())?;
                let stored: String = row.try_get("content").map_err(|err| err.to_string())?;
                let meta: Value = row.try_get("metadata").map_err(|err| err.to_string())?;
                if utf16_len(&stored) != case["expect_content_len"].as_u64().unwrap_or(0) as usize {
                    return Err(format!("over-cap len {}", utf16_len(&stored)));
                }
                if stored.contains('\u{2026}') {
                    return Err("over-cap stored the truncation marker".to_string());
                }
                let full = meta.get("full_content_length").and_then(Value::as_u64);
                if full != case["expect_full_len"].as_u64() {
                    return Err(format!("over-cap full {full:?}"));
                }
                if meta.get("truncated") != Some(&Value::Bool(true)) {
                    return Err("over-cap truncated flag missing".to_string());
                }
            }
            _ => return Err(format!("unknown fixture {name}")),
        }
    }
    Ok(())
}

#[tokio::test]
async fn golden_capture_batch() {
    with_schema(
        "golden_capture_batch",
        "rr2a_golden",
        golden_capture_batch_body,
    )
    .await;
}

#[tokio::test]
async fn fixture_capture_batches() {
    with_schema(
        "fixture_capture_batches",
        "rr2a_fix",
        fixture_capture_batches_body,
    )
    .await;
}

fn capture_options() -> CaptureOptions {
    CaptureOptions {
        allow_filesystem: false,
        owner_user_id: None,
        project: ProjectChoice::Disabled,
    }
}

fn captured(session_key: &str, role: &str, content: &str) -> CaptureBatch {
    CaptureBatch {
        session_key: session_key.to_string(),
        agent: "ranker".to_string(),
        channel: Some("test".to_string()),
        title: None,
        settings: None,
        task_id: None,
        finalize: false,
        created_at: None,
        updated_at: None,
        messages: vec![CaptureMessage {
            event_id: format!("{session_key}-{role}"),
            role: role.to_string(),
            content: content.to_string(),
            tool_name: None,
            tool_args: None,
            tool_result: None,
            metadata: None,
            created_at: None,
        }],
    }
}

fn axis_literal(axis: usize) -> String {
    let mut parts = Vec::with_capacity(1024);
    for index in 0..1024 {
        parts.push(if index == axis { "1" } else { "0" });
    }
    format!("[{}]", parts.join(","))
}

async fn ranking_orders_body(pool: PgPool) -> Result<(), String> {
    let store = PostgresMemory::from_pool_with(
        pool.clone(),
        false,
        &memory::MemoryEmbedConfig {
            embed_endpoint: Some(String::new()),
            ..memory::MemoryEmbedConfig::default()
        },
    )
    .map_err(|err| err.to_string())?;
    let options = capture_options();
    let assistant = format!("calpha{}", "c".repeat(994));
    let user = format!("ualpha{}", "a".repeat(994));
    let system = "balpha".to_string();
    for (session, role, content) in [
        ("rank-c", "assistant", assistant.as_str()),
        ("rank-a", "user", user.as_str()),
        ("rank-b", "system", system.as_str()),
    ] {
        MemoryStore::capture(&store, &captured(session, role, content), &options)
            .await
            .map_err(|err| format!("capture {session}: {err}"))?;
    }
    sqlx::query("UPDATE ros_messages SET created_at = NOW(), access_count = 25 WHERE content LIKE 'calpha%'")
        .execute(&pool)
        .await
        .map_err(|err| format!("update c: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0 WHERE content LIKE 'ualpha%'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("update a: {err}"))?;
    sqlx::query("UPDATE ros_messages SET created_at = NOW() - interval '30 days', access_count = 0 WHERE content LIKE 'balpha%'")
        .execute(&pool)
        .await
        .map_err(|err| format!("update b: {err}"))?;
    let regex = store
        .search_with(
            "alpha",
            &EngineOptions {
                mode: Some("regex".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("regex search: {err}"))?;
    let order: Vec<String> = regex
        .hits
        .iter()
        .map(|hit| hit.content.chars().take(6).collect())
        .collect();
    if order != ["calpha", "ualpha", "balpha"] {
        return Err(format!("regex order {order:?}"));
    }
    let short = "banana".to_string();
    let long = format!("banana {}", "x".repeat(40));
    MemoryStore::capture(&store, &captured("rank-short", "user", &short), &options)
        .await
        .map_err(|err| format!("capture short: {err}"))?;
    MemoryStore::capture(&store, &captured("rank-long", "user", &long), &options)
        .await
        .map_err(|err| format!("capture long: {err}"))?;
    let hybrid = store
        .search_with(
            "banana",
            &EngineOptions {
                mode: Some("hybrid".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("hybrid search: {err}"))?;
    if hybrid.hits.iter().any(|hit| hit.content == "banana") {
        return Err("hybrid quality floor kept the short banana row".to_string());
    }
    if !hybrid
        .hits
        .iter()
        .any(|hit| hit.content.starts_with("banana "))
    {
        return Err("hybrid missed the long banana row".to_string());
    }
    MemoryStore::capture(&store, &captured("rank-kitten", "user", "kitten"), &options)
        .await
        .map_err(|err| format!("capture kitten: {err}"))?;
    MemoryStore::capture(
        &store,
        &captured("rank-kittens", "user", "kittens"),
        &options,
    )
    .await
    .map_err(|err| format!("capture kittens: {err}"))?;
    let trigram = store
        .search_with(
            "kitten",
            &EngineOptions {
                mode: Some("trigram".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("trigram search: {err}"))?;
    if trigram.hits.first().map(|hit| hit.content.as_str()) != Some("kitten") {
        return Err(format!(
            "trigram order {:?}",
            trigram
                .hits
                .iter()
                .map(|hit| hit.content.clone())
                .collect::<Vec<_>>()
        ));
    }
    if !trigram.hits.iter().any(|hit| hit.content.len() < 40) {
        return Err("explicit trigram dropped a short row".to_string());
    }
    MemoryStore::capture(
        &store,
        &captured("rank-vs", "system", "vsystem vectorneedle"),
        &options,
    )
    .await
    .map_err(|err| format!("capture vsystem: {err}"))?;
    MemoryStore::capture(
        &store,
        &captured("rank-vu", "user", "vuser vectorneedle"),
        &options,
    )
    .await
    .map_err(|err| format!("capture vuser: {err}"))?;
    sqlx::query("UPDATE ros_messages SET created_at = NOW() - interval '30 days', access_count = 0, embedding = $1::halfvec(1024) WHERE content = 'vsystem vectorneedle'")
        .bind(axis_literal(0))
        .execute(&pool)
        .await
        .map_err(|err| format!("embed vsystem: {err}"))?;
    sqlx::query("UPDATE ros_messages SET created_at = NOW(), access_count = 0, embedding = $1::halfvec(1024) WHERE content = 'vuser vectorneedle'")
        .bind(axis_literal(1))
        .execute(&pool)
        .await
        .map_err(|err| format!("embed vuser: {err}"))?;
    let embedding = {
        let mut values = vec![0.0; 1024];
        values[0] = 1.0;
        values
    };
    store.configure_embed(
        Some("http://127.0.0.1:9".to_string()),
        "text-embedding-3-small",
    );
    store.set_embed_fetch(std::sync::Arc::new(move |_call: EmbedCall| {
        let body = serde_json::json!({ "data": [{ "embedding": embedding.clone(), "index": 0 }] })
            .to_string();
        Box::pin(async move { Ok(EmbedResponse { status: 200, body }) })
            as std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<EmbedResponse, memory::FetchFail>>
                        + Send,
                >,
            >
    }));
    let vector = store
        .search_with(
            "vectorneedle",
            &EngineOptions {
                mode: Some("vector".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("vector search: {err:?}"))?;
    let vector_order: Vec<String> = vector.hits.iter().map(|hit| hit.content.clone()).collect();
    if vector_order.first().map(String::as_str) != Some("vsystem vectorneedle") {
        return Err(format!("vector order {vector_order:?}"));
    }
    if vector.hits.get(1).map(|hit| hit.content.as_str()) != Some("vuser vectorneedle") {
        return Err(format!("vector second {vector_order:?}"));
    }
    Ok(())
}

#[tokio::test]
async fn ranking_orders() {
    with_schema("ranking_orders", "rr2b_rank", ranking_orders_body).await;
}

async fn database_parity_paths_body(pool: PgPool) -> Result<(), String> {
    let store = PostgresMemory::from_pool_with(
        pool.clone(),
        false,
        &memory::MemoryEmbedConfig {
            embed_endpoint: Some(String::new()),
            ..memory::MemoryEmbedConfig::default()
        },
    )
    .map_err(|err| err.to_string())?;
    let options = capture_options();
    MemoryStore::capture(
        &store,
        &captured("win-new", "user", "windowtoken recent"),
        &options,
    )
    .await
    .map_err(|err| format!("capture recent: {err}"))?;
    MemoryStore::capture(
        &store,
        &captured("win-old", "user", "windowtoken stale"),
        &options,
    )
    .await
    .map_err(|err| format!("capture stale: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW() - interval '2 days' WHERE content = 'windowtoken stale'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("age stale: {err}"))?;
    let windowed = store
        .search_with(
            "windowtoken",
            &EngineOptions {
                mode: Some("regex".to_string()),
                scope: Some("messages".to_string()),
                window: Some("last_24h".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("window search: {err}"))?;
    let window_hits: Vec<String> = windowed
        .hits
        .iter()
        .map(|hit| hit.content.clone())
        .collect();
    if window_hits != ["windowtoken recent"] {
        return Err(format!("window hits {window_hits:?}"));
    }
    let marked = MemoryStore::capture(
        &store,
        &captured("tag-yes", "user", "tagtoken marked"),
        &options,
    )
    .await
    .map_err(|err| format!("capture marked: {err}"))?;
    MemoryStore::capture(
        &store,
        &captured("tag-no", "user", "tagtoken other"),
        &options,
    )
    .await
    .map_err(|err| format!("capture other: {err}"))?;
    memory::tags::add_tag(
        &store.tag_conn(),
        &memory::tags::AddTagInput {
            entity_type: "conversation".to_string(),
            entity_id: Some(marked.conversation_id.clone()),
            session_key: None,
            agent: None,
            tag: Some("project:AcmeApp".to_string()),
            key: None,
            value: None,
            display: None,
            reason: None,
        },
        "alice",
    )
    .await
    .map_err(|err| format!("add tag: {err}"))?;
    let tagged = store
        .search_with(
            "tagtoken",
            &EngineOptions {
                mode: Some("regex".to_string()),
                scope: Some("messages".to_string()),
                tag: Some("project:acmeapp".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("tag search: {err}"))?;
    let tag_hits: Vec<String> = tagged.hits.iter().map(|hit| hit.content.clone()).collect();
    if tag_hits != ["tagtoken marked"] {
        return Err(format!("tag hits {tag_hits:?}"));
    }
    let source = "substantive source message for the expanded summary view";
    let summary_capture =
        MemoryStore::capture(&store, &captured("expand-src", "user", source), &options)
            .await
            .map_err(|err| format!("capture source: {err}"))?;
    let message_id: String =
        sqlx::query_scalar("SELECT id::text FROM ros_messages WHERE content = $1")
            .bind(source)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("message id: {err}"))?;
    let summary_id: String = sqlx::query_scalar(
        "INSERT INTO ros_summaries (conversation_id, kind, depth, content, message_count)
         VALUES ($1::uuid, 'leaf', 0, 'parent summary body', 1)
         RETURNING id::text",
    )
    .bind(&summary_capture.conversation_id)
    .fetch_one(&pool)
    .await
    .map_err(|err| format!("insert summary: {err}"))?;
    sqlx::query(
        "INSERT INTO ros_summaries (conversation_id, parent_id, kind, depth, content, message_count)
         VALUES ($1::uuid, $2::uuid, 'leaf', 1, 'child body', 0)",
    )
    .bind(&summary_capture.conversation_id)
    .bind(&summary_id)
    .execute(&pool)
    .await
    .map_err(|err| format!("insert child: {err}"))?;
    sqlx::query(
        "INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES ($1::uuid, $2::uuid, 0)",
    )
    .bind(&summary_id)
    .bind(&message_id)
    .execute(&pool)
    .await
    .map_err(|err| format!("insert source: {err}"))?;
    let expanded = store
        .expander()
        .expand(&summary_id)
        .await
        .map_err(|err| format!("expand: {err}"))?
        .ok_or_else(|| "summary expand returned none".to_string())?;
    if expanded.summary.content != "parent summary body" {
        return Err(format!("summary content {}", expanded.summary.content));
    }
    if expanded
        .children
        .first()
        .map(|child| child.content.as_str())
        != Some("child body")
    {
        return Err(format!("children {:?}", expanded.children));
    }
    if !expanded
        .source_messages
        .iter()
        .any(|message| message.content == source)
    {
        return Err(format!("sources {:?}", expanded.source_messages));
    }
    memory::tags::add_tag(
        &store.tag_conn(),
        &memory::tags::AddTagInput {
            entity_type: "conversation".to_string(),
            entity_id: Some(summary_capture.conversation_id.clone()),
            session_key: None,
            agent: None,
            tag: Some("project:AcmeApp".to_string()),
            key: None,
            value: None,
            display: None,
            reason: None,
        },
        "alice",
    )
    .await
    .map_err(|err| format!("tag summary conversation: {err}"))?;
    sqlx::query(
        "INSERT INTO ros_tags (entity_type, entity_id, key, value, display, source, state)
         VALUES ('conversation', $1::uuid, 'project', 'hidden', 'Hidden', 'user', 'rejected')",
    )
    .bind(&summary_capture.conversation_id)
    .execute(&pool)
    .await
    .map_err(|err| format!("rejected tag: {err}"))?;
    let tool_hits = [
        memory::SearchHit {
            id: summary_id.clone(),
            hit_type: "summary".to_string(),
            content: "parent summary body".to_string(),
            role: "summary".to_string(),
            agent: "summary".to_string(),
            conversation_id: summary_capture.conversation_id.clone(),
            score: 0.8,
            created_at: chrono::Utc::now(),
            truncated: false,
            full_length: None,
            tool_name: None,
            tool_result: None,
            kind: Some("leaf".to_string()),
            earliest_at: None,
            latest_at: None,
            fallback: None,
            degraded: None,
            chunk_arm: None,
            snippet: None,
        },
        memory::SearchHit {
            id: message_id.clone(),
            hit_type: "message".to_string(),
            content: source.to_string(),
            role: "user".to_string(),
            agent: "ranker".to_string(),
            conversation_id: summary_capture.conversation_id.clone(),
            score: 0.4,
            created_at: chrono::Utc::now(),
            truncated: false,
            full_length: None,
            tool_name: None,
            tool_result: None,
            kind: None,
            earliest_at: None,
            latest_at: None,
            fallback: None,
            degraded: None,
            chunk_arm: None,
            snippet: None,
        },
    ];
    let now_ms = memory::now_ms();
    let rendered = memory::search_tool_output(
        &store.expander(),
        &store.tag_conn(),
        "deploy",
        &tool_hits,
        &memory::SearchToolView {
            expand: true,
            now_ms,
            ..memory::SearchToolView::default()
        },
    )
    .await
    .map_err(|err| format!("search tool output: {err}"))?;
    if !rendered.contains("### Summaries (expanded)")
        || !rendered.contains("child body")
        || !rendered.contains(source)
        || rendered.contains("### Summaries\n")
        || rendered.matches("tags: project:AcmeApp").count() != 2
        || rendered.contains("hidden")
        || rendered.contains("Hidden")
    {
        return Err(format!("expanded tool text:\n{rendered}"));
    }
    let closed = memory::search_tool_output(
        &store.expander(),
        &store.tag_conn(),
        "deploy",
        &tool_hits,
        &memory::SearchToolView {
            expand: false,
            now_ms,
            ..memory::SearchToolView::default()
        },
    )
    .await
    .map_err(|err| format!("unexpanded tool output: {err}"))?;
    if !closed.contains("### Summaries\n")
        || closed.contains("### Summaries (expanded)")
        || closed.matches("tags: project:AcmeApp").count() != 2
        || closed.contains("hidden")
    {
        return Err(format!("unexpanded tool text:\n{closed}"));
    }
    let entity: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("entity id: {err}"))?;
    let rows = [
        ("user", Some("alice"), "user-kept"),
        ("model", None, "model-open"),
        ("model", Some("someone"), "model-decided"),
        ("model", Some("cwd-git-root"), "model-rule"),
        ("model", Some(""), "model-blank"),
    ];
    for (source_name, decided_by, value) in rows {
        sqlx::query(
            "INSERT INTO ros_tags (entity_type, entity_id, key, value, display, source, state, decided_by)
             VALUES ('conversation', $1::uuid, 'project', $2, $2, $3, 'accepted', $4)",
        )
        .bind(&entity)
        .bind(value)
        .bind(source_name)
        .bind(decided_by)
        .execute(&pool)
        .await
        .map_err(|err| format!("insert tag {value}: {err}"))?;
    }
    let proposals = [
        "user-kept",
        "model-open",
        "model-decided",
        "model-rule",
        "model-blank",
    ]
    .into_iter()
    .map(|value| memory::tags::RemovalProposal {
        action: "remove".to_string(),
        key: "project".to_string(),
        value: value.to_string(),
        reason: "stale".to_string(),
    })
    .chain(std::iter::once(memory::tags::RemovalProposal {
        action: "keep".to_string(),
        key: "project".to_string(),
        value: "user-kept".to_string(),
        reason: "ignored".to_string(),
    }))
    .collect::<Vec<_>>();
    let updated = memory::tags::propose_tag_removals(
        &store.tag_conn(),
        "conversation",
        &entity,
        &proposals,
        false,
    )
    .await
    .map_err(|err| format!("propose: {err}"))?;
    if updated != 3 {
        return Err(format!("protected removal updated {updated}"));
    }
    let states: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT value, removal_state FROM ros_tags WHERE entity_id = $1::uuid ORDER BY value",
    )
    .bind(&entity)
    .fetch_all(&pool)
    .await
    .map_err(|err| format!("removal states: {err}"))?;
    let expected = [
        ("model-blank".to_string(), Some("suggested".to_string())),
        ("model-decided".to_string(), None),
        ("model-open".to_string(), Some("suggested".to_string())),
        ("model-rule".to_string(), Some("suggested".to_string())),
        ("user-kept".to_string(), None),
    ];
    if states != expected {
        return Err(format!("removal states {states:?}"));
    }
    Ok(())
}

#[tokio::test]
async fn database_parity_paths() {
    with_schema(
        "database_parity_paths",
        "rr2b_paths",
        database_parity_paths_body,
    )
    .await;
}

fn near(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() < 0.01
}

fn pair_literal(axis0: f64, axis1: f64) -> String {
    let mut parts = Vec::with_capacity(1024);
    for index in 0..1024 {
        if index == 0 {
            parts.push(format!("{axis0}"));
        } else if index == 1 {
            parts.push(format!("{axis1}"));
        } else {
            parts.push("0".to_string());
        }
    }
    format!("[{}]", parts.join(","))
}

fn query_embedding() -> Vec<f64> {
    let mut values = vec![0.0; 1024];
    values[0] = 1.0;
    values
}

async fn ranking_fusion_body(pool: PgPool) -> Result<(), String> {
    let store = PostgresMemory::from_pool_with(
        pool.clone(),
        false,
        &memory::MemoryEmbedConfig {
            embed_endpoint: Some(String::new()),
            ..memory::MemoryEmbedConfig::default()
        },
    )
    .map_err(|err| err.to_string())?;
    let options = capture_options();
    let dense = format!("dense {}", "alpharank ".repeat(30));
    let sparse = format!("sparse alpharank {}", "zzzzzz ".repeat(20));
    MemoryStore::capture(&store, &captured("fuse-dense", "user", &dense), &options)
        .await
        .map_err(|err| format!("capture dense: {err}"))?;
    MemoryStore::capture(&store, &captured("fuse-sparse", "user", &sparse), &options)
        .await
        .map_err(|err| format!("capture sparse: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0 WHERE content LIKE '%alpharank%'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("stamp alpharank: {err}"))?;
    let formula: Vec<(String, f64)> = sqlx::query_as(
        "SELECT CASE WHEN content LIKE 'dense %' THEN 'dense' ELSE 'sparse' END,
                (ts_rank_cd(content_tsv, plainto_tsquery('english', 'alpharank'), 32) * 0.3
                 + LEAST(length(content) / 1000.0, 1.0) * 0.3
                 + (EXP(-0.05 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0)
                    * (1.0 + 0.01 * LEAST(COALESCE(access_count, 0), 25))) * 0.3
                 + (CASE WHEN role = 'system' THEN 0.5 WHEN tool_name IS NOT NULL THEN 0.3 WHEN role = 'user' THEN 0.7 ELSE 0.6 END) * 0.1)::float8
         FROM ros_messages
         WHERE content LIKE '%alpharank%'
         ORDER BY 2 DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| format!("fts formula: {err}"))?;
    if formula.first().map(|(name, _)| name.as_str()) != Some("dense") {
        return Err(format!("fts formula order {formula:?}"));
    }
    let fts = store
        .search_with(
            "alpharank",
            &EngineOptions {
                mode: Some("fts".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("fts search: {err}"))?;
    let fts_order: Vec<String> = fts
        .hits
        .iter()
        .map(|hit| {
            if hit.content.starts_with("dense ") {
                "dense".to_string()
            } else {
                "sparse".to_string()
            }
        })
        .collect();
    if fts_order != ["dense", "sparse"] {
        return Err(format!("fts order {fts_order:?}"));
    }
    for hit in &fts.hits {
        let name = if hit.content.starts_with("dense ") {
            "dense"
        } else {
            "sparse"
        };
        let Some((_, expected)) = formula.iter().find(|(label, _)| label == name) else {
            return Err(format!("fts hit {name} missing from formula"));
        };
        if (hit.score - expected).abs() > 1e-3 {
            return Err(format!("fts {name} score {} formula {expected}", hit.score));
        }
    }
    let message_body = format!("fusiontoken {}", "m".repeat(40));
    let summary_body = format!("fusiontoken {}", "s".repeat(40));
    let summed = MemoryStore::capture(
        &store,
        &captured("fuse-sum", "user", &message_body),
        &options,
    )
    .await
    .map_err(|err| format!("capture fusion message: {err}"))?;
    sqlx::query(
        "INSERT INTO ros_summaries (conversation_id, kind, depth, content, message_count)
         VALUES ($1::uuid, 'leaf', 0, $2, 1)",
    )
    .bind(&summed.conversation_id)
    .bind(&summary_body)
    .execute(&pool)
    .await
    .map_err(|err| format!("insert fusion summary: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0 WHERE content LIKE 'fusiontoken %'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("stamp fusion message: {err}"))?;
    sqlx::query(
        "UPDATE ros_summaries SET created_at = NOW(), access_count = 0 WHERE content LIKE 'fusiontoken %'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("stamp fusion summary: {err}"))?;
    let bonus = store
        .search_with(
            "fusiontoken",
            &EngineOptions {
                mode: Some("hybrid".to_string()),
                scope: Some("both".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("summary bonus search: {err}"))?;
    let bonus_types: Vec<&str> = bonus.hits.iter().map(|hit| hit.hit_type.as_str()).collect();
    if bonus_types != ["summary", "message"] {
        return Err(format!(
            "summary bonus order {bonus_types:?} scores {:?}",
            bonus.hits.iter().map(|hit| hit.score).collect::<Vec<_>>()
        ));
    }
    let summary_score = (1.0 / 22.0) * (1.0 + 0.36) * 1.3;
    let message_score = (1.0 / 21.0) * (1.0 + 0.37);
    if !near(bonus.hits[0].score, summary_score) || !near(bonus.hits[1].score, message_score) {
        return Err(format!(
            "summary bonus scores {:?} expected {summary_score} then {message_score}",
            bonus.hits.iter().map(|hit| hit.score).collect::<Vec<_>>()
        ));
    }
    let lead = format!("ftslead {}", "armword ".repeat(25));
    let both = format!("bothhit armword {}", "q".repeat(40));
    MemoryStore::capture(&store, &captured("fuse-arm-lead", "user", &lead), &options)
        .await
        .map_err(|err| format!("capture fts lead: {err}"))?;
    MemoryStore::capture(&store, &captured("fuse-arm-both", "user", &both), &options)
        .await
        .map_err(|err| format!("capture both arms: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0, embedding = $1::halfvec(1024) WHERE content LIKE 'bothhit %'",
    )
    .bind(pair_literal(1.0, 0.0))
    .execute(&pool)
    .await
    .map_err(|err| format!("embed bothhit: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0 WHERE content LIKE 'ftslead %'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("stamp fts lead: {err}"))?;
    let embedding = query_embedding();
    store.configure_embed(
        Some("http://127.0.0.1:9".to_string()),
        "text-embedding-3-small",
    );
    store.set_embed_fetch(std::sync::Arc::new(move |_call: EmbedCall| {
        let body = serde_json::json!({ "data": [{ "embedding": embedding.clone(), "index": 0 }] })
            .to_string();
        Box::pin(async move { Ok(EmbedResponse { status: 200, body }) })
            as std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<EmbedResponse, memory::FetchFail>>
                        + Send,
                >,
            >
    }));
    let arms = store
        .search_with(
            "armword",
            &EngineOptions {
                mode: Some("hybrid".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(10),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("competing arms: {err}"))?;
    let arm_order: Vec<&str> = arms
        .hits
        .iter()
        .map(|hit| {
            if hit.content.starts_with("bothhit ") {
                "both"
            } else {
                "lead"
            }
        })
        .collect();
    if arm_order != ["both", "lead"] {
        return Err(format!(
            "competing-arm order {arm_order:?} scores {:?}",
            arms.hits.iter().map(|hit| hit.score).collect::<Vec<_>>()
        ));
    }
    let both_score = (1.0 / 22.0 + 1.0 / 21.0) * (1.0 + 0.37);
    let lead_score = (1.0 / 21.0) * (1.0 + 0.37);
    if !near(arms.hits[0].score, both_score) || !near(arms.hits[1].score, lead_score) {
        return Err(format!(
            "competing-arm scores {:?} expected {both_score} then {lead_score}",
            arms.hits.iter().map(|hit| hit.score).collect::<Vec<_>>()
        ));
    }
    for index in 0..22 {
        let content = format!("rank-{index:02} {}", "rankword ".repeat(40 - index));
        MemoryStore::capture(
            &store,
            &captured(&format!("fuse-rank-{index}"), "user", &content),
            &options,
        )
        .await
        .map_err(|err| format!("capture rank {index}: {err}"))?;
        sqlx::query(
            "UPDATE ros_messages SET created_at = NOW(), access_count = 0, embedding = $1::halfvec(1024) WHERE content LIKE $2",
        )
        .bind(pair_literal(1.0, index as f64))
        .bind(format!("rank-{index:02} %"))
        .execute(&pool)
        .await
        .map_err(|err| format!("embed rank {index}: {err}"))?;
    }
    let weak_both = format!("rank-weakboth {}{}", "rankword ".repeat(2), "x".repeat(24));
    let weak_single = format!("rank-single rankword {}", "z".repeat(30));
    MemoryStore::capture(
        &store,
        &captured("fuse-weakboth", "user", &weak_both),
        &options,
    )
    .await
    .map_err(|err| format!("capture weak both: {err}"))?;
    MemoryStore::capture(
        &store,
        &captured("fuse-single", "user", &weak_single),
        &options,
    )
    .await
    .map_err(|err| format!("capture weak single: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0, embedding = $1::halfvec(1024) WHERE content LIKE 'rank-weakboth %'",
    )
    .bind(axis_literal(2))
    .execute(&pool)
    .await
    .map_err(|err| format!("embed weak both: {err}"))?;
    sqlx::query(
        "UPDATE ros_messages SET created_at = NOW(), access_count = 0 WHERE content LIKE 'rank-single %'",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("stamp weak single: {err}"))?;
    let gated = store
        .search_with(
            "rankword",
            &EngineOptions {
                mode: Some("hybrid".to_string()),
                scope: Some("messages".to_string()),
                limit: Some(30),
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|err| format!("gate search: {err}"))?;
    let top = gated
        .hits
        .first()
        .ok_or_else(|| "gate search returned nothing".to_string())?;
    if !top.content.starts_with("rank-00 ") {
        return Err(format!(
            "gate top {:?} score {}",
            top.content.chars().take(12).collect::<String>(),
            top.score
        ));
    }
    let Some(weak) = gated
        .hits
        .iter()
        .find(|hit| hit.content.starts_with("rank-weakboth "))
    else {
        return Err(format!(
            "gate dropped the two-arm tail; hits {}",
            gated.hits.len()
        ));
    };
    if weak.score >= top.score * 0.5 {
        return Err(format!(
            "two-arm tail {} is not below half of {}",
            weak.score, top.score
        ));
    }
    if gated
        .hits
        .iter()
        .any(|hit| hit.content.starts_with("rank-single "))
    {
        return Err(format!(
            "gate kept the single-arm tail score {}",
            gated
                .hits
                .iter()
                .find(|hit| hit.content.starts_with("rank-single "))
                .map(|hit| hit.score)
                .unwrap_or(0.0)
        ));
    }
    Ok(())
}

#[tokio::test]
async fn ranking_fusion() {
    with_schema("ranking_fusion", "rr2b_fuse", ranking_fusion_body).await;
}

fn advisory_key_sql(column: &str) -> String {
    format!(
        "{column}.classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
         AND {column}.objid::bigint = (hashtextextended($1, 0) & 4294967295)
         AND {column}.objsubid = 1
         AND {column}.locktype = 'advisory'"
    )
}

async fn cancelled_taxonomy_body(pool: PgPool) -> Result<(), String> {
    let store = PostgresMemory::from_pool_with(
        pool.clone(),
        false,
        &memory::MemoryEmbedConfig {
            embed_endpoint: Some(String::new()),
            ..memory::MemoryEmbedConfig::default()
        },
    )
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "CREATE FUNCTION rr2b_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("hold function: {err}"))?;
    sqlx::query(
        "CREATE TRIGGER rr2b_hold_ins AFTER INSERT ON ros_tag_taxonomy FOR EACH ROW EXECUTE FUNCTION rr2b_hold()",
    )
    .execute(&pool)
    .await
    .map_err(|err| format!("hold trigger: {err}"))?;
    let key = format!("c{}", std::process::id());
    let lock_name = format!("ros_tag_taxonomy:{key}");
    let tags = store.tag_conn();
    let task_tags = tags.clone();
    let task_key = key.clone();
    let task = tokio::spawn(async move {
        memory::tags::upsert_taxonomy(
            &task_tags,
            &memory::tags::UpsertTaxonomy {
                key: task_key,
                value: "blocked".to_string(),
                display: None,
                parent: memory::tags::ParentSet::Omitted,
                aliases: None,
                state: None,
                reason: Some("cancel".to_string()),
            },
            None,
        )
        .await
    });
    let waiter = format!(
        "SELECT a.pid FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid = a.pid AND l.granted
         WHERE a.pid <> pg_backend_pid()
           AND a.state = 'active'
           AND a.wait_event_type = 'Timeout'
           AND {}
         LIMIT 1",
        advisory_key_sql("l")
    );
    let mut holder = pool
        .acquire()
        .await
        .map_err(|err| format!("acquire holder: {err}"))?;
    let mut seen = false;
    for _ in 0..50 {
        let pid: Option<i32> = sqlx::query_scalar(audited(waiter.clone()))
            .bind(&lock_name)
            .fetch_optional(&mut *holder)
            .await
            .map_err(|err| format!("wait for taxonomy insert: {err}"))?;
        if pid.is_some() {
            seen = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    if !seen {
        task.abort();
        let joined = task.await;
        return Err(format!(
            "upsert did not reach the taxonomy insert: {joined:?}"
        ));
    }
    task.abort();
    let _ = task.await;
    drop(holder);
    let granted = format!(
        "SELECT count(*)::bigint FROM pg_locks l WHERE l.granted AND {}",
        advisory_key_sql("l")
    );
    let mut released = false;
    for _ in 0..80 {
        let count: i64 = sqlx::query_scalar(audited(granted.clone()))
            .bind(&lock_name)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("advisory count: {err}"))?;
        if count == 0 {
            released = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    if !released {
        return Err("cancelled taxonomy transaction kept the advisory lock".to_string());
    }
    let kept: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM ros_tag_taxonomy WHERE key = $1 AND value = 'blocked'",
    )
    .bind(&key)
    .fetch_one(&pool)
    .await
    .map_err(|err| format!("blocked row: {err}"))?;
    if kept != 0 {
        return Err(format!("cancelled taxonomy insert persisted {kept} rows"));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut first = None;
    let mut second = None;
    while tokio::time::Instant::now() < deadline && (first.is_none() || second.is_none()) {
        if first.is_none() {
            first = pool.try_acquire();
        }
        if second.is_none() {
            second = pool.try_acquire();
        }
        if first.is_some() && second.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let mut first = first.ok_or_else(|| "pool withheld a connection after cancel".to_string())?;
    let mut second =
        second.ok_or_else(|| "pool withheld the second connection after cancel".to_string())?;
    for conn in [&mut first, &mut second] {
        let txid: Option<i64> = sqlx::query_scalar("SELECT txid_current_if_assigned()")
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| format!("txid: {err}"))?;
        if txid.is_some() {
            return Err("cancelled taxonomy transaction returned an open transaction".to_string());
        }
    }
    drop(first);
    drop(second);
    let mut proof = pool
        .acquire()
        .await
        .map_err(|err| format!("proof acquire: {err}"))?;
    sqlx::query("BEGIN")
        .execute(&mut *proof)
        .await
        .map_err(|err| format!("proof begin: {err}"))?;
    sqlx::query("SET LOCAL lock_timeout = '2s'")
        .execute(&mut *proof)
        .await
        .map_err(|err| format!("proof timeout: {err}"))?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&lock_name)
        .execute(&mut *proof)
        .await
        .map_err(|err| format!("advisory lock still held: {err}"))?;
    sqlx::query("COMMIT")
        .execute(&mut *proof)
        .await
        .map_err(|err| format!("proof commit: {err}"))?;
    drop(proof);
    sqlx::query("DROP TRIGGER rr2b_hold_ins ON ros_tag_taxonomy")
        .execute(&pool)
        .await
        .map_err(|err| format!("drop trigger: {err}"))?;
    memory::tags::upsert_taxonomy(
        &tags,
        &memory::tags::UpsertTaxonomy {
            key: key.clone(),
            value: "kept".to_string(),
            display: None,
            parent: memory::tags::ParentSet::Omitted,
            aliases: None,
            state: None,
            reason: None,
        },
        None,
    )
    .await
    .map_err(|err| format!("follow-up upsert: {err}"))?;
    let saved: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM ros_tag_taxonomy WHERE key = $1 AND value = 'kept'",
    )
    .bind(&key)
    .fetch_one(&pool)
    .await
    .map_err(|err| format!("kept row: {err}"))?;
    if saved != 1 {
        return Err(format!("follow-up upsert saved {saved}"));
    }
    Ok(())
}

#[tokio::test]
async fn cancelled_taxonomy_rolls_back() {
    with_schema(
        "cancelled_taxonomy_rolls_back",
        "rr2b_tax",
        cancelled_taxonomy_body,
    )
    .await;
}
