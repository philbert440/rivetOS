#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

use crate::embed_wire::EmbedWireShape;
use crate::rows::{Bind, Cell, DbFail, QueryResult, collapse_ws};
use crate::scoring::LooseNumber;
use crate::search::{
    EmbedCall, EmbedResponse, EngineConfig, EngineOptions, FetchFail, SearchDb, SearchEngine,
    SearchSession,
};

type Handler = Arc<dyn Fn(&str, &[Bind]) -> Result<QueryResult, DbFail> + Send + Sync>;

struct FakeInner {
    handler: Mutex<Handler>,
    log: Mutex<Vec<String>>,
    client_log: Mutex<Vec<String>>,
    params_log: Mutex<Vec<Vec<String>>>,
    releases: Mutex<Vec<Option<String>>>,
    throw_select: Mutex<bool>,
    chunk_missing: Mutex<bool>,
    bump_fail: Mutex<bool>,
}

#[derive(Clone)]
struct FakeDb {
    inner: Arc<FakeInner>,
}

struct FakeSession {
    db: FakeDb,
    released: bool,
}

impl FakeDb {
    fn new() -> Self {
        Self {
            inner: Arc::new(FakeInner {
                handler: Mutex::new(Arc::new(|sql, _| stock(sql))),
                log: Mutex::new(Vec::new()),
                client_log: Mutex::new(Vec::new()),
                params_log: Mutex::new(Vec::new()),
                releases: Mutex::new(Vec::new()),
                throw_select: Mutex::new(false),
                chunk_missing: Mutex::new(false),
                bump_fail: Mutex::new(false),
            }),
        }
    }

    fn log(&self) -> Vec<String> {
        self.inner.log.lock().clone()
    }

    fn client_log(&self) -> Vec<String> {
        self.inner.client_log.lock().clone()
    }

    fn params(&self) -> Vec<Vec<String>> {
        self.inner.params_log.lock().clone()
    }

    fn releases(&self) -> Vec<Option<String>> {
        self.inner.releases.lock().clone()
    }
}

impl SearchDb for FakeDb {
    type Session = FakeSession;

    async fn query(&self, sql: &str, params: &[Bind]) -> Result<QueryResult, DbFail> {
        self.dispatch(sql, params, false).await
    }

    async fn connect(&self) -> Result<FakeSession, DbFail> {
        Ok(FakeSession {
            db: self.clone(),
            released: false,
        })
    }
}

impl FakeDb {
    async fn dispatch(
        &self,
        sql: &str,
        params: &[Bind],
        client: bool,
    ) -> Result<QueryResult, DbFail> {
        let flat = collapse_ws(sql);
        if client {
            self.inner.client_log.lock().push(flat.clone());
        }
        self.inner.log.lock().push(flat.clone());
        self.inner.params_log.lock().push(dump_binds(params));
        let upper = flat.to_ascii_uppercase();
        if upper.starts_with("UPDATE") && *self.inner.bump_fail.lock() {
            return Err(DbFail::new("bump failed"));
        }
        if client
            && *self.inner.throw_select.lock()
            && (upper.contains("SELECT") || flat.contains("<=>") || flat.contains("ros_messages"))
        {
            return Err(DbFail::new("vector select failed"));
        }
        if flat.contains("to_regclass('ros_message_chunks')") && *self.inner.chunk_missing.lock() {
            return Ok(probe(false, false));
        }
        let handler = self.inner.handler.lock().clone();
        handler(&flat, params)
    }
}

impl SearchSession for FakeSession {
    async fn query(&mut self, sql: &str, params: &[Bind]) -> Result<QueryResult, DbFail> {
        self.db.dispatch(sql, params, true).await
    }

    fn release(&mut self, err: Option<DbFail>) {
        if self.released {
            return;
        }
        self.released = true;
        self.db
            .inner
            .releases
            .lock()
            .push(err.map(|fail| fail.message));
    }
}

fn stock(sql: &str) -> Result<QueryResult, DbFail> {
    let upper = sql.to_ascii_uppercase();
    if upper.starts_with("UPDATE") || upper == "BEGIN" || upper == "COMMIT" || upper == "ROLLBACK" {
        return Ok(QueryResult::empty());
    }
    if upper.starts_with("SET LOCAL")
        || upper.starts_with("SAVEPOINT")
        || upper.starts_with("RELEASE")
    {
        return Ok(QueryResult::empty());
    }
    if sql.contains("has_table_privilege") || sql.contains("to_regclass('ros_message_chunks')") {
        return Ok(probe(true, true));
    }
    if sql.contains("ros_message_chunks") {
        return Ok(QueryResult::empty());
    }
    if sql.contains("similarity(") || sql.contains("~*") {
        return Ok(one_hit(
            "00000000-0000-4000-8000-000000000001",
            "families.app lives in a long enough document",
        ));
    }
    if sql.contains("<=>") {
        return Ok(one_hit(
            "00000000-0000-4000-8000-000000000009",
            "vector parent",
        ));
    }
    Ok(QueryResult::empty())
}

fn probe(present: bool, granted: bool) -> QueryResult {
    let mut row = HashMap::new();
    row.insert("present".to_string(), Cell::Bool(present));
    row.insert("granted".to_string(), Cell::Bool(granted));
    packed(vec![row])
}

fn one_hit(id: &str, content: &str) -> QueryResult {
    let mut row = HashMap::new();
    row.insert("id".to_string(), Cell::Text(id.to_string()));
    row.insert("content".to_string(), Cell::Text(content.to_string()));
    row.insert("role".to_string(), Cell::Text("user".to_string()));
    row.insert("agent".to_string(), Cell::Text("grok".to_string()));
    row.insert(
        "conversation_id".to_string(),
        Cell::Text("00000000-0000-4000-8000-000000000002".to_string()),
    );
    row.insert(
        "created_at".to_string(),
        Cell::Text("2026-08-01T12:00:00.000Z".to_string()),
    );
    row.insert("score".to_string(), Cell::F64(0.8));
    row.insert("boost".to_string(), Cell::F64(0.2));
    row.insert("semantic_sim".to_string(), Cell::F64(0.9));
    packed(vec![row])
}

fn packed(rows: Vec<HashMap<String, Cell>>) -> QueryResult {
    let row_count = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    QueryResult { rows, row_count }
}

fn dump_binds(params: &[Bind]) -> Vec<String> {
    params
        .iter()
        .map(|param| match param {
            Bind::Text(text) => text.clone(),
            Bind::Texts(texts) => texts.join(","),
            Bind::I64(value) => value.to_string(),
            Bind::F64(value) => value.to_string(),
            Bind::Bool(value) => value.to_string(),
            Bind::Null | Bind::NullTexts => String::new(),
        })
        .collect()
}

fn engine(db: FakeDb, endpoint: Option<&str>, model: &str) -> SearchEngine<FakeDb> {
    SearchEngine::new(
        db,
        EngineConfig {
            embed_endpoint: endpoint.map(str::to_string),
            embed_model: model.to_string(),
            ..EngineConfig::default()
        },
    )
    .expect("engine")
}

fn opts(mode: &str) -> EngineOptions {
    EngineOptions {
        mode: Some(mode.to_string()),
        scope: Some("messages".to_string()),
        limit: Some(5),
        ..EngineOptions::default()
    }
}

fn counting_fetch(status: u16, body: &'static str) -> (Arc<AtomicU64>, crate::search::EmbedFetch) {
    let calls = Arc::new(AtomicU64::new(0));
    let seen = calls.clone();
    let fetch = Arc::new(move |_call: EmbedCall| {
        seen.fetch_add(1, Ordering::SeqCst);
        let body = body.to_string();
        Box::pin(async move {
            if status == 599 {
                Err(FetchFail::Network("boom".to_string()))
            } else {
                Ok(EmbedResponse { status, body })
            }
        }) as crate::search::EmbedFut
    });
    (calls, fetch)
}

#[tokio::test]
async fn unknown_mode_and_bad_tag_are_request_errors() {
    let db = FakeDb::new();
    let engine = engine(db.clone(), None, "");
    let err = engine
        .search("q", &opts("nope"))
        .await
        .expect_err("mode")
        .to_string();
    assert_eq!(err, "Unknown search mode: nope");
    let err = engine
        .search(
            "q",
            &EngineOptions {
                tag: Some("nope".to_string()),
                ..opts("fts")
            },
        )
        .await
        .expect_err("tag")
        .to_string();
    assert_eq!(err, "tag must be key:value (got \"nope\")");
    assert!(db.log().is_empty());
}

#[tokio::test]
async fn missing_tag_table_returns_empty_and_known_tag_binds_ids() {
    let db = FakeDb::new();
    *db.inner.handler.lock() = Arc::new(|sql, _| {
        if sql.contains("FROM ros_tags t") {
            return Err(DbFail::new("relation \"ros_tags\" does not exist"));
        }
        stock(sql)
    });
    let engine = engine(db.clone(), None, "");
    let missing = engine
        .search(
            "q",
            &EngineOptions {
                tag: Some("topic:missing".to_string()),
                ..opts("fts")
            },
        )
        .await
        .expect("search");
    assert!(missing.hits.is_empty());
    assert!(db.log().iter().all(|sql| !sql.contains("plainto_tsquery")));
    *db.inner.handler.lock() = Arc::new(|sql, _| {
        if sql.contains("FROM ros_tags t") {
            let mut row = HashMap::new();
            row.insert("id".to_string(), Cell::Text("c-yes".to_string()));
            return Ok(packed(vec![row]));
        }
        stock(sql)
    });
    db.inner.log.lock().clear();
    db.inner.params_log.lock().clear();
    let _ = engine
        .search(
            "q",
            &EngineOptions {
                tag: Some("Project:AcmeApp".to_string()),
                ..opts("fts")
            },
        )
        .await
        .expect("tagged");
    let params = db.params();
    assert!(
        params
            .iter()
            .any(|row| row.iter().any(|item| item == "project"))
    );
    assert!(
        params
            .iter()
            .any(|row| row.iter().any(|item| item == "acmeapp"))
    );
    assert!(
        params
            .iter()
            .any(|row| row.iter().any(|item| item.contains("c-yes")))
    );
    assert!(db.log().iter().any(|sql| sql.contains("FROM ros_tags t")));
}

#[tokio::test]
async fn degraded_rules_follow_the_mode() {
    let db = FakeDb::new();
    let hybrid = engine(db.clone(), None, "");
    let plain = hybrid
        .search("hello", &opts("hybrid"))
        .await
        .expect("hybrid");
    assert!(plain.degraded.is_none());
    assert_eq!(hybrid.runtime_stats().vector_arm_dropped, 0);
    let vector = engine(db.clone(), None, "");
    let plain = vector
        .search("hello", &opts("vector"))
        .await
        .expect("vector");
    assert!(plain.degraded.is_none());
    assert_eq!(vector.runtime_stats().vector_arm_dropped, 0);
    let dropped = engine(db.clone(), Some("http://embed.test"), "m");
    let (calls, fetch) = counting_fetch(500, "");
    dropped.set_fetch(fetch);
    let result = dropped
        .search("hello", &opts("vector"))
        .await
        .expect("drop");
    assert_eq!(
        result.degraded.map(|item| item.reason).as_deref(),
        Some("http 500")
    );
    assert_eq!(dropped.runtime_stats().vector_arm_dropped, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let fts = engine(db, Some("http://embed.test"), "m");
    let (calls, fetch) = counting_fetch(500, "");
    fts.set_fetch(fetch);
    let result = fts.search("hello", &opts("fts")).await.expect("fts");
    assert_eq!(
        result.degraded.map(|item| item.reason).as_deref(),
        Some("http 500")
    );
    assert_eq!(fts.runtime_stats().vector_arm_dropped, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let trigram = engine(FakeDb::new(), Some("http://embed.test"), "m");
    let (calls, fetch) = counting_fetch(200, "{\"data\":[{\"embedding\":[0.2],\"index\":0}]}");
    trigram.set_fetch(fetch);
    let result = trigram
        .search("hello", &opts("trigram"))
        .await
        .expect("trigram");
    assert!(result.degraded.is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn literal_hybrid_runs_trigram_and_hyphen_falls_back() {
    let db = FakeDb::new();
    let engine = engine(db.clone(), None, "");
    let literal = engine
        .search("families.app", &opts("hybrid"))
        .await
        .expect("literal");
    assert!(literal.fallback.is_none());
    assert!(db.log().iter().any(|sql| sql.contains("similarity(")));
    assert!(db.log().iter().any(|sql| sql.contains("plainto_tsquery")));
    db.inner.log.lock().clear();
    let recovered = engine
        .search("foo-bar", &opts("fts"))
        .await
        .expect("fallback");
    assert_eq!(recovered.fallback.as_deref(), Some("trigram"));
    assert!(!recovered.hits.is_empty());
}

#[tokio::test]
async fn missing_embed_model_fails_at_construction_and_after_a_later_clear() {
    let err = SearchEngine::new(
        FakeDb::new(),
        EngineConfig {
            embed_endpoint: Some("http://embed.test".to_string()),
            embed_model: String::new(),
            ..EngineConfig::default()
        },
    )
    .err()
    .expect("model");
    assert!(err.contains("embedModel is required when embedEndpoint is set"));
    let engine = engine(FakeDb::new(), Some("http://embed.test"), "m");
    engine.set_embed_model("");
    let err = engine
        .search("q", &opts("fts"))
        .await
        .expect_err("model")
        .to_string();
    assert!(err.contains("embedModel is required when embedEndpoint is set"));
    let health = engine.check_embedding_health().await;
    assert!(!health.available);
    assert!(
        health
            .reason
            .unwrap_or_default()
            .contains("embedModel is required")
    );
    engine.set_embed_endpoint(Some(String::new()));
    engine.set_embed_model("m");
    let health = engine.check_embedding_health().await;
    assert_eq!(health.reason.as_deref(), Some("not configured"));
}

#[tokio::test]
async fn query_cache_is_separate_from_the_health_probe() {
    let now = Arc::new(Mutex::new(1_700_000_000_000i64));
    let clock_now = now.clone();
    let db = FakeDb::new();
    let engine = SearchEngine::new(
        db,
        EngineConfig {
            embed_endpoint: Some("http://embed.test".to_string()),
            embed_model: "m".to_string(),
            clock: Some(Arc::new(move || *clock_now.lock())),
            ..EngineConfig::default()
        },
    )
    .expect("engine");
    let (calls, fetch) = counting_fetch(200, "{\"data\":[{\"embedding\":[0.25,0.5],\"index\":0}]}");
    engine.set_fetch(fetch);
    let first = engine.check_embedding_health().await;
    let second = engine.check_embedding_health().await;
    assert!(first.available && second.available);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(engine.runtime_stats().query_embed_cache_misses, 0);
    let _ = engine.search("hello", &opts("fts")).await.expect("miss");
    let _ = engine.search("hello", &opts("fts")).await.expect("hit");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let stats = engine.runtime_stats();
    assert_eq!(stats.query_embed_cache_hits, 1);
    assert_eq!(stats.query_embed_cache_misses, 1);
    let (gate, _) = tokio::join!(
        engine.check_embedding_health(),
        engine.check_embedding_health()
    );
    assert!(gate.available);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn vector_arm_drop_buckets_decay_and_warn_is_throttled() {
    let now = Arc::new(Mutex::new(1_700_000_000_000i64));
    let clock_now = now.clone();
    let warns = Arc::new(Mutex::new(Vec::new()));
    let warn_log = warns.clone();
    let engine = SearchEngine::new(
        FakeDb::new(),
        EngineConfig {
            embed_endpoint: Some("http://embed.test".to_string()),
            embed_model: "m".to_string(),
            embed_timeout_ms: LooseNumber::Number(8000.0),
            clock: Some(Arc::new(move || *clock_now.lock())),
            warn: Some(Arc::new(move |line| warn_log.lock().push(line.to_string()))),
            ..EngineConfig::default()
        },
    )
    .expect("engine");
    let (_calls, fetch) = counting_fetch(500, "");
    engine.set_fetch(fetch);
    for _ in 0..3 {
        let _ = engine.search("hello", &opts("vector")).await.expect("drop");
    }
    assert_eq!(engine.runtime_stats().vector_arm_dropped, 3);
    assert_eq!(engine.runtime_stats().vector_arm_dropped_last_hour, 3);
    *now.lock() -= 30 * 60_000;
    assert_eq!(engine.runtime_stats().vector_arm_dropped_last_hour, 3);
    *now.lock() += 30 * 60_000;
    *now.lock() += 60_000;
    let _ = engine.search("hello", &opts("vector")).await.expect("drop");
    assert!(warns.lock().len() >= 2);
    assert!(
        warns
            .lock()
            .iter()
            .any(|line| line.contains("[memory-search] vector arm dropped: http 500"))
    );
    *now.lock() += 3_600_000 + 60_000;
    let stats = engine.runtime_stats();
    assert_eq!(stats.vector_arm_dropped, 4);
    assert_eq!(stats.vector_arm_dropped_last_hour, 0);
}

#[tokio::test]
async fn vector_transaction_sets_ef_search_and_releases_once() {
    let db = FakeDb::new();
    let engine = engine(db.clone(), Some("http://embed.test"), "m");
    let (_calls, fetch) = counting_fetch(200, "{\"data\":[{\"embedding\":[0.2,0.4],\"index\":0}]}");
    engine.set_fetch(fetch);
    let result = engine
        .search("hello", &opts("vector"))
        .await
        .expect("vector");
    assert!(result.degraded.is_none());
    assert!(!result.hits.is_empty());
    let client = db.client_log();
    assert_eq!(client.first().map(String::as_str), Some("BEGIN"));
    assert!(
        client
            .iter()
            .any(|sql| sql.starts_with("SET LOCAL hnsw.ef_search = "))
    );
    assert!(client.iter().any(|sql| sql.contains("<=>")));
    assert!(client.iter().any(|sql| sql == "SAVEPOINT chunk_arm"));
    assert!(client.iter().any(|sql| {
        sql.contains("ORDER BY c.embedding <=> $1::halfvec LIMIT")
            && !sql.contains("(c.embedding <=> $1::halfvec) + 0")
    }));
    assert!(
        client
            .iter()
            .any(|sql| sql == "RELEASE SAVEPOINT chunk_arm")
    );
    assert_eq!(client.last().map(String::as_str), Some("COMMIT"));
    assert_eq!(db.releases(), vec![None]);
    *db.inner.throw_select.lock() = true;
    let err = engine
        .search("hello", &opts("vector"))
        .await
        .expect_err("throw");
    assert!(err.to_string().contains("vector select failed"));
    let releases = db.releases();
    assert_eq!(
        releases.last().map(Option::as_deref),
        Some(Some("vector select failed"))
    );
    assert_eq!(releases.len(), 2);
}

#[tokio::test]
async fn chunk_probe_failure_is_sticky_and_bump_errors_do_not_fail_search() {
    let db = FakeDb::new();
    *db.inner.chunk_missing.lock() = true;
    let warns = Arc::new(Mutex::new(Vec::new()));
    let warn_log = warns.clone();
    let engine = SearchEngine::new(
        db.clone(),
        EngineConfig {
            embed_endpoint: Some("http://embed.test".to_string()),
            embed_model: "m".to_string(),
            warn: Some(Arc::new(move |line| warn_log.lock().push(line.to_string()))),
            ..EngineConfig::default()
        },
    )
    .expect("engine");
    let (_calls, fetch) = counting_fetch(200, "{\"data\":[{\"embedding\":[0.2],\"index\":0}]}");
    engine.set_fetch(fetch);
    let result = engine
        .search("hello", &opts("vector"))
        .await
        .expect("vector");
    let reason = result.chunk_arm.expect("chunk").reason;
    assert_eq!(reason, "ros_message_chunks not present (run migrations)");
    assert!(
        warns
            .lock()
            .iter()
            .any(|line| line.contains("[memory-search] chunk arm unavailable:"))
    );
    *db.inner.bump_fail.lock() = true;
    *db.inner.chunk_missing.lock() = false;
    db.inner.log.lock().clear();
    warns.lock().clear();
    let regex = engine.search("alpha", &opts("regex")).await.expect("regex");
    assert!(!regex.hits.is_empty());
    for _ in 0..30 {
        tokio::task::yield_now().await;
        if warns
            .lock()
            .iter()
            .any(|line| line.contains("access bump skipped"))
        {
            break;
        }
    }
    assert!(
        warns
            .lock()
            .iter()
            .any(|line| line.contains("[memory-search] access bump skipped: bump failed"))
    );
}

#[tokio::test]
async fn embed_reasons_and_native_body() {
    let cases = [
        (
            400,
            "{\"data\":[{\"embedding\":[0.1],\"index\":0}]}",
            "http 400",
        ),
        (200, "not-json", "bad response"),
        (
            200,
            "{\"data\":[{\"embedding\":[],\"index\":0}]}",
            "empty vector",
        ),
        (599, "", "network"),
    ];
    for (status, body, reason) in cases {
        let engine = engine(FakeDb::new(), Some("http://embed.test"), "m");
        let (_calls, fetch) = counting_fetch(status, body);
        engine.set_fetch(fetch);
        let result = engine
            .search("hello", &opts("vector"))
            .await
            .expect("search");
        assert_eq!(
            result.degraded.map(|item| item.reason).as_deref(),
            Some(reason)
        );
    }
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_body = seen.clone();
    let engine = engine(FakeDb::new(), Some("http://embed.test"), "m");
    engine.edit_config(|cfg| cfg.embed_wire_shape = EmbedWireShape::Native);
    engine.set_fetch(Arc::new(move |call: EmbedCall| {
        seen_body.lock().push(call.body.to_string());
        Box::pin(async move {
            Ok(EmbedResponse {
                status: 200,
                body: "{\"embeddings\":[[0.5,0.25]]}".to_string(),
            })
        }) as crate::search::EmbedFut
    }));
    let result = engine.search("hello", &opts("fts")).await.expect("native");
    assert!(result.degraded.is_none());
    let body = seen.lock().first().cloned().unwrap_or_default();
    assert!(body.contains("\"texts\""));
    assert!(body.contains("\"input\""));
}

#[tokio::test]
async fn local_embed_server_accepts_openai_and_times_out() {
    let body = "{\"data\":[{\"embedding\":[0.5,0.25],\"index\":0}]}";
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf = vec![0u8; 8192];
        let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = tokio::io::AsyncWriteExt::write_all(&mut sock, resp.as_bytes()).await;
    });
    let engine = engine(
        FakeDb::new(),
        Some(&format!("http://127.0.0.1:{port}")),
        "m",
    );
    let result = engine.search("hello", &opts("fts")).await.expect("openai");
    assert!(result.degraded.is_none());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf = vec![0u8; 1024];
        let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
        std::future::pending::<()>().await;
    });
    let engine = SearchEngine::new(
        FakeDb::new(),
        EngineConfig {
            embed_endpoint: Some(format!("http://127.0.0.1:{port}")),
            embed_model: "m".to_string(),
            embed_timeout_ms: LooseNumber::Number(500.0),
            ..EngineConfig::default()
        },
    )
    .expect("engine");
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        engine.search("hello", &opts("fts")),
    )
    .await
    .expect("timed search")
    .expect("search");
    assert_eq!(
        result.degraded.map(|item| item.reason).as_deref(),
        Some("timeout")
    );
}
