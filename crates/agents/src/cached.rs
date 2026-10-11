use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use parking_lot::{Mutex, MutexGuard};
use tokio::sync::watch;

use crate::error::PresetError;
use crate::preset::AgentPreset;
use crate::store::{AgentPresetStore, LogCallback, find_preset_by_handle, system_now_ms};

const DEFAULT_TTL_MS: i64 = 30_000;

struct CacheState {
    known: Vec<AgentPreset>,
    has_value: bool,
    fetched_at: i64,
    generation: u64,
    published_generation: i64,
    failed_generation: i64,
    failed_at: i64,
    last_error: Option<String>,
    inflight_generation: Option<u64>,
    inflight_id: u64,
    next_op: u64,
    inflight: Option<watch::Receiver<Option<Vec<AgentPreset>>>>,
}

struct Shared {
    store: Arc<dyn AgentPresetStore>,
    ttl_ms: i64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    log: Option<LogCallback>,
    state: Mutex<CacheState>,
}

pub struct CachedPresetStatus {
    pub has_value: bool,
    pub fetched_at: i64,
    pub last_error: Option<String>,
}

pub struct CachedPresetResolver {
    shared: Arc<Shared>,
}

pub struct CachedPresetResolverOptions {
    pub ttl_ms: Option<i64>,
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub log: Option<LogCallback>,
}

pub fn create_cached_preset_resolver(
    store: Arc<dyn AgentPresetStore>,
    opts: CachedPresetResolverOptions,
) -> CachedPresetResolver {
    CachedPresetResolver {
        shared: Arc::new(Shared {
            store,
            ttl_ms: opts.ttl_ms.unwrap_or(DEFAULT_TTL_MS),
            now: opts.now.unwrap_or_else(|| Arc::new(system_now_ms)),
            log: opts.log,
            state: Mutex::new(CacheState {
                known: Vec::new(),
                has_value: false,
                fetched_at: 0,
                generation: 0,
                published_generation: -1,
                failed_generation: -1,
                failed_at: 0,
                last_error: None,
                inflight_generation: None,
                inflight_id: 0,
                next_op: 1,
                inflight: None,
            }),
        }),
    }
}

impl CachedPresetResolver {
    pub async fn list(&self) -> Vec<AgentPreset> {
        let plan = {
            let state = lock(&self.shared.state);
            let now = (self.shared.now)();
            let generation_i64 = i64::try_from(state.generation).unwrap_or(i64::MAX);
            if state.has_value
                && state.failed_generation == generation_i64
                && now.saturating_sub(state.failed_at) < self.shared.ttl_ms
            {
                ListPlan::Ready(state.known.clone())
            } else if state.published_generation == generation_i64 && state.has_value {
                let known = state.known.clone();
                if now.saturating_sub(state.fetched_at) >= self.shared.ttl_ms {
                    ListPlan::Stale { known }
                } else {
                    ListPlan::Ready(known)
                }
            } else {
                ListPlan::Refresh
            }
        };
        match plan {
            ListPlan::Ready(known) => known,
            ListPlan::Stale { known } => {
                let _ = start_refresh(&self.shared);
                tokio::task::yield_now().await;
                known
            }
            ListPlan::Refresh => {
                let mut receiver = start_refresh(&self.shared);
                loop {
                    if let Some(rows) = receiver.borrow().clone() {
                        return rows;
                    }
                    if receiver.changed().await.is_err() {
                        return lock(&self.shared.state).known.clone();
                    }
                }
            }
        }
    }

    pub async fn find(&self, handle: &protocol::js::JsString) -> Option<AgentPreset> {
        let rows = self.list().await;
        find_preset_by_handle(&rows, handle).cloned()
    }

    pub fn last_known(&self) -> Vec<AgentPreset> {
        lock(&self.shared.state).known.clone()
    }

    pub fn invalidate(&self) {
        let mut state = lock(&self.shared.state);
        state.generation = state.generation.saturating_add(1);
    }

    pub fn status(&self) -> CachedPresetStatus {
        let state = lock(&self.shared.state);
        CachedPresetStatus {
            has_value: state.has_value,
            fetched_at: state.fetched_at,
            last_error: state.last_error.clone(),
        }
    }
}

enum ListPlan {
    Ready(Vec<AgentPreset>),
    Stale { known: Vec<AgentPreset> },
    Refresh,
}

fn lock(state: &Mutex<CacheState>) -> MutexGuard<'_, CacheState> {
    state.lock()
}

fn start_refresh(shared: &Arc<Shared>) -> watch::Receiver<Option<Vec<AgentPreset>>> {
    let (sender, receiver, generation, op_id) = {
        let mut state = lock(&shared.state);
        let generation = state.generation;
        if state.inflight_generation == Some(generation)
            && let Some(receiver) = state.inflight.clone()
        {
            return receiver;
        }
        let (sender, receiver) = watch::channel(None);
        let op_id = state.next_op;
        state.next_op = state.next_op.saturating_add(1);
        state.inflight_generation = Some(generation);
        state.inflight_id = op_id;
        state.inflight = Some(receiver.clone());
        (sender, receiver, generation, op_id)
    };
    let shared = Arc::clone(shared);
    tokio::spawn(async move {
        let rows = match shared.store.list(None).await {
            Ok(rows) => publish_success(&shared, generation, rows),
            Err(err) => publish_failure(&shared, generation, &err),
        };
        {
            let mut state = lock(&shared.state);
            if state.inflight_id == op_id {
                state.inflight = None;
                state.inflight_generation = None;
            }
        }
        let _ = sender.send(Some(rows));
    });
    receiver
}

fn publish_success(shared: &Shared, generation: u64, rows: Vec<AgentPreset>) -> Vec<AgentPreset> {
    let mut state = lock(&shared.state);
    if state.generation == generation {
        state.known = rows.clone();
        state.has_value = true;
        state.published_generation = i64::try_from(generation).unwrap_or(i64::MAX);
        state.fetched_at = (shared.now)();
        state.failed_generation = -1;
        state.last_error = None;
    }
    rows
}

fn publish_failure(shared: &Shared, generation: u64, err: &PresetError) -> Vec<AgentPreset> {
    let message = err.to_string();
    let known = {
        let mut state = lock(&shared.state);
        if state.generation == generation {
            state.last_error = Some(message.clone());
            if state.has_value {
                state.failed_generation = i64::try_from(generation).unwrap_or(i64::MAX);
                state.failed_at = (shared.now)();
            }
        }
        state.known.clone()
    };
    let line = format!("agent preset refresh failed: {message}");
    if let Some(log) = &shared.log {
        let log = Arc::clone(log);
        let owned = line;
        let _ = std::panic::catch_unwind(AssertUnwindSafe(move || log(&owned)));
    } else {
        tracing::warn!("{line}");
    }
    known
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::{oneshot, watch};

    use super::{CachedPresetResolverOptions, create_cached_preset_resolver, start_refresh};
    use crate::error::PresetError;
    use crate::js_row::{js_string, object_from_pairs};
    use crate::preset::{
        AgentPreset, AgentPresetInput, AgentPresetPatch, AgentRegistryBackend, preset_from_js,
    };
    use crate::store::{AgentPresetStore, BoxFuture};

    struct HoldStore {
        calls: AtomicUsize,
        slots: parking_lot::Mutex<VecDeque<oneshot::Receiver<Vec<AgentPreset>>>>,
    }

    impl HoldStore {
        fn new(slots: Vec<oneshot::Receiver<Vec<AgentPreset>>>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                slots: parking_lot::Mutex::new(VecDeque::from(slots)),
            }
        }
    }

    impl AgentPresetStore for HoldStore {
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
            let step = self.slots.lock().pop_front();
            Box::pin(async move {
                match step {
                    Some(receiver) => receiver
                        .await
                        .map_err(|err| PresetError::message(err.to_string())),
                    None => Ok(Vec::new()),
                }
            })
        }

        fn get(&self, _: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
            Box::pin(async { Ok(None) })
        }

        fn find_by_handle(
            &self,
            _: &protocol::js::JsString,
        ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
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

    fn sample(id: &str, name: &str) -> AgentPreset {
        let row = object_from_pairs(vec![
            ("id", js_string(id)),
            ("name", js_string(name)),
            ("color", js_string("")),
            ("model", js_string("")),
            ("effort", js_string("medium")),
            ("systemPrompt", js_string("")),
            ("nodeBaseUrl", js_string("")),
            ("createdAt", protocol::js::JsValue::Number(1.0)),
            ("updatedAt", protocol::js::JsValue::Number(1.0)),
            ("sharedLink", protocol::js::JsValue::Bool(true)),
            ("node", js_string("n")),
            ("directory", js_string("/d")),
        ])
        .expect("row");
        preset_from_js(&row).expect("preset")
    }

    async fn until_calls(store: &HoldStore, count: usize) {
        for _ in 0..50 {
            if store.calls.load(Ordering::SeqCst) >= count {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    async fn recv(receiver: &mut watch::Receiver<Option<Vec<AgentPreset>>>) -> Vec<AgentPreset> {
        loop {
            if let Some(rows) = receiver.borrow().clone() {
                return rows;
            }
            receiver.changed().await.expect("refresh");
        }
    }

    #[tokio::test]
    async fn an_older_refresh_cannot_displace_or_publish_over_the_current_one() {
        let (old_tx, old_rx) = oneshot::channel();
        let (new_tx, new_rx) = oneshot::channel();
        let store = std::sync::Arc::new(HoldStore::new(vec![old_rx, new_rx]));
        let resolver = create_cached_preset_resolver(
            store.clone(),
            CachedPresetResolverOptions {
                ttl_ms: Some(30_000),
                now: Some(std::sync::Arc::new(|| 0)),
                log: None,
            },
        );
        let mut older = start_refresh(&resolver.shared);
        until_calls(&store, 1).await;
        assert_eq!(store.calls.load(Ordering::SeqCst), 1);
        resolver.invalidate();
        let mut current = start_refresh(&resolver.shared);
        until_calls(&store, 2).await;
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
        old_tx.send(vec![sample("old", "Old")]).expect("old");
        let stale = recv(&mut older).await;
        assert_eq!(stale[0].id.to_utf8(), "old");
        assert!(resolver.last_known().is_empty());
        let mut joined = start_refresh(&resolver.shared);
        tokio::task::yield_now().await;
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
        new_tx.send(vec![sample("new", "New")]).expect("new");
        let fresh = recv(&mut current).await;
        let joined_rows = recv(&mut joined).await;
        assert_eq!(fresh[0].id.to_utf8(), "new");
        assert_eq!(joined_rows[0].id.to_utf8(), "new");
        assert_eq!(resolver.last_known()[0].id.to_utf8(), "new");
        assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    }
}
