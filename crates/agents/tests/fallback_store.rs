mod common;
pub use common::contract::*;
pub use common::*;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;
use std::time::Duration;

use agents::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentPresetStore, AgentRegistryBackend,
    BoxFuture, FallbackPresetStore, FallbackPresetStoreOptions, FileAgentPresetStore,
    ImportLegacyAgentsArgs, JsString, PresetError, create_fallback_preset_store,
    import_legacy_agents_json,
};
use tokio::sync::oneshot;

enum Ready {
    Bool(bool),
    Fail(String),
    Hang,
    Gate(Mutex<Option<oneshot::Receiver<bool>>>),
}

enum Probe {
    Ready(bool),
    Fail(String),
    Hang,
    Gate(Option<oneshot::Receiver<bool>>),
}

struct Fake {
    backend: AgentRegistryBackend,
    file: Option<String>,
    marker: String,
    checks: AtomicUsize,
    calls: Mutex<Vec<String>>,
    ready: Mutex<Ready>,
    entered: Mutex<Option<oneshot::Sender<()>>>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
    rows: Mutex<Vec<AgentPreset>>,
}

impl Fake {
    fn new(backend: AgentRegistryBackend, marker: &str, ready: Ready) -> Self {
        Self {
            backend,
            file: None,
            marker: marker.to_string(),
            checks: AtomicUsize::new(0),
            calls: Mutex::new(Vec::new()),
            ready: Mutex::new(ready),
            entered: Mutex::new(None),
            release: Mutex::new(None),
            rows: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().clone()
    }
}

impl AgentPresetStore for Fake {
    fn backend(&self) -> AgentRegistryBackend {
        self.backend
    }
    fn file(&self) -> Option<String> {
        self.file.clone()
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        let ready = &self.ready;
        Box::pin(async move {
            let action = {
                let mut slot = ready.lock();
                match &mut *slot {
                    Ready::Bool(value) => Probe::Ready(*value),
                    Ready::Fail(message) => Probe::Fail(message.clone()),
                    Ready::Hang => Probe::Hang,
                    Ready::Gate(gate) => Probe::Gate(gate.get_mut().take()),
                }
            };
            match action {
                Probe::Ready(value) => Ok(value),
                Probe::Fail(message) => Err(PresetError::message(message)),
                Probe::Hang => std::future::pending().await,
                Probe::Gate(Some(receiver)) => receiver
                    .await
                    .map_err(|err| PresetError::message(err.to_string())),
                Probe::Gate(None) => Ok(false),
            }
        })
    }
    fn list(&self, _: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        self.calls.lock().push(format!("{}:list", self.marker));
        let marker = self.marker.clone();
        Box::pin(async move { Ok(vec![preset(&marker, &marker)]) })
    }
    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.calls.lock().push(format!("{}:get", self.marker));
        let marker = self.marker.clone();
        let id = id.to_string();
        Box::pin(async move {
            if id == marker {
                Ok(Some(preset(&id, &id)))
            } else {
                Ok(None)
            }
        })
    }
    fn find_by_handle(
        &self,
        _: &JsString,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.calls.lock().push(format!("{}:find", self.marker));
        Box::pin(async { Ok(None) })
    }
    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        self.calls
            .lock()
            .push(format!("{}:create:{}", self.marker, input.name));
        let marker = self.marker.clone();
        let entered = self.entered.lock().take();
        let release = self.release.lock().take();
        let name = input.name.clone();
        let rows = &self.rows;
        Box::pin(async move {
            if let Some(sender) = entered {
                let _ = sender.send(());
            }
            if let Some(receiver) = release {
                let _ = receiver.await;
            }
            let row = preset(&marker, name.to_utf8());
            rows.lock().push(row.clone());
            Ok(row)
        })
    }
    fn update(
        &self,
        _: &str,
        _: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.calls.lock().push(format!("{}:update", self.marker));
        Box::pin(async { Ok(None) })
    }
    fn delete(&self, _: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        self.calls.lock().push(format!("{}:delete", self.marker));
        Box::pin(async { Ok(true) })
    }
}

fn wrap(
    primary: Arc<dyn AgentPresetStore>,
    fallback: Arc<dyn AgentPresetStore>,
    recheck_ms: i64,
    probe_timeout_ms: Option<i64>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    log: Option<agents::LogCallback>,
) -> FallbackPresetStore {
    create_fallback_preset_store(FallbackPresetStoreOptions {
        primary,
        fallback,
        recheck_ms: Some(recheck_ms),
        probe_timeout_ms,
        now: Some(now),
        log,
    })
}

#[tokio::test]
async fn serves_the_fallback_until_the_primary_answers_true() {
    let ready = Arc::new(AtomicBool::new(false));
    let clock = Arc::new(AtomicUsize::new(1_000));
    let primary = Arc::new(Fake::new(
        AgentRegistryBackend::Postgres,
        "primary",
        Ready::Bool(false),
    ));
    let mut fallback = Fake::new(AgentRegistryBackend::File, "fallback", Ready::Bool(true));
    fallback.file = Some("/var/agents.json".to_string());
    let fallback = Arc::new(fallback);
    let ready_flag = Arc::clone(&ready);
    let primary_ready = Arc::new(ReadyStore {
        inner: Arc::clone(&primary),
        ready: ready_flag,
    });
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let logged = Arc::clone(&logs);
    let clock_now = Arc::clone(&clock);
    let store = wrap(
        primary_ready,
        fallback.clone(),
        500,
        None,
        Arc::new(move || clock_now.load(Ordering::SeqCst) as i64),
        Some(Arc::new(move |message| {
            logged.lock().push(message.to_string())
        })),
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_cb = Arc::clone(&seen);
    store.on_primary_ready(Box::new(move || seen_cb.lock().push("ready")));
    assert_eq!(store.backend(), AgentRegistryBackend::File);
    assert_eq!(store.file().as_deref(), Some("/var/agents.json"));
    assert!(store.is_ready().await.unwrap());
    assert_eq!(store.list(None).await.unwrap()[0].id.to_utf8(), "fallback");
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    assert_eq!(fallback.calls(), ["fallback:list"]);
    clock.fetch_add(499, Ordering::SeqCst);
    assert_eq!(
        store.get("fallback").await.unwrap().unwrap().id.to_utf8(),
        "fallback"
    );
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    ready.store(true, Ordering::SeqCst);
    clock.fetch_add(1, Ordering::SeqCst);
    let mut body = common::input("Alpha");
    body.node = "n".into();
    body.directory = "/d".into();
    assert_eq!(store.create(body).await.unwrap().id.to_utf8(), "primary");
    assert_eq!(store.backend(), AgentRegistryBackend::Postgres);
    assert!(store.file().is_none());
    assert_eq!(seen.lock().as_slice(), ["ready"]);
    assert_eq!(primary.checks.load(Ordering::SeqCst), 2);
    assert!(
        primary
            .calls()
            .contains(&"primary:create:Alpha".to_string())
    );
    let late = Arc::new(AtomicBool::new(false));
    let late_flag = Arc::clone(&late);
    store.on_primary_ready(Box::new(move || late_flag.store(true, Ordering::SeqCst)));
    assert!(late.load(Ordering::SeqCst));
    ready.store(false, Ordering::SeqCst);
    clock.fetch_add(10_000, Ordering::SeqCst);
    assert!(store.delete("x").await.unwrap());
    assert!(primary.calls().iter().any(|call| call == "primary:delete"));
    assert_eq!(primary.checks.load(Ordering::SeqCst), 2);
    assert!(logs.lock().is_empty());
}

struct ReadyStore {
    inner: Arc<Fake>,
    ready: Arc<AtomicBool>,
}

impl AgentPresetStore for ReadyStore {
    fn backend(&self) -> AgentRegistryBackend {
        self.inner.backend()
    }
    fn file(&self) -> Option<String> {
        self.inner.file()
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        self.inner.checks.fetch_add(1, Ordering::SeqCst);
        let ready = self.ready.load(Ordering::SeqCst);
        Box::pin(async move { Ok(ready) })
    }
    fn list(&self, node: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        self.inner.list(node)
    }
    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.inner.get(id)
    }
    fn find_by_handle(
        &self,
        handle: &JsString,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.inner.find_by_handle(handle)
    }
    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        self.inner.create(input)
    }
    fn update(
        &self,
        id: &str,
        patch: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.inner.update(id, patch)
    }
    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        self.inner.delete(id)
    }
}

#[tokio::test]
async fn a_throwing_primary_check_is_not_ready_inside_the_window() {
    let clock = Arc::new(AtomicUsize::new(0));
    let primary = Arc::new(Fake::new(
        AgentRegistryBackend::Postgres,
        "primary",
        Ready::Fail("relation \"ros_agent_presets\" does not exist".to_string()),
    ));
    let mut fallback = Fake::new(AgentRegistryBackend::File, "fallback", Ready::Bool(true));
    fallback.file = Some("/var/agents.json".to_string());
    let fallback = Arc::new(fallback);
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let logged = Arc::clone(&logs);
    let clock_now = Arc::clone(&clock);
    let store = wrap(
        primary.clone(),
        fallback.clone(),
        30_000,
        None,
        Arc::new(move || clock_now.load(Ordering::SeqCst) as i64),
        Some(Arc::new(move |message| {
            logged.lock().push(message.to_string())
        })),
    );
    assert!(
        store
            .find_by_handle(&JsString::from_text("x"))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(fallback.calls(), ["fallback:find"]);
    assert_eq!(store.backend(), AgentRegistryBackend::File);
    assert!(logs.lock().join("\n").contains("ros_agent_presets"));
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    clock.fetch_add(1_000, Ordering::SeqCst);
    store.list(None).await.unwrap();
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    assert!(fallback.calls().iter().any(|call| call == "fallback:list"));
    clock.fetch_add(30_000, Ordering::SeqCst);
    store.list(None).await.unwrap();
    assert_eq!(primary.checks.load(Ordering::SeqCst), 2);
    assert_eq!(store.backend(), AgentRegistryBackend::File);
}

#[tokio::test]
async fn logs_a_throwing_callback_and_still_announces_the_next_one() {
    let ready = Arc::new(AtomicBool::new(false));
    let primary = Arc::new(Fake::new(
        AgentRegistryBackend::Postgres,
        "primary",
        Ready::Bool(false),
    ));
    let fallback = Arc::new(Fake::new(
        AgentRegistryBackend::File,
        "fallback",
        Ready::Bool(true),
    ));
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let logged = Arc::clone(&logs);
    let store = wrap(
        Arc::new(ReadyStore {
            inner: primary,
            ready: Arc::clone(&ready),
        }),
        fallback,
        30_000,
        None,
        Arc::new(|| 0),
        Some(Arc::new(move |message| {
            logged.lock().push(message.to_string())
        })),
    );
    store.on_primary_ready(Box::new(|| panic!("callback blew up")));
    let second = Arc::new(AtomicBool::new(false));
    let second_flag = Arc::clone(&second);
    store.on_primary_ready(Box::new(move || second_flag.store(true, Ordering::SeqCst)));
    ready.store(true, Ordering::SeqCst);
    assert_eq!(store.list(None).await.unwrap()[0].id.to_utf8(), "primary");
    assert!(second.load(Ordering::SeqCst));
    assert!(logs.lock().join("\n").contains("callback blew up"));
    assert_eq!(store.backend(), AgentRegistryBackend::Postgres);
}

#[tokio::test]
async fn a_timed_out_primary_check_is_not_ready() {
    let clock = Arc::new(AtomicUsize::new(0));
    let primary = Arc::new(Fake::new(
        AgentRegistryBackend::Postgres,
        "primary",
        Ready::Hang,
    ));
    let fallback = Arc::new(Fake::new(
        AgentRegistryBackend::File,
        "fallback",
        Ready::Bool(true),
    ));
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let logged = Arc::clone(&logs);
    let clock_now = Arc::clone(&clock);
    let store = wrap(
        primary.clone(),
        fallback,
        500,
        Some(30),
        Arc::new(move || clock_now.load(Ordering::SeqCst) as i64),
        Some(Arc::new(move |message| {
            logged.lock().push(message.to_string())
        })),
    );
    assert_eq!(store.list(None).await.unwrap()[0].id.to_utf8(), "fallback");
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    assert!(logs.lock().join("\n").contains("timed out"));
    assert_eq!(store.backend(), AgentRegistryBackend::File);
    clock.fetch_add(499, Ordering::SeqCst);
    store.get("fallback").await.unwrap();
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    clock.fetch_add(1, Ordering::SeqCst);
    assert_eq!(store.list(None).await.unwrap()[0].id.to_utf8(), "fallback");
    assert_eq!(primary.checks.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn logs_once_when_a_fallback_op_is_still_in_flight_after_30s() {
    let clock = Arc::new(AtomicUsize::new(0));
    let ready = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut fallback = Fake::new(AgentRegistryBackend::File, "fallback", Ready::Bool(true));
    fallback.file = Some("/var/agents.json".to_string());
    *fallback.entered.lock() = Some(entered_tx);
    *fallback.release.lock() = Some(release_rx);
    let fallback = Arc::new(fallback);
    let primary = Arc::new(Fake::new(
        AgentRegistryBackend::Postgres,
        "primary",
        Ready::Bool(false),
    ));
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let logged = Arc::clone(&logs);
    let clock_now = Arc::clone(&clock);
    let store = Arc::new(wrap(
        Arc::new(ReadyStore {
            inner: Arc::clone(&primary),
            ready: Arc::clone(&ready),
        }),
        fallback,
        1_000,
        None,
        Arc::new(move || clock_now.load(Ordering::SeqCst) as i64),
        Some(Arc::new(move |message| {
            logged.lock().push(message.to_string())
        })),
    ));
    assert_eq!(store.list(None).await.unwrap()[0].id.to_utf8(), "fallback");
    clock.fetch_add(500, Ordering::SeqCst);
    let creating = store.clone();
    let hung = tokio::spawn(async move {
        let mut body = common::input("Late");
        body.node = "n".into();
        body.directory = "/d".into();
        creating.create(body).await
    });
    entered_rx.await.unwrap();
    ready.store(true, Ordering::SeqCst);
    clock.fetch_add(1_000, Ordering::SeqCst);
    let announced = Arc::new(AtomicBool::new(false));
    let announced_flag = Arc::clone(&announced);
    store.on_primary_ready(Box::new(move || {
        announced_flag.store(true, Ordering::SeqCst)
    }));
    let flipping_store = Arc::clone(&store);
    let flipping = tokio::spawn(async move { flipping_store.list(None).await });
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(30)).await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    let text = logs.lock().join("\n");
    assert!(
        text.contains("still in flight after 30s"),
        "logs={text:?} announced={} checks={} backend={}",
        announced.load(Ordering::SeqCst),
        primary.checks.load(Ordering::SeqCst),
        store.backend().as_str(),
    );
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    let hung_logs = logs
        .lock()
        .iter()
        .filter(|line| line.contains("still in flight after 30s"))
        .count();
    assert_eq!(hung_logs, 1);
    assert!(!announced.load(Ordering::SeqCst));
    release_tx.send(()).unwrap();
    hung.await.unwrap().unwrap();
    flipping.await.unwrap().unwrap();
    assert!(announced.load(Ordering::SeqCst));
    assert_eq!(store.backend(), AgentRegistryBackend::Postgres);
}

#[tokio::test]
async fn imports_a_fallback_create_that_was_in_flight_when_the_primary_flipped() {
    let dir = TempDir::new("agent-registry-drain");
    let file = dir.path_str("agents.json");
    let file_store = FileAgentPresetStore::new(file.clone());
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let slow = Arc::new(SlowFile {
        inner: file_store,
        file: file.clone(),
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(Some(release_rx)),
    });
    let ready = Arc::new(AtomicBool::new(false));
    let clock = Arc::new(AtomicUsize::new(0));
    let imported = Arc::new(Mutex::new(Vec::<AgentPreset>::new()));
    let primary = Arc::new(MemoryPrimary {
        ready: Arc::clone(&ready),
        rows: Arc::clone(&imported),
    });
    let clock_now = Arc::clone(&clock);
    let store = Arc::new(wrap(
        primary.clone(),
        slow,
        1_000,
        None,
        Arc::new(move || clock_now.load(Ordering::SeqCst) as i64),
        None,
    ));
    let announced = Arc::new(AtomicBool::new(false));
    type ImportTask = tokio::task::JoinHandle<Result<(), PresetError>>;
    let import_slot: Arc<Mutex<Option<ImportTask>>> = Arc::new(Mutex::new(None));
    let announced_flag = Arc::clone(&announced);
    let slot = Arc::clone(&import_slot);
    let import_file = file.clone();
    let import_primary = Arc::clone(&primary);
    store.on_primary_ready(Box::new(move || {
        announced_flag.store(true, Ordering::SeqCst);
        let file = import_file.clone();
        let primary = import_primary.clone();
        *slot.lock() = Some(tokio::spawn(async move {
            import_legacy_agents_json(ImportLegacyAgentsArgs {
                file: &file,
                store: primary.as_ref(),
                node: "node-f",
                directory_root: "/home/agents",
                log: None,
            })
            .await
            .map(|_| ())
        }));
    }));
    assert!(store.list(None).await.unwrap().is_empty());
    assert!(!announced.load(Ordering::SeqCst));
    let creating = Arc::clone(&store);
    let hung = tokio::spawn(async move {
        let mut body = common::input("Late");
        body.directory = "/tmp/late-agent".into();
        creating.create(body).await
    });
    entered_rx.await.unwrap();
    assert!(!announced.load(Ordering::SeqCst));
    ready.store(true, Ordering::SeqCst);
    clock.store(1_000, Ordering::SeqCst);
    let (drain_tx, drain_rx) = oneshot::channel();
    let drain_slot = Arc::new(Mutex::new(Some(drain_tx)));
    store.on_fallback_drain(Arc::new(move || {
        if let Some(sender) = drain_slot.lock().take() {
            let _ = sender.send(());
        }
    }));
    let flipping_store = Arc::clone(&store);
    let flipping = tokio::spawn(async move { flipping_store.list(None).await });
    drain_rx.await.unwrap();
    assert!(!announced.load(Ordering::SeqCst));
    assert!(imported.lock().is_empty());
    release_tx.send(()).unwrap();
    hung.await.unwrap().unwrap();
    flipping.await.unwrap().unwrap();
    let task = import_slot.lock().take().unwrap();
    task.await.unwrap().unwrap();
    assert!(announced.load(Ordering::SeqCst));
    let names: Vec<_> = imported
        .lock()
        .iter()
        .map(|row| row.name.to_utf8().to_string())
        .collect();
    assert_eq!(names, ["Late"]);
    store.drain_fallback().await;
}

#[tokio::test]
async fn aborting_the_caller_does_not_release_the_fallback_drain_early() {
    let dir = TempDir::new("agent-registry-drain-abort");
    let file = dir.path_str("agents.json");
    let file_store = FileAgentPresetStore::new(file.clone());
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let slow = Arc::new(SlowFile {
        inner: file_store,
        file: file.clone(),
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(Some(release_rx)),
    });
    let ready = Arc::new(AtomicBool::new(false));
    let clock = Arc::new(AtomicUsize::new(0));
    let primary = Arc::new(MemoryPrimary {
        ready: Arc::clone(&ready),
        rows: Arc::new(Mutex::new(Vec::new())),
    });
    let clock_now = Arc::clone(&clock);
    let store = Arc::new(wrap(
        primary,
        slow,
        1_000,
        None,
        Arc::new(move || clock_now.load(Ordering::SeqCst) as i64),
        None,
    ));
    let announced = Arc::new(AtomicBool::new(false));
    let announced_flag = Arc::clone(&announced);
    store.on_primary_ready(Box::new(move || {
        announced_flag.store(true, Ordering::SeqCst);
    }));
    assert!(store.list(None).await.unwrap().is_empty());
    let creating = Arc::clone(&store);
    let hung = tokio::spawn(async move {
        let mut body = common::input("Late");
        body.directory = "/tmp/late-agent".into();
        creating.create(body).await
    });
    entered_rx.await.unwrap();
    hung.abort();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert!(!announced.load(Ordering::SeqCst));
    ready.store(true, Ordering::SeqCst);
    clock.store(1_000, Ordering::SeqCst);
    let (drain_tx, drain_rx) = oneshot::channel();
    let drain_slot = Arc::new(Mutex::new(Some(drain_tx)));
    store.on_fallback_drain(Arc::new(move || {
        if let Some(sender) = drain_slot.lock().take() {
            let _ = sender.send(());
        }
    }));
    let flipping_store = Arc::clone(&store);
    let flipping = tokio::spawn(async move { flipping_store.list(None).await });
    drain_rx.await.unwrap();
    assert!(!announced.load(Ordering::SeqCst));
    release_tx.send(()).unwrap();
    flipping.await.unwrap().unwrap();
    assert!(announced.load(Ordering::SeqCst));
    let _ = hung.await;
}

struct SlowFile {
    inner: FileAgentPresetStore,
    file: String,
    entered: Mutex<Option<oneshot::Sender<()>>>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
}

impl AgentPresetStore for SlowFile {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::File
    }
    fn file(&self) -> Option<String> {
        Some(self.file.clone())
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        self.inner.is_ready()
    }
    fn list(&self, node: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        self.inner.list(node)
    }
    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.inner.get(id)
    }
    fn find_by_handle(
        &self,
        handle: &JsString,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.inner.find_by_handle(handle)
    }
    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let entered = self.entered.lock().take();
        let release = self.release.lock().take();
        let inner_future = self.inner.create(input);
        Box::pin(async move {
            if let Some(sender) = entered {
                let _ = sender.send(());
            }
            if let Some(receiver) = release {
                let _ = receiver.await;
            }
            inner_future.await
        })
    }
    fn update(
        &self,
        id: &str,
        patch: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        self.inner.update(id, patch)
    }
    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        self.inner.delete(id)
    }
}

struct MemoryPrimary {
    ready: Arc<AtomicBool>,
    rows: Arc<Mutex<Vec<AgentPreset>>>,
}

impl AgentPresetStore for MemoryPrimary {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::Postgres
    }
    fn file(&self) -> Option<String> {
        None
    }
    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        let ready = self.ready.load(Ordering::SeqCst);
        Box::pin(async move { Ok(ready) })
    }
    fn list(&self, _: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        let rows = self.rows.lock().clone();
        Box::pin(async move { Ok(rows) })
    }
    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let id = id.to_string();
        let rows = self.rows.lock().clone();
        Box::pin(async move { Ok(rows.into_iter().find(|row| row.id.to_utf8() == id)) })
    }
    fn find_by_handle(
        &self,
        _: &JsString,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        Box::pin(async { Ok(None) })
    }
    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let rows = Arc::clone(&self.rows);
        Box::pin(async move {
            let mut row = preset(
                input
                    .id
                    .as_ref()
                    .map(|value| value.to_utf8())
                    .unwrap_or("generated"),
                input.name.to_utf8(),
            );
            row.node = Some(input.node);
            row.directory = Some(input.directory);
            rows.lock().push(row.clone());
            Ok(row)
        })
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
async fn shares_one_in_flight_primary_check() {
    let (sender, receiver) = oneshot::channel();
    let primary = Arc::new(Fake::new(
        AgentRegistryBackend::Postgres,
        "primary",
        Ready::Gate(Mutex::new(Some(receiver))),
    ));
    let fallback = Arc::new(Fake::new(
        AgentRegistryBackend::File,
        "fallback",
        Ready::Bool(true),
    ));
    let store = Arc::new(wrap(
        primary.clone(),
        fallback.clone(),
        30_000,
        None,
        Arc::new(|| 0),
        None,
    ));
    let left = Arc::clone(&store);
    let right = Arc::clone(&store);
    let both = tokio::spawn(async move { tokio::join!(left.list(None), right.list(None)) });
    sender.send(false).unwrap();
    let (first, second) = both.await.unwrap();
    first.unwrap();
    second.unwrap();
    assert_eq!(primary.checks.load(Ordering::SeqCst), 1);
    assert_eq!(fallback.calls(), ["fallback:list", "fallback:list"]);
}
