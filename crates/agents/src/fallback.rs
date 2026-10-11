use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, MutexGuard};
use tokio::sync::{oneshot, watch};

use crate::error::PresetError;
use crate::preset::{AgentPreset, AgentPresetInput, AgentPresetPatch, AgentRegistryBackend};
use crate::store::{AgentPresetStore, BoxFuture, LogCallback, system_now_ms};

pub const PRESET_PROBE_TIMEOUT_MS: i64 = 10_000;
const DRAIN_LIVENESS_MS: u64 = 30_000;
const DEFAULT_RECHECK_MS: i64 = 30_000;

struct FallbackState {
    serving_primary: bool,
    announced: bool,
    last_check: Option<i64>,
    fallback_ops: usize,
    drain_warned: bool,
    drain_timer: Option<tokio::task::AbortHandle>,
    callbacks: Vec<Box<dyn Fn() + Send>>,
    drainers: Vec<oneshot::Sender<()>>,
    inflight: Option<watch::Receiver<Option<bool>>>,
    drain_hook: Option<Arc<dyn Fn() + Send + Sync>>,
}

struct Shared {
    primary: Arc<dyn AgentPresetStore>,
    fallback: Arc<dyn AgentPresetStore>,
    recheck_ms: i64,
    probe_timeout_ms: i64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    log: Option<LogCallback>,
    state: Mutex<FallbackState>,
}

pub struct FallbackPresetStore {
    shared: Arc<Shared>,
}

pub struct FallbackPresetStoreOptions {
    pub primary: Arc<dyn AgentPresetStore>,
    pub fallback: Arc<dyn AgentPresetStore>,
    pub recheck_ms: Option<i64>,
    pub probe_timeout_ms: Option<i64>,
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub log: Option<LogCallback>,
}

pub fn create_fallback_preset_store(opts: FallbackPresetStoreOptions) -> FallbackPresetStore {
    FallbackPresetStore {
        shared: Arc::new(Shared {
            primary: opts.primary,
            fallback: opts.fallback,
            recheck_ms: opts.recheck_ms.unwrap_or(DEFAULT_RECHECK_MS),
            probe_timeout_ms: opts.probe_timeout_ms.unwrap_or(PRESET_PROBE_TIMEOUT_MS),
            now: opts.now.unwrap_or_else(|| Arc::new(system_now_ms)),
            log: opts.log,
            state: Mutex::new(FallbackState {
                serving_primary: false,
                announced: false,
                last_check: None,
                fallback_ops: 0,
                drain_warned: false,
                drain_timer: None,
                callbacks: Vec::new(),
                drainers: Vec::new(),
                inflight: None,
                drain_hook: None,
            }),
        }),
    }
}

impl FallbackPresetStore {
    pub fn on_primary_ready(&self, callback: Box<dyn Fn() + Send>) {
        {
            let mut state = lock(&self.shared.state);
            if !state.announced {
                state.callbacks.push(callback);
                return;
            }
        }
        call_callback(&self.shared, callback);
    }

    pub async fn drain_fallback(&self) {
        drain(&self.shared).await;
    }

    pub fn on_fallback_drain(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        lock(&self.shared.state).drain_hook = Some(hook);
    }
}

struct FallbackDone(Arc<Shared>);

impl Drop for FallbackDone {
    fn drop(&mut self) {
        end_fallback(&self.0);
    }
}

async fn dispatch<T, Make, Fut>(shared: Arc<Shared>, make: Make) -> Result<T, PresetError>
where
    T: Send + 'static,
    Make: FnOnce(Arc<dyn AgentPresetStore>) -> Fut,
    Fut: std::future::Future<Output = Result<T, PresetError>> + Send + 'static,
{
    let on_fallback = using_fallback(&shared).await;
    let store: Arc<dyn AgentPresetStore> = if on_fallback {
        Arc::clone(&shared.fallback)
    } else {
        Arc::clone(&shared.primary)
    };
    let operation = make(store);
    if !on_fallback {
        return operation.await;
    }
    let (sender, receiver) = oneshot::channel();
    let task_shared = Arc::clone(&shared);
    tokio::spawn(async move {
        let _done = FallbackDone(task_shared);
        let result = operation.await;
        let _ = sender.send(result);
    });
    match receiver.await {
        Ok(result) => result,
        Err(_) => Err(PresetError::message(
            "fallback preset operation ended before it finished",
        )),
    }
}

async fn using_fallback(shared: &Arc<Shared>) -> bool {
    let cached = {
        let mut state = lock(&shared.state);
        if !state.serving_primary && state.inflight.is_none() {
            let t = (shared.now)();
            if state
                .last_check
                .is_some_and(|last| t.saturating_sub(last) < shared.recheck_ms)
            {
                state.fallback_ops += 1;
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if cached {
        return true;
    }
    let ready = use_primary(Arc::clone(shared)).await;
    let serving = lock(&shared.state).serving_primary;
    if ready || serving {
        return false;
    }
    {
        let mut state = lock(&shared.state);
        state.fallback_ops += 1;
    }
    true
}

impl AgentPresetStore for FallbackPresetStore {
    fn backend(&self) -> AgentRegistryBackend {
        if lock(&self.shared.state).serving_primary {
            self.shared.primary.backend()
        } else {
            self.shared.fallback.backend()
        }
    }

    fn file(&self) -> Option<String> {
        if lock(&self.shared.state).serving_primary {
            self.shared.primary.file()
        } else {
            self.shared.fallback.file()
        }
    }

    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            if use_primary(Arc::clone(&shared)).await {
                Ok(true)
            } else {
                shared.fallback.is_ready().await
            }
        })
    }

    fn list(&self, node: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        let shared = Arc::clone(&self.shared);
        let node = node.map(str::to_string);
        Box::pin(dispatch(shared, move |store| async move {
            store.list(node.as_deref()).await
        }))
    }

    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let shared = Arc::clone(&self.shared);
        let id = id.to_string();
        Box::pin(dispatch(shared, move |store| async move {
            store.get(&id).await
        }))
    }

    fn find_by_handle(
        &self,
        handle: &str,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let shared = Arc::clone(&self.shared);
        let handle = handle.to_string();
        Box::pin(dispatch(shared, move |store| async move {
            store.find_by_handle(&handle).await
        }))
    }

    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let shared = Arc::clone(&self.shared);
        Box::pin(dispatch(shared, move |store| async move {
            store.create(input).await
        }))
    }

    fn update(
        &self,
        id: &str,
        patch: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let shared = Arc::clone(&self.shared);
        let id = id.to_string();
        Box::pin(dispatch(shared, move |store| async move {
            store.update(&id, patch).await
        }))
    }

    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        let shared = Arc::clone(&self.shared);
        let id = id.to_string();
        Box::pin(dispatch(shared, move |store| async move {
            store.delete(&id).await
        }))
    }
}

fn lock(state: &Mutex<FallbackState>) -> MutexGuard<'_, FallbackState> {
    state.lock()
}

enum ProbeJoin {
    Ready(bool),
    Wait(watch::Receiver<Option<bool>>),
    Start(watch::Sender<Option<bool>>, watch::Receiver<Option<bool>>),
}

async fn use_primary(shared: Arc<Shared>) -> bool {
    let joined = {
        let mut state = lock(&shared.state);
        if state.serving_primary {
            ProbeJoin::Ready(true)
        } else if let Some(inflight) = state.inflight.clone() {
            ProbeJoin::Wait(inflight)
        } else {
            let t = (shared.now)();
            if state
                .last_check
                .is_some_and(|last| t.saturating_sub(last) < shared.recheck_ms)
            {
                ProbeJoin::Ready(false)
            } else {
                state.last_check = Some(t);
                let (sender, receiver) = watch::channel(None);
                state.inflight = Some(receiver.clone());
                ProbeJoin::Start(sender, receiver)
            }
        }
    };
    match joined {
        ProbeJoin::Ready(value) => value,
        ProbeJoin::Wait(inflight) => wait_probe(inflight).await,
        ProbeJoin::Start(sender, receiver) => {
            let task = Arc::clone(&shared);
            tokio::spawn(async move {
                let result = probe(Arc::clone(&task)).await;
                {
                    let mut state = lock(&task.state);
                    state.inflight = None;
                }
                let _ = sender.send(Some(result));
            });
            wait_probe(receiver).await
        }
    }
}

async fn wait_probe(mut receiver: watch::Receiver<Option<bool>>) -> bool {
    loop {
        if let Some(value) = *receiver.borrow() {
            return value;
        }
        if receiver.changed().await.is_err() {
            return false;
        }
    }
}

async fn probe(shared: Arc<Shared>) -> bool {
    let pending = shared.primary.is_ready();
    let timeout = Duration::from_millis(u64::try_from(shared.probe_timeout_ms).unwrap_or(0));
    match tokio::time::timeout(timeout, pending).await {
        Ok(Ok(true)) => {
            let need_drain = {
                let mut state = lock(&shared.state);
                state.serving_primary = true;
                state.fallback_ops > 0
            };
            if need_drain {
                drain(&shared).await;
            }
            fire_ready(&shared);
            true
        }
        Ok(Ok(false)) => false,
        Ok(Err(err)) => {
            emit(
                &shared,
                &format!("preset store primary check failed: {err}"),
            );
            false
        }
        Err(_) => {
            emit(
                &shared,
                &format!(
                    "preset store primary check failed: preset store primary check timed out after {}ms",
                    shared.probe_timeout_ms
                ),
            );
            false
        }
    }
}

async fn drain(shared: &Arc<Shared>) {
    let (receiver, hook) = {
        let mut state = lock(&shared.state);
        if state.fallback_ops == 0 {
            return;
        }
        arm_drain(shared, &mut state);
        let (sender, receiver) = oneshot::channel();
        state.drainers.push(sender);
        (receiver, state.drain_hook.clone())
    };
    if let Some(hook) = hook {
        hook();
    }
    let _ = receiver.await;
}

fn arm_drain(shared: &Arc<Shared>, state: &mut FallbackState) {
    if state.drain_timer.is_some() || state.drain_warned {
        return;
    }
    let shared = Arc::clone(shared);
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DRAIN_LIVENESS_MS)).await;
        let should_log = {
            let mut state = lock(&shared.state);
            state.drain_timer = None;
            if state.fallback_ops == 0 || state.drain_warned {
                false
            } else {
                state.drain_warned = true;
                true
            }
        };
        if should_log {
            emit(
                &shared,
                "preset store fallback operation still in flight after 30s; a hung stateDir is blocking the primary import",
            );
        }
    });
    state.drain_timer = Some(handle.abort_handle());
}

fn end_fallback(shared: &Shared) {
    let pending = {
        let mut state = lock(&shared.state);
        state.fallback_ops = state.fallback_ops.saturating_sub(1);
        if state.fallback_ops != 0 {
            return;
        }
        if let Some(timer) = state.drain_timer.take() {
            timer.abort();
        }
        state.drain_warned = false;
        std::mem::take(&mut state.drainers)
    };
    for sender in pending {
        let _ = sender.send(());
    }
}

fn fire_ready(shared: &Shared) {
    let pending = {
        let mut state = lock(&shared.state);
        if state.announced {
            return;
        }
        state.announced = true;
        std::mem::take(&mut state.callbacks)
    };
    for callback in pending {
        call_callback(shared, callback);
    }
}

fn call_callback(shared: &Shared, callback: Box<dyn Fn() + Send>) {
    let result = std::panic::catch_unwind(AssertUnwindSafe(callback));
    if let Err(payload) = result {
        emit(
            shared,
            &format!(
                "preset store primary-ready callback failed: {}",
                panic_message(payload)
            ),
        );
    }
}

fn emit(shared: &Shared, message: &str) {
    if let Some(log) = &shared.log {
        let log = Arc::clone(log);
        let owned = message.to_string();
        let _ = std::panic::catch_unwind(AssertUnwindSafe(move || log(&owned)));
        return;
    }
    tracing::warn!("{message}");
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "unknown error".to_string()
}
