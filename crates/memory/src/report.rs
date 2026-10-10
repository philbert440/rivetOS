use serde_json::{Map, Value};

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
    format!("({alias}.session_key IS NULL OR {alias}.session_key NOT LIKE '{HEARTBEAT_SESSION_PREFIX}%')")
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

pub fn format_js_iso(dt: chrono::DateTime<chrono::Utc>) -> String {
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
                format!(" (oldest {})", fmt_queue_age(r.oldest_pending_age_min.unwrap_or(0.0)))
            } else {
                String::new()
            };
            let dead_part = if r.dead > 0 {
                format!(", ⚠️ {} dead", en_us(r.dead))
            } else {
                format!(", {} dead", r.dead)
            };
            let err = if r.dead > 0 {
                r.last_error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default()
            } else {
                String::new()
            };
            let running = r.running.map(|n| format!(", {n} running")).unwrap_or_default();
            let scheduled = r.scheduled.map(|n| format!(", {n} scheduled")).unwrap_or_default();
            format!("  {}: {} pending{age}{dead_part}{running}{scheduled}{err}", r.task, en_us(r.pending))
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n**Queue health (graphile-worker):**\n{lines}")
}

pub fn format_embedding_queue(msg_queue: i64, sum_queue: i64, unembeddable: i64, failed: i64) -> String {
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
        format!("\n  Unembeddable (excluded by design): {}", en_us(unembeddable))
    } else {
        String::new()
    };
    format!(
        "\n**Embedding queue:** {queue_status}\n  Messages awaiting embedding: {}\n  Summaries awaiting embedding: {}{extra}",
        en_us(msg_queue),
        en_us(sum_queue),
        extra
    )
}

pub fn format_unsummarized(eligible_msgs: i64, eligible_convs: i64, active_msgs: i64, active_convs: i64, below_msgs: i64, below_convs: i64) -> String {
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

pub fn browse_sql(filter: &crate::store::BrowseFilter, since: Option<&str>, before: Option<&str>) -> Result<BrowseSql, String> {
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    let mut pi = 1usize;
    if let Some(tag) = filter.tag.as_deref() {
        let Some((key, value)) = crate::slug::parse_tag_literal(tag) else {
            return Err("tag must be key:value".to_string());
        };
        conditions.push(format!("m.conversation_id IN {}", tagged_conversations_sql(pi, pi + 1)));
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
