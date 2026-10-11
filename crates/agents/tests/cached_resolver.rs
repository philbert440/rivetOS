mod common;
pub use common::contract::*;
pub use common::*;

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agents::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentPresetStore, AgentRegistryBackend,
    BoxFuture, CachedPresetResolver, CachedPresetResolverOptions, PresetError,
    create_cached_preset_resolver,
};
use tokio::sync::oneshot;

enum Step {
    Rows(Vec<AgentPreset>),
    Wait(oneshot::Receiver<Vec<AgentPreset>>),
    Fail(String),
}

struct SeqStore {
    calls: AtomicUsize,
    find_calls: AtomicUsize,
    steps: Mutex<VecDeque<Step>>,
}

impl SeqStore {
    fn new(steps: Vec<Step>) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            find_calls: AtomicUsize::new(0),
            steps: Mutex::new(VecDeque::from(steps)),
        }
    }
}

impl AgentPresetStore for SeqStore {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::File
    }
    fn file(&self) -> Option<String> {
        None
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(true) })
    }
    fn list(&self, _: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let step = self.steps.lock().unwrap().pop_front();
        Box::pin(async move {
            match step {
                Some(Step::Rows(rows)) => Ok(rows),
                Some(Step::Wait(receiver)) => receiver
                    .await
                    .map_err(|err| PresetError::message(err.to_string())),
                Some(Step::Fail(message)) => Err(PresetError::message(message)),
                None => Err(PresetError::message("refresh was not bounded")),
            }
        })
    }
    fn get(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn find_by_handle(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.find_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(PresetError::message("findByHandle must not be called")) })
    }
    fn create(&self, _: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        Box::pin(async { Err(PresetError::message("no create")) })
    }
    fn update(
        &self,
        _: &str,
        _: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn delete(&self, _: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(false) })
    }
}

fn resolver(
    store: Arc<dyn AgentPresetStore>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ttl: i64,
    log: Option<agents::LogCallback>,
) -> CachedPresetResolver {
    create_cached_preset_resolver(
        store,
        CachedPresetResolverOptions {
            ttl_ms: Some(ttl),
            now: Some(now),
            log,
        },
    )
}

fn fixed_now(value: i64) -> Arc<dyn Fn() -> i64 + Send + Sync> {
    Arc::new(move || value)
}

fn clock(cell: &Arc<AtomicI64>) -> Arc<dyn Fn() -> i64 + Send + Sync> {
    let cell = Arc::clone(cell);
    Arc::new(move || cell.load(Ordering::SeqCst))
}

async fn wait_until(mut ready: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ready() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("condition was not met");
}

#[tokio::test]
async fn awaits_the_store_on_the_first_call() {
    let (sender, receiver) = oneshot::channel();
    let store = Arc::new(SeqStore::new(vec![Step::Wait(receiver)]));
    let resolver = resolver(store.clone(), fixed_now(0), 30_000, None);
    let pending = resolver.list();
    tokio::pin!(pending);
    assert!(futures_pending(&mut pending).await);
    assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    sender.send(vec![preset("a", "A")]).unwrap();
    let rows = pending.await;
    assert_eq!(rows[0].id, "a");
}

#[tokio::test]
async fn returns_the_last_known_list_when_stale_and_refreshes_once() {
    let (sender, receiver) = oneshot::channel();
    let store = Arc::new(SeqStore::new(vec![
        Step::Rows(vec![preset("a", "first")]),
        Step::Wait(receiver),
    ]));
    let now = Arc::new(AtomicI64::new(0));
    let resolver = resolver(store.clone(), clock(&now), 1_000, None);
    assert_eq!(resolver.list().await[0].name, "first");
    now.store(1_000, Ordering::SeqCst);
    assert_eq!(resolver.list().await[0].name, "first");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    assert_eq!(resolver.list().await[0].name, "first");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    sender.send(vec![preset("a", "second")]).unwrap();
    wait_until(|| {
        resolver
            .last_known()
            .first()
            .is_some_and(|row| row.name == "second")
    })
    .await;
}

#[tokio::test]
async fn keeps_the_last_known_list_when_a_refresh_throws() {
    let store = Arc::new(SeqStore::new(vec![
        Step::Rows(vec![preset("a", "Ok")]),
        Step::Fail("db down".to_string()),
    ]));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let logged = Arc::clone(&logs);
    let now = Arc::new(AtomicI64::new(0));
    let resolver = resolver(
        store.clone(),
        clock(&now),
        1_000,
        Some(Arc::new(move |message| {
            logged.lock().unwrap().push(message.to_string())
        })),
    );
    assert_eq!(resolver.list().await[0].name, "Ok");
    now.store(1_000, Ordering::SeqCst);
    assert_eq!(resolver.list().await[0].name, "Ok");
    wait_until(|| {
        logs.lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("db down"))
    })
    .await;
    assert_eq!(resolver.last_known()[0].name, "Ok");
    assert_eq!(resolver.list().await[0].name, "Ok");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn finds_by_handle_on_the_cached_list() {
    let store = Arc::new(SeqStore::new(vec![Step::Rows(vec![
        preset("beta", "Alpha"),
        preset("id-b", "beta"),
        preset("id-c", "Gamma"),
    ])]));
    let resolver = resolver(store.clone(), fixed_now(0), 30_000, None);
    assert_eq!(resolver.find("beta").await.unwrap().id, "beta");
    assert_eq!(resolver.find("Alpha").await.unwrap().id, "beta");
    assert_eq!(resolver.find("gamma").await.unwrap().id, "id-c");
    assert!(resolver.find("missing").await.is_none());
    assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.find_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalidate_makes_the_next_list_await_a_fresh_read() {
    let store = Arc::new(SeqStore::new(vec![
        Step::Rows(vec![preset("a", "n1")]),
        Step::Rows(vec![preset("a", "n2")]),
    ]));
    let resolver = resolver(store.clone(), fixed_now(0), 30_000, None);
    assert_eq!(resolver.list().await[0].name, "n1");
    assert_eq!(resolver.list().await[0].name, "n1");
    assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    resolver.invalidate();
    assert_eq!(resolver.list().await[0].name, "n2");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    assert_eq!(resolver.last_known()[0].name, "n2");
}

#[tokio::test]
async fn an_older_refresh_does_not_satisfy_the_next_list() {
    let (old_tx, old_rx) = oneshot::channel();
    let (new_tx, new_rx) = oneshot::channel();
    let store = Arc::new(SeqStore::new(vec![
        Step::Rows(vec![preset("old1", "old1")]),
        Step::Wait(old_rx),
        Step::Wait(new_rx),
    ]));
    let now = Arc::new(AtomicI64::new(0));
    let resolver = resolver(store.clone(), clock(&now), 1_000, None);
    assert_eq!(resolver.list().await[0].id, "old1");
    now.store(1_000, Ordering::SeqCst);
    assert_eq!(resolver.list().await[0].id, "old1");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    resolver.invalidate();
    let pending = resolver.list();
    tokio::pin!(pending);
    assert!(futures_pending(&mut pending).await);
    assert_eq!(store.calls.load(Ordering::SeqCst), 3);
    old_tx.send(vec![preset("old2", "old2")]).unwrap();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    assert_eq!(resolver.last_known()[0].id, "old1");
    new_tx.send(vec![preset("new", "new")]).unwrap();
    let rows = pending.await;
    assert_eq!(rows[0].id, "new");
    assert_eq!(store.calls.load(Ordering::SeqCst), 3);
    assert_eq!(resolver.last_known()[0].id, "new");
}

#[tokio::test]
async fn a_failed_cold_load_does_not_mark_the_cache_fresh() {
    let store = Arc::new(SeqStore::new(vec![
        Step::Fail("down".to_string()),
        Step::Rows(vec![preset("a", "Later")]),
    ]));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let logged = Arc::clone(&logs);
    let resolver = resolver(
        store.clone(),
        fixed_now(0),
        30_000,
        Some(Arc::new(move |message| {
            logged.lock().unwrap().push(message.to_string())
        })),
    );
    assert!(resolver.list().await.is_empty());
    assert!(logs.lock().unwrap().join("\n").contains("down"));
    assert!(resolver.last_known().is_empty());
    let rows = resolver.list().await;
    assert_eq!(rows[0].id, "a");
    assert_eq!(rows[0].name, "Later");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_throwing_logger_does_not_reject_the_refresh() {
    let store = Arc::new(SeqStore::new(vec![
        Step::Rows(vec![preset("a", "Ok")]),
        Step::Fail("db down".to_string()),
    ]));
    let now = Arc::new(AtomicI64::new(0));
    let resolver = resolver(
        store.clone(),
        clock(&now),
        1_000,
        Some(Arc::new(|_| panic!("log broke"))),
    );
    assert_eq!(resolver.list().await[0].name, "Ok");
    now.store(1_000, Ordering::SeqCst);
    assert_eq!(resolver.list().await[0].name, "Ok");
    wait_until(|| store.calls.load(Ordering::SeqCst) == 2).await;
    assert_eq!(resolver.last_known()[0].name, "Ok");
    assert_eq!(resolver.list().await[0].name, "Ok");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn one_list_stops_after_at_most_two_reads_when_refreshes_are_invalidated() {
    let invalidate_flag = Arc::new(Mutex::new(None::<Arc<dyn Fn() + Send + Sync>>));
    let store = Arc::new(CountingInvalidate {
        calls: AtomicUsize::new(0),
        invalidate: Arc::clone(&invalidate_flag),
    });
    let resolver = Arc::new(resolver(store.clone(), fixed_now(0), 30_000, None));
    let resolver_for_hook = Arc::clone(&resolver);
    *invalidate_flag.lock().unwrap() = Some(Arc::new(move || resolver_for_hook.invalidate()));
    let rows = resolver.list().await;
    let calls = store.calls.load(Ordering::SeqCst);
    assert!(calls >= 1);
    assert!(calls <= 2);
    assert_eq!(rows[0].id, "a");
    assert!(resolver.last_known().is_empty());
    let status = resolver.status();
    assert!(!status.has_value);
    assert_eq!(status.fetched_at, 0);
    assert!(status.last_error.is_none());
}

type InvalidateHook = Arc<dyn Fn() + Send + Sync>;

struct CountingInvalidate {
    calls: AtomicUsize,
    invalidate: Arc<Mutex<Option<InvalidateHook>>>,
}

impl AgentPresetStore for CountingInvalidate {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::File
    }
    fn file(&self) -> Option<String> {
        None
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(true) })
    }
    fn list(&self, _: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        let calls = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let hook = self.invalidate.lock().unwrap().clone();
        Box::pin(async move {
            if calls > 20 {
                return Err(PresetError::message("refresh was not bounded"));
            }
            if let Some(invalidate) = hook {
                invalidate();
            }
            Ok(vec![preset("a", &format!("n{calls}"))])
        })
    }
    fn get(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn find_by_handle(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn create(&self, _: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        Box::pin(async { Err(PresetError::message("no create")) })
    }
    fn update(
        &self,
        _: &str,
        _: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn delete(&self, _: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(false) })
    }
}

#[tokio::test]
async fn serves_a_warm_cache_for_the_ttl_after_a_failed_refresh() {
    let (sender, receiver) = oneshot::channel();
    let store = Arc::new(SeqStore::new(vec![
        Step::Rows(vec![preset("a", "Ok")]),
        Step::Fail("db down".to_string()),
        Step::Wait(receiver),
    ]));
    let now = Arc::new(AtomicI64::new(0));
    let resolver = resolver(store.clone(), clock(&now), 30_000, None);
    assert_eq!(resolver.list().await[0].name, "Ok");
    let status = resolver.status();
    assert!(status.has_value);
    assert_eq!(status.fetched_at, 0);
    assert!(status.last_error.is_none());
    resolver.invalidate();
    assert_eq!(resolver.list().await[0].name, "Ok");
    assert_eq!(resolver.list().await[0].name, "Ok");
    assert_eq!(resolver.list().await[0].name, "Ok");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    let status = resolver.status();
    assert!(status.has_value);
    assert_eq!(status.last_error.as_deref(), Some("db down"));
    assert_eq!(status.fetched_at, 0);
    assert_eq!(resolver.last_known()[0].name, "Ok");
    now.store(29_999, Ordering::SeqCst);
    assert_eq!(resolver.list().await[0].name, "Ok");
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    now.store(30_000, Ordering::SeqCst);
    let pending = resolver.list();
    tokio::pin!(pending);
    assert!(futures_pending(&mut pending).await);
    assert_eq!(store.calls.load(Ordering::SeqCst), 3);
    sender.send(vec![preset("a", "Later")]).unwrap();
    assert_eq!(pending.await[0].name, "Later");
    let status = resolver.status();
    assert!(status.has_value);
    assert_eq!(status.fetched_at, 30_000);
    assert!(status.last_error.is_none());
    assert_eq!(resolver.last_known()[0].name, "Later");
}

#[tokio::test]
async fn status_distinguishes_a_down_store_from_an_empty_registry() {
    let store = Arc::new(SeqStore::new(vec![
        Step::Fail("db down".to_string()),
        Step::Rows(Vec::new()),
    ]));
    let resolver = resolver(store.clone(), fixed_now(50), 30_000, None);
    let status = resolver.status();
    assert!(!status.has_value);
    assert_eq!(status.fetched_at, 0);
    assert!(resolver.list().await.is_empty());
    let status = resolver.status();
    assert!(!status.has_value);
    assert_eq!(status.last_error.as_deref(), Some("db down"));
    assert_eq!(status.fetched_at, 0);
    assert!(resolver.list().await.is_empty());
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    let status = resolver.status();
    assert!(status.has_value);
    assert_eq!(status.fetched_at, 50);
    assert!(status.last_error.is_none());
}

async fn futures_pending<T>(future: &mut Pin<&mut impl Future<Output = T>>) -> bool {
    tokio::time::timeout(Duration::from_millis(20), future)
        .await
        .is_err()
}
