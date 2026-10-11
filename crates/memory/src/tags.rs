use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use std::pin::Pin;

use parking_lot::Mutex;
use protocol::js::js_trim;
use serde_json::Value;

use crate::rows::{Bind, Cell, QueryResult, cell, text_cell};
use crate::slug::{normalize_tag_key, normalize_tag_value, parse_tag_literal, split_tag_literal};

pub const REVIEWED_TAG_SOURCES: [&str; 3] = ["user", "model", "import"];
const TAXONOMY_MAX_DEPTH: usize = 32;
const TAG_COLUMNS: &str = "id, entity_type, entity_id, key, value, display, source, state, confidence, proposed_by, reason, decided_by, decided_at, created_at, updated_at";

#[derive(Debug, Clone, PartialEq)]
pub struct Tag {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub key: String,
    pub value: String,
    pub display: String,
    pub source: String,
    pub state: String,
    pub confidence: Option<f64>,
    pub proposed_by: String,
    pub reason: String,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingTag {
    pub tag: Tag,
    pub action: Option<String>,
    pub session_key: Option<String>,
    pub title: Option<String>,
    pub agent: Option<String>,
    pub conversation_id: Option<String>,
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TagCount {
    pub key: String,
    pub value: String,
    pub display: String,
    pub conversations: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaxonomyEntry {
    pub key: String,
    pub value: String,
    pub display: String,
    pub parent_value: Option<String>,
    pub aliases: Vec<String>,
    pub state: String,
    pub source: String,
    pub reason: String,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct ListTagsOptions {
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub key: Option<String>,
    pub value: Option<String>,
    pub states: Option<Vec<String>>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone)]
pub enum ParentSet {
    Omitted,
    Clear,
    Value(String),
}

#[derive(Debug, Clone)]
pub struct UpsertTaxonomy {
    pub key: String,
    pub value: String,
    pub display: Option<String>,
    pub parent: ParentSet,
    pub aliases: Option<Vec<String>>,
    pub state: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AddTagInput {
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub session_key: Option<String>,
    pub agent: Option<String>,
    pub tag: Option<String>,
    pub key: Option<String>,
    pub value: Option<String>,
    pub display: Option<String>,
    pub reason: Option<String>,
}

pub type Handler = Arc<dyn Fn(&str, &[Bind]) -> Result<QueryResult, String> + Send + Sync>;
pub type TagCalls = Arc<Mutex<Vec<(String, Vec<Bind>)>>>;

#[derive(Clone)]
pub struct TagConn {
    handler: Handler,
    pub calls: TagCalls,
    connect_to: Option<Arc<TagConn>>,
    total_count: Option<i64>,
    pub releases: Arc<AtomicUsize>,
}

impl TagConn {
    pub fn from_handler(handler: Handler) -> Self {
        Self {
            handler,
            calls: Arc::new(Mutex::new(Vec::new())),
            connect_to: None,
            total_count: None,
            releases: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn with_pool(self, client: TagConn) -> Self {
        Self {
            connect_to: Some(Arc::new(client)),
            total_count: Some(1),
            ..self
        }
    }

    pub async fn query(&self, sql: &str, params: &[Bind]) -> Result<QueryResult, String> {
        self.calls.lock().push((sql.to_string(), params.to_vec()));
        (self.handler)(sql, params)
    }
}

async fn in_transaction<T, F>(db: &TagConn, lock_name: Option<&str>, f: F) -> Result<T, String>
where
    T: Send,
    F: for<'a> FnOnce(&'a TagConn) -> Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>,
{
    let Some(client) = db.connect_to.clone().filter(|_| db.total_count.is_some()) else {
        return f(db).await;
    };
    let out = async {
        client.query("BEGIN", &[]).await?;
        if let Some(name) = lock_name {
            client
                .query(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                    &[Bind::Text(name.to_string())],
                )
                .await?;
        }
        let value = f(&client).await?;
        client.query("COMMIT", &[]).await?;
        Ok(value)
    }
    .await;
    if out.is_err() {
        let _ = client.query("ROLLBACK", &[]).await;
    }
    client.releases.fetch_add(1, Ordering::SeqCst);
    out
}

use std::future::Future;

pub fn is_native_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut idx = 0usize;
    for (group_i, group) in groups.iter().enumerate() {
        if group_i > 0 {
            if bytes.get(idx) != Some(&b'-') {
                return false;
            }
            idx += 1;
        }
        for _ in 0..*group {
            let Some(byte) = bytes.get(idx) else {
                return false;
            };
            if !byte.is_ascii_hexdigit() {
                return false;
            }
            idx += 1;
        }
    }
    idx == bytes.len()
}

fn like_escape(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn is_harness(value: &str) -> bool {
    protocol::HARNESS_IDS.contains(&value)
}

pub fn session_key_aliases(key: &str) -> Vec<String> {
    let mut out = vec![key.to_string()];
    let Some(colon) = key.find(':') else {
        return out;
    };
    if colon == 0 || colon + 1 == key.len() {
        return out;
    }
    let harness = &key[..colon];
    if !is_harness(harness) {
        return out;
    }
    let native = &key[colon + 1..];
    let tail = native.rsplit_once('/').map(|(_, tail)| tail).unwrap_or("");
    if !tail.is_empty() && is_native_uuid(tail) {
        out.push(format!("{harness}:{tail}"));
        out.push(tail.to_string());
    } else {
        out.push(native.to_string());
    }
    dedupe_strings(out)
}

pub fn session_key_matchers(key: &str) -> (Vec<String>, Vec<String>) {
    let exact = session_key_aliases(key);
    let mut like = Vec::new();
    if is_native_uuid(key) {
        like.push(format!("%:{key}"));
        like.push(format!("%/{key}"));
    } else if let Some(colon) = key.find(':')
        && colon > 0
    {
        let native = &key[colon + 1..];
        let tail = native
            .rfind('/')
            .map(|i| &native[i + 1..])
            .unwrap_or(native);
        if is_native_uuid(tail) {
            like.push(format!("{}:%/{tail}", like_escape(&key[..colon])));
        }
    }
    (exact, like)
}

fn dedupe_strings(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

pub fn row_to_tag(row: &HashMap<String, Cell>) -> Tag {
    Tag {
        id: text_cell(row, "id"),
        entity_type: text_cell(row, "entity_type"),
        entity_id: text_cell(row, "entity_id"),
        key: text_cell(row, "key"),
        value: text_cell(row, "value"),
        display: text_cell(row, "display"),
        source: text_cell(row, "source"),
        state: text_cell(row, "state"),
        confidence: cell(row, "confidence").and_then(Cell::as_f64),
        proposed_by: text_cell(row, "proposed_by"),
        reason: text_cell(row, "reason"),
        decided_by: cell(row, "decided_by")
            .and_then(Cell::as_text)
            .map(str::to_string),
        decided_at: cell(row, "decided_at")
            .and_then(Cell::as_text)
            .map(str::to_string),
        created_at: text_cell(row, "created_at"),
        updated_at: text_cell(row, "updated_at"),
    }
}

fn row_to_taxonomy(row: &HashMap<String, Cell>) -> TaxonomyEntry {
    let aliases = match cell(row, "aliases") {
        Some(Cell::Json(Value::Array(items))) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    TaxonomyEntry {
        key: text_cell(row, "key"),
        value: text_cell(row, "value"),
        display: text_cell(row, "display"),
        parent_value: cell(row, "parent_value")
            .and_then(Cell::as_text)
            .map(str::to_string),
        aliases,
        state: text_cell(row, "state"),
        source: text_cell(row, "source"),
        reason: text_cell(row, "reason"),
        decided_at: cell(row, "decided_at")
            .and_then(Cell::as_text)
            .map(str::to_string),
        created_at: text_cell(row, "created_at"),
        updated_at: text_cell(row, "updated_at"),
    }
}

pub async fn list_tags(db: &TagConn, opts: &ListTagsOptions) -> Result<Vec<Tag>, String> {
    let mut conds = Vec::new();
    let mut params = Vec::new();
    let bind = |params: &mut Vec<Bind>, value: Bind| -> String {
        params.push(value);
        format!("${}", params.len())
    };
    if let Some(entity_type) = &opts.entity_type {
        let slot = bind(&mut params, Bind::Text(entity_type.clone()));
        conds.push(format!("entity_type = {slot}"));
    }
    if let Some(entity_id) = &opts.entity_id {
        let slot = bind(&mut params, Bind::Text(entity_id.clone()));
        conds.push(format!("entity_id = {slot}"));
    }
    if let Some(key) = &opts.key {
        let slot = bind(&mut params, Bind::Text(normalize_tag_key(key)));
        conds.push(format!("key = {slot}"));
    }
    if let Some(value) = &opts.value {
        let slot = bind(&mut params, Bind::Text(normalize_tag_value(value)));
        conds.push(format!("value = {slot}"));
    }
    let states = opts
        .states
        .clone()
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| vec!["suggested".into(), "accepted".into()]);
    let state_slot = bind(&mut params, Bind::Texts(states));
    conds.push(format!("state = ANY({state_slot}::text[])"));
    let limit = opts.limit.unwrap_or(200).clamp(1, 1000);
    let limit_slot = bind(&mut params, Bind::I64(limit));
    let sql = format!(
        "SELECT {TAG_COLUMNS} FROM ros_tags
      WHERE {}
      ORDER BY state = 'accepted' DESC, key, value, created_at DESC
      LIMIT {limit_slot}",
        conds.join(" AND ")
    );
    let result = db.query(&sql, &params).await?;
    Ok(result.rows.iter().map(row_to_tag).collect())
}

pub async fn pending_tags(db: &TagConn, limit: i64) -> Result<Vec<PendingTag>, String> {
    let limit = limit.clamp(1, 500);
    let sql = format!(
        "SELECT {cols},
            t.removal_state, t.removal_reason,
            COALESCE(c.session_key, sc.session_key) AS session_key,
            COALESCE(c.title, sc.title) AS title,
            COALESCE(c.agent, sc.agent) AS agent,
            COALESCE(c.id, s.conversation_id) AS conversation_id,
            left(s.content, 200) AS excerpt
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
       LEFT JOIN ros_conversations sc ON sc.id = s.conversation_id
      WHERE (t.state = 'suggested' OR t.removal_state = 'suggested')
        AND (c.id IS NOT NULL OR s.id IS NOT NULL)
      ORDER BY CASE WHEN t.removal_state = 'suggested' THEN t.updated_at ELSE t.created_at END DESC
      LIMIT $1",
        cols = TAG_COLUMNS
            .split(", ")
            .map(|c| format!("t.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let result = db.query(&sql, &[Bind::I64(limit)]).await?;
    Ok(result
        .rows
        .iter()
        .map(|row| {
            let mut tag = row_to_tag(row);
            let removal = cell(row, "removal_state").and_then(Cell::as_text) == Some("suggested");
            let action = removal.then(|| "remove".to_string());
            if removal
                && let Some(reason) = cell(row, "removal_reason").and_then(Cell::as_text)
                && !reason.is_empty()
            {
                tag.reason = reason.to_string();
            }
            PendingTag {
                tag,
                action,
                session_key: cell(row, "session_key")
                    .and_then(Cell::as_text)
                    .map(str::to_string),
                title: cell(row, "title")
                    .and_then(Cell::as_text)
                    .map(str::to_string),
                agent: cell(row, "agent")
                    .and_then(Cell::as_text)
                    .map(str::to_string),
                conversation_id: cell(row, "conversation_id")
                    .and_then(Cell::as_text)
                    .map(str::to_string),
                excerpt: cell(row, "excerpt")
                    .and_then(Cell::as_text)
                    .map(str::to_string),
            }
        })
        .collect())
}

pub async fn decide_tags(
    db: &TagConn,
    ids: &[String],
    state: &str,
    decided_by: &str,
) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let classified = db
        .query(
            "SELECT id, removal_state FROM ros_tags WHERE id = ANY($1::uuid[])",
            &[Bind::Texts(ids.to_vec())],
        )
        .await?;
    let removal_ids: Vec<String> = classified
        .rows
        .iter()
        .filter(|row| cell(row, "removal_state").and_then(Cell::as_text) == Some("suggested"))
        .map(|row| text_cell(row, "id"))
        .collect();
    let add_ids: Vec<String> = ids
        .iter()
        .filter(|id| !removal_ids.iter().any(|removal| removal == *id))
        .cloned()
        .collect();
    let mut changed = Vec::new();
    if !removal_ids.is_empty() {
        let (sql, params) = if state == "accepted" {
            (
                "UPDATE ros_tags
                SET state = 'rejected', removal_state = NULL,
                    decided_by = $2, decided_at = now(), updated_at = now()
              WHERE id = ANY($1::uuid[]) AND removal_state = 'suggested'
              RETURNING id",
                vec![Bind::Texts(removal_ids), Bind::Text(decided_by.to_string())],
            )
        } else {
            (
                "UPDATE ros_tags
                SET removal_state = 'rejected', updated_at = now()
              WHERE id = ANY($1::uuid[]) AND removal_state = 'suggested'
              RETURNING id",
                vec![Bind::Texts(removal_ids)],
            )
        };
        let rows = db.query(sql, &params).await?;
        changed.extend(rows.rows.iter().map(|row| text_cell(row, "id")));
    }
    if add_ids.is_empty() {
        return Ok(changed);
    }
    let rows = db
        .query(
            "UPDATE ros_tags
        SET state = $2, decided_by = $3, decided_at = now(), updated_at = now(),
            source = CASE WHEN source = 'rule' AND $2 = 'accepted' THEN 'user' ELSE source END
      WHERE id = ANY($1::uuid[]) AND state <> $2
      RETURNING id",
            &[
                Bind::Texts(add_ids),
                Bind::Text(state.to_string()),
                Bind::Text(decided_by.to_string()),
            ],
        )
        .await?;
    changed.extend(rows.rows.iter().map(|row| text_cell(row, "id")));
    Ok(changed)
}

pub async fn add_tag(db: &TagConn, input: &AddTagInput, decided_by: &str) -> Result<Tag, String> {
    let mut key = input
        .key
        .as_deref()
        .map(normalize_tag_key)
        .unwrap_or_default();
    let mut value = input
        .value
        .as_deref()
        .map(normalize_tag_value)
        .unwrap_or_default();
    let mut display = input
        .display
        .clone()
        .or_else(|| input.value.clone())
        .unwrap_or_default();
    if let Some(tag) = &input.tag {
        let Some((parsed_key, parsed_value)) = parse_tag_literal(tag) else {
            return Err(format!("invalid tag literal \"{tag}\" (want key:value)"));
        };
        key = parsed_key;
        value = parsed_value;
        display = input.display.clone().unwrap_or_else(|| {
            split_tag_literal(tag)
                .map(|(_, raw)| js_trim(raw).to_string())
                .unwrap_or_default()
        });
    }
    if key.is_empty() || value.is_empty() {
        return Err("key and value are required".to_string());
    }
    let mut entity_id = input.entity_id.clone();
    if entity_id.is_none() && input.session_key.is_some() && input.entity_type == "conversation" {
        let session_key = input.session_key.clone().unwrap_or_default();
        let (exact, like) = session_key_matchers(&session_key);
        let found = db
            .query(
                "WITH m AS (
         SELECT id, agent, session_key, updated_at FROM ros_conversations
          WHERE (session_key = ANY($1::text[]) OR session_key LIKE ANY($4::text[]))
            AND ($3::text IS NULL OR agent = $3)
       )
       SELECT id, (SELECT count(DISTINCT agent) FROM m) AS agents
         FROM m
        ORDER BY (session_key = $2) DESC, updated_at DESC
        LIMIT 1",
                &[
                    Bind::Texts(exact),
                    Bind::Text(session_key.clone()),
                    input.agent.clone().map(Bind::Text).unwrap_or(Bind::Null),
                    Bind::Texts(like),
                ],
            )
            .await?;
        if let Some(hit) = found.rows.first() {
            let agents = cell(hit, "agents").and_then(Cell::as_f64).unwrap_or(0.0);
            if agents > 1.0 {
                return Err(format!(
                    "invalid request: session \"{session_key}\" exists under several agents; pass agent"
                ));
            }
            entity_id = Some(text_cell(hit, "id"));
        }
        if entity_id.as_deref().unwrap_or("").is_empty() {
            return Err(format!(
                "no conversation captured for session \"{session_key}\""
            ));
        }
    }
    let Some(entity_id) = entity_id.filter(|id| !id.is_empty()) else {
        return Err("entity_id (or session_key for a conversation) is required".to_string());
    };
    let rows = db
        .query(
            &format!(
                "INSERT INTO ros_tags
       (entity_type, entity_id, key, value, display, source, state, proposed_by, reason, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 'user', 'accepted', $6, $7, $6, now())
     ON CONFLICT (entity_type, entity_id, key, value) DO UPDATE
       SET state = 'accepted', decided_by = EXCLUDED.decided_by, decided_at = now(),
           updated_at = now(),
           source = CASE WHEN ros_tags.source = 'rule' THEN 'user' ELSE ros_tags.source END,
           display = CASE WHEN ros_tags.display = '' THEN EXCLUDED.display ELSE ros_tags.display END
     RETURNING {TAG_COLUMNS}"
            ),
            &[
                Bind::Text(input.entity_type.clone()),
                Bind::Text(entity_id),
                Bind::Text(key),
                Bind::Text(value),
                Bind::Text(display),
                Bind::Text(decided_by.to_string()),
                Bind::Text(input.reason.clone().unwrap_or_default()),
            ],
        )
        .await?;
    rows.rows
        .first()
        .map(row_to_tag)
        .ok_or_else(|| "addTag returned no row".to_string())
}

pub async fn tags_for_conversations(
    db: &TagConn,
    conversation_ids: &[String],
    states: Option<Vec<String>>,
    include_summary_tags: bool,
    limit: Option<i64>,
) -> Result<Vec<(String, Vec<Tag>)>, String> {
    let mut order = Vec::new();
    for id in conversation_ids {
        if !id.is_empty() && !order.contains(id) {
            order.push(id.clone());
        }
    }
    if order.is_empty() {
        return Ok(Vec::new());
    }
    let states = states.unwrap_or_else(|| vec!["accepted".into()]);
    let cols = TAG_COLUMNS
        .split(", ")
        .map(|c| format!("t.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let limit_sql = if limit.is_some() { " LIMIT $3" } else { "" };
    let sql = if include_summary_tags {
        format!(
            "SELECT {cols}, COALESCE(c.id, s.conversation_id) AS conversation_id
           FROM ros_tags t
           LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
           LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
          WHERE COALESCE(c.id, s.conversation_id) = ANY($1::uuid[]) AND t.state = ANY($2::text[])
          ORDER BY (t.entity_type = 'conversation') DESC, t.key, t.value{limit_sql}"
        )
    } else {
        format!(
            "SELECT {cols}, t.entity_id AS conversation_id FROM ros_tags t
          WHERE t.entity_type = 'conversation' AND t.entity_id = ANY($1::uuid[])
            AND t.state = ANY($2::text[])
          ORDER BY t.key, t.value{limit_sql}"
        )
    };
    let mut params = vec![Bind::Texts(order.clone()), Bind::Texts(states)];
    if let Some(limit) = limit {
        params.push(Bind::I64(limit.clamp(1, 5000)));
    }
    let result = db.query(&sql, &params).await?;
    let mut grouped: HashMap<String, Vec<Tag>> = HashMap::new();
    let mut keys = Vec::new();
    for row in &result.rows {
        let id = text_cell(row, "conversation_id");
        let tag = row_to_tag(row);
        let list = grouped.entry(id.clone()).or_insert_with(|| {
            keys.push(id);
            Vec::new()
        });
        if !list
            .iter()
            .any(|existing| existing.key == tag.key && existing.value == tag.value)
        {
            list.push(tag);
        }
    }
    Ok(keys
        .into_iter()
        .filter_map(|id| grouped.remove(&id).map(|tags| (id, tags)))
        .collect())
}

pub async fn tags_for_session_keys(
    db: &TagConn,
    session_keys: &[String],
    states: Option<Vec<String>>,
) -> Result<Vec<(String, Vec<Tag>)>, String> {
    let keys = dedupe_strings(
        session_keys
            .iter()
            .filter(|k| !k.is_empty())
            .cloned()
            .collect(),
    );
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut requested_by: HashMap<String, Vec<String>> = HashMap::new();
    let mut exact = Vec::new();
    let mut like = Vec::new();
    for key in &keys {
        let (aliases, patterns) = session_key_matchers(key);
        for alias in aliases {
            if !exact.contains(&alias) {
                exact.push(alias.clone());
            }
            let list = requested_by.entry(alias).or_default();
            if !list.contains(key) {
                list.push(key.clone());
            }
        }
        for pattern in patterns {
            if !like.contains(&pattern) {
                like.push(pattern);
            }
        }
    }
    let states = states.unwrap_or_else(|| vec!["suggested".into(), "accepted".into()]);
    let cols = TAG_COLUMNS
        .split(", ")
        .map(|c| format!("t.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {cols}, c.session_key
       FROM ros_tags t
       JOIN ros_conversations c ON c.id = t.entity_id AND t.entity_type = 'conversation'
      WHERE (c.session_key = ANY($1::text[]) OR c.session_key LIKE ANY($3::text[]))
        AND t.state = ANY($2::text[])
      ORDER BY t.state = 'accepted' DESC, t.key, t.value"
    );
    let result = db
        .query(
            &sql,
            &[Bind::Texts(exact), Bind::Texts(states), Bind::Texts(like)],
        )
        .await?;
    let mut grouped: HashMap<String, Vec<Tag>> = HashMap::new();
    let mut order = Vec::new();
    for row in &result.rows {
        let stored = text_cell(row, "session_key");
        let tag = row_to_tag(row);
        let mut answers = Vec::new();
        for alias in session_key_aliases(&stored) {
            if let Some(asked) = requested_by.get(&alias) {
                for key in asked {
                    if !answers.contains(key) {
                        answers.push(key.clone());
                    }
                }
            }
        }
        for key in answers {
            let list = grouped.entry(key.clone()).or_insert_with(|| {
                order.push(key);
                Vec::new()
            });
            if !list
                .iter()
                .any(|existing| existing.key == tag.key && existing.value == tag.value)
            {
                list.push(tag.clone());
            }
        }
    }
    Ok(order
        .into_iter()
        .filter_map(|id| grouped.remove(&id).map(|tags| (id, tags)))
        .collect())
}

pub fn tagged_conversations_sql(key_idx: i64, value_idx: i64) -> String {
    format!(
        "(SELECT COALESCE(tc.id, ts.conversation_id)
             FROM ros_tags tt
             LEFT JOIN ros_conversations tc ON tt.entity_type = 'conversation' AND tc.id = tt.entity_id
             LEFT JOIN ros_summaries ts ON tt.entity_type = 'summary' AND ts.id = tt.entity_id
            WHERE tt.key = ${key_idx} AND tt.value = ${value_idx} AND tt.state = 'accepted')"
    )
}

pub async fn conversation_ids_with_tag(
    db: &TagConn,
    key: &str,
    value: &str,
) -> Result<Vec<String>, String> {
    let result = db
        .query(
            "SELECT DISTINCT COALESCE(c.id, s.conversation_id) AS id
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
      WHERE t.key = $1 AND t.value = $2 AND t.state = 'accepted'
        AND COALESCE(c.id, s.conversation_id) IS NOT NULL",
            &[
                Bind::Text(normalize_tag_key(key)),
                Bind::Text(normalize_tag_value(value)),
            ],
        )
        .await?;
    Ok(result.rows.iter().map(|row| text_cell(row, "id")).collect())
}

pub async fn tag_counts(
    db: &TagConn,
    key: Option<&str>,
    limit: i64,
) -> Result<Vec<TagCount>, String> {
    let mut params = Vec::new();
    let mut where_sql =
        "WHERE t.state = 'accepted' AND COALESCE(c.id, s.conversation_id) IS NOT NULL".to_string();
    if let Some(key) = key {
        params.push(Bind::Text(normalize_tag_key(key)));
        where_sql.push_str(&format!(" AND t.key = ${}", params.len()));
    }
    params.push(Bind::I64(limit.clamp(1, 1000)));
    let sql = format!(
        "SELECT t.key, t.value, max(t.display) AS display,
            count(DISTINCT COALESCE(c.id, s.conversation_id))::text AS n
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
       {where_sql}
      GROUP BY t.key, t.value
      ORDER BY count(DISTINCT COALESCE(c.id, s.conversation_id)) DESC, t.key, t.value
      LIMIT ${}",
        params.len()
    );
    let result = db.query(&sql, &params).await?;
    Ok(result
        .rows
        .iter()
        .map(|row| TagCount {
            key: text_cell(row, "key"),
            value: text_cell(row, "value"),
            display: text_cell(row, "display"),
            conversations: cell(row, "n")
                .and_then(Cell::as_i64)
                .or_else(|| cell(row, "n").and_then(Cell::as_f64).map(|n| n as i64))
                .unwrap_or(0),
        })
        .collect())
}

pub async fn upsert_taxonomy(
    db: &TagConn,
    input: &UpsertTaxonomy,
    source: Option<&str>,
) -> Result<TaxonomyEntry, String> {
    let source = source.unwrap_or("user").to_string();
    let lock = format!("ros_tag_taxonomy:{}", normalize_tag_key(&input.key));
    let input = input.clone();
    in_transaction(db, Some(&lock), move |q| {
        let source = source.clone();
        let input = input.clone();
        Box::pin(async move { upsert_taxonomy_in(q, &input, &source).await })
    })
    .await
}

async fn upsert_taxonomy_in(
    db: &TagConn,
    input: &UpsertTaxonomy,
    source: &str,
) -> Result<TaxonomyEntry, String> {
    let key = normalize_tag_key(&input.key);
    let value = normalize_tag_value(&input.value);
    if key.is_empty() || value.is_empty() {
        return Err("key and value are required".to_string());
    }
    let parent_given = !matches!(input.parent, ParentSet::Omitted);
    let parent = match &input.parent {
        ParentSet::Omitted | ParentSet::Clear => None,
        ParentSet::Value(raw) => {
            let normalized = normalize_tag_value(raw);
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        }
    };
    if parent.as_deref() == Some(value.as_str()) {
        return Err("a value cannot be its own parent".to_string());
    }
    if let Some(parent) = &parent {
        let mut cursor = Some(parent.clone());
        let mut depth = 0usize;
        while let Some(current) = cursor.clone() {
            if depth >= TAXONOMY_MAX_DEPTH {
                break;
            }
            let up = db
                .query(
                    "SELECT parent_value FROM ros_tag_taxonomy WHERE key = $1 AND value = $2",
                    &[Bind::Text(key.clone()), Bind::Text(current.clone())],
                )
                .await?;
            if depth == 0 && up.rows.is_empty() {
                return Err(format!(
                    "invalid parent: {key}:{current} is not in the vocabulary"
                ));
            }
            cursor = up.rows.first().and_then(|row| {
                cell(row, "parent_value")
                    .and_then(Cell::as_text)
                    .map(str::to_string)
            });
            if cursor.as_deref() == Some(value.as_str()) {
                return Err("invalid parent: it would create a cycle".to_string());
            }
            depth += 1;
        }
        if cursor.is_some() {
            return Err("invalid parent: taxonomy is nested too deeply".to_string());
        }
    }
    let aliases = input.aliases.as_ref().map(|items| {
        items
            .iter()
            .map(|item| normalize_tag_value(item))
            .filter(|item| !item.is_empty() && item != &value)
            .collect::<Vec<_>>()
    });
    let state = input
        .state
        .clone()
        .unwrap_or_else(|| "accepted".to_string());
    let rows = db
        .query(
            "INSERT INTO ros_tag_taxonomy (key, value, display, parent_value, aliases, state, source, reason, decided_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::text[], '{}'), $6, $7, $8,
             CASE WHEN $6 = 'suggested' THEN NULL ELSE now() END)
     ON CONFLICT (key, value) DO UPDATE SET
       display      = CASE WHEN $3 <> '' THEN $3 ELSE ros_tag_taxonomy.display END,
       parent_value = CASE WHEN $9 THEN $4 ELSE ros_tag_taxonomy.parent_value END,
       aliases      = COALESCE($5::text[], ros_tag_taxonomy.aliases),
       state        = $6,
       source       = $7,
       reason       = CASE WHEN $8 <> '' THEN $8 ELSE ros_tag_taxonomy.reason END,
       decided_at   = CASE WHEN $6 = 'suggested' THEN ros_tag_taxonomy.decided_at ELSE now() END,
       updated_at   = now()
     RETURNING key, value, display, parent_value, aliases, state, source, reason, decided_at, created_at, updated_at",
            &[
                Bind::Text(key),
                Bind::Text(value),
                Bind::Text(input.display.clone().unwrap_or_default()),
                parent.map(Bind::Text).unwrap_or(Bind::Null),
                aliases.map(Bind::Texts).unwrap_or(Bind::NullTexts),
                Bind::Text(state),
                Bind::Text(source.to_string()),
                Bind::Text(input.reason.clone().unwrap_or_default()),
                Bind::Bool(parent_given),
            ],
        )
        .await?;
    rows.rows
        .first()
        .map(row_to_taxonomy)
        .ok_or_else(|| "upsertTaxonomy returned no row".to_string())
}

pub async fn decide_taxonomy(
    db: &TagConn,
    entries: &[(String, String)],
    state: &str,
) -> Result<i64, String> {
    if entries.len() > 500 {
        return Err("invalid request: at most 500 entries".to_string());
    }
    let mut changed = 0i64;
    for (key, value) in entries {
        let result = db
            .query(
                "UPDATE ros_tag_taxonomy SET state = $3, decided_at = now(), updated_at = now()
        WHERE key = $1 AND value = $2 AND state <> $3",
                &[
                    Bind::Text(normalize_tag_key(key)),
                    Bind::Text(normalize_tag_value(value)),
                    Bind::Text(state.to_string()),
                ],
            )
            .await?;
        changed += result.row_count;
    }
    Ok(changed)
}

pub async fn merge_taxonomy_value(
    db: &TagConn,
    key: &str,
    from: &str,
    into: &str,
) -> Result<(i64, i64, String), String> {
    let k = normalize_tag_key(key);
    let f = normalize_tag_value(from);
    let requested = normalize_tag_value(into);
    if k.is_empty() || f.is_empty() || requested.is_empty() || f == requested {
        return Err("merge needs one key and two different values".to_string());
    }
    let lock = format!("ros_tag_taxonomy:{k}");
    in_transaction(db, Some(&lock), move |q| {
        let k = k.clone();
        let f = f.clone();
        let requested = requested.clone();
        Box::pin(async move {
            let alias = q
                .query(
                    "SELECT value FROM ros_tag_taxonomy
        WHERE key = $1 AND $2 = ANY(aliases) AND state = 'accepted'
        ORDER BY value LIMIT 1",
                    &[Bind::Text(k.clone()), Bind::Text(requested.clone())],
                )
                .await?;
            let i = alias.rows.first().map(|row| text_cell(row, "value")).unwrap_or(requested);
            if i == f {
                return Err("invalid merge: the target resolves to the value being merged".to_string());
            }
            let known = q
                .query(
                    "SELECT 1 FROM ros_tag_taxonomy WHERE key = $1 AND value = $2
       UNION ALL
       SELECT 1 FROM ros_tags WHERE key = $1 AND value = $2
       LIMIT 1",
                    &[Bind::Text(k.clone()), Bind::Text(f.clone())],
                )
                .await?;
            if known.rows.is_empty() {
                return Err(format!("invalid merge: {k}:{f} is not in the vocabulary or in use"));
            }
            let mut cursor = Some(i.clone());
            let mut depth = 0usize;
            while let Some(current) = cursor.clone() {
                if depth >= TAXONOMY_MAX_DEPTH {
                    break;
                }
                let up = q
                    .query(
                        "SELECT parent_value FROM ros_tag_taxonomy WHERE key = $1 AND value = $2",
                        &[Bind::Text(k.clone()), Bind::Text(current)],
                    )
                    .await?;
                cursor = up.rows.first().and_then(|row| cell(row, "parent_value").and_then(Cell::as_text).map(str::to_string));
                if cursor.as_deref() == Some(f.as_str()) {
                    return Err(format!("invalid merge: {k}:{i} is nested under {k}:{f}"));
                }
                depth += 1;
            }
            if cursor.is_some() {
                return Err("invalid merge: taxonomy is nested too deeply".to_string());
            }
            q.query(
                "INSERT INTO ros_tag_taxonomy (key, value, display, aliases, state, source, reason, decided_at)
       VALUES ($1, $2, '', ARRAY[$3]::text[], 'accepted', 'user', 'merge target', now())
       ON CONFLICT (key, value) DO UPDATE SET
         aliases = (
           SELECT COALESCE(array_agg(DISTINCT a), '{}') FROM unnest(
             ros_tag_taxonomy.aliases || ARRAY[$3]::text[] ||
             COALESCE((SELECT t.aliases FROM ros_tag_taxonomy t WHERE t.key = $1 AND t.value = $3), '{}')
           ) AS a WHERE a <> $2
         ),
         state = 'accepted', decided_at = now(), updated_at = now()",
                &[Bind::Text(k.clone()), Bind::Text(i.clone()), Bind::Text(f.clone())],
            )
            .await?;
            let moved = q
                .query(
                    "UPDATE ros_tags t SET value = $3, display = '', updated_at = now()
        WHERE t.key = $1 AND t.value = $2
          AND NOT EXISTS (SELECT 1 FROM ros_tags o
                           WHERE o.entity_type = t.entity_type AND o.entity_id = t.entity_id
                             AND o.key = $1 AND o.value = $3)",
                    &[Bind::Text(k.clone()), Bind::Text(f.clone()), Bind::Text(i.clone())],
                )
                .await?;
            q.query(
                "UPDATE ros_tags o
          SET state = t.state, decided_by = t.decided_by, decided_at = t.decided_at,
              updated_at = now()
         FROM ros_tags t
        WHERE t.key = $1 AND t.value = $2
          AND o.key = $1 AND o.value = $3
          AND o.entity_type = t.entity_type AND o.entity_id = t.entity_id
          AND t.state <> 'suggested'
          AND (o.state = 'suggested'
               OR COALESCE(t.decided_at, t.updated_at) > COALESCE(o.decided_at, o.updated_at))",
                &[Bind::Text(k.clone()), Bind::Text(f.clone()), Bind::Text(i.clone())],
            )
            .await?;
            q.query(
                "UPDATE ros_tags o
          SET source = t.source, updated_at = now()
         FROM ros_tags t
        WHERE t.key = $1 AND t.value = $2
          AND o.key = $1 AND o.value = $3
          AND o.entity_type = t.entity_type AND o.entity_id = t.entity_id
          AND o.source = 'rule' AND t.source = ANY($4::text[]) AND t.state = 'accepted'",
                &[
                    Bind::Text(k.clone()),
                    Bind::Text(f.clone()),
                    Bind::Text(i.clone()),
                    Bind::Texts(REVIEWED_TAG_SOURCES.iter().map(|s| (*s).to_string()).collect()),
                ],
            )
            .await?;
            let dropped = q
                .query(
                    "DELETE FROM ros_tags WHERE key = $1 AND value = $2",
                    &[Bind::Text(k.clone()), Bind::Text(f.clone())],
                )
                .await?;
            q.query(
                "UPDATE ros_tag_taxonomy
          SET state = 'rejected', reason = $3, aliases = '{}', parent_value = NULL,
              decided_at = now(), updated_at = now()
        WHERE key = $1 AND value = $2",
                &[Bind::Text(k.clone()), Bind::Text(f.clone()), Bind::Text(format!("merged into {k}:{i}"))],
            )
            .await?;
            q.query(
                "UPDATE ros_tag_taxonomy SET parent_value = $3, updated_at = now()
        WHERE key = $1 AND parent_value = $2 AND value <> $3",
                &[Bind::Text(k.clone()), Bind::Text(f.clone()), Bind::Text(i.clone())],
            )
            .await?;
            q.query(
                "UPDATE ros_tag_taxonomy SET aliases = array_remove(aliases, $2), updated_at = now()
        WHERE key = $1 AND value <> $3 AND $2 = ANY(aliases)",
                &[Bind::Text(k.clone()), Bind::Text(f), Bind::Text(i.clone())],
            )
            .await?;
            Ok((moved.row_count, dropped.row_count, i))
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cell_text(text: &str) -> Cell {
        Cell::Text(text.to_string())
    }

    fn sample_row() -> HashMap<String, Cell> {
        let mut row = HashMap::new();
        row.insert("id".into(), cell_text("t1"));
        row.insert("entity_type".into(), cell_text("conversation"));
        row.insert("entity_id".into(), cell_text("c1"));
        row.insert("key".into(), cell_text("project"));
        row.insert("value".into(), cell_text("acmeapp"));
        row.insert("display".into(), cell_text("AcmeApp"));
        row.insert("source".into(), cell_text("model"));
        row.insert("state".into(), cell_text("suggested"));
        row.insert("confidence".into(), Cell::F64(0.8));
        row.insert("proposed_by".into(), cell_text("m"));
        row.insert("reason".into(), cell_text("r"));
        row.insert("decided_by".into(), Cell::Null);
        row.insert("decided_at".into(), Cell::Null);
        row.insert("created_at".into(), cell_text("2026-10-02T12:00:00.000Z"));
        row.insert("updated_at".into(), cell_text("2026-10-02T12:00:00.000Z"));
        row
    }

    fn fixed(rows: Vec<HashMap<String, Cell>>, row_count: Option<i64>) -> TagConn {
        let count = row_count.unwrap_or(rows.len() as i64);
        TagConn::from_handler(Arc::new(move |_sql, _params| {
            Ok(QueryResult {
                rows: rows.clone(),
                row_count: count,
            })
        }))
    }

    fn head3(sql: &str) -> String {
        crate::rows::collapse_ws(sql)
            .split_whitespace()
            .take(3)
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn maps_snake_case_and_drops_null_optionals() {
        let tag = row_to_tag(&sample_row());
        assert_eq!(tag.id, "t1");
        assert_eq!(tag.entity_type, "conversation");
        assert_eq!(tag.confidence, Some(0.8));
        assert!(tag.decided_by.is_none());
        assert!(tag.decided_at.is_none());
    }

    #[tokio::test]
    async fn list_and_pending_and_decide_match_the_store_contract() {
        let pool = fixed(vec![sample_row()], None);
        let opts = ListTagsOptions {
            entity_type: Some("conversation".into()),
            entity_id: Some("c1".into()),
            key: Some("Project".into()),
            value: Some("AcmeApp".into()),
            ..ListTagsOptions::default()
        };
        let _ = list_tags(&pool, &opts).await.unwrap();
        let (sql, params) = pool.calls.lock()[0].clone();
        let flat = crate::rows::collapse_ws(&sql);
        assert!(flat.contains("entity_type = $1 AND entity_id = $2 AND key = $3 AND value = $4 AND state = ANY($5::text[])"));
        assert!(matches!(&params[0], Bind::Text(v) if v == "conversation"));
        assert!(matches!(&params[2], Bind::Text(v) if v == "project"));
        assert!(matches!(&params[3], Bind::Text(v) if v == "acmeapp"));
        assert!(
            matches!(&params[4], Bind::Texts(v) if v == &vec!["suggested".to_string(), "accepted".to_string()])
        );
        assert!(matches!(&params[5], Bind::I64(200)));
        let mut pending_row = sample_row();
        pending_row.insert("session_key".into(), cell_text("claude:x"));
        pending_row.insert("title".into(), cell_text("T"));
        pending_row.insert("agent".into(), cell_text("rivet"));
        pending_row.insert("conversation_id".into(), cell_text("c1"));
        pending_row.insert("excerpt".into(), Cell::Null);
        let pool = fixed(vec![pending_row], None);
        let out = pending_tags(&pool, 10).await.unwrap();
        assert_eq!(out[0].tag.id, "t1");
        assert_eq!(out[0].session_key.as_deref(), Some("claude:x"));
        assert_eq!(out[0].title.as_deref(), Some("T"));
        assert_eq!(out[0].conversation_id.as_deref(), Some("c1"));
        let (sql, params) = pool.calls.lock()[0].clone();
        assert!(sql.contains("t.state = 'suggested'"));
        assert!(sql.contains("c.id IS NOT NULL OR s.id IS NOT NULL"));
        assert!(matches!(&params[0], Bind::I64(10)));
        let mut decided = HashMap::new();
        decided.insert("id".into(), cell_text("a"));
        let pool = fixed(vec![decided], None);
        assert_eq!(
            decide_tags(&pool, &["a".into(), "b".into()], "rejected", "alice")
                .await
                .unwrap(),
            vec!["a".to_string()]
        );
        let update = pool
            .calls
            .lock()
            .iter()
            .find(|(sql, _)| sql.contains("SET state = $2"))
            .cloned()
            .unwrap();
        assert!(
            update
                .0
                .contains("SET state = $2, decided_by = $3, decided_at = now()")
        );
        assert!(update.0.contains("AND state <> $2"));
        assert!(
            matches!(&update.1[0], Bind::Texts(v) if v == &vec!["a".to_string(), "b".to_string()])
        );
        assert!(matches!(&update.1[1], Bind::Text(v) if v == "rejected"));
        assert!(matches!(&update.1[2], Bind::Text(v) if v == "alice"));
        let pool = fixed(vec![], Some(0));
        assert!(
            decide_tags(&pool, &[], "accepted", "x")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(pool.calls.lock().is_empty());
    }

    #[tokio::test]
    async fn add_tag_display_session_and_errors() {
        let mut row = sample_row();
        row.insert("source".into(), cell_text("user"));
        row.insert("state".into(), cell_text("accepted"));
        let pool = fixed(vec![row.clone()], None);
        let tag = add_tag(
            &pool,
            &AddTagInput {
                entity_type: "conversation".into(),
                entity_id: Some("c1".into()),
                tag: Some("Project:AcmeApp".into()),
                session_key: None,
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "alice",
        )
        .await
        .unwrap();
        assert_eq!(tag.state, "accepted");
        let (sql, params) = pool.calls.lock()[0].clone();
        assert!(sql.contains("'user', 'accepted'"));
        assert!(sql.contains("ON CONFLICT (entity_type, entity_id, key, value) DO UPDATE"));
        assert!(matches!(&params[0], Bind::Text(v) if v == "conversation"));
        assert!(matches!(&params[1], Bind::Text(v) if v == "c1"));
        assert!(matches!(&params[2], Bind::Text(v) if v == "project"));
        assert!(matches!(&params[3], Bind::Text(v) if v == "acmeapp"));
        assert!(matches!(&params[4], Bind::Text(v) if v == "AcmeApp"));
        assert!(matches!(&params[5], Bind::Text(v) if v == "alice"));
        let pool = fixed(vec![row.clone()], None);
        let _ = add_tag(
            &pool,
            &AddTagInput {
                entity_type: "conversation".into(),
                entity_id: Some("c1".into()),
                tag: Some("Project\u{FF1A}AcmeApp".into()),
                session_key: None,
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "alice",
        )
        .await
        .unwrap();
        let params = pool.calls.lock()[0].1.clone();
        assert!(matches!(&params[2], Bind::Text(v) if v == "project"));
        assert!(matches!(&params[3], Bind::Text(v) if v == "acmeapp"));
        assert!(matches!(&params[4], Bind::Text(v) if v == "AcmeApp"));
        let mut ambiguous = HashMap::new();
        ambiguous.insert("id".into(), cell_text("c1"));
        ambiguous.insert("agents".into(), cell_text("2"));
        let pool = fixed(vec![ambiguous], None);
        let err = add_tag(
            &pool,
            &AddTagInput {
                entity_type: "conversation".into(),
                entity_id: None,
                session_key: Some("claude-code:x".into()),
                tag: Some("topic:x".into()),
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "alice",
        )
        .await
        .unwrap_err();
        assert!(err.contains("several agents; pass agent"));
        assert_eq!(pool.calls.lock().len(), 1);
        let sql = pool.calls.lock()[0].0.clone();
        assert!(sql.contains("SELECT count(DISTINCT agent) FROM m"));
        assert!(!sql.contains("LIMIT 20"));
        let step = Arc::new(AtomicUsize::new(0));
        let step2 = step.clone();
        let accepted = row.clone();
        let pool = TagConn::from_handler(Arc::new(move |_sql, _params| {
            let n = step2.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                let mut hit = HashMap::new();
                hit.insert("id".into(), cell_text("c1"));
                hit.insert("agents".into(), cell_text("1"));
                Ok(QueryResult {
                    rows: vec![hit],
                    row_count: 1,
                })
            } else {
                let mut saved = accepted.clone();
                saved.insert("entity_id".into(), cell_text("c1"));
                Ok(QueryResult {
                    rows: vec![saved],
                    row_count: 1,
                })
            }
        }));
        let tag = add_tag(
            &pool,
            &AddTagInput {
                entity_type: "conversation".into(),
                entity_id: None,
                session_key: Some("claude-code:x".into()),
                tag: Some("topic:x".into()),
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "alice",
        )
        .await
        .unwrap();
        assert_eq!(tag.entity_id, "c1");
        let pool = fixed(vec![], Some(0));
        let err = add_tag(
            &pool,
            &AddTagInput {
                entity_type: "summary".into(),
                entity_id: Some("s".into()),
                tag: Some("nocolon".into()),
                session_key: None,
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "x",
        )
        .await
        .unwrap_err();
        assert!(err.contains("invalid tag literal"));
        let err = add_tag(
            &pool,
            &AddTagInput {
                entity_type: "summary".into(),
                entity_id: Some("s".into()),
                key: Some("topic".into()),
                tag: None,
                session_key: None,
                agent: None,
                value: None,
                display: None,
                reason: None,
            },
            "x",
        )
        .await
        .unwrap_err();
        assert!(err.contains("required"));
        let step = Arc::new(AtomicUsize::new(0));
        let step2 = step.clone();
        let accepted = row;
        let found = TagConn::from_handler(Arc::new(move |_sql, _params| {
            let n = step2.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                let mut hit = HashMap::new();
                hit.insert("id".into(), cell_text("c-found"));
                hit.insert("agents".into(), cell_text("1"));
                Ok(QueryResult {
                    rows: vec![hit],
                    row_count: 1,
                })
            } else {
                let mut saved = accepted.clone();
                saved.insert("entity_id".into(), cell_text("c-found"));
                Ok(QueryResult {
                    rows: vec![saved],
                    row_count: 1,
                })
            }
        }));
        let tag = add_tag(
            &found,
            &AddTagInput {
                entity_type: "conversation".into(),
                entity_id: None,
                session_key: Some("claude:abc".into()),
                tag: Some("topic:x".into()),
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "alice",
        )
        .await
        .unwrap();
        assert_eq!(tag.entity_id, "c-found");
        let (sql, params) = found.calls.lock()[0].clone();
        assert!(sql.contains("session_key = ANY($1::text[]) OR session_key LIKE ANY($4::text[])"));
        assert!(matches!(&params[0], Bind::Texts(v) if v == &vec!["claude:abc".to_string()]));
        assert!(matches!(&params[1], Bind::Text(v) if v == "claude:abc"));
        assert!(matches!(&params[2], Bind::Null));
        assert!(matches!(&params[3], Bind::Texts(v) if v.is_empty()));
        let none = fixed(vec![], Some(0));
        let err = add_tag(
            &none,
            &AddTagInput {
                entity_type: "conversation".into(),
                entity_id: None,
                session_key: Some("claude:none".into()),
                tag: Some("topic:x".into()),
                agent: None,
                key: None,
                value: None,
                display: None,
                reason: None,
            },
            "alice",
        )
        .await
        .unwrap_err();
        assert!(err.contains("no conversation captured"));
    }

    #[tokio::test]
    async fn lookups_and_session_matchers() {
        let uuid = "a1b2c3d4-1111-4222-8333-444455556666";
        let mut c1 = sample_row();
        c1.insert("conversation_id".into(), cell_text("c1"));
        let mut c1b = sample_row();
        c1b.insert("id".into(), cell_text("t2"));
        c1b.insert("key".into(), cell_text("topic"));
        c1b.insert("value".into(), cell_text("x"));
        c1b.insert("conversation_id".into(), cell_text("c1"));
        let mut c2 = sample_row();
        c2.insert("id".into(), cell_text("t3"));
        c2.insert("entity_id".into(), cell_text("c2"));
        c2.insert("conversation_id".into(), cell_text("c2"));
        let pool = fixed(vec![c1, c1b, c2], None);
        let map = tags_for_conversations(
            &pool,
            &["c1".into(), "c2".into(), "c1".into(), String::new()],
            None,
            false,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            map.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["c1", "c2"]
        );
        assert_eq!(
            map[0].1.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["t1", "t2"]
        );
        let params = pool.calls.lock()[0].1.clone();
        assert!(
            matches!(&params[0], Bind::Texts(v) if v == &vec!["c1".to_string(), "c2".to_string()])
        );
        assert!(matches!(&params[1], Bind::Texts(v) if v == &vec!["accepted".to_string()]));
        let mut stored = sample_row();
        stored.insert("session_key".into(), cell_text(uuid));
        let pool = fixed(vec![stored], None);
        let map = tags_for_session_keys(
            &pool,
            &[format!("claude-code:{uuid}"), "codex:other".into()],
            None,
        )
        .await
        .unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map[0].0, format!("claude-code:{uuid}"));
        assert_eq!(map[0].1[0].id, "t1");
        let params = pool.calls.lock()[0].1.clone();
        assert!(
            matches!(&params[0], Bind::Texts(v) if v == &vec![format!("claude-code:{uuid}"), uuid.to_string(), "codex:other".to_string(), "other".to_string()])
        );
        assert!(
            matches!(&params[2], Bind::Texts(v) if v == &vec![format!("claude-code:%/{uuid}")])
        );
        let mut path_row = sample_row();
        path_row.insert(
            "session_key".into(),
            cell_text(&format!("claude-code:-home-rivet-proj/{uuid}")),
        );
        let path = fixed(vec![path_row], None);
        let map = tags_for_session_keys(&path, &[format!("claude-code:{uuid}")], None)
            .await
            .unwrap();
        assert_eq!(map[0].1[0].id, "t1");
        let mut canonical = sample_row();
        canonical.insert(
            "session_key".into(),
            cell_text(&format!("claude-code:{uuid}")),
        );
        let canonical = fixed(vec![canonical], None);
        let map = tags_for_session_keys(&canonical, &[uuid.to_string()], None)
            .await
            .unwrap();
        assert_eq!(map[0].0, uuid);
        assert_eq!(map[0].1[0].id, "t1");
        let mut stray = sample_row();
        stray.insert("session_key".into(), cell_text("codex:something-else"));
        let stray = fixed(vec![stray], None);
        assert!(
            tags_for_session_keys(&stray, &[uuid.to_string()], None)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            session_key_matchers(uuid).1,
            vec![format!("%:{uuid}"), format!("%/{uuid}")]
        );
        assert_eq!(
            session_key_matchers(&format!("claude-code:{uuid}")).1,
            vec![format!("claude-code:%/{uuid}")]
        );
        assert_eq!(
            session_key_matchers(&format!("claude-code:-slug/{uuid}")).1,
            vec![format!("claude-code:%/{uuid}")]
        );
        assert!(
            session_key_matchers("codex:chat-20260707-abcd")
                .1
                .is_empty()
        );
        assert!(session_key_matchers("task:123").1.is_empty());
        let mut a = sample_row();
        a.insert("id".into(), cell_text("a"));
        a.insert("session_key".into(), cell_text(uuid));
        let mut b = sample_row();
        b.insert("id".into(), cell_text("b"));
        b.insert(
            "session_key".into(),
            cell_text(&format!("claude-code:{uuid}")),
        );
        let pool = fixed(vec![a, b], None);
        let map = tags_for_session_keys(&pool, &[format!("claude-code:{uuid}")], None)
            .await
            .unwrap();
        assert_eq!(map[0].1.len(), 1);
        let pool = fixed(vec![], Some(0));
        assert!(
            tags_for_session_keys(&pool, &[], None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(pool.calls.lock().is_empty());
        let mut idrow = HashMap::new();
        idrow.insert("id".into(), cell_text("c9"));
        let pool = fixed(vec![idrow], None);
        assert_eq!(
            conversation_ids_with_tag(&pool, "Project", "AcmeApp")
                .await
                .unwrap(),
            vec!["c9".to_string()]
        );
        let (sql, params) = pool.calls.lock()[0].clone();
        assert!(sql.contains("COALESCE(c.id, s.conversation_id)"));
        assert!(sql.contains("FROM ros_tags t"));
        assert!(matches!(&params[0], Bind::Text(v) if v == "project"));
        assert!(matches!(&params[1], Bind::Text(v) if v == "acmeapp"));
        let mut count = HashMap::new();
        count.insert("key".into(), cell_text("project"));
        count.insert("value".into(), cell_text("acmeapp"));
        count.insert("display".into(), cell_text("AcmeApp"));
        count.insert("n".into(), cell_text("7"));
        let pool = fixed(vec![count], None);
        let counts = tag_counts(&pool, Some("project"), 200).await.unwrap();
        assert_eq!(counts[0].conversations, 7);
        assert_eq!(counts[0].display, "AcmeApp");
    }

    #[tokio::test]
    async fn taxonomy_upsert_and_merge() {
        let many = (0..501)
            .map(|n| ("topic".to_string(), format!("v{n}")))
            .collect::<Vec<_>>();
        let err = decide_taxonomy(&fixed(vec![], Some(0)), &many, "accepted")
            .await
            .unwrap_err();
        assert!(err.contains("at most 500"));
        let handler: Handler = Arc::new(|sql, _params| {
            if sql.contains("SELECT parent_value") {
                let mut row = HashMap::new();
                row.insert("parent_value".into(), Cell::Null);
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else {
                let mut row = HashMap::new();
                row.insert("key".into(), cell_text("topic"));
                row.insert("value".into(), cell_text("rivethub"));
                row.insert("display".into(), cell_text("RivetHub"));
                row.insert("parent_value".into(), cell_text("rivetos"));
                row.insert("aliases".into(), Cell::Json(Value::Array(vec![])));
                row.insert("state".into(), cell_text("accepted"));
                row.insert("source".into(), cell_text("user"));
                row.insert("reason".into(), cell_text(""));
                row.insert("decided_at".into(), cell_text("2026-10-02T12:00:00.000Z"));
                row.insert("created_at".into(), cell_text("2026-10-02T12:00:00.000Z"));
                row.insert("updated_at".into(), cell_text("2026-10-02T12:00:00.000Z"));
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            }
        });
        let pool = TagConn::from_handler(handler);
        let entry = upsert_taxonomy(
            &pool,
            &UpsertTaxonomy {
                key: "Topic".into(),
                value: "RivetHub".into(),
                display: Some("RivetHub".into()),
                parent: ParentSet::Value("RivetOS".into()),
                aliases: None,
                state: None,
                reason: None,
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(entry.key, "topic");
        assert_eq!(entry.value, "rivethub");
        assert_eq!(entry.parent_value.as_deref(), Some("rivetos"));
        assert_eq!(entry.state, "accepted");
        let insert = pool
            .calls
            .lock()
            .iter()
            .find(|(sql, _)| sql.contains("INSERT INTO ros_tag_taxonomy"))
            .cloned()
            .unwrap();
        assert!(matches!(&insert.1[0], Bind::Text(v) if v == "topic"));
        assert!(matches!(&insert.1[1], Bind::Text(v) if v == "rivethub"));
        assert!(matches!(&insert.1[2], Bind::Text(v) if v == "RivetHub"));
        assert!(matches!(&insert.1[3], Bind::Text(v) if v == "rivetos"));
        assert!(matches!(&insert.1[4], Bind::NullTexts));
        assert!(matches!(&insert.1[5], Bind::Text(v) if v == "accepted"));
        assert!(matches!(&insert.1[6], Bind::Text(v) if v == "user"));
        assert!(matches!(&insert.1[7], Bind::Text(v) if v.is_empty()));
        assert!(matches!(&insert.1[8], Bind::Bool(true)));
        let err = upsert_taxonomy(
            &pool,
            &UpsertTaxonomy {
                key: "topic".into(),
                value: "x".into(),
                parent: ParentSet::Value("X".into()),
                display: None,
                aliases: None,
                state: None,
                reason: None,
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("own parent"));
        let ghost = TagConn::from_handler(Arc::new(|_sql, _params| Ok(QueryResult::empty())));
        let err = upsert_taxonomy(
            &ghost,
            &UpsertTaxonomy {
                key: "topic".into(),
                value: "child".into(),
                parent: ParentSet::Value("ghost".into()),
                display: None,
                aliases: None,
                state: None,
                reason: None,
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("topic:ghost is not in the vocabulary"));
        assert_eq!(ghost.calls.lock().len(), 1);
        let cycle = TagConn::from_handler(Arc::new(|sql, params| {
            if sql.contains("SELECT parent_value") {
                let current = match params.get(1) {
                    Some(Bind::Text(v)) => v.as_str(),
                    _ => "",
                };
                let mut row = HashMap::new();
                if current == "a" {
                    row.insert("parent_value".into(), cell_text("b"));
                } else {
                    row.insert("parent_value".into(), Cell::Null);
                }
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else {
                Ok(QueryResult::empty())
            }
        }));
        let err = upsert_taxonomy(
            &cycle,
            &UpsertTaxonomy {
                key: "topic".into(),
                value: "b".into(),
                parent: ParentSet::Value("a".into()),
                display: None,
                aliases: None,
                state: None,
                reason: None,
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("cycle"));
        assert!(
            cycle
                .calls
                .lock()
                .iter()
                .all(|(sql, _)| !sql.contains("INSERT INTO ros_tag_taxonomy"))
        );
        let client = TagConn::from_handler(Arc::new(|sql, _params| {
            if sql.contains("DELETE FROM ros_tags") {
                Err("boom".into())
            } else if sql.contains("UNION ALL") {
                let mut row = HashMap::new();
                row.insert("?column?".into(), Cell::I64(1));
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else {
                Ok(QueryResult {
                    rows: vec![],
                    row_count: 1,
                })
            }
        }));
        let pool_query = TagConn::from_handler(Arc::new(|_sql, _params| Ok(QueryResult::empty())));
        let pool_calls = pool_query.calls.clone();
        let client_calls = client.calls.clone();
        let client_releases = client.releases.clone();
        let pool = pool_query.with_pool(client);
        let err = merge_taxonomy_value(&pool, "topic", "old", "new")
            .await
            .unwrap_err();
        assert!(err.contains("boom"));
        let calls = client_calls.lock().clone();
        assert_eq!(head3(&calls[0].0), "BEGIN");
        assert_eq!(head3(&calls.last().unwrap().0), "ROLLBACK");
        assert_eq!(client_releases.load(Ordering::SeqCst), 1);
        assert!(pool_calls.lock().is_empty());
        let success = TagConn::from_handler(Arc::new(|sql, _params| {
            let text = crate::rows::collapse_ws(sql);
            if text.contains("= ANY(aliases) AND state") {
                Ok(QueryResult::empty())
            } else if text.contains("UNION ALL") {
                let mut row = HashMap::new();
                row.insert("?column?".into(), Cell::I64(1));
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else if text.contains("UPDATE ros_tags t SET value") {
                Ok(QueryResult {
                    rows: vec![],
                    row_count: 4,
                })
            } else if text.contains("DELETE FROM ros_tags") {
                Ok(QueryResult {
                    rows: vec![],
                    row_count: 1,
                })
            } else {
                Ok(QueryResult::empty())
            }
        }));
        let (moved, dropped, into) = merge_taxonomy_value(&success, "topic", "Wiki-Pages", "wiki")
            .await
            .unwrap();
        assert_eq!((moved, dropped, into), (4, 1, "wiki".to_string()));
        let sqls = success
            .calls
            .lock()
            .iter()
            .map(|(sql, _)| crate::rows::collapse_ws(sql))
            .collect::<Vec<_>>();
        let at = |needle: &str| sqls.iter().position(|sql| sql.contains(needle)).unwrap();
        assert!(at("INSERT INTO ros_tag_taxonomy") < sqls.len());
        assert!(
            at("SET state = t.state, decided_by = t.decided_by")
                > at("UPDATE ros_tags t SET value")
        );
        assert!(
            at("SET state = t.state, decided_by = t.decided_by")
                < at("DELETE FROM ros_tags WHERE key = $1 AND value = $2")
        );
        assert!(sqls[at("UPDATE ros_tags t SET value")].contains("SET value = $3, display = ''"));
        assert!(sqls[at("SET state = 'rejected'")].contains("aliases = '{}', parent_value = NULL"));
        assert!(sqls.iter().any(|sql| sql.contains("SET parent_value = $3")));
        assert!(
            sqls.iter()
                .any(|sql| sql.contains("array_remove(aliases, $2)"))
        );
        let move_params = success.calls.lock()[at("UPDATE ros_tags t SET value")]
            .1
            .clone();
        assert!(matches!(&move_params[0], Bind::Text(v) if v == "topic"));
        assert!(matches!(&move_params[1], Bind::Text(v) if v == "wiki-pages"));
        assert!(matches!(&move_params[2], Bind::Text(v) if v == "wiki"));
        let err = merge_taxonomy_value(&success, "topic", "a", "A")
            .await
            .unwrap_err();
        assert!(err.contains("two different values"));
        let unknown = TagConn::from_handler(Arc::new(|_sql, _params| Ok(QueryResult::empty())));
        let err = merge_taxonomy_value(&unknown, "topic", "typo", "wiki")
            .await
            .unwrap_err();
        assert!(err.contains("topic:typo is not in the vocabulary or in use"));
        let nested = TagConn::from_handler(Arc::new(|sql, params| {
            let text = crate::rows::collapse_ws(sql);
            if text.contains("UNION ALL") {
                let mut row = HashMap::new();
                row.insert("?column?".into(), Cell::I64(1));
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else if text.contains("SELECT parent_value") {
                let current = match params.get(1) {
                    Some(Bind::Text(v)) => v.clone(),
                    _ => String::new(),
                };
                let mut row = HashMap::new();
                if current == "rivethub" {
                    row.insert("parent_value".into(), cell_text("rivetos"));
                } else {
                    row.insert("parent_value".into(), Cell::Null);
                }
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else {
                Ok(QueryResult::empty())
            }
        }));
        let err = merge_taxonomy_value(&nested, "topic", "rivetos", "rivethub")
            .await
            .unwrap_err();
        assert!(err.contains("topic:rivethub is nested under topic:rivetos"));
        assert!(
            nested
                .calls
                .lock()
                .iter()
                .all(|(sql, _)| !sql.contains("INSERT INTO ros_tag_taxonomy"))
        );
        let follow = TagConn::from_handler(Arc::new(|sql, params| {
            let text = crate::rows::collapse_ws(sql);
            if text.contains("UNION ALL") {
                let mut row = HashMap::new();
                row.insert("?column?".into(), Cell::I64(1));
                Ok(QueryResult {
                    rows: vec![row],
                    row_count: 1,
                })
            } else if text.contains("= ANY(aliases) AND state") {
                let target = match params.get(1) {
                    Some(Bind::Text(v)) => v.as_str(),
                    _ => "",
                };
                if target == "old-wiki" {
                    let mut row = HashMap::new();
                    row.insert("value".into(), cell_text("wiki"));
                    Ok(QueryResult {
                        rows: vec![row],
                        row_count: 1,
                    })
                } else if target == "loop" {
                    let mut row = HashMap::new();
                    row.insert("value".into(), cell_text("pages"));
                    Ok(QueryResult {
                        rows: vec![row],
                        row_count: 1,
                    })
                } else {
                    Ok(QueryResult::empty())
                }
            } else {
                Ok(QueryResult::empty())
            }
        }));
        let (_, _, into) = merge_taxonomy_value(&follow, "topic", "pages", "old-wiki")
            .await
            .unwrap();
        assert_eq!(into, "wiki");
        let err = merge_taxonomy_value(&follow, "topic", "pages", "loop")
            .await
            .unwrap_err();
        assert!(err.contains("invalid merge"));
    }
}
