use std::collections::{HashMap, HashSet, VecDeque};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use sqlx::PgPool;

use crate::embed_prep::{
    DEFAULT_EMBED_QUERY_INSTRUCTION, apply_embed_query_instruction, clamp_embed_timeout_ms,
    normalize_query_text,
};
use crate::embed_wire::{
    EMBED_TRUNCATE_DIMS, EmbedWireShape, build_embed_request, normalize_embed_vector,
    parse_embed_response, vector_literal,
};
use crate::error::{StoreError, now_ms};
use crate::report::format_js_iso;
use crate::rows::{Bind, Cell, DbFail, QueryResult, cell, exec_query, text_cell};
use crate::scoring::{
    CHUNK_ARM_PROBE_SQL, GATE_FRACTION, HYBRID_RRF_K, LooseNumber, SUMMARY_FUSION_BONUS,
    SUMMARY_IMPORTANCE, W_FTS, W_IMPORTANCE, W_SEMANTIC, W_TEMPORAL, chunk_pool_size,
    clamp_hnsw_ef_search, hybrid_pool_size, importance_sql, looks_literal, message_quality_sql,
    reciprocal_rank_fusion, semantic_proxy_sql, should_trigram_fallback, summary_quality_sql,
    temporal_decay_sql,
};
use crate::slug::{normalize_tag_key, normalize_tag_value, parse_tag_literal};
use crate::token_source::TokenSource;
use crate::window::apply_window_args;

const MODEL_REQUIRED: &str = "embedModel is required when embedEndpoint is set (env: RIVETOS_EMBED_MODEL). OpenAI-compatible embedding model id (example: text-embedding-3-small)";
const VECTOR_DROP_LOG_INTERVAL_MS: i64 = 60_000;
const DROP_BUCKET_MINUTES: i64 = 60;
const MINUTE_MS: i64 = 60_000;
const HEALTH_COALESCE_MS: i64 = 60_000;
const HEALTH_PROBE_CAP_MS: i64 = 5_000;

const TAG_SQL: &str = "SELECT DISTINCT COALESCE(c.id, s.conversation_id) AS id
       FROM ros_tags t
       LEFT JOIN ros_conversations c ON t.entity_type = 'conversation' AND c.id = t.entity_id
       LEFT JOIN ros_summaries s ON t.entity_type = 'summary' AND s.id = t.entity_id
      WHERE t.key = $1 AND t.value = $2 AND t.state = 'accepted'
        AND COALESCE(c.id, s.conversation_id) IS NOT NULL";

const BUMP_MESSAGES: &str = "UPDATE ros_messages
           SET access_count = access_count + 1, last_accessed_at = NOW()
           WHERE id = ANY($1::uuid[])";

const BUMP_SUMMARIES: &str = "UPDATE ros_summaries
           SET access_count = access_count + 1, last_accessed_at = NOW()
           WHERE id = ANY($1::uuid[])";

pub type EmbedFut =
    Pin<Box<dyn std::future::Future<Output = Result<EmbedResponse, FetchFail>> + Send>>;
pub type EmbedFetch = Arc<dyn Fn(EmbedCall) -> EmbedFut + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type WarnFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct EmbedCall {
    pub url: String,
    pub body: Value,
    pub headers: Vec<(String, String)>,
    pub timeout_ms: i64,
}

#[derive(Debug, Clone)]
pub struct EmbedResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Clone)]
pub enum FetchFail {
    Network(String),
    Timeout,
}

#[derive(Debug)]
pub enum SearchFail {
    Request(String),
    Db(DbFail),
}

impl std::fmt::Display for SearchFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request(message) => f.write_str(message),
            Self::Db(err) => f.write_str(&err.message),
        }
    }
}

impl std::error::Error for SearchFail {}

impl From<DbFail> for SearchFail {
    fn from(err: DbFail) -> Self {
        Self::Db(err)
    }
}

impl SearchFail {
    fn db_clone(&self) -> DbFail {
        match self {
            Self::Db(err) => err.clone(),
            Self::Request(message) => DbFail::new(message.clone()),
        }
    }
}

pub fn store_error(err: SearchFail) -> StoreError {
    match err {
        SearchFail::Request(message) => StoreError::Request(message),
        SearchFail::Db(fail) if fail.connect => StoreError::connection(fail.message),
        SearchFail::Db(fail) => StoreError::Memory {
            code: protocol::MemoryErrorCode::MemoryQueryFailed,
            message: fail.message.clone(),
            cause: Some(fail.message),
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchDegraded {
    pub vector: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkArmDegraded {
    pub chunks: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchSnippet {
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub chunk_idx: i64,
    pub chunk_count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub hit_type: String,
    pub content: String,
    pub role: String,
    pub agent: String,
    pub conversation_id: String,
    pub score: f64,
    pub created_at: DateTime<Utc>,
    pub truncated: bool,
    pub full_length: Option<i64>,
    pub tool_name: Option<String>,
    pub tool_result: Option<String>,
    pub kind: Option<String>,
    pub earliest_at: Option<DateTime<Utc>>,
    pub latest_at: Option<DateTime<Utc>>,
    pub fallback: Option<String>,
    pub degraded: Option<SearchDegraded>,
    pub chunk_arm: Option<ChunkArmDegraded>,
    pub snippet: Option<SearchSnippet>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub degraded: Option<SearchDegraded>,
    pub fallback: Option<String>,
    pub chunk_arm: Option<ChunkArmDegraded>,
}

impl SearchResults {
    pub fn empty() -> Self {
        Self {
            hits: Vec::new(),
            degraded: None,
            fallback: None,
            chunk_arm: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchRuntimeStats {
    pub vector_arm_dropped: u64,
    pub vector_arm_dropped_last_hour: u64,
    pub query_embed_cache_hits: u64,
    pub query_embed_cache_misses: u64,
    pub chunk_arm_hits: u64,
    pub parent_arm_hits: u64,
    pub chunk_arm_unavailable: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HealthView {
    pub available: bool,
    pub checked_at: String,
    pub reason: Option<String>,
}

#[derive(Clone, Default)]
pub struct EngineOptions {
    pub mode: Option<String>,
    pub scope: Option<String>,
    pub limit: Option<i64>,
    pub agent: Option<String>,
    pub since: Option<String>,
    pub before: Option<String>,
    pub tag: Option<String>,
    pub conversation_ids: Option<Vec<String>>,
    pub window: Option<String>,
}

#[derive(Clone)]
pub struct EngineConfig {
    pub embed_endpoint: Option<String>,
    pub embed_model: String,
    pub embed_query_instruction: Option<String>,
    pub embed_timeout_ms: LooseNumber,
    pub hnsw_ef_search: LooseNumber,
    pub embed_api_key: String,
    pub embed_token_source: Option<TokenSource>,
    pub embed_wire_shape: EmbedWireShape,
    pub embed_expected_dims: Option<usize>,
    pub clock: Option<Clock>,
    pub fetch: Option<EmbedFetch>,
    pub warn: Option<WarnFn>,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            embed_endpoint: None,
            embed_model: String::new(),
            embed_query_instruction: None,
            embed_timeout_ms: LooseNumber::Absent,
            hnsw_ef_search: LooseNumber::Absent,
            embed_api_key: String::new(),
            embed_token_source: None,
            embed_wire_shape: EmbedWireShape::Openai,
            embed_expected_dims: None,
            clock: None,
            fetch: None,
            warn: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ResolvedConfig {
    pub embed_endpoint: Option<String>,
    pub embed_model: String,
    pub embed_query_instruction: String,
    pub embed_timeout_ms: i64,
    pub hnsw_ef_search: i64,
    pub embed_api_key: String,
    pub embed_token_source: Option<TokenSource>,
    pub embed_wire_shape: EmbedWireShape,
    pub embed_expected_dims: Option<usize>,
}

pub trait SearchSession: Send {
    fn query<'a>(
        &'a mut self,
        sql: &'a str,
        params: &'a [Bind],
    ) -> impl std::future::Future<Output = Result<QueryResult, DbFail>> + Send + 'a;

    fn release(&mut self, err: Option<DbFail>);
}

pub trait SearchDb: Clone + Send + Sync + 'static {
    type Session: SearchSession;

    fn query<'a>(
        &'a self,
        sql: &'a str,
        params: &'a [Bind],
    ) -> impl std::future::Future<Output = Result<QueryResult, DbFail>> + Send + 'a;

    fn connect(&self) -> impl std::future::Future<Output = Result<Self::Session, DbFail>> + Send;
}

#[derive(Clone)]
pub struct PoolDb {
    pool: PgPool,
}

pub struct PoolSession {
    conn: Option<sqlx::pool::PoolConnection<sqlx::Postgres>>,
}

impl PoolDb {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl SearchDb for PoolDb {
    type Session = PoolSession;

    async fn query(&self, sql: &str, params: &[Bind]) -> Result<QueryResult, DbFail> {
        let mut conn = self.pool.acquire().await.map_err(DbFail::from_sqlx)?;
        exec_query(&mut conn, sql, params).await
    }

    async fn connect(&self) -> Result<PoolSession, DbFail> {
        let conn = self.pool.acquire().await.map_err(DbFail::from_sqlx)?;
        Ok(PoolSession { conn: Some(conn) })
    }
}

impl SearchSession for PoolSession {
    async fn query(&mut self, sql: &str, params: &[Bind]) -> Result<QueryResult, DbFail> {
        let Some(conn) = self.conn.as_mut() else {
            return Err(DbFail::new("connection released"));
        };
        exec_query(&mut *conn, sql, params).await
    }

    fn release(&mut self, err: Option<DbFail>) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        if err.is_some() {
            tokio::spawn(async move {
                let _ = conn.close().await;
            });
        }
    }
}

#[derive(Clone)]
struct Candidate {
    hit: SearchHit,
    boost: f64,
    sim: Option<f64>,
}

struct CacheEntry {
    vec: Vec<f64>,
    expires_at: i64,
}

struct QueryCache {
    map: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
    hits: u64,
    misses: u64,
}

impl QueryCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            hits: 0,
            misses: 0,
        }
    }

    fn get(&mut self, key: &str, now: i64) -> Option<Vec<f64>> {
        let Some(entry) = self.map.get(key) else {
            self.misses += 1;
            return None;
        };
        if now >= entry.expires_at {
            self.map.remove(key);
            self.order.retain(|item| item != key);
            self.misses += 1;
            return None;
        }
        let vec = entry.vec.clone();
        self.order.retain(|item| item != key);
        self.order.push_back(key.to_string());
        self.hits += 1;
        Some(vec)
    }

    fn set(&mut self, key: String, vec: Vec<f64>, now: i64) {
        if self.map.contains_key(&key) {
            self.order.retain(|item| item != &key);
        }
        self.map.insert(
            key.clone(),
            CacheEntry {
                vec,
                expires_at: now + crate::embed_prep::QUERY_EMBED_CACHE_TTL_MS,
            },
        );
        self.order.push_back(key);
        while self.map.len() > crate::embed_prep::QUERY_EMBED_CACHE_MAX {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&old);
        }
    }
}

struct DropState {
    total: u64,
    counts: [u64; 60],
    epochs: [i64; 60],
    last_log_at: i64,
}

impl DropState {
    fn new() -> Self {
        Self {
            total: 0,
            counts: [0; 60],
            epochs: [-1; 60],
            last_log_at: 0,
        }
    }

    fn add(&mut self, now: i64) {
        let minute = now.div_euclid(MINUTE_MS);
        let index = usize::try_from(minute.rem_euclid(DROP_BUCKET_MINUTES)).unwrap_or(0);
        if self.epochs[index] != minute {
            self.counts[index] = 0;
            self.epochs[index] = minute;
        }
        self.counts[index] += 1;
        self.total += 1;
    }

    fn last_hour(&self, now: i64) -> u64 {
        let minute = now.div_euclid(MINUTE_MS);
        let mut total = 0u64;
        for index in 0..60 {
            let epoch = self.epochs[index];
            if epoch >= 0 && minute >= epoch && minute - epoch < DROP_BUCKET_MINUTES {
                total += self.counts[index];
            }
        }
        total
    }
}

struct ChunkState {
    available: Option<bool>,
    reason: Option<String>,
    hits: u64,
    parent_hits: u64,
    unavailable: u64,
}

impl ChunkState {
    fn new() -> Self {
        Self {
            available: None,
            reason: None,
            hits: 0,
            parent_hits: 0,
            unavailable: 0,
        }
    }
}

struct HealthSlot {
    at: i64,
    cached: Option<HealthView>,
    inflight: Option<tokio::sync::watch::Receiver<Option<HealthView>>>,
}

struct EngineShared {
    cfg: Mutex<ResolvedConfig>,
    cache: Mutex<QueryCache>,
    drops: Mutex<DropState>,
    chunk: Mutex<ChunkState>,
    bump_log_at: Mutex<i64>,
    clock: Clock,
    fetch: Mutex<EmbedFetch>,
    warn: WarnFn,
}

struct EmbedOutcome {
    vec: Option<Vec<f64>>,
    reason: Option<String>,
    elapsed_ms: i64,
}

struct TextParts {
    where_clause: String,
    fts_score_expr: String,
    semantic_expr: String,
    params: Vec<Bind>,
    limit_idx: usize,
}

#[derive(Clone)]
pub struct SearchEngine<D: SearchDb> {
    db: D,
    shared: Arc<EngineShared>,
    health: Arc<tokio::sync::Mutex<HealthSlot>>,
}

impl<D: SearchDb> SearchEngine<D> {
    pub fn new(db: D, config: EngineConfig) -> Self {
        let clock = config.clock.clone().unwrap_or_else(|| Arc::new(now_ms));
        let fetch = config.fetch.clone().unwrap_or_else(default_fetch);
        let warn = config.warn.clone().unwrap_or_else(|| Arc::new(|_line| {}));
        Self {
            db,
            shared: Arc::new(EngineShared {
                cfg: Mutex::new(resolve_config(&config)),
                cache: Mutex::new(QueryCache::new()),
                drops: Mutex::new(DropState::new()),
                chunk: Mutex::new(ChunkState::new()),
                bump_log_at: Mutex::new(0),
                clock,
                fetch: Mutex::new(fetch),
                warn,
            }),
            health: Arc::new(tokio::sync::Mutex::new(HealthSlot {
                at: i64::MIN,
                cached: None,
                inflight: None,
            })),
        }
    }

    pub(crate) fn edit_config(&self, edit: impl FnOnce(&mut ResolvedConfig)) {
        edit(&mut self.shared.cfg.lock());
    }

    pub fn set_embed_endpoint(&self, endpoint: Option<String>) {
        self.shared.cfg.lock().embed_endpoint = endpoint.filter(|value| !value.is_empty());
    }

    pub fn set_embed_model(&self, model: impl Into<String>) {
        self.shared.cfg.lock().embed_model = model.into();
    }

    pub fn set_fetch(&self, fetch: EmbedFetch) {
        *self.shared.fetch.lock() = fetch;
    }

    pub(crate) fn database(&self) -> &D {
        &self.db
    }

    pub fn runtime_stats(&self) -> SearchRuntimeStats {
        let now = self.now_ms();
        let (query_embed_cache_hits, query_embed_cache_misses) = {
            let cache = self.shared.cache.lock();
            (cache.hits, cache.misses)
        };
        let (vector_arm_dropped, vector_arm_dropped_last_hour) = {
            let drops = self.shared.drops.lock();
            (drops.total, drops.last_hour(now))
        };
        let (chunk_arm_hits, parent_arm_hits, chunk_arm_unavailable) = {
            let chunk = self.shared.chunk.lock();
            (chunk.hits, chunk.parent_hits, chunk.unavailable)
        };
        SearchRuntimeStats {
            vector_arm_dropped,
            vector_arm_dropped_last_hour,
            query_embed_cache_hits,
            query_embed_cache_misses,
            chunk_arm_hits,
            parent_arm_hits,
            chunk_arm_unavailable,
        }
    }

    pub async fn search(
        &self,
        query: &str,
        options: &EngineOptions,
    ) -> Result<SearchResults, SearchFail> {
        if let Some(message) = self.model_problem() {
            return Err(SearchFail::Request(message));
        }
        let options = self.with_window(options)?;
        if let Some(tag) = options.tag.clone().filter(|tag| !tag.is_empty()) {
            return self.search_with_tag(query, &options, &tag).await;
        }
        self.search_unfiltered(query, &options).await
    }

    pub async fn check_embedding_health(&self) -> HealthView {
        if let Some(reason) = self.model_problem() {
            return HealthView {
                available: false,
                checked_at: self.now_iso(),
                reason: Some(reason),
            };
        }
        let now = self.now_ms();
        let mut slot = self.health.lock().await;
        if now.saturating_sub(slot.at) < HEALTH_COALESCE_MS {
            if let Some(cached) = slot.cached.clone() {
                return cached;
            }
            if let Some(rx) = slot.inflight.clone() {
                drop(slot);
                return wait_health(rx).await;
            }
        }
        slot.at = now;
        let (tx, rx) = tokio::sync::watch::channel(None);
        slot.inflight = Some(rx);
        slot.cached = None;
        drop(slot);
        tokio::task::yield_now().await;
        let outcome = self.embed_query("memory health check", true).await;
        let view = HealthView {
            available: outcome.vec.is_some(),
            checked_at: self.now_iso(),
            reason: if outcome.vec.is_some() {
                None
            } else {
                Some(outcome.reason.unwrap_or_else(|| "unknown".to_string()))
            },
        };
        let mut slot = self.health.lock().await;
        slot.cached = Some(view.clone());
        slot.inflight = None;
        drop(slot);
        let _ = tx.send(Some(view.clone()));
        view
    }

    pub async fn bump_access(&self, hits: &[SearchHit]) {
        let messages: Vec<String> = hits
            .iter()
            .filter(|hit| hit.hit_type == "message")
            .map(|hit| hit.id.clone())
            .collect();
        let summaries: Vec<String> = hits
            .iter()
            .filter(|hit| hit.hit_type == "summary")
            .map(|hit| hit.id.clone())
            .collect();
        let outcome = async {
            if !messages.is_empty() {
                self.db
                    .query(BUMP_MESSAGES, &[Bind::Texts(messages)])
                    .await?;
            }
            if !summaries.is_empty() {
                self.db
                    .query(BUMP_SUMMARIES, &[Bind::Texts(summaries)])
                    .await?;
            }
            Ok::<(), DbFail>(())
        }
        .await;
        if let Err(err) = outcome {
            self.log_bump(&err.message);
        }
    }

    pub async fn embed_wiki_text(&self, text: &str) -> Option<Vec<f64>> {
        let cfg = self.resolved();
        let (Some(endpoint), model) = (cfg.embed_endpoint, cfg.embed_model) else {
            return None;
        };
        if model.is_empty() {
            return None;
        }
        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(model));
        body.insert("input".to_string(), Value::String(text.to_string()));
        let call = EmbedCall {
            url: format!("{}/v1/embeddings", endpoint.trim_end_matches('/')),
            body: Value::Object(body),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            timeout_ms: cfg.embed_timeout_ms,
        };
        let fetch = self.shared.fetch.lock().clone();
        let response = match tokio::time::timeout(
            Duration::from_millis(cfg.embed_timeout_ms.max(0) as u64),
            fetch(call),
        )
        .await
        {
            Ok(Ok(response)) if (200..300).contains(&response.status) => response,
            _ => return None,
        };
        let data = serde_json::from_str::<Value>(&response.body).ok()?;
        let parsed = parse_embed_response(&data, 1);
        normalize_embed_vector(
            parsed.first().cloned().flatten(),
            cfg.embed_expected_dims,
            Some(EMBED_TRUNCATE_DIMS),
        )
    }

    fn resolved(&self) -> ResolvedConfig {
        self.shared.cfg.lock().clone()
    }

    fn now_ms(&self) -> i64 {
        (self.shared.clock)()
    }

    fn now_iso(&self) -> String {
        DateTime::from_timestamp_millis(self.now_ms())
            .map(format_js_iso)
            .unwrap_or_else(|| format_js_iso(Utc::now()))
    }

    fn warn(&self, line: &str) {
        tracing::warn!("{line}");
        (self.shared.warn)(line);
    }

    fn model_problem(&self) -> Option<String> {
        let cfg = self.resolved();
        if cfg.embed_endpoint.is_some() && cfg.embed_model.is_empty() {
            Some(MODEL_REQUIRED.to_string())
        } else {
            None
        }
    }

    fn with_window(&self, options: &EngineOptions) -> Result<EngineOptions, SearchFail> {
        let (since, before) = apply_window_args(
            options.window.as_deref(),
            options.since.as_deref(),
            options.before.as_deref(),
            chrono::Local::now(),
        )
        .map_err(SearchFail::Request)?;
        let mut out = options.clone();
        out.since = since;
        out.before = before;
        out.window = None;
        Ok(out)
    }

    async fn search_with_tag(
        &self,
        query: &str,
        options: &EngineOptions,
        tag: &str,
    ) -> Result<SearchResults, SearchFail> {
        let Some((key, value)) = parse_tag_literal(tag) else {
            return Err(SearchFail::Request(format!(
                "tag must be key:value (got \"{tag}\")"
            )));
        };
        let ids = match self
            .db
            .query(
                TAG_SQL,
                &[
                    Bind::Text(normalize_tag_key(&key)),
                    Bind::Text(normalize_tag_value(&value)),
                ],
            )
            .await
        {
            Ok(result) => result
                .rows
                .iter()
                .map(|row| text_cell(row, "id"))
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>(),
            Err(err) if tag_table_missing(&err.message) => Vec::new(),
            Err(err) => return Err(err.into()),
        };
        if ids.is_empty() {
            return Ok(SearchResults::empty());
        }
        let mut next = options.clone();
        next.tag = None;
        next.conversation_ids = Some(ids);
        self.search_unfiltered(query, &next).await
    }

    async fn search_unfiltered(
        &self,
        query: &str,
        options: &EngineOptions,
    ) -> Result<SearchResults, SearchFail> {
        let mode = options.mode.as_deref().unwrap_or("hybrid");
        let scope = options.scope.as_deref().unwrap_or("both");
        let limit = options.limit.unwrap_or(20);
        if mode == "hybrid" {
            return self.hybrid_search(query, scope, limit, options).await;
        }
        if mode == "vector" {
            let embedded = self.embed_query(query, false).await;
            let Some(vec) = embedded.vec.clone() else {
                let hits = self
                    .single_text_search("fts", query, scope, limit, options, true)
                    .await?;
                if self.resolved().embed_endpoint.is_some() {
                    let reason = embedded.reason.unwrap_or_else(|| "unknown".to_string());
                    self.record_drop(&reason, embedded.elapsed_ms);
                    return Ok(annotate(
                        hits,
                        Some(SearchDegraded {
                            vector: true,
                            reason,
                        }),
                        None,
                        None,
                    ));
                }
                return Ok(hits);
            };
            let hits = self.vector_search(&vec, scope, limit, options).await?;
            self.fire_bump(&hits);
            return Ok(annotate(
                SearchResults {
                    hits,
                    degraded: None,
                    fallback: None,
                    chunk_arm: None,
                },
                None,
                None,
                self.chunk_signal(),
            ));
        }
        self.single_text_search(mode, query, scope, limit, options, false)
            .await
    }

    async fn single_text_search(
        &self,
        mode: &str,
        query: &str,
        scope: &str,
        limit: i64,
        options: &EngineOptions,
        skip_embed: bool,
    ) -> Result<SearchResults, SearchFail> {
        let mut degraded = None;
        let mut embedding = None;
        if mode == "fts" && self.resolved().embed_endpoint.is_some() && !skip_embed {
            let embedded = self.embed_query(query, false).await;
            if let Some(vec) = embedded.vec.clone() {
                embedding = Some(vec);
            } else {
                let reason = embedded.reason.unwrap_or_else(|| "unknown".to_string());
                self.log_drop(&reason, embedded.elapsed_ms);
                degraded = Some(SearchDegraded {
                    vector: true,
                    reason,
                });
            }
        }
        let mut hits = Vec::new();
        if scope == "messages" || scope == "both" {
            hits.extend(
                self.search_messages(query, mode, limit, options, embedding.as_deref())
                    .await?,
            );
        }
        if scope == "summaries" || scope == "both" {
            hits.extend(
                self.search_summaries(query, mode, limit, options, embedding.as_deref())
                    .await?,
            );
        }
        sort_hits(&mut hits);
        truncate_hits(&mut hits, limit);
        if mode == "fts" && hits.is_empty() && should_trigram_fallback(query) {
            let recovered =
                Box::pin(self.single_text_search("trigram", query, scope, limit, options, true))
                    .await?;
            if !recovered.hits.is_empty() {
                return Ok(annotate(
                    recovered,
                    degraded,
                    Some("trigram".to_string()),
                    None,
                ));
            }
        }
        self.fire_bump(&hits);
        Ok(annotate(
            SearchResults {
                hits,
                degraded: None,
                fallback: None,
                chunk_arm: None,
            },
            degraded,
            None,
            None,
        ))
    }

    async fn hybrid_search(
        &self,
        query: &str,
        scope: &str,
        limit: i64,
        options: &EngineOptions,
    ) -> Result<SearchResults, SearchFail> {
        let pool = hybrid_pool_size(limit);
        let embedded = if self.resolved().embed_endpoint.is_some() {
            Some(self.embed_query(query, false).await)
        } else {
            None
        };
        let qvec = embedded.as_ref().and_then(|item| item.vec.clone());
        let mut degraded = None;
        if self.resolved().embed_endpoint.is_some()
            && let Some(item) = &embedded
            && item.vec.is_none()
        {
            let reason = item.reason.clone().unwrap_or_else(|| "unknown".to_string());
            self.record_drop(&reason, item.elapsed_ms);
            degraded = Some(SearchDegraded {
                vector: true,
                reason,
            });
        }
        let use_trigram = looks_literal(query);
        let (fts, initial_trigram, vector) = tokio::join!(
            self.retrieve_text("fts", query, scope, pool, options),
            async {
                if use_trigram {
                    self.retrieve_text("trigram", query, scope, pool, options)
                        .await
                } else {
                    Ok(Vec::new())
                }
            },
            async {
                if let Some(vec) = &qvec {
                    self.retrieve_vector(vec, scope, pool, options).await
                } else {
                    Ok(Vec::new())
                }
            }
        );
        let fts = fts?;
        let mut trigram = initial_trigram?;
        let vector = vector?;
        let mut fallback = None;
        if !use_trigram && fts.is_empty() && should_trigram_fallback(query) {
            if trigram.is_empty() {
                trigram = self
                    .retrieve_text("trigram", query, scope, pool, options)
                    .await?;
            }
            if !trigram.is_empty() {
                fallback = Some("trigram".to_string());
            }
        }
        let fused = rrf_fuse(&[fts, trigram, vector]);
        let top = truncate_owned(fused, limit);
        let chunk = if qvec.is_some() {
            self.chunk_signal()
        } else {
            None
        };
        let results = annotate(
            SearchResults {
                hits: top,
                degraded: None,
                fallback: None,
                chunk_arm: None,
            },
            degraded,
            fallback,
            chunk,
        );
        self.fire_bump(&results.hits);
        Ok(results)
    }

    async fn retrieve_text(
        &self,
        method: &str,
        query: &str,
        scope: &str,
        pool: i64,
        options: &EngineOptions,
    ) -> Result<Vec<Candidate>, SearchFail> {
        let mut out = Vec::new();
        if scope == "messages" || scope == "both" {
            let parts = build_text_query(&TextBuild {
                alias: "m",
                query,
                mode: method,
                limit: pool,
                options,
                embedding: None,
                agent_filter: true,
                quality_filter: true,
            })?;
            let sql = format!(
                "SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at, m.tool_name, m.tool_result, {boost} AS boost FROM ros_messages m WHERE {where_clause} ORDER BY {score} DESC LIMIT ${limit}",
                boost = message_boost(),
                where_clause = parts.where_clause,
                score = parts.fts_score_expr,
                limit = parts.limit_idx,
            );
            let rows = self.db.query(&sql, &parts.params).await?;
            out.extend(rows.rows.iter().map(|row| map_candidate(row, "message")));
        }
        if scope == "summaries" || scope == "both" {
            let parts = build_text_query(&TextBuild {
                alias: "s",
                query,
                mode: method,
                limit: pool,
                options,
                embedding: None,
                agent_filter: false,
                quality_filter: true,
            })?;
            let sql = format!(
                "SELECT s.id, s.content, s.kind AS role, 'summary' AS agent, s.conversation_id, s.created_at, s.kind, s.earliest_at, s.latest_at, {boost} AS boost FROM ros_summaries s WHERE {where_clause} ORDER BY {score} DESC LIMIT ${limit}",
                boost = summary_boost(),
                where_clause = parts.where_clause,
                score = parts.fts_score_expr,
                limit = parts.limit_idx,
            );
            let rows = self.db.query(&sql, &parts.params).await?;
            out.extend(rows.rows.iter().map(|row| map_candidate(row, "summary")));
        }
        Ok(out)
    }

    async fn retrieve_vector(
        &self,
        qvec: &[f64],
        scope: &str,
        pool: i64,
        options: &EngineOptions,
    ) -> Result<Vec<Candidate>, SearchFail> {
        let mut session = self.open_hnsw().await?;
        let result = self
            .vector_candidates(&mut session, qvec, scope, pool, options, true)
            .await;
        self.finish_hnsw(&mut session, result).await
    }

    async fn vector_candidates(
        &self,
        session: &mut D::Session,
        qvec: &[f64],
        scope: &str,
        pool: i64,
        options: &EngineOptions,
        with_window: bool,
    ) -> Result<Vec<Candidate>, SearchFail> {
        let literal = vector_literal(qvec);
        let mut out = Vec::new();
        if scope == "messages" || scope == "both" {
            let (sql, params) = message_vector_pool_sql(&literal, pool, options, with_window);
            let rows = session.query(&sql, &params).await?;
            let parents: Vec<Candidate> = rows
                .rows
                .iter()
                .map(|row| map_candidate(row, "message"))
                .collect();
            let chunks = self
                .chunk_candidates(session, &literal, pool, options, with_window)
                .await;
            let (merged, chunk_wins, parent_wins) =
                merge_candidates(parents, chunks, Some(as_usize(pool)));
            self.add_arm_counts(chunk_wins, parent_wins);
            out.extend(merged);
        }
        if scope == "summaries" || scope == "both" {
            let (sql, params) = summary_vector_pool_sql(&literal, pool, options, with_window);
            let rows = session.query(&sql, &params).await?;
            out.extend(rows.rows.iter().map(|row| map_candidate(row, "summary")));
        }
        Ok(out)
    }

    async fn vector_search(
        &self,
        embedding: &[f64],
        scope: &str,
        limit: i64,
        options: &EngineOptions,
    ) -> Result<Vec<SearchHit>, SearchFail> {
        let mut session = self.open_hnsw().await?;
        let result = self
            .explicit_vector(&mut session, embedding, scope, limit, options)
            .await;
        let mut hits = self.finish_hnsw(&mut session, result).await?;
        sort_hits(&mut hits);
        truncate_hits(&mut hits, limit);
        self.fire_bump(&hits);
        Ok(hits)
    }

    async fn explicit_vector(
        &self,
        session: &mut D::Session,
        embedding: &[f64],
        scope: &str,
        limit: i64,
        options: &EngineOptions,
    ) -> Result<Vec<SearchHit>, SearchFail> {
        let literal = vector_literal(embedding);
        let mut hits = Vec::new();
        if scope == "messages" || scope == "both" {
            let (sql, params) = explicit_message_vector_sql(&literal, limit, options);
            let rows = session.query(&sql, &params).await?;
            let parents: Vec<Candidate> = rows
                .rows
                .iter()
                .map(|row| map_candidate(row, "message"))
                .collect();
            let chunks = self
                .chunk_candidates(session, &literal, limit, options, false)
                .await;
            let (merged, chunk_wins, parent_wins) =
                merge_candidates(parents, chunks, Some(as_usize(limit)));
            self.add_arm_counts(chunk_wins, parent_wins);
            hits.extend(merged.into_iter().map(|candidate| {
                let mut hit = candidate.hit;
                hit.score = candidate.sim.unwrap_or(0.0) * W_SEMANTIC + candidate.boost;
                hit
            }));
        }
        if scope == "summaries" || scope == "both" {
            let (sql, params) = explicit_summary_vector_sql(&literal, limit, options);
            let rows = session.query(&sql, &params).await?;
            hits.extend(rows.rows.iter().map(map_scored_summary));
        }
        Ok(hits)
    }

    async fn chunk_candidates(
        &self,
        session: &mut D::Session,
        literal: &str,
        pool: i64,
        options: &EngineOptions,
        with_window: bool,
    ) -> Vec<Candidate> {
        if !self.chunk_ready(session).await {
            return Vec::new();
        }
        let (sql, params) = chunk_sql(literal, pool, options, with_window);
        if let Err(err) = session.query("SAVEPOINT chunk_arm", &[]).await {
            rollback_savepoint(session, "chunk_arm").await;
            self.fail_chunk(&err);
            return Vec::new();
        }
        let rows = match session.query(&sql, &params).await {
            Ok(rows) => rows,
            Err(err) => {
                rollback_savepoint(session, "chunk_arm").await;
                self.fail_chunk(&err);
                return Vec::new();
            }
        };
        if let Err(err) = session.query("RELEASE SAVEPOINT chunk_arm", &[]).await {
            rollback_savepoint(session, "chunk_arm").await;
            self.fail_chunk(&err);
            return Vec::new();
        }
        rows.rows.iter().map(map_chunk).collect()
    }

    async fn chunk_ready(&self, session: &mut D::Session) -> bool {
        if let Some(ready) = self.shared.chunk.lock().available {
            return ready;
        }
        if let Err(err) = session.query("SAVEPOINT chunk_arm_probe", &[]).await {
            rollback_savepoint(session, "chunk_arm_probe").await;
            self.fail_chunk(&err);
            return false;
        }
        let result = match session.query(CHUNK_ARM_PROBE_SQL, &[]).await {
            Ok(result) => result,
            Err(err) => {
                rollback_savepoint(session, "chunk_arm_probe").await;
                self.fail_chunk(&err);
                return false;
            }
        };
        if let Err(err) = session
            .query("RELEASE SAVEPOINT chunk_arm_probe", &[])
            .await
        {
            rollback_savepoint(session, "chunk_arm_probe").await;
            self.fail_chunk(&err);
            return false;
        }
        let present = result
            .rows
            .first()
            .and_then(|row| cell(row, "present"))
            .and_then(Cell::as_bool)
            == Some(true);
        let granted = result
            .rows
            .first()
            .and_then(|row| cell(row, "granted"))
            .and_then(Cell::as_bool)
            == Some(true);
        if present && granted {
            self.shared.chunk.lock().available = Some(true);
            true
        } else {
            self.disable_chunk(if present {
                "no SELECT on ros_message_chunks"
            } else {
                "ros_message_chunks not present (run migrations)"
            });
            false
        }
    }

    fn fail_chunk(&self, err: &DbFail) {
        self.disable_chunk(&chunk_arm_error_reason(&err.message, err.code.as_deref()));
    }

    fn disable_chunk(&self, reason: &str) {
        let mut state = self.shared.chunk.lock();
        if state.available == Some(false) && state.reason.is_some() {
            return;
        }
        state.available = Some(false);
        state.reason = Some(reason.to_string());
        state.unavailable += 1;
        drop(state);
        self.warn(&format!(
            "[memory-search] chunk arm unavailable: {reason} — searching parents only"
        ));
    }

    fn chunk_signal(&self) -> Option<ChunkArmDegraded> {
        let state = self.shared.chunk.lock();
        if state.available == Some(false) {
            state.reason.clone().map(|reason| ChunkArmDegraded {
                chunks: true,
                reason,
            })
        } else {
            None
        }
    }

    fn add_arm_counts(&self, chunk_wins: u64, parent_wins: u64) {
        let mut state = self.shared.chunk.lock();
        state.hits += chunk_wins;
        state.parent_hits += parent_wins;
    }

    async fn search_messages(
        &self,
        query: &str,
        mode: &str,
        limit: i64,
        options: &EngineOptions,
        embedding: Option<&[f64]>,
    ) -> Result<Vec<SearchHit>, SearchFail> {
        let parts = build_text_query(&TextBuild {
            alias: "m",
            query,
            mode,
            limit,
            options,
            embedding,
            agent_filter: true,
            quality_filter: false,
        })?;
        let temporal = temporal_decay_sql("m");
        let importance = importance_sql("m");
        let sql = format!(
            "SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at, m.tool_name, m.tool_result, ({fts} * {w_fts} + {sem} * {w_sem} + ({temporal}) * {w_tmp} + ({importance}) * {w_imp})::float8 AS score FROM ros_messages m WHERE {where_clause} ORDER BY score DESC LIMIT ${limit_idx}",
            fts = parts.fts_score_expr,
            sem = parts.semantic_expr,
            w_fts = num(W_FTS),
            w_sem = num(W_SEMANTIC),
            w_tmp = num(W_TEMPORAL),
            w_imp = num(W_IMPORTANCE),
            where_clause = parts.where_clause,
            limit_idx = parts.limit_idx,
        );
        let rows = self.db.query(&sql, &parts.params).await?;
        Ok(rows.rows.iter().map(map_scored_message).collect())
    }

    async fn search_summaries(
        &self,
        query: &str,
        mode: &str,
        limit: i64,
        options: &EngineOptions,
        embedding: Option<&[f64]>,
    ) -> Result<Vec<SearchHit>, SearchFail> {
        let parts = build_text_query(&TextBuild {
            alias: "s",
            query,
            mode,
            limit,
            options,
            embedding,
            agent_filter: false,
            quality_filter: false,
        })?;
        let temporal = temporal_decay_sql("s");
        let sql = format!(
            "SELECT s.id, s.content, s.kind AS role, 'summary' AS agent, s.conversation_id, s.created_at, s.kind, s.earliest_at, s.latest_at, ({fts} * {w_fts} + {sem} * {w_sem} + ({temporal}) * {w_tmp} + {summary_importance} * {w_imp})::float8 AS score FROM ros_summaries s WHERE {where_clause} ORDER BY score DESC LIMIT ${limit_idx}",
            fts = parts.fts_score_expr,
            sem = parts.semantic_expr,
            w_fts = num(W_FTS),
            w_sem = num(W_SEMANTIC),
            w_tmp = num(W_TEMPORAL),
            w_imp = num(W_IMPORTANCE),
            summary_importance = num(SUMMARY_IMPORTANCE),
            where_clause = parts.where_clause,
            limit_idx = parts.limit_idx,
        );
        let rows = self.db.query(&sql, &parts.params).await?;
        Ok(rows.rows.iter().map(map_scored_summary).collect())
    }

    async fn embed_query(&self, text: &str, health: bool) -> EmbedOutcome {
        let cfg = self.resolved();
        let Some(endpoint) = cfg.embed_endpoint.clone() else {
            return EmbedOutcome {
                vec: None,
                reason: Some("not configured".to_string()),
                elapsed_ms: 0,
            };
        };
        let now = self.now_ms();
        let normalized = normalize_query_text(text);
        let cache_key = format!("{}\0{normalized}", cfg.embed_query_instruction);
        if !health && let Some(vec) = self.shared.cache.lock().get(&cache_key, now) {
            return EmbedOutcome {
                vec: Some(vec),
                reason: None,
                elapsed_ms: 0,
            };
        }
        let timeout_ms = if health {
            cfg.embed_timeout_ms.min(HEALTH_PROBE_CAP_MS)
        } else {
            cfg.embed_timeout_ms
        };
        let input = apply_embed_query_instruction(&cfg.embed_query_instruction, &normalized);
        let parts =
            build_embed_request(&endpoint, cfg.embed_wire_shape, &cfg.embed_model, &[input]);
        let started = self.now_ms();
        let fetch = self.shared.fetch.lock().clone();
        let token_source = cfg.embed_token_source.clone();
        let api_key = cfg.embed_api_key.clone();
        let expected = cfg.embed_expected_dims;
        let work = async move {
            let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
            let mut sent = None;
            if let Some(source) = &token_source {
                let token = source.get_token().await.map_err(FetchFail::Network)?;
                headers.push(("Authorization".to_string(), format!("Bearer {token}")));
                sent = Some((source.clone(), token));
            } else if !api_key.is_empty() {
                headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
            }
            let call = EmbedCall {
                url: parts.url.clone(),
                body: parts.body.clone(),
                headers: headers.clone(),
                timeout_ms,
            };
            let mut response = fetch(call).await?;
            if response.status == 401
                && let Some((source, token)) = sent
            {
                source.invalidate(Some(token.as_str()));
                let next = source.get_token().await.map_err(FetchFail::Network)?;
                headers.retain(|(name, _)| name != "Authorization");
                headers.push(("Authorization".to_string(), format!("Bearer {next}")));
                response = fetch(EmbedCall {
                    url: parts.url,
                    body: parts.body,
                    headers,
                    timeout_ms,
                })
                .await?;
            }
            Ok(response)
        };
        let result =
            tokio::time::timeout(Duration::from_millis(timeout_ms.max(0) as u64), work).await;
        let elapsed_ms = self.now_ms().saturating_sub(started);
        match result {
            Err(_) => EmbedOutcome {
                vec: None,
                reason: Some("timeout".to_string()),
                elapsed_ms,
            },
            Ok(Err(FetchFail::Timeout)) => EmbedOutcome {
                vec: None,
                reason: Some("timeout".to_string()),
                elapsed_ms,
            },
            Ok(Err(FetchFail::Network(_))) => EmbedOutcome {
                vec: None,
                reason: Some("network".to_string()),
                elapsed_ms,
            },
            Ok(Ok(response)) => {
                self.finish_embed(response, health, &cache_key, expected, elapsed_ms)
            }
        }
    }

    fn finish_embed(
        &self,
        response: EmbedResponse,
        health: bool,
        cache_key: &str,
        expected: Option<usize>,
        elapsed_ms: i64,
    ) -> EmbedOutcome {
        if !(200..300).contains(&response.status) {
            return EmbedOutcome {
                vec: None,
                reason: Some(format!("http {}", response.status)),
                elapsed_ms,
            };
        }
        let data = match serde_json::from_str::<Value>(&response.body) {
            Ok(data) => data,
            Err(_) => {
                return EmbedOutcome {
                    vec: None,
                    reason: Some("bad response".to_string()),
                    elapsed_ms,
                };
            }
        };
        let parsed = parse_embed_response(&data, 1);
        let clipped = normalize_embed_vector(
            parsed.first().cloned().flatten(),
            expected,
            Some(EMBED_TRUNCATE_DIMS),
        );
        let Some(vec) = clipped else {
            return EmbedOutcome {
                vec: None,
                reason: Some("empty vector".to_string()),
                elapsed_ms,
            };
        };
        if !health {
            self.shared
                .cache
                .lock()
                .set(cache_key.to_string(), vec.clone(), self.now_ms());
        }
        EmbedOutcome {
            vec: Some(vec),
            reason: None,
            elapsed_ms,
        }
    }

    fn record_drop(&self, reason: &str, elapsed_ms: i64) {
        self.shared.drops.lock().add(self.now_ms());
        self.log_drop(reason, elapsed_ms);
    }

    fn log_drop(&self, reason: &str, elapsed_ms: i64) {
        let now = self.now_ms();
        let mut drops = self.shared.drops.lock();
        if now.saturating_sub(drops.last_log_at) >= VECTOR_DROP_LOG_INTERVAL_MS {
            drops.last_log_at = now;
            drop(drops);
            self.warn(&format!(
                "[memory-search] vector arm dropped: {reason} ({elapsed_ms}ms)"
            ));
        }
    }

    fn log_bump(&self, message: &str) {
        let now = self.now_ms();
        let mut last = self.shared.bump_log_at.lock();
        if now.saturating_sub(*last) >= VECTOR_DROP_LOG_INTERVAL_MS {
            *last = now;
            drop(last);
            self.warn(&format!("[memory-search] access bump skipped: {message}"));
        }
    }

    fn fire_bump(&self, hits: &[SearchHit]) {
        let engine = self.clone();
        let hits = hits.to_vec();
        tokio::spawn(async move {
            engine.bump_access(&hits).await;
        });
    }

    async fn open_hnsw(&self) -> Result<D::Session, SearchFail> {
        let mut session = self.db.connect().await?;
        let ef = self.resolved().hnsw_ef_search;
        if let Err(err) = session.query("BEGIN", &[]).await {
            let fail = SearchFail::from(err);
            session.release(Some(fail.db_clone()));
            return Err(fail);
        }
        let set_sql = format!("SET LOCAL hnsw.ef_search = {ef}");
        if let Err(err) = session.query(&set_sql, &[]).await {
            let fail = SearchFail::from(err);
            let _ = session.query("ROLLBACK", &[]).await;
            session.release(Some(fail.db_clone()));
            return Err(fail);
        }
        Ok(session)
    }

    async fn finish_hnsw<T>(
        &self,
        session: &mut D::Session,
        result: Result<T, SearchFail>,
    ) -> Result<T, SearchFail> {
        match result {
            Ok(value) => match session.query("COMMIT", &[]).await {
                Ok(_) => {
                    session.release(None);
                    Ok(value)
                }
                Err(err) => {
                    let fail = SearchFail::from(err);
                    let _ = session.query("ROLLBACK", &[]).await;
                    session.release(Some(fail.db_clone()));
                    Err(fail)
                }
            },
            Err(err) => {
                let _ = session.query("ROLLBACK", &[]).await;
                session.release(Some(err.db_clone()));
                Err(err)
            }
        }
    }
}

fn resolve_config(config: &EngineConfig) -> ResolvedConfig {
    ResolvedConfig {
        embed_endpoint: config
            .embed_endpoint
            .clone()
            .filter(|value| !value.is_empty()),
        embed_model: config.embed_model.clone(),
        embed_query_instruction: match &config.embed_query_instruction {
            Some(value) => value.clone(),
            None => DEFAULT_EMBED_QUERY_INSTRUCTION.to_string(),
        },
        embed_timeout_ms: clamp_embed_timeout_ms(&config.embed_timeout_ms),
        hnsw_ef_search: clamp_hnsw_ef_search(&config.hnsw_ef_search),
        embed_api_key: config.embed_api_key.clone(),
        embed_token_source: config.embed_token_source.clone(),
        embed_wire_shape: config.embed_wire_shape,
        embed_expected_dims: config.embed_expected_dims,
    }
}

fn default_fetch() -> EmbedFetch {
    Arc::new(|call| {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(call.timeout_ms.max(1) as u64))
                .build()
                .map_err(|err| FetchFail::Network(err.to_string()))?;
            let mut request = client.post(&call.url);
            for (name, value) in &call.headers {
                request = request.header(name, value);
            }
            match request.json(&call.body).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response
                        .text()
                        .await
                        .map_err(|err| FetchFail::Network(err.to_string()))?;
                    Ok(EmbedResponse { status, body })
                }
                Err(err) if err.is_timeout() => Err(FetchFail::Timeout),
                Err(err) => Err(FetchFail::Network(err.to_string())),
            }
        })
    })
}

async fn wait_health(mut rx: tokio::sync::watch::Receiver<Option<HealthView>>) -> HealthView {
    loop {
        if let Some(view) = rx.borrow().clone() {
            return view;
        }
        if rx.changed().await.is_err() {
            break;
        }
    }
    HealthView {
        available: false,
        checked_at: format_js_iso(Utc::now()),
        reason: Some("unknown".to_string()),
    }
}

async fn rollback_savepoint(session: &mut impl SearchSession, name: &str) {
    let rollback = format!("ROLLBACK TO SAVEPOINT {name}");
    if session.query(&rollback, &[]).await.is_ok() {
        let release = format!("RELEASE SAVEPOINT {name}");
        let _ = session.query(&release, &[]).await;
    }
}

pub fn chunk_arm_error_reason(message: &str, code: Option<&str>) -> String {
    match code.unwrap_or("") {
        "42501" => "no SELECT on ros_message_chunks".to_string(),
        "42P01" => "ros_message_chunks missing".to_string(),
        "" => {
            if message.is_empty() {
                "unknown".to_string()
            } else {
                message.to_string()
            }
        }
        other => format!("sql {other}"),
    }
}

fn tag_table_missing(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("does not exist") || lower.contains("relation")
}

fn num(value: f64) -> String {
    format!("{value}")
}

fn as_usize(value: i64) -> usize {
    usize::try_from(value).unwrap_or(0)
}

fn message_boost() -> String {
    format!(
        "((({}) * {} + ({}) * {})::float8)",
        temporal_decay_sql("m"),
        num(W_TEMPORAL),
        importance_sql("m"),
        num(W_IMPORTANCE)
    )
}

fn summary_boost() -> String {
    format!(
        "((({}) * {} + {} * {})::float8)",
        temporal_decay_sql("s"),
        num(W_TEMPORAL),
        num(SUMMARY_IMPORTANCE),
        num(W_IMPORTANCE)
    )
}

fn annotate(
    mut results: SearchResults,
    degraded: Option<SearchDegraded>,
    fallback: Option<String>,
    chunk_arm: Option<ChunkArmDegraded>,
) -> SearchResults {
    let degraded = degraded.or(results.degraded.take());
    let fallback = fallback.or(results.fallback.take());
    let chunk_arm = chunk_arm.or(results.chunk_arm.take());
    if degraded.is_some() || fallback.is_some() || chunk_arm.is_some() {
        for hit in &mut results.hits {
            if let Some(fallback) = &fallback {
                hit.fallback = Some(fallback.clone());
            }
            if let Some(degraded) = &degraded {
                hit.degraded = Some(degraded.clone());
            }
            if let Some(chunk_arm) = &chunk_arm {
                hit.chunk_arm = Some(chunk_arm.clone());
            }
        }
    }
    results.degraded = degraded;
    results.fallback = fallback;
    results.chunk_arm = chunk_arm;
    results
}

fn rrf_fuse(lists: &[Vec<Candidate>]) -> Vec<SearchHit> {
    let fused = reciprocal_rank_fusion(lists, candidate_key, HYBRID_RRF_K);
    let arm_sets: Vec<HashSet<String>> = lists
        .iter()
        .map(|list| list.iter().map(candidate_key).collect())
        .collect();
    let mut scored = Vec::new();
    for (key, item) in fused {
        let arm_count = arm_sets.iter().filter(|set| set.contains(&key)).count();
        let layer = if item.item.hit.hit_type == "summary" {
            SUMMARY_FUSION_BONUS
        } else {
            1.0
        };
        let mut hit = item.item.hit;
        hit.score = item.rrf * (1.0 + item.item.boost) * layer;
        scored.push((hit, arm_count));
    }
    sort_scored(&mut scored);
    let Some(top) = scored.first().map(|(hit, _)| hit.score) else {
        return Vec::new();
    };
    scored
        .into_iter()
        .filter(|(hit, arms)| *arms >= 2 || hit.score >= top * GATE_FRACTION)
        .map(|(hit, _)| hit)
        .collect()
}

fn candidate_key(candidate: &Candidate) -> String {
    format!("{}:{}", candidate.hit.hit_type, candidate.hit.id)
}

fn sort_scored(scored: &mut [(SearchHit, usize)]) {
    scored.sort_by(|left, right| {
        right
            .0
            .score
            .partial_cmp(&left.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn sort_hits(hits: &mut [SearchHit]) {
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn truncate_hits(hits: &mut Vec<SearchHit>, limit: i64) {
    let keep = as_usize(limit);
    if hits.len() > keep {
        hits.truncate(keep);
    }
}

fn truncate_owned(mut hits: Vec<SearchHit>, limit: i64) -> Vec<SearchHit> {
    truncate_hits(&mut hits, limit);
    hits
}

#[derive(Clone, Copy)]
struct TextBuild<'a> {
    alias: &'a str,
    query: &'a str,
    mode: &'a str,
    limit: i64,
    options: &'a EngineOptions,
    embedding: Option<&'a [f64]>,
    agent_filter: bool,
    quality_filter: bool,
}

fn build_text_query(spec: &TextBuild<'_>) -> Result<TextParts, SearchFail> {
    let TextBuild {
        alias,
        query,
        mode,
        limit,
        options,
        embedding,
        agent_filter,
        quality_filter,
    } = *spec;
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    if agent_filter && let Some(agent) = &options.agent {
        params.push(Bind::Text(agent.clone()));
        conditions.push(format!("{alias}.agent = ${}", params.len()));
    }
    if let Some(ids) = &options.conversation_ids {
        params.push(Bind::Texts(ids.clone()));
        conditions.push(format!(
            "{alias}.conversation_id = ANY(${}::uuid[])",
            params.len()
        ));
    }
    if let Some(since) = &options.since {
        params.push(Bind::Text(since.clone()));
        conditions.push(format!(
            "{alias}.created_at >= ${}::timestamptz",
            params.len()
        ));
    }
    if let Some(before) = &options.before {
        params.push(Bind::Text(before.clone()));
        conditions.push(format!(
            "{alias}.created_at < ${}::timestamptz",
            params.len()
        ));
    }
    if quality_filter {
        conditions.push(if alias == "m" {
            message_quality_sql()
        } else {
            summary_quality_sql()
        });
    }
    params.push(Bind::Text(query.to_string()));
    let q = format!("${}", params.len());
    let (match_condition, fts_score_expr) = match mode {
        "fts" => {
            let match_condition = format!("{alias}.content_tsv @@ plainto_tsquery('english', {q})");
            let fts_score_expr = if alias == "m" {
                format!("ts_rank_cd({alias}.content_tsv, plainto_tsquery('english', {q}), 32)")
            } else {
                format!("ts_rank_cd({alias}.content_tsv, plainto_tsquery('english', {q}))")
            };
            (match_condition, fts_score_expr)
        }
        "trigram" => {
            if alias == "m" {
                (
                    format!(
                        "(similarity(m.content, {q}) > 0.3 OR similarity(coalesce(m.tool_result, ''), {q}) > 0.3)"
                    ),
                    format!(
                        "GREATEST(similarity(m.content, {q}), similarity(coalesce(m.tool_result, ''), {q}))"
                    ),
                )
            } else {
                (
                    format!("similarity(s.content, {q}) > 0.3"),
                    format!("similarity(s.content, {q})"),
                )
            }
        }
        "regex" => {
            if alias == "m" {
                (
                    format!("(m.content ~* {q} OR coalesce(m.tool_result, '') ~* {q})"),
                    "1.0".to_string(),
                )
            } else {
                (format!("s.content ~* {q}"), "1.0".to_string())
            }
        }
        other => {
            return Err(SearchFail::Request(format!("Unknown search mode: {other}")));
        }
    };
    conditions.push(match_condition);
    let semantic_expr = if mode == "fts"
        && let Some(embedding) = embedding
    {
        params.push(Bind::Text(vector_literal(embedding)));
        format!(
            "COALESCE(1 - ({alias}.embedding <=> ${}::halfvec), {})",
            params.len(),
            semantic_proxy_sql(alias)
        )
    } else {
        semantic_proxy_sql(alias)
    };
    params.push(Bind::I64(limit));
    let limit_idx = params.len();
    Ok(TextParts {
        where_clause: conditions.join(" AND "),
        fts_score_expr,
        semantic_expr,
        params,
        limit_idx,
    })
}

fn push_window(
    params: &mut Vec<Bind>,
    conds: &mut Vec<String>,
    alias: &str,
    options: &EngineOptions,
    with_window: bool,
) {
    if !with_window {
        return;
    }
    if let Some(since) = &options.since {
        params.push(Bind::Text(since.clone()));
        conds.push(format!(
            "{alias}.created_at >= ${}::timestamptz",
            params.len()
        ));
    }
    if let Some(before) = &options.before {
        params.push(Bind::Text(before.clone()));
        conds.push(format!(
            "{alias}.created_at < ${}::timestamptz",
            params.len()
        ));
    }
}

fn message_vector_pool_sql(
    literal: &str,
    pool: i64,
    options: &EngineOptions,
    with_window: bool,
) -> (String, Vec<Bind>) {
    let mut params = vec![Bind::Text(literal.to_string())];
    let mut conds = vec!["m.embedding IS NOT NULL".to_string(), message_quality_sql()];
    if let Some(agent) = &options.agent {
        params.push(Bind::Text(agent.clone()));
        conds.push(format!("m.agent = ${}", params.len()));
    }
    if let Some(ids) = &options.conversation_ids {
        params.push(Bind::Texts(ids.clone()));
        conds.push(format!(
            "m.conversation_id = ANY(${}::uuid[])",
            params.len()
        ));
    }
    push_window(&mut params, &mut conds, "m", options, with_window);
    params.push(Bind::I64(pool));
    let sql = format!(
        "SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at, m.tool_name, m.tool_result, (1 - (m.embedding <=> $1::halfvec)) AS semantic_sim, {boost} AS boost FROM ros_messages m WHERE {conds} ORDER BY m.embedding <=> $1::halfvec LIMIT ${limit}",
        boost = message_boost(),
        conds = conds.join(" AND "),
        limit = params.len(),
    );
    (sql, params)
}

fn summary_vector_pool_sql(
    literal: &str,
    pool: i64,
    options: &EngineOptions,
    with_window: bool,
) -> (String, Vec<Bind>) {
    let mut params = vec![Bind::Text(literal.to_string())];
    let mut conds = vec!["s.embedding IS NOT NULL".to_string(), summary_quality_sql()];
    if let Some(ids) = &options.conversation_ids {
        params.push(Bind::Texts(ids.clone()));
        conds.push(format!(
            "s.conversation_id = ANY(${}::uuid[])",
            params.len()
        ));
    }
    push_window(&mut params, &mut conds, "s", options, with_window);
    params.push(Bind::I64(pool));
    let sql = format!(
        "SELECT s.id, s.content, s.kind AS role, 'summary' AS agent, s.conversation_id, s.created_at, s.kind, s.earliest_at, s.latest_at, {boost} AS boost FROM ros_summaries s WHERE {conds} ORDER BY s.embedding <=> $1::halfvec LIMIT ${limit}",
        boost = summary_boost(),
        conds = conds.join(" AND "),
        limit = params.len(),
    );
    (sql, params)
}

fn explicit_message_vector_sql(
    literal: &str,
    limit: i64,
    options: &EngineOptions,
) -> (String, Vec<Bind>) {
    let mut params = vec![Bind::Text(literal.to_string())];
    let mut filters = Vec::new();
    if let Some(agent) = &options.agent {
        params.push(Bind::Text(agent.clone()));
        filters.push(format!("AND m.agent = ${}", params.len()));
    }
    if let Some(ids) = &options.conversation_ids {
        params.push(Bind::Texts(ids.clone()));
        filters.push(format!(
            "AND m.conversation_id = ANY(${}::uuid[])",
            params.len()
        ));
    }
    params.push(Bind::I64(limit));
    let sql = format!(
        "SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at, m.tool_name, m.tool_result, (1 - (m.embedding <=> $1::halfvec)) AS semantic_sim, {boost} AS boost FROM ros_messages m WHERE m.embedding IS NOT NULL {filters} ORDER BY m.embedding <=> $1::halfvec LIMIT ${limit}",
        boost = message_boost(),
        filters = filters.join(" "),
        limit = params.len(),
    );
    (sql, params)
}

fn explicit_summary_vector_sql(
    literal: &str,
    limit: i64,
    options: &EngineOptions,
) -> (String, Vec<Bind>) {
    let temporal = temporal_decay_sql("s");
    let ids = options.conversation_ids.is_some();
    let sql = format!(
        "SELECT s.id, s.content, s.kind AS role, 'summary' AS agent, s.conversation_id, s.created_at, s.kind, s.earliest_at, s.latest_at, (1 - (s.embedding <=> $1::halfvec))::float8 AS semantic_sim, ((1 - (s.embedding <=> $1::halfvec)) * {w_sem} + ({temporal}) * {w_tmp} + {summary_importance} * {w_imp})::float8 AS score FROM ros_summaries s WHERE s.embedding IS NOT NULL {ids_filter} ORDER BY s.embedding <=> $1::halfvec LIMIT $2",
        w_sem = num(W_SEMANTIC),
        w_tmp = num(W_TEMPORAL),
        w_imp = num(W_IMPORTANCE),
        summary_importance = num(SUMMARY_IMPORTANCE),
        ids_filter = if ids {
            "AND s.conversation_id = ANY($3::uuid[])"
        } else {
            ""
        },
    );
    let mut params = vec![Bind::Text(literal.to_string()), Bind::I64(limit)];
    if let Some(ids) = &options.conversation_ids {
        params.push(Bind::Texts(ids.clone()));
    }
    (sql, params)
}

fn chunk_sql(
    literal: &str,
    pool: i64,
    options: &EngineOptions,
    with_window: bool,
) -> (String, Vec<Bind>) {
    let mut params = vec![Bind::Text(literal.to_string())];
    let mut conds = vec!["c.embedding IS NOT NULL".to_string(), message_quality_sql()];
    if let Some(agent) = &options.agent {
        params.push(Bind::Text(agent.clone()));
        conds.push(format!("m.agent = ${}", params.len()));
    }
    if let Some(ids) = &options.conversation_ids {
        params.push(Bind::Texts(ids.clone()));
        conds.push(format!(
            "m.conversation_id = ANY(${}::uuid[])",
            params.len()
        ));
    }
    push_window(&mut params, &mut conds, "m", options, with_window);
    params.push(Bind::I64(chunk_pool_size(pool)));
    let chunk_pool_idx = params.len();
    params.push(Bind::I64(pool));
    let sql = format!(
        "WITH ranked AS ( SELECT c.message_id, c.idx, c.char_start, c.char_end, c.content, (1 - (c.embedding <=> $1::halfvec)) AS sim FROM ros_message_chunks c JOIN ros_messages m ON m.id = c.message_id WHERE {conds} ORDER BY c.embedding <=> $1::halfvec LIMIT ${chunk_pool_idx} ), best AS ( SELECT DISTINCT ON (message_id) message_id, idx, char_start, char_end, content, sim FROM ranked ORDER BY message_id, sim DESC, idx ) SELECT m.id, m.content, m.role, m.agent, m.metadata, m.conversation_id, m.created_at, m.tool_name, m.tool_result, {boost} AS boost, b.sim AS semantic_sim, b.content AS chunk_content, b.char_start AS chunk_char_start, b.char_end AS chunk_char_end, b.idx AS chunk_idx, (SELECT count(*) FROM ros_message_chunks c2 WHERE c2.message_id = b.message_id) AS chunk_count FROM best b JOIN ros_messages m ON m.id = b.message_id ORDER BY b.sim DESC LIMIT ${limit}",
        conds = conds.join(" AND "),
        boost = message_boost(),
        limit = params.len(),
    );
    (sql, params)
}

fn merge_candidates(
    parents: Vec<Candidate>,
    chunks: Vec<Candidate>,
    limit: Option<usize>,
) -> (Vec<Candidate>, u64, u64) {
    let mut order = Vec::new();
    let mut map: HashMap<String, Candidate> = HashMap::new();
    for parent in parents {
        if !map.contains_key(&parent.hit.id) {
            order.push(parent.hit.id.clone());
            map.insert(parent.hit.id.clone(), parent);
        }
    }
    for chunk in &chunks {
        if let Some(parent) = map.get(&chunk.hit.id).cloned() {
            if chunk.sim.unwrap_or(0.0) >= parent.sim.unwrap_or(0.0) {
                let mut won = parent;
                won.sim = Some(chunk.sim.unwrap_or(0.0));
                won.hit.snippet = chunk.hit.snippet.clone();
                map.insert(chunk.hit.id.clone(), won);
            }
        } else {
            order.push(chunk.hit.id.clone());
            map.insert(chunk.hit.id.clone(), chunk.clone());
        }
    }
    let mut merged = Vec::new();
    for id in order {
        if let Some(candidate) = map.remove(&id) {
            merged.push(candidate);
        }
    }
    merged.sort_by(|left, right| {
        right
            .sim
            .unwrap_or(0.0)
            .partial_cmp(&left.sim.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if let Some(limit) = limit {
        merged.truncate(limit);
    }
    let chunk_ids: HashSet<String> = chunks.iter().map(|chunk| chunk.hit.id.clone()).collect();
    let mut chunk_wins = 0u64;
    let mut parent_wins = 0u64;
    for item in &merged {
        if chunk_ids.contains(&item.hit.id) && item.hit.snippet.is_some() {
            chunk_wins += 1;
        } else {
            parent_wins += 1;
        }
    }
    (merged, chunk_wins, parent_wins)
}

fn map_candidate(row: &HashMap<String, Cell>, hit_type: &str) -> Candidate {
    let mut hit = blank_hit(row, hit_type);
    if hit_type == "message" {
        hit.tool_name = opt_text_cell(row, "tool_name");
        hit.tool_result = opt_text_cell(row, "tool_result");
        let (truncated, full_length) = truncated_meta(row.get("metadata"));
        hit.truncated = truncated;
        hit.full_length = full_length;
    } else {
        hit.kind = opt_text_cell(row, "kind");
        hit.earliest_at = row_time(row, "earliest_at");
        hit.latest_at = row_time(row, "latest_at");
    }
    Candidate {
        hit,
        boost: cell(row, "boost").and_then(Cell::as_f64).unwrap_or(0.0),
        sim: cell(row, "semantic_sim").and_then(Cell::as_f64),
    }
}

fn map_chunk(row: &HashMap<String, Cell>) -> Candidate {
    let mut candidate = map_candidate(row, "message");
    candidate.hit.snippet = Some(SearchSnippet {
        text: text_cell(row, "chunk_content"),
        char_start: loose_i64(row, "chunk_char_start").unwrap_or(0),
        char_end: loose_i64(row, "chunk_char_end").unwrap_or(0),
        chunk_idx: loose_i64(row, "chunk_idx").unwrap_or(0),
        chunk_count: loose_i64(row, "chunk_count"),
    });
    candidate
}

fn map_scored_message(row: &HashMap<String, Cell>) -> SearchHit {
    let mut candidate = map_candidate(row, "message");
    candidate.hit.score = cell(row, "score").and_then(Cell::as_f64).unwrap_or(0.0);
    candidate.hit
}

fn map_scored_summary(row: &HashMap<String, Cell>) -> SearchHit {
    let mut candidate = map_candidate(row, "summary");
    candidate.hit.score = cell(row, "score").and_then(Cell::as_f64).unwrap_or(0.0);
    candidate.hit
}

fn blank_hit(row: &HashMap<String, Cell>, hit_type: &str) -> SearchHit {
    SearchHit {
        id: text_cell(row, "id"),
        hit_type: hit_type.to_string(),
        content: text_cell(row, "content"),
        role: text_cell(row, "role"),
        agent: text_cell(row, "agent"),
        conversation_id: text_cell(row, "conversation_id"),
        score: 0.0,
        created_at: row_time(row, "created_at").unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
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
    }
}

fn opt_text_cell(row: &HashMap<String, Cell>, name: &str) -> Option<String> {
    match cell(row, name) {
        Some(Cell::Null) | None => None,
        Some(Cell::Text(text)) => Some(text.clone()),
        Some(other) => other.as_text().map(str::to_string),
    }
}

fn loose_i64(row: &HashMap<String, Cell>, name: &str) -> Option<i64> {
    let cell = cell(row, name)?;
    cell.as_i64()
        .or_else(|| cell.as_f64().map(|value| value as i64))
}

fn row_time(row: &HashMap<String, Cell>, name: &str) -> Option<DateTime<Utc>> {
    let text = cell(row, name).and_then(Cell::as_text)?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn truncated_meta(cell: Option<&Cell>) -> (bool, Option<i64>) {
    let Some(Cell::Json(Value::Object(map))) = cell else {
        return (false, None);
    };
    if map.get("truncated").and_then(Value::as_bool) != Some(true) {
        return (false, None);
    }
    let full = ["full_content_length", "full_tool_result_length"]
        .into_iter()
        .find_map(|key| {
            let value = map.get(key)?;
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
        });
    (true, full)
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod engine_tests;
