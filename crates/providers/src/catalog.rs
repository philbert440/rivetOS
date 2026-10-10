use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::types::lock;

pub const DEFAULT_CATALOG_TTL_MS: i64 = 60_000;
pub const DEFAULT_CATALOG_TIMEOUT_MS: u64 = 5_000;

pub type FetchIds = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<Vec<String>, String>> + Send>> + Send + Sync,
>;

struct Entry {
    discovered: Vec<String>,
    at: i64,
    failing: bool,
    last_error: Option<String>,
    inflight: bool,
}

pub struct ModelCatalog {
    floor: Vec<String>,
    ttl_ms: i64,
    timeout_ms: u64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    fetch: FetchIds,
    log: Option<Arc<dyn Fn(String) + Send + Sync>>,
    label: String,
    entry: Arc<Mutex<Entry>>,
}

impl ModelCatalog {
    pub fn new(
        floor: Vec<String>,
        fetch: FetchIds,
        ttl_ms: Option<i64>,
        timeout_ms: Option<u64>,
        now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
        log: Option<Arc<dyn Fn(String) + Send + Sync>>,
        label: Option<String>,
    ) -> Self {
        Self {
            floor: dedupe(floor.into_iter().filter(|id| !id.is_empty()).collect()),
            ttl_ms: ttl_ms.unwrap_or(DEFAULT_CATALOG_TTL_MS),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_CATALOG_TIMEOUT_MS),
            now: now.unwrap_or_else(|| Arc::new(|| 0)),
            fetch,
            log,
            label: label.unwrap_or_else(|| "models".to_string()),
            entry: Arc::new(Mutex::new(Entry {
                discovered: Vec::new(),
                at: i64::MIN,
                failing: false,
                last_error: None,
                inflight: false,
            })),
        }
    }

    pub fn list(&self) -> Vec<String> {
        let guard = lock(&self.entry);
        dedupe(
            self.floor
                .iter()
                .cloned()
                .chain(guard.discovered.iter().cloned())
                .collect(),
        )
    }

    pub fn refresh(&self) -> Vec<String> {
        let t = (self.now)();
        let start = {
            let mut guard = lock(&self.entry);
            let due = t.saturating_sub(guard.at) >= self.ttl_ms;
            if !guard.inflight && due {
                guard.inflight = true;
                true
            } else {
                false
            }
        };
        if start {
            let fetch = Arc::clone(&self.fetch);
            let timeout_ms = self.timeout_ms;
            let label = self.label.clone();
            let log = self.log.clone();
            let now = Arc::clone(&self.now);
            let entry = Arc::clone(&self.entry);
            tokio::spawn(async move {
                let fetched =
                    tokio::time::timeout(Duration::from_millis(timeout_ms), fetch()).await;
                let mut guard = lock(&entry);
                match fetched {
                    Ok(Ok(ids)) => {
                        guard.discovered =
                            dedupe(ids.into_iter().filter(|id| !id.is_empty()).collect());
                        guard.failing = false;
                        guard.last_error = None;
                    }
                    Ok(Err(msg)) => {
                        note_failure(&mut guard, &log, &label, msg);
                    }
                    Err(_) => {
                        note_failure(
                            &mut guard,
                            &log,
                            &label,
                            format!("timed out after {timeout_ms} ms"),
                        );
                    }
                }
                guard.at = now();
                guard.inflight = false;
            });
        }
        self.list()
    }

    pub fn last_error(&self) -> Option<String> {
        lock(&self.entry).last_error.clone()
    }
}

fn note_failure(
    guard: &mut Entry,
    log: &Option<Arc<dyn Fn(String) + Send + Sync>>,
    label: &str,
    msg: String,
) {
    if let Some(log) = log
        && !guard.failing
    {
        let kept = if guard.discovered.is_empty() {
            "static floor"
        } else {
            "last-known list"
        };
        log(format!(
            "[token-command] model catalog {label}: {msg} — serving the {kept}"
        ));
    }
    guard.last_error = Some(msg);
    guard.failing = true;
}

fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}
