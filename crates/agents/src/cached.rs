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
                    ListPlan::Stale {
                        generation: state.generation,
                        known,
                    }
                } else {
                    ListPlan::Ready(known)
                }
            } else {
                ListPlan::Refresh(state.generation)
            }
        };
        match plan {
            ListPlan::Ready(known) => known,
            ListPlan::Stale { generation, known } => {
                let _ = start_refresh(&self.shared, generation);
                tokio::task::yield_now().await;
                known
            }
            ListPlan::Refresh(generation) => {
                let mut receiver = start_refresh(&self.shared, generation);
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

    pub async fn find(&self, handle: &str) -> Option<AgentPreset> {
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
    Stale {
        generation: u64,
        known: Vec<AgentPreset>,
    },
    Refresh(u64),
}

fn lock(state: &Mutex<CacheState>) -> MutexGuard<'_, CacheState> {
    state.lock()
}

fn start_refresh(
    shared: &Arc<Shared>,
    generation: u64,
) -> watch::Receiver<Option<Vec<AgentPreset>>> {
    {
        let state = lock(&shared.state);
        if state.inflight_generation == Some(generation)
            && let Some(receiver) = &state.inflight
        {
            return receiver.clone();
        }
    }
    let (sender, receiver) = watch::channel(None);
    {
        let mut state = lock(&shared.state);
        state.inflight_generation = Some(generation);
        state.inflight = Some(receiver.clone());
    }
    let shared = Arc::clone(shared);
    tokio::spawn(async move {
        let rows = match shared.store.list(None).await {
            Ok(rows) => publish_success(&shared, generation, rows),
            Err(err) => publish_failure(&shared, generation, &err),
        };
        {
            let mut state = lock(&shared.state);
            if state.inflight_generation == Some(generation) {
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
