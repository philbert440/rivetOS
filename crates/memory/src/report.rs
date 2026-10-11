use chrono::{DateTime, Local, Utc};
use serde_json::{Map, Value, json};

pub const FULL_WINDOW: i64 = 10;
pub const IDLE_MINUTES: i64 = 15;
pub const STALE_MINUTES: i64 = 4 * 24 * 60;
pub const STALE_MIN_BATCH: i64 = 2;
pub const MIN_BATCH_SIZE: i64 = 5;
pub const HEARTBEAT_SESSION_PREFIX: &str = "heartbeat:";
pub const BROWSE_CONTENT_LIMIT: usize = 500;
pub const BROWSE_TOOL_RESULT_LIMIT: usize = 800;

pub const QUEUE_HEALTH_SQL: &str = "SELECT t.identifier AS task,
                    COUNT(*) FILTER (WHERE j.attempts < j.max_attempts
                      AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
                      AND j.run_at <= now())::text AS pending,
                    COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts)::text AS dead,
                    COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts AND j.created_at > now() - interval '24 hours')::text AS recent_dead,
                    COUNT(*) FILTER (WHERE j.attempts < j.max_attempts AND j.locked_at >= now() - interval '4 hours')::text AS running,
                    COUNT(*) FILTER (WHERE j.attempts < j.max_attempts AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours') AND j.run_at > now())::text AS scheduled,
                    CASE WHEN MIN(j.run_at) FILTER (
                      WHERE j.attempts < j.max_attempts
                        AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
                        AND j.run_at <= now()
                    ) IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - MIN(j.run_at) FILTER (
                      WHERE j.attempts < j.max_attempts
                        AND (j.locked_at IS NULL OR j.locked_at < now() - interval '4 hours')
                        AND j.run_at <= now()
                    ))) / 60) END AS oldest_pending_age_min,
                    LEFT((array_agg(j.last_error ORDER BY j.updated_at DESC NULLS LAST)
                      FILTER (WHERE j.attempts >= j.max_attempts))[1], 120) AS last_error
               FROM graphile_worker._private_jobs j
               JOIN graphile_worker._private_tasks t ON t.id = j.task_id
              GROUP BY t.identifier
              ORDER BY COUNT(*) FILTER (WHERE j.attempts >= j.max_attempts) DESC,
                       COUNT(*) FILTER (WHERE j.attempts < j.max_attempts) DESC";

pub const EMBEDDING_HEALTH_SQL: &str = "
          SELECT
            (SELECT COUNT(*) FROM ros_messages
              WHERE embedding IS NULL
                AND embed_status IS DISTINCT FROM 'unembeddable'
                AND embed_status IS DISTINCT FROM 'failed'
                AND (
                  (content IS NOT NULL AND LENGTH(content) > 0)
                  OR (tool_result IS NOT NULL AND LENGTH(tool_result) > 0)
                )) AS msg_queue,
            (SELECT COUNT(*) FROM ros_summaries
              WHERE embedding IS NULL
                AND embed_status IS DISTINCT FROM 'unembeddable'
                AND embed_status IS DISTINCT FROM 'failed'
                AND content IS NOT NULL) AS sum_queue,
            (SELECT COUNT(*) FROM ros_messages
              WHERE embedding IS NULL AND embed_status = 'unembeddable') +
            (SELECT COUNT(*) FROM ros_summaries
              WHERE embedding IS NULL AND embed_status = 'unembeddable') AS unembeddable,
            (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND embed_status = 'failed') +
            (SELECT COUNT(*) FROM ros_summaries WHERE embedding IS NULL AND embed_status = 'failed') AS failed,
            (SELECT COUNT(*) FROM ros_messages WHERE embedding IS NULL AND embed_status = 'failed'
              AND created_at > now() - interval '7 days') +
            (SELECT COUNT(*) FROM ros_summaries WHERE embedding IS NULL AND embed_status = 'failed'
              AND created_at > now() - interval '7 days') AS recent_failed
        ";

pub const OWNER_COLUMN_PROBE_SQL: &str = "SELECT count(*)::int AS n FROM pg_attribute
  WHERE attname = 'owner_user_id' AND NOT attisdropped
    AND attrelid IN (to_regclass('ros_conversations'), to_regclass('ros_messages'))";

pub fn sql_not_heartbeat_conversation(alias: &str) -> String {
    format!(
        "({alias}.session_key IS NULL OR {alias}.session_key NOT LIKE '{HEARTBEAT_SESSION_PREFIX}%')"
    )
}

pub fn tagged_conversations_sql(key_idx: usize, value_idx: usize) -> String {
    format!(
        "(SELECT COALESCE(tc.id, ts.conversation_id)
             FROM ros_tags tt
             LEFT JOIN ros_conversations tc ON tt.entity_type = 'conversation' AND tc.id = tt.entity_id
             LEFT JOIN ros_summaries ts ON tt.entity_type = 'summary' AND ts.id = tt.entity_id
            WHERE tt.key = ${key_idx} AND tt.value = ${value_idx} AND tt.state = 'accepted')"
    )
}

pub fn compaction_sql() -> String {
    let not_heartbeat = sql_not_heartbeat_conversation("c");
    format!(
        "WITH per_conv AS (
             SELECT c.id AS conversation_id, c.updated_at,
                    COUNT(m.id) AS qualifying
             FROM ros_conversations c
             JOIN ros_messages m ON m.conversation_id = c.id
             LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
             WHERE ss.summary_id IS NULL
               AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10)
                    OR m.tool_name IS NOT NULL)
               AND {not_heartbeat}
             GROUP BY c.id
           )
           SELECT
             COALESCE(SUM(qualifying) FILTER (
               WHERE qualifying >= $1
                  OR (qualifying >= $2 AND updated_at < NOW() - ($3 || ' minutes')::interval)
                  OR (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ), 0) AS eligible_msgs,
             COUNT(*) FILTER (
               WHERE qualifying >= $1
                  OR (qualifying >= $2 AND updated_at < NOW() - ($3 || ' minutes')::interval)
                  OR (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ) AS eligible_convs,
             COALESCE(SUM(qualifying) FILTER (
               WHERE qualifying >= $2 AND qualifying < $1
                 AND updated_at >= NOW() - ($3 || ' minutes')::interval
             ), 0) AS active_tail_msgs,
             COUNT(*) FILTER (
               WHERE qualifying >= $2 AND qualifying < $1
                 AND updated_at >= NOW() - ($3 || ' minutes')::interval
             ) AS active_tail_convs,
             COALESCE(SUM(qualifying) FILTER (
               WHERE qualifying < $2
                 AND NOT (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ), 0) AS below_floor_msgs,
             COUNT(*) FILTER (
               WHERE qualifying < $2
                 AND NOT (qualifying >= $4 AND updated_at < NOW() - ($5 || ' minutes')::interval)
             ) AS below_floor_convs
           FROM per_conv"
    )
}

pub fn en_us(n: i64) -> String {
    let neg = n < 0;
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    let body: String = out.chars().rev().collect();
    if neg { format!("-{body}") } else { body }
}

pub fn fmt_queue_age(minutes: f64) -> String {
    if !minutes.is_finite() || minutes < 0.0 {
        return "0m".to_string();
    }
    if minutes < 60.0 {
        return format!("{}m", minutes.floor() as i64);
    }
    if minutes < 60.0 * 24.0 {
        return format!("{}h", (minutes / 60.0).floor() as i64);
    }
    format!("{}d", (minutes / 60.0 / 24.0).floor() as i64)
}

pub fn format_js_iso(dt: DateTime<Utc>) -> String {
    let ms = dt.timestamp_subsec_millis();
    format!("{}.{:03}Z", dt.format("%Y-%m-%dT%H:%M:%S"), ms)
}

pub fn fmt_date(iso: Option<&str>) -> String {
    iso.and_then(|s| s.get(..10)).unwrap_or("?").to_string()
}

pub fn time_since(then_ms: i64, now_ms: i64) -> String {
    let ms = now_ms.saturating_sub(then_ms);
    if ms < 60_000 {
        "just now".to_string()
    } else if ms < 3_600_000 {
        format!("{}m ago", ms / 60_000)
    } else if ms < 86_400_000 {
        format!("{}h ago", ms / 3_600_000)
    } else {
        format!("{}d ago", ms / 86_400_000)
    }
}

#[derive(Debug, Clone)]
pub struct QueueRow {
    pub task: String,
    pub pending: i64,
    pub dead: i64,
    pub running: Option<i64>,
    pub scheduled: Option<i64>,
    pub oldest_pending_age_min: Option<f64>,
    pub last_error: Option<String>,
    pub recent_dead: i64,
}

pub fn format_queue_health(rows: &[QueueRow]) -> String {
    if rows.is_empty() {
        return "\n**Queue health (graphile-worker):**\n  (empty)".to_string();
    }
    let lines = rows
        .iter()
        .map(|r| {
            let age = if r.oldest_pending_age_min.is_some() && r.pending > 0 {
                format!(
                    " (oldest {})",
                    fmt_queue_age(r.oldest_pending_age_min.unwrap_or(0.0))
                )
            } else {
                String::new()
            };
            let dead_part = if r.dead > 0 {
                format!(", ⚠️ {} dead", en_us(r.dead))
            } else {
                format!(", {} dead", r.dead)
            };
            let err = if r.dead > 0 {
                r.last_error
                    .as_ref()
                    .map(|e| format!(" — {e}"))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let running = r
                .running
                .map(|n| format!(", {n} running"))
                .unwrap_or_default();
            let scheduled = r
                .scheduled
                .map(|n| format!(", {n} scheduled"))
                .unwrap_or_default();
            format!(
                "  {}: {} pending{age}{dead_part}{running}{scheduled}{err}",
                r.task,
                en_us(r.pending)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n**Queue health (graphile-worker):**\n{lines}")
}

pub fn format_embedding_queue(
    msg_queue: i64,
    sum_queue: i64,
    unembeddable: i64,
    failed: i64,
) -> String {
    let queue_total = msg_queue + sum_queue;
    let queue_status = if failed > 0 {
        format!("⚠️ {failed} failed; {queue_total} pending")
    } else if queue_total == 0 {
        "✅ caught up".to_string()
    } else if queue_total < 50 {
        format!("⏳ {queue_total} pending")
    } else {
        format!("⚠️ {queue_total} pending (backlog)")
    };
    let extra = if unembeddable > 0 {
        format!(
            "\n  Unembeddable (excluded by design): {}",
            en_us(unembeddable)
        )
    } else {
        String::new()
    };
    format!(
        "\n**Embedding queue:** {queue_status}\n  Messages awaiting embedding: {}\n  Summaries awaiting embedding: {}{extra}",
        en_us(msg_queue),
        en_us(sum_queue)
    )
}

pub fn format_unsummarized(
    eligible_msgs: i64,
    eligible_convs: i64,
    active_msgs: i64,
    active_convs: i64,
    below_msgs: i64,
    below_convs: i64,
) -> String {
    let total = eligible_msgs + active_msgs + below_msgs;
    let mark = if eligible_convs == 0 {
        "✅"
    } else if eligible_msgs < 100 {
        "⏳"
    } else {
        "⚠️"
    };
    let stale_days = (STALE_MINUTES as f64 / 1440.0).round() as i64;
    format!(
        "\n**Unsummarized messages:** {} total\n  Eligible for compaction: {} msgs in {} convs {mark}\n    (≥{FULL_WINDOW} unsummarized, OR ≥{MIN_BATCH_SIZE} + idle ≥{IDLE_MINUTES}m, OR ≥{STALE_MIN_BATCH} + idle ≥{stale_days}d)\n  Active tail: {} msgs in {} convs (will flush when idle)\n  Below floor: {} msgs in {} convs (<{STALE_MIN_BATCH} qualifying, or not yet stale — won't compact yet)",
        en_us(total),
        en_us(eligible_msgs),
        en_us(eligible_convs),
        en_us(active_msgs),
        en_us(active_convs),
        en_us(below_msgs),
        en_us(below_convs),
    )
}

pub fn assemble_stats(parts: &[Option<&str>]) -> String {
    let mut out = vec!["## Memory System Health".to_string()];
    for part in parts.iter().flatten() {
        if !part.is_empty() {
            out.push((*part).to_string());
        }
    }
    out.join("\n")
}

pub fn health_cached(now_ms: i64, last_ms: i64, connected: bool) -> Option<bool> {
    if last_ms > 0 && now_ms.saturating_sub(last_ms) < 30_000 {
        Some(connected)
    } else {
        None
    }
}

pub fn is_missing_schema_code(code: Option<&str>) -> bool {
    matches!(code, Some("42P01" | "42703"))
}

pub fn embedding_probe_reason(endpoint: Option<&str>) -> &'static str {
    match endpoint {
        Some(value) if !value.is_empty() => "embedding endpoint probe is deferred to slice 2b",
        _ => "embedding endpoint not configured",
    }
}

pub fn browse_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(50).clamp(1, 200)
}

pub fn history_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(100)
}

pub struct BrowseSql {
    pub sql: String,
    pub params: Vec<String>,
}

pub fn browse_sql(
    filter: &crate::store::BrowseFilter,
    since: Option<&str>,
    before: Option<&str>,
) -> Result<BrowseSql, String> {
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    let mut pi = 1usize;
    if let Some(tag) = filter.tag.as_deref() {
        let Some((key, value)) = crate::slug::parse_tag_literal(tag) else {
            return Err("tag must be key:value".to_string());
        };
        conditions.push(format!(
            "m.conversation_id IN {}",
            tagged_conversations_sql(pi, pi + 1)
        ));
        pi += 2;
        params.push(key);
        params.push(value);
    }
    if let Some(role) = filter.role.as_deref().filter(|s| !s.is_empty()) {
        conditions.push(format!("m.role = ${pi}"));
        pi += 1;
        params.push(role.to_string());
    }
    if let Some(agent) = filter.agent.as_deref().filter(|s| !s.is_empty()) {
        conditions.push(format!("m.agent = ${pi}"));
        pi += 1;
        params.push(agent.to_string());
    }
    if let Some(tool) = filter.tool_name.as_deref().filter(|s| !s.is_empty()) {
        conditions.push(format!("m.tool_name = ${pi}"));
        pi += 1;
        params.push(tool.to_string());
    }
    if let Some(since) = since {
        conditions.push(format!("m.created_at >= ${pi}::timestamptz"));
        pi += 1;
        params.push(since.to_string());
    }
    if let Some(before) = before {
        conditions.push(format!("m.created_at < ${pi}::timestamptz"));
        pi += 1;
        params.push(before.to_string());
    }
    let limit = browse_limit(filter.limit);
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT m.id, m.role, m.agent, m.content, m.created_at,
            m.conversation_id, c.session_key, m.tool_name
       FROM ros_messages m
       LEFT JOIN ros_conversations c ON c.id = m.conversation_id
       {where_sql}
       ORDER BY m.created_at DESC
       LIMIT {limit}"
    );
    let _ = pi;
    Ok(BrowseSql { sql, params })
}

pub fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Debug)]
pub struct BrowseToolSql {
    pub sql: String,
    pub params: Vec<String>,
    pub since: Option<String>,
    pub before: Option<String>,
    pub include_tools: bool,
    pub order_desc: bool,
    pub limit: i64,
    pub window_label: Option<String>,
}

#[derive(Debug)]
pub struct BrowseToolRow {
    pub id: String,
    pub role: String,
    pub agent: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub conversation_id: String,
    pub tool_name: Option<String>,
    pub tool_result: Option<String>,
    pub metadata: Option<Map<String, Value>>,
    pub tags: Vec<String>,
}

pub fn fmt_local_ts(dt: DateTime<Utc>) -> String {
    let local = dt.with_timezone(&Local);
    let body = local.format("%Y-%m-%d %H:%M:%S").to_string();
    let zone = local.format("%Z").to_string();
    if zone.is_empty() {
        body
    } else {
        format!("{body} {zone}")
    }
}

pub fn browse_tool_sql(
    args: &Map<String, Value>,
    now: DateTime<Local>,
) -> Result<BrowseToolSql, String> {
    let include_tools = args.get("include_tools") == Some(&Value::Bool(true));
    let window_label = args
        .get("window")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let since_arg = args.get("since").and_then(Value::as_str);
    let before_arg = args.get("before").and_then(Value::as_str);
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    let mut pi = 1usize;
    if let Some(conversation_id) = args
        .get("conversation_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("m.conversation_id = ${pi}::uuid"));
        pi += 1;
        params.push(conversation_id.to_string());
    }
    if let Some(agent) = args
        .get("agent")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("m.agent = ${pi}"));
        pi += 1;
        params.push(agent.to_string());
    }
    if let Some(tag) = args.get("tag").and_then(Value::as_str) {
        let trimmed = protocol::js::js_trim(tag);
        if !trimmed.is_empty() {
            let Some((key, value)) = crate::slug::parse_tag_literal(tag) else {
                return Err(format!(
                    "Browse failed: tag must be key:value (got \"{tag}\")"
                ));
            };
            conditions.push(format!(
                "m.conversation_id IN {}",
                tagged_conversations_sql(pi, pi + 1)
            ));
            pi += 2;
            params.push(key);
            params.push(value);
        }
    }
    if !include_tools {
        conditions.push("m.role <> 'tool'".to_string());
    }
    let (since, before) =
        crate::window::apply_window_args(window_label.as_deref(), since_arg, before_arg, now)?;
    if let Some(since) = &since {
        conditions.push(format!("m.created_at >= ${pi}::timestamptz"));
        pi += 1;
        params.push(since.clone());
    }
    if let Some(before) = &before {
        conditions.push(format!("m.created_at < ${pi}::timestamptz"));
        pi += 1;
        params.push(before.clone());
    }
    let limit = browse_limit(args.get("limit").and_then(Value::as_i64));
    let order_desc = args.get("order").and_then(Value::as_str) != Some("asc");
    let order = if order_desc { "DESC" } else { "ASC" };
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT m.id, m.role, m.agent, m.content, m.created_at,
            m.conversation_id, m.tool_name, m.tool_result, m.metadata
       FROM ros_messages m
       {where_sql}
       ORDER BY m.created_at {order}
       LIMIT {limit}"
    );
    let _ = pi;
    Ok(BrowseToolSql {
        sql,
        params,
        since,
        before,
        include_tools,
        order_desc,
        limit,
        window_label,
    })
}

fn browse_filter_note(built: &BrowseToolSql) -> String {
    let mut parts = Vec::new();
    let window = built
        .window_label
        .as_deref()
        .filter(|value| !value.is_empty());
    if window.is_some() && (built.since.is_some() || built.before.is_some()) {
        if let Some(window) = window {
            parts.push(format!("window=\"{window}\""));
        }
        if let Some(since) = &built.since {
            parts.push(format!("since={since}"));
        }
        if let Some(before) = &built.before {
            parts.push(format!("before={before}"));
        }
    } else if built.since.is_some() || built.before.is_some() {
        if let Some(since) = &built.since {
            parts.push(format!("since={since}"));
        }
        if let Some(before) = &built.before {
            parts.push(format!("before={before}"));
        }
    }
    if !built.include_tools {
        parts.push("tools excluded (include_tools=true to show)".to_string());
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("\n_{}_", parts.join(" "))
    }
}

pub fn render_browse_tool(rows: &[BrowseToolRow], built: &BrowseToolSql) -> String {
    let note = browse_filter_note(built);
    if rows.is_empty() {
        return format!(
            "No messages found.{note}\n_Try a wider window, drop agent/conversation filters, flip order, pass include_tools=true, or use memory_search for topic recall._"
        );
    }
    let which = if built.order_desc { "newest" } else { "oldest" };
    let mut header = format!("## Messages ({} returned, {which} first)", rows.len());
    header.push_str(&note);
    if rows.len() as i64 >= built.limit {
        header.push_str(&format!(
            "\n_Hit limit={}. Flip order, raise limit (max 200), or narrow since/before/window._",
            built.limit
        ));
    }
    let lines = rows.iter().map(|row| {
        let ts = fmt_local_ts(row.created_at);
        let tool = match row.tool_name.as_deref() {
            Some(name) if !name.is_empty() => format!(" [tool: {name}]"),
            _ => String::new(),
        };
        let tag_note = if row.tags.is_empty() {
            String::new()
        } else {
            format!(" tags: {}", row.tags.join(", "))
        };
        let body = crate::get_full::format_browse_message_body(
            &row.id,
            &row.content,
            row.tool_name.as_deref(),
            row.tool_result.as_deref(),
            row.metadata.as_ref(),
            BROWSE_CONTENT_LIMIT,
            BROWSE_TOOL_RESULT_LIMIT,
        );
        format!("[{ts}] {}/{}{tool}{tag_note}\n{body}", row.agent, row.role)
    });
    format!(
        "{header}\n\n{}",
        lines.collect::<Vec<_>>().join("\n\n---\n\n")
    )
}

pub fn memory_tool_parameters(name: &str) -> Value {
    match name {
        "memory_browse" => {
            let mut params = json!({
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "Browse a specific conversation by ID"
                    },
                    "since": {
                        "type": "string",
                        "description": "Show messages after this time (ISO timestamp, e.g. 2025-03-15T10:00:00Z). Must be UTC — bare dates like \"2025-03-15\" are UTC midnight (= previous evening US local). Prefer window=."
                    },
                    "before": {
                        "type": "string",
                        "description": "Show messages before this time (ISO timestamp, e.g. 2025-03-16). Same UTC gotcha as since. Prefer window=."
                    },
                    "window": {
                        "type": "string",
                        "enum": [],
                        "description": "Shortcut for time-bounded windows (today, yesterday, this_morning, this_week, last_24h, last_7d, last_14d). last_7d/last_14d are rolling (prefer over this_week early in the week). Resolves to (since, before) in the SERVER local timezone — no TZ math required. Used only when neither since nor before is provided."
                    },
                    "agent": {
                        "type": "string",
                        "description": "Filter by agent (opus, grok, etc.)"
                    },
                    "tag": {
                        "type": "string",
                        "description": "Only conversations carrying this accepted key:value tag (e.g. project:acmeapp). See memory_tags."
                    },
                    "include_tools": {
                        "type": "boolean",
                        "description": "Include role=tool rows (tool calls/results). Default false — browse returns user/assistant/system only so a limit=50 window is not flooded by tool noise. Set true when debugging capture, harness wiring, or tool failures."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Max messages to return (default: 50, max: 200)"
                    },
                    "order": {
                        "type": "string",
                        "enum": ["asc", "desc"],
                        "description": "Chronological order — asc (oldest first) or desc (newest first, default)"
                    }
                },
                "required": []
            });
            if let Some(window) = params
                .get_mut("properties")
                .and_then(Value::as_object_mut)
                .and_then(|props| props.get_mut("window"))
                .and_then(Value::as_object_mut)
            {
                window.insert(
                    "enum".to_string(),
                    Value::Array(
                        crate::window::WINDOW_CHOICES
                            .iter()
                            .map(|choice| Value::String((*choice).to_string()))
                            .collect(),
                    ),
                );
            }
            params
        }
        "memory_stats" => json!({
            "type": "object",
            "properties": {
                "agent": {
                    "type": "string",
                    "description": "Filter stats to a specific agent (optional)"
                }
            },
            "required": []
        }),
        "memory_get_full" => json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Row id, as shown by memory_search / memory_browse truncation hints"
                }
            },
            "required": ["id"]
        }),
        _ => Value::Object(Map::new()),
    }
}
