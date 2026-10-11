use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type FetchFut = Pin<Box<dyn Future<Output = Result<Vec<String>, String>> + Send>>;
pub type FetchIds = Arc<dyn Fn() -> FetchFut + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

const DEFAULT_TTL_MS: i64 = 60_000;
const DEFAULT_TIMEOUT_MS: i64 = 5_000;

struct State {
    discovered: Vec<String>,
    at: i64,
    failing: bool,
    last_error: Option<String>,
    inflight: bool,
}

struct Inner {
    floor: Vec<String>,
    ttl_ms: i64,
    timeout_ms: i64,
    now: Clock,
    fetch_ids: FetchIds,
    log: Option<LogFn>,
    label: String,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct ModelCatalog {
    inner: Arc<Inner>,
}

impl ModelCatalog {
    pub fn new(
        floor: Vec<String>,
        fetch_ids: FetchIds,
        ttl_ms: Option<i64>,
        timeout_ms: Option<i64>,
        now: Option<Clock>,
        log: Option<LogFn>,
        label: Option<String>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                floor: dedupe(floor.into_iter().filter(|id| !id.is_empty()).collect()),
                ttl_ms: ttl_ms.unwrap_or(DEFAULT_TTL_MS),
                timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
                now: now.unwrap_or_else(|| Arc::new(crate::error::now_ms)),
                fetch_ids,
                log,
                label: label.unwrap_or_else(|| "models".to_string()),
                state: Mutex::new(State {
                    discovered: Vec::new(),
                    at: i64::MIN,
                    failing: false,
                    last_error: None,
                    inflight: false,
                }),
            }),
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.merged()
    }

    pub fn refresh(&self) -> Vec<String> {
        let start = {
            let mut state = self.inner.state.lock();
            let now = (self.inner.now)();
            if !state.inflight && now.saturating_sub(state.at) >= self.inner.ttl_ms {
                state.inflight = true;
                true
            } else {
                false
            }
        };
        if start {
            let catalog = self.clone();
            tokio::spawn(async move {
                catalog.finish_refresh().await;
            });
        }
        self.merged()
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner.state.lock().last_error.clone()
    }

    fn merged(&self) -> Vec<String> {
        let state = self.inner.state.lock();
        dedupe(
            self.inner
                .floor
                .iter()
                .cloned()
                .chain(state.discovered.iter().cloned())
                .collect(),
        )
    }

    async fn finish_refresh(&self) {
        let timeout = Duration::from_millis(self.inner.timeout_ms.max(0) as u64);
        let fetched = tokio::time::timeout(timeout, (self.inner.fetch_ids)()).await;
        let outcome = match fetched {
            Err(_) => Err(format!("timed out after {} ms", self.inner.timeout_ms)),
            Ok(result) => result,
        };
        let mut state = self.inner.state.lock();
        match outcome {
            Ok(ids) => {
                state.discovered = dedupe(ids.into_iter().filter(|id| !id.is_empty()).collect());
                state.failing = false;
                state.last_error = None;
            }
            Err(msg) => {
                if let Some(log) = &self.inner.log
                    && !state.failing
                {
                    let kept = if state.discovered.is_empty() {
                        "static floor"
                    } else {
                        "last-known list"
                    };
                    log(&format!(
                        "[token-command] model catalog {}: {msg} — serving the {kept}",
                        self.inner.label
                    ));
                }
                state.last_error = Some(msg);
                state.failing = true;
            }
        }
        state.at = (self.inner.now)();
        state.inflight = false;
    }
}

fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    fn ids(items: &[&str]) -> FetchIds {
        let owned: Vec<String> = items.iter().map(|s| (*s).to_string()).collect();
        Arc::new(move || {
            let owned = owned.clone();
            Box::pin(async move { Ok(owned) })
        })
    }

    async fn wait_until(mut pred: impl FnMut() -> bool) {
        for _ in 0..50 {
            if pred() {
                return;
            }
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(pred(), "catalog refresh did not finish");
    }

    #[tokio::test]
    async fn serves_the_static_floor() {
        let cat = ModelCatalog::new(
            vec!["floor-a".into(), "floor-b".into()],
            ids(&[]),
            None,
            None,
            Some(Arc::new(|| 0)),
            None,
            None,
        );
        assert_eq!(
            cat.list(),
            vec!["floor-a".to_string(), "floor-b".to_string()]
        );
    }

    #[tokio::test]
    async fn merges_discovered_ids_after_the_floor() {
        let now = Arc::new(AtomicI64::new(0));
        let clock = now.clone();
        let cat = ModelCatalog::new(
            vec!["floor-a".into()],
            ids(&["floor-a", "disc-1"]),
            Some(10),
            None,
            Some(Arc::new(move || clock.load(Ordering::SeqCst))),
            None,
            None,
        );
        cat.refresh();
        let cat2 = cat.clone();
        wait_until(|| cat2.list().iter().any(|id| id == "disc-1")).await;
        assert_eq!(
            cat.list(),
            vec!["floor-a".to_string(), "disc-1".to_string()]
        );
        now.store(20, Ordering::SeqCst);
        cat.refresh();
        assert_eq!(
            cat.list(),
            vec!["floor-a".to_string(), "disc-1".to_string()]
        );
    }

    #[tokio::test]
    async fn keeps_last_known_and_logs_once_per_outage() {
        let now = Arc::new(AtomicI64::new(0));
        let fail = Arc::new(AtomicBool::new(false));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let clock = now.clone();
        let fail_fetch = fail.clone();
        let fetch: FetchIds = Arc::new(move || {
            let fail_fetch = fail_fetch.clone();
            Box::pin(async move {
                if fail_fetch.load(Ordering::SeqCst) {
                    Err("down".to_string())
                } else {
                    Ok(vec!["disc".to_string()])
                }
            })
        });
        let log_sink = logs.clone();
        let cat = ModelCatalog::new(
            vec!["floor".into()],
            fetch,
            Some(10),
            None,
            Some(Arc::new(move || clock.load(Ordering::SeqCst))),
            Some(Arc::new(move |msg| log_sink.lock().push(msg.to_string()))),
            Some("vllm".into()),
        );
        cat.refresh();
        let cat2 = cat.clone();
        wait_until(|| cat2.list().iter().any(|id| id == "disc")).await;
        fail.store(true, Ordering::SeqCst);
        now.store(20, Ordering::SeqCst);
        cat.refresh();
        let cat3 = cat.clone();
        wait_until(|| cat3.last_error().unwrap_or_default().contains("down")).await;
        assert_eq!(cat.list(), vec!["floor".to_string(), "disc".to_string()]);
        assert_eq!(logs.lock().len(), 1);
        now.store(40, Ordering::SeqCst);
        cat.refresh();
        let logs2 = logs.clone();
        wait_until(|| logs2.lock().len() == 1).await;
        assert_eq!(logs.lock().len(), 1);
    }
}
