use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;

use protocol::js::JsString;

use crate::error::{MeshError, MeshParseErrorCode};
use crate::model::{
    DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_STALE_THRESHOLD_MS, MESH_FILE_NAME, MeshFile, MeshNode,
    MeshNodeEvent, MeshParseOptions, OnInvalidNode, ParseOutcome, inherit_operator_fields,
    mesh_file_to_pretty, mesh_node_from_network, operator_host_warning, parse_mesh_file,
    timestamp_ms,
};
use crate::resolve::{MeshDiscovery, should_take_remote, sync_target};
use crate::ssh::SEED_SYNC_TIMEOUT_MS;
use crate::tls::{TlsMaterial, client_config};

const FILE_OP_TIMEOUT: Duration = Duration::from_secs(30);

pub struct RegistryConfig {
    pub storage_dir: String,
    pub heartbeat_interval_ms: Option<u64>,
    pub stale_threshold_ms: Option<u64>,
    pub discovery: Option<MeshDiscovery>,
    pub on_event: Option<Arc<dyn Fn(MeshNodeEvent) + Send + Sync>>,
    pub tls: Option<TlsMaterial>,
}

struct Inner {
    file_path: PathBuf,
    lock_path: PathBuf,
    heartbeat_interval_ms: Option<u64>,
    stale_threshold_ms: Option<u64>,
    discovery: Option<MeshDiscovery>,
    on_event: Option<Arc<dyn Fn(MeshNodeEvent) + Send + Sync>>,
    tls: Option<TlsMaterial>,
    local_node_id: Mutex<Option<JsString>>,
    local_node: Mutex<Option<MeshNode>>,
    warnings: Mutex<Vec<String>>,
    fail_next_save: Mutex<Option<String>>,
    heartbeat: Mutex<Option<JoinHandle<()>>>,
    shutdown: AtomicBool,
    flights: FlightGate,
    lock_waits: AtomicUsize,
}

#[derive(Clone)]
pub struct FileMeshRegistry {
    inner: Arc<Inner>,
}

impl FileMeshRegistry {
    pub fn new(config: RegistryConfig) -> Self {
        let dir = if config.storage_dir.is_empty() {
            ::config::paths::shared_dir(&protocol::host::ProcessEnv)
        } else {
            config.storage_dir
        };
        let file_path = PathBuf::from(&dir).join(MESH_FILE_NAME);
        let lock_path = PathBuf::from(format!("{}.lock", file_path.display()));
        Self {
            inner: Arc::new(Inner {
                file_path,
                lock_path,
                heartbeat_interval_ms: config.heartbeat_interval_ms,
                stale_threshold_ms: config.stale_threshold_ms,
                discovery: config.discovery,
                on_event: config.on_event,
                tls: config.tls,
                local_node_id: Mutex::new(None),
                local_node: Mutex::new(None),
                warnings: Mutex::new(Vec::new()),
                fail_next_save: Mutex::new(None),
                heartbeat: Mutex::new(None),
                shutdown: AtomicBool::new(false),
                flights: FlightGate::new(),
                lock_waits: AtomicUsize::new(0),
            }),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.inner.file_path
    }

    pub fn fail_next_save(&self, message: impl Into<String>) {
        *self.inner.fail_next_save.lock() = Some(message.into());
    }

    pub fn warnings(&self) -> Vec<String> {
        self.inner.warnings.lock().clone()
    }

    pub async fn register(&self, node: MeshNode) -> Result<(), MeshError> {
        let inner = Arc::clone(&self.inner);
        let events = blocking(self.inner.flights.clone(), move |deadline| {
            inner.register_blocking(node, deadline)
        })
        .await?;
        self.emit_all(events);
        Ok(())
    }

    pub async fn deregister(&self, node_id: &str) -> Result<(), MeshError> {
        self.deregister_units(&JsString::from_text(node_id), false)
            .await
    }

    pub async fn heartbeat(&self, node_id: &str, status: Option<&str>) -> Result<(), MeshError> {
        self.heartbeat_units(&JsString::from_text(node_id), status)
            .await
    }

    async fn heartbeat_units(
        &self,
        node_id: &JsString,
        status: Option<&str>,
    ) -> Result<(), MeshError> {
        let inner = Arc::clone(&self.inner);
        let node_id_owned = node_id.clone();
        let status_owned = status.map(str::to_string);
        let missing = blocking(self.inner.flights.clone(), move |deadline| {
            inner.heartbeat_blocking(&node_id_owned, status_owned.as_deref(), deadline)
        })
        .await?;
        if missing {
            let local = self.inner.local_node.lock().clone();
            if let Some(mut local) = local
                && local.id == *node_id
            {
                tracing::warn!("Local node {node_id} missing from mesh roster — re-registering");
                local.last_seen = timestamp_ms();
                if let Some(status) = status {
                    local.status = status.into();
                }
                self.register(local).await?;
            }
        }
        Ok(())
    }

    pub async fn get_nodes(&self) -> Result<Vec<MeshNode>, MeshError> {
        let inner = Arc::clone(&self.inner);
        blocking(self.inner.flights.clone(), move |deadline| {
            inner.read_blocking(deadline, |file| Ok(file.values()))
        })
        .await
    }

    pub async fn get_node(&self, node_id: &str) -> Result<Option<MeshNode>, MeshError> {
        let inner = Arc::clone(&self.inner);
        let node_id = node_id.to_string();
        blocking(self.inner.flights.clone(), move |deadline| {
            inner.read_blocking(deadline, |file| Ok(file.get(&node_id).cloned()))
        })
        .await
    }

    pub async fn find_by_agent(&self, agent_id: &str) -> Result<Vec<MeshNode>, MeshError> {
        let nodes = self.get_nodes().await?;
        Ok(nodes
            .into_iter()
            .filter(|node| {
                node.agents.iter().any(|agent| agent == agent_id) && node.status == "online"
            })
            .collect())
    }

    pub async fn find_by_capability(&self, capability: &str) -> Result<Vec<MeshNode>, MeshError> {
        let nodes = self.get_nodes().await?;
        Ok(nodes
            .into_iter()
            .filter(|node| {
                node.capabilities.iter().any(|item| item == capability) && node.status == "online"
            })
            .collect())
    }

    pub async fn find_by_provider(&self, provider_id: &str) -> Result<Vec<MeshNode>, MeshError> {
        let nodes = self.get_nodes().await?;
        Ok(nodes
            .into_iter()
            .filter(|node| {
                node.providers.iter().any(|item| item == provider_id) && node.status == "online"
            })
            .collect())
    }

    pub async fn sync(&self) -> Result<(), MeshError> {
        let Some((host, port)) = sync_target(self.inner.discovery.as_ref()) else {
            return Ok(());
        };
        self.sync_from_seed(&host, port).await;
        Ok(())
    }

    pub async fn prune(&self, stale_threshold_ms: Option<u64>) -> Result<Vec<MeshNode>, MeshError> {
        let inner = Arc::clone(&self.inner);
        let (pruned, events) = blocking(self.inner.flights.clone(), move |deadline| {
            inner.prune_blocking(stale_threshold_ms, deadline)
        })
        .await?;
        self.emit_all(events);
        Ok(pruned)
    }

    pub async fn start(&self, local_node: MeshNode) -> Result<(), MeshError> {
        ensure_runtime()?;
        self.inner.flights.wait_idle().await;
        self.inner.shutdown.store(false, Ordering::SeqCst);
        {
            *self.inner.local_node_id.lock() = Some(local_node.id.clone());
            *self.inner.local_node.lock() = Some(local_node.clone());
        }
        self.register(local_node.clone()).await?;
        let interval = self
            .inner
            .heartbeat_interval_ms
            .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_MS)
            .max(1);
        self.spawn_heartbeat(local_node.id.clone(), interval);
        if self
            .inner
            .discovery
            .as_ref()
            .is_some_and(|discovery| discovery.mode == "seed")
            && let Err(err) = self.sync().await
        {
            tracing::warn!("Initial mesh sync failed: {err}");
        }
        tracing::info!("Mesh started — heartbeat every {interval}ms");
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), MeshError> {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        let handle = self.inner.heartbeat.lock().take();
        if let Some(handle) = handle {
            handle.abort();
            let _ = handle.await;
        }
        self.inner.flights.wait_idle().await;
        let node_id = self.inner.local_node_id.lock().clone();
        if let Some(node_id) = node_id
            && let Err(err) = self.deregister_units(&node_id, true).await
        {
            tracing::warn!("Failed to deregister on shutdown: {err}");
        }
        tracing::info!("Mesh stopped");
        Ok(())
    }

    async fn deregister_units(
        &self,
        node_id: &JsString,
        shutdown_write: bool,
    ) -> Result<(), MeshError> {
        let inner = Arc::clone(&self.inner);
        let node_id = node_id.clone();
        let events = blocking(self.inner.flights.clone(), move |deadline| {
            inner.deregister_blocking(&node_id, deadline, shutdown_write)
        })
        .await?;
        self.emit_all(events);
        Ok(())
    }

    fn spawn_heartbeat(&self, node_id: JsString, interval_ms: u64) {
        if let Some(previous) = self.inner.heartbeat.lock().take() {
            previous.abort();
        }
        let registry = self.clone();
        let period = Duration::from_millis(interval_ms);
        let handle = tokio::spawn(async move {
            let start = tokio::time::Instant::now() + period;
            let mut ticker = tokio::time::interval_at(start, period);
            loop {
                ticker.tick().await;
                if let Err(err) = registry.heartbeat_units(&node_id, Some("online")).await {
                    if !err.is_stopped() {
                        tracing::error!("Mesh heartbeat failed: {err}");
                    }
                    continue;
                }
                if let Err(err) = registry.prune(None).await
                    && !err.is_stopped()
                {
                    tracing::error!("Mesh heartbeat failed: {err}");
                }
            }
        });
        *self.inner.heartbeat.lock() = Some(handle);
    }

    async fn sync_from_seed(&self, host: &str, port: u16) {
        let url = format!("https://{host}:{port}/api/mesh");
        let fetched = fetch_seed(&url, self.inner.tls.as_ref()).await;
        let nodes = match fetched {
            Ok(nodes) => nodes,
            Err(err) => {
                tracing::warn!("Seed sync failed ({host}:{port}): {err}");
                return;
            }
        };
        let inner = Arc::clone(&self.inner);
        match blocking(self.inner.flights.clone(), move |deadline| {
            inner.merge_remote_blocking(nodes, deadline)
        })
        .await
        {
            Ok(0) => {}
            Ok(merged) => tracing::info!("Synced {merged} nodes from seed {host}:{port}"),
            Err(err) => tracing::warn!("Seed sync failed ({host}:{port}): {err}"),
        }
    }

    fn emit_all(&self, events: Vec<MeshNodeEvent>) {
        if let Some(callback) = &self.inner.on_event {
            for event in events {
                callback(event);
            }
        }
    }
}

impl Inner {
    fn register_blocking(
        &self,
        node: MeshNode,
        deadline: Instant,
    ) -> Result<Vec<MeshNodeEvent>, MeshError> {
        self.with_lock(deadline, || {
            let mut data = self.load_locked()?;
            let existing = data.get(&node.id).cloned();
            if let Some(existing) = &existing {
                let preview = inherit_operator_fields(node.clone(), Some(existing));
                if let Some(warning) = operator_host_warning(&node, existing, &preview) {
                    tracing::warn!("{warning}");
                }
            }
            let is_new = existing.is_none();
            let merged = inherit_operator_fields(node, existing.as_ref());
            let now = timestamp_ms();
            let event = MeshNodeEvent {
                event_type: if is_new {
                    "node:joined"
                } else {
                    "node:updated"
                }
                .to_string(),
                node: merged.clone(),
                timestamp: now,
            };
            if is_new {
                tracing::info!(
                    "Node registered: {} ({}) at {}:{}",
                    merged.name,
                    merged.id,
                    merged.host,
                    merged.port
                );
            } else {
                tracing::info!("Node updated: {} ({})", merged.name, merged.id);
            }
            let id = merged.id.clone();
            data.insert(id, merged);
            data.updated_at = now;
            self.save_locked(&data, deadline)?;
            Ok(vec![event])
        })
    }

    fn deregister_blocking(
        &self,
        node_id: &JsString,
        deadline: Instant,
        shutdown_write: bool,
    ) -> Result<Vec<MeshNodeEvent>, MeshError> {
        self.with_lock(deadline, || {
            let mut data = self.load_locked()?;
            let Some(mut node) = data.get_by_key(node_id).cloned() else {
                return Ok(Vec::new());
            };
            node.status = "offline".into();
            let now = timestamp_ms();
            data.insert(node_id.clone(), node.clone());
            data.updated_at = now;
            self.save_locked_mode(&data, deadline, shutdown_write)?;
            tracing::info!("Node deregistered: {} ({node_id})", node.name);
            Ok(vec![MeshNodeEvent {
                event_type: "node:left".to_string(),
                node,
                timestamp: now,
            }])
        })
    }

    fn heartbeat_blocking(
        &self,
        node_id: &JsString,
        status: Option<&str>,
        deadline: Instant,
    ) -> Result<bool, MeshError> {
        self.with_lock(deadline, || {
            let mut data = self.load_locked()?;
            let Some(node) = data.get_mut_by_key(node_id) else {
                return Ok(true);
            };
            let now = timestamp_ms();
            node.last_seen = now;
            if let Some(status) = status {
                node.status = status.into();
            }
            data.updated_at = now;
            self.save_locked(&data, deadline)?;
            Ok(false)
        })
    }

    fn prune_blocking(
        &self,
        stale_threshold_ms: Option<u64>,
        deadline: Instant,
    ) -> Result<(Vec<MeshNode>, Vec<MeshNodeEvent>), MeshError> {
        let threshold = stale_threshold_ms
            .or(self.stale_threshold_ms)
            .unwrap_or(DEFAULT_STALE_THRESHOLD_MS);
        let local_id = self.local_node_id.lock().clone();
        self.with_lock(deadline, || {
            let mut data = self.load_locked()?;
            let now = timestamp_ms();
            let now_f = now.as_f64();
            let mut pruned = Vec::new();
            let mut events = Vec::new();
            for (id, node) in &mut data.nodes {
                if local_id.as_ref().is_some_and(|local| id == local) {
                    continue;
                }
                if is_infrastructure_role(node.role.as_deref()) {
                    continue;
                }
                let age = now_f - node.last_seen.as_f64();
                if age > threshold as f64 && node.status != "offline" {
                    node.status = "offline".into();
                    let secs = (age / 1000.0).round() as i64;
                    tracing::warn!("Node stale: {} ({id}) — last seen {secs}s ago", node.name);
                    pruned.push(node.clone());
                    events.push(MeshNodeEvent {
                        event_type: "node:stale".to_string(),
                        node: node.clone(),
                        timestamp: now,
                    });
                }
            }
            if !pruned.is_empty() {
                data.updated_at = now;
                self.save_locked(&data, deadline)?;
            }
            Ok((pruned, events))
        })
    }

    fn merge_remote_blocking(
        &self,
        remotes: Vec<MeshNode>,
        deadline: Instant,
    ) -> Result<usize, MeshError> {
        self.with_lock(deadline, || {
            let mut data = self.load_locked()?;
            let mut merged = 0_usize;
            for remote in remotes {
                let local = data.get(&remote.id).cloned();
                if !should_take_remote(local.as_ref(), &remote) {
                    continue;
                }
                if let Some(existing) = &local {
                    let preview = inherit_operator_fields(remote.clone(), Some(existing));
                    if let Some(warning) = operator_host_warning(&remote, existing, &preview) {
                        tracing::warn!("{warning}");
                    }
                }
                let node = inherit_operator_fields(remote, local.as_ref());
                let id = node.id.clone();
                data.insert(id, node);
                merged += 1;
            }
            if merged > 0 {
                data.updated_at = timestamp_ms();
                self.save_locked(&data, deadline)?;
            }
            Ok(merged)
        })
    }

    fn read_blocking<T>(
        &self,
        deadline: Instant,
        read: impl FnOnce(&MeshFile) -> Result<T, MeshError>,
    ) -> Result<T, MeshError> {
        self.with_lock(deadline, || {
            let data = self.load_locked()?;
            read(&data)
        })
    }

    fn with_lock<T>(
        &self,
        deadline: Instant,
        body: impl FnOnce() -> Result<T, MeshError>,
    ) -> Result<T, MeshError> {
        if deadline_passed(deadline) {
            return Err(file_timeout());
        }
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if deadline_passed(deadline) {
            return Err(file_timeout());
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&self.lock_path)?;
        let mut flock = fd_lock::RwLock::new(file);
        lock_write_until(&mut flock, deadline, &self.lock_waits, body)
    }

    fn load_locked(&self) -> Result<MeshFile, MeshError> {
        let raw = match protocol::host::read_text(&self.file_path) {
            Ok(raw) => raw,
            Err(err) if err.code == "ENOENT" => {
                self.warnings.lock().clear();
                return Ok(MeshFile::empty());
            }
            Err(err) => return Err(MeshError::message(err.to_string())),
        };
        let path = self.file_path.display().to_string();
        match parse_mesh_file(
            &raw,
            &path,
            MeshParseOptions {
                on_invalid_node: OnInvalidNode::Skip,
            },
        ) {
            Ok(outcome) => {
                for warning in &outcome.warnings {
                    tracing::warn!("{warning}");
                }
                *self.warnings.lock() = outcome.warnings;
                Ok(outcome.file)
            }
            Err(err) => {
                if err.code() != MeshParseErrorCode::JsonInvalid {
                    tracing::error!("{}", err.message());
                    return Err(err.into());
                }
                self.warnings.lock().clear();
                Ok(MeshFile::empty())
            }
        }
    }

    fn save_locked(&self, file: &MeshFile, deadline: Instant) -> Result<(), MeshError> {
        self.save_locked_mode(file, deadline, false)
    }

    fn save_locked_mode(
        &self,
        file: &MeshFile,
        deadline: Instant,
        shutdown_write: bool,
    ) -> Result<(), MeshError> {
        if self.write_blocked(shutdown_write) {
            return Err(MeshError::stopped());
        }
        if deadline_passed(deadline) {
            return Err(file_timeout());
        }
        if let Some(message) = self.fail_next_save.lock().take() {
            return Err(MeshError::message(message));
        }
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if deadline_passed(deadline) {
            return Err(file_timeout());
        }
        if self.write_blocked(shutdown_write) {
            return Err(MeshError::stopped());
        }
        let pretty = mesh_file_to_pretty(file);
        let tmp = format!("{}.tmp-{}", self.file_path.display(), std::process::id());
        if let Err(err) = std::fs::write(&tmp, &pretty) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err.into());
        }
        if deadline_passed(deadline) {
            let _ = std::fs::remove_file(&tmp);
            return Err(file_timeout());
        }
        if self.write_blocked(shutdown_write) {
            let _ = std::fs::remove_file(&tmp);
            return Err(MeshError::stopped());
        }
        if let Err(err) = std::fs::rename(&tmp, &self.file_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err.into());
        }
        Ok(())
    }

    fn write_blocked(&self, shutdown_write: bool) -> bool {
        !shutdown_write && self.shutdown.load(Ordering::SeqCst)
    }
}

pub fn load_mesh_file_blocking(
    paths: &[String],
    options: MeshParseOptions,
) -> Result<Option<ParseOutcome>, MeshError> {
    for path in paths {
        let raw = match protocol::host::read_text(Path::new(path)) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        match parse_mesh_file(&raw, path, options) {
            Ok(outcome) => {
                for warning in &outcome.warnings {
                    tracing::warn!("{warning}");
                }
                return Ok(Some(outcome));
            }
            Err(err) if err.code() == MeshParseErrorCode::JsonInvalid => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Ok(None)
}

pub async fn load_mesh_file(
    paths: &[String],
    options: MeshParseOptions,
) -> Result<Option<ParseOutcome>, MeshError> {
    let paths = paths.to_vec();
    blocking(FlightGate::new(), move |_deadline| {
        load_mesh_file_blocking(&paths, options)
    })
    .await
}

async fn fetch_seed(url: &str, tls: Option<&TlsMaterial>) -> Result<Vec<MeshNode>, MeshError> {
    let client = match tls {
        Some(material) => {
            let config = client_config(material)?;
            reqwest::Client::builder()
                .use_preconfigured_tls(config)
                .timeout(Duration::from_millis(SEED_SYNC_TIMEOUT_MS))
                .build()?
        }
        None => reqwest::Client::builder()
            .timeout(Duration::from_millis(SEED_SYNC_TIMEOUT_MS))
            .build()?,
    };
    let response = client
        .get(url)
        .header("content-type", "application/json")
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(MeshError::message(seed_failure_text(
            status.as_u16(),
            &text,
        )));
    }
    seed_nodes_from_text(&text, url)
}

fn seed_failure_text(status: u16, text: &str) -> String {
    format!("Seed responded {status}: {text}")
}

fn seed_nodes_from_text(text: &str, url: &str) -> Result<Vec<MeshNode>, MeshError> {
    let parsed = protocol::js::parse(text).map_err(|err| {
        MeshError::message(format!("seed mesh response is not valid JSON: {err}"))
    })?;
    let Some(items) = parsed.as_array() else {
        return Err(MeshError::message("seed mesh response is not an array"));
    };
    let mut nodes = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if item.as_object().is_none() {
            tracing::warn!("skipping non-object seed node at index {index}");
            continue;
        }
        let key = item
            .get("id")
            .and_then(protocol::js::JsValue::as_str)
            .unwrap_or("remote");
        match mesh_node_from_network(key, item, url) {
            Ok(node) => nodes.push(node),
            Err(err) => tracing::warn!("skipping bad seed node: {err}"),
        }
    }
    Ok(nodes)
}

fn ensure_runtime() -> Result<(), MeshError> {
    if tokio::runtime::Handle::try_current().is_err() {
        Err(MeshError::message("mesh registry needs a tokio runtime"))
    } else {
        Ok(())
    }
}

fn file_timeout() -> MeshError {
    MeshError::message("mesh file operation timed out after 30s")
}

fn deadline_passed(deadline: Instant) -> bool {
    Instant::now() >= deadline
}

fn lock_is_contended(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::WouldBlock || err.kind() == ErrorKind::AlreadyExists
}

fn is_infrastructure_role(role: Option<&str>) -> bool {
    role.is_some_and(|role| !role.is_empty() && role != "agent")
}

fn lock_write_until<T>(
    flock: &mut fd_lock::RwLock<std::fs::File>,
    deadline: Instant,
    waits: &AtomicUsize,
    body: impl FnOnce() -> Result<T, MeshError>,
) -> Result<T, MeshError> {
    loop {
        if deadline_passed(deadline) {
            return Err(file_timeout());
        }
        match flock.try_write() {
            Ok(_guard) => {
                if deadline_passed(deadline) {
                    return Err(file_timeout());
                }
                return body();
            }
            Err(err) if lock_is_contended(&err) => {
                waits.fetch_add(1, Ordering::SeqCst);
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(file_timeout());
                }
                std::thread::sleep(left.min(Duration::from_millis(25)));
            }
            Err(err) => return Err(err.into()),
        }
    }
}

#[derive(Clone)]
struct FlightGate {
    inflight: Arc<AtomicUsize>,
    idle: Arc<tokio::sync::Notify>,
}

impl FlightGate {
    fn new() -> Self {
        Self {
            inflight: Arc::new(AtomicUsize::new(0)),
            idle: Arc::new(tokio::sync::Notify::new()),
        }
    }

    async fn wait_idle(&self) {
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inflight.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }
}

struct Flight {
    gate: FlightGate,
}

impl Flight {
    fn enter(gate: FlightGate) -> Self {
        gate.inflight.fetch_add(1, Ordering::SeqCst);
        Self { gate }
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        if self.gate.inflight.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.gate.idle.notify_waiters();
        }
    }
}

async fn blocking<T: Send + 'static>(
    gate: FlightGate,
    body: impl FnOnce(Instant) -> Result<T, MeshError> + Send + 'static,
) -> Result<T, MeshError> {
    let deadline = Instant::now() + FILE_OP_TIMEOUT;
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| MeshError::message("mesh registry needs a tokio runtime"))?;
    let flight = Flight::enter(gate);
    let joined = handle.spawn_blocking(move || {
        let _flight = flight;
        body(deadline)
    });
    match joined.await {
        Ok(result) => result,
        Err(err) if err.is_panic() => Err(MeshError::message("mesh file task panicked")),
        Err(err) => Err(MeshError::message(err.to_string())),
    }
}

#[cfg(test)]
struct Release(Option<std::sync::mpsc::Sender<()>>);

#[cfg(test)]
impl Drop for Release {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[cfg(test)]
mod deadline_and_seed {
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;

    use super::FileMeshRegistry;
    use super::RegistryConfig;
    use super::file_timeout;
    use super::seed_failure_text;
    use super::seed_nodes_from_text;
    use crate::model::MeshFile;

    #[test]
    fn past_deadline_does_not_create_mesh_json() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("rr7m-deadline-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = FileMeshRegistry::new(RegistryConfig {
            storage_dir: dir.display().to_string(),
            heartbeat_interval_ms: None,
            stale_threshold_ms: None,
            discovery: None,
            on_event: None,
            tls: None,
        });
        let parsed = protocol::js::parse(r#"{"id":"n","name":"n","host":"h"}"#).unwrap();
        let node = crate::model::mesh_node_from_value("n", &parsed, "test").unwrap();
        let err = registry
            .inner
            .register_blocking(
                node,
                std::time::Instant::now() - std::time::Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), file_timeout().to_string());
        let late = registry
            .inner
            .save_locked(
                &MeshFile::empty(),
                std::time::Instant::now() - std::time::Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(late.to_string(), file_timeout().to_string());
        assert!(!registry.inner.file_path.exists());
        assert!(!registry.inner.lock_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_status_text_uses_the_numeric_code() {
        assert_eq!(seed_failure_text(403, "no"), "Seed responded 403: no");
    }

    #[test]
    fn seed_keeps_good_rows_when_one_element_is_bad() {
        let text = r#"[{"id":"a","name":"a","host":"h","port":1},{"id":"b","name":"b","host":"h","port":"x"},"skip",{"id":"c","name":"c","host":"h"}]"#;
        let nodes = seed_nodes_from_text(text, "http://seed").unwrap();
        let ids: Vec<_> = nodes.iter().map(|node| node.id.to_utf8()).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }

    #[test]
    fn seed_null_operator_keeps_the_row_and_inherits_the_stored_user() {
        let text = r#"[{"id":"a","name":"A","host":"10.0.0.8","agents":["opus"],"status":"online","lastSeen":50,"port":3100,"sshUser":null,"installRoot":null,"platform":null},{"id":"b","name":"B","host":"h","sshUser":1}]"#;
        let nodes = seed_nodes_from_text(text, "https://seed/api/mesh").unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "a");
        assert!(nodes[0].ssh_user.is_none());
        assert!(nodes[0].install_root.is_none());
        assert!(nodes[0].platform.is_none());
        assert_eq!(nodes[0].agents, vec!["opus".to_string()]);
        assert_eq!(nodes[0].status, "online");
        assert_eq!(nodes[0].last_seen.as_f64(), 50.0);

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("rr7m-seed-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = FileMeshRegistry::new(RegistryConfig {
            storage_dir: dir.display().to_string(),
            heartbeat_interval_ms: None,
            stale_threshold_ms: None,
            discovery: None,
            on_event: None,
            tls: None,
        });
        let parsed = protocol::js::parse(
            r#"{"id":"a","name":"A","host":"10.0.0.8","sshUser":"desk","lastSeen":1,"status":"online","port":1}"#,
        )
        .unwrap();
        let local = crate::model::mesh_node_from_value("a", &parsed, "test").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        registry.inner.register_blocking(local, deadline).unwrap();
        let merged = registry
            .inner
            .merge_remote_blocking(nodes, deadline)
            .unwrap();
        assert_eq!(merged, 1);
        let raw = std::fs::read_to_string(&registry.inner.file_path).unwrap();
        assert!(raw.contains("desk"));
        assert!(raw.contains("opus"));
        assert!(!raw.contains("null"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shutdown_blocks_a_later_heartbeat_write() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("rr7m-stop-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = FileMeshRegistry::new(RegistryConfig {
            storage_dir: dir.display().to_string(),
            heartbeat_interval_ms: Some(60_000),
            stale_threshold_ms: None,
            discovery: None,
            on_event: None,
            tls: None,
        });
        let parsed = protocol::js::parse(
            r#"{"id":"n","name":"n","host":"h","status":"online","lastSeen":1,"port":1}"#,
        )
        .unwrap();
        let node = crate::model::mesh_node_from_value("n", &parsed, "test").unwrap();
        registry.register(node).await.unwrap();
        registry
            .inner
            .shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let before = std::fs::read_to_string(&registry.inner.file_path).unwrap();
        let err = registry.heartbeat("n", Some("online")).await.unwrap_err();
        assert!(err.is_stopped());
        assert_eq!(
            before,
            std::fs::read_to_string(&registry.inner.file_path).unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stop_does_not_let_a_blocked_heartbeat_restore_online() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("rr7m-race-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = FileMeshRegistry::new(RegistryConfig {
            storage_dir: dir.display().to_string(),
            heartbeat_interval_ms: Some(60_000),
            stale_threshold_ms: None,
            discovery: None,
            on_event: None,
            tls: None,
        });
        let parsed = protocol::js::parse(
            r#"{"id":"n","name":"n","host":"h","status":"online","lastSeen":1,"port":1}"#,
        )
        .unwrap();
        let node = crate::model::mesh_node_from_value("n", &parsed, "test").unwrap();
        registry.register(node).await.unwrap();
        *registry.inner.local_node_id.lock() = Some("n".into());

        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
        let lock_path = registry.inner.lock_path.clone();
        std::thread::spawn(move || {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .unwrap();
            let mut flock = fd_lock::RwLock::new(file);
            let guard = flock.write().unwrap();
            held_tx.send(()).unwrap();
            let _ = release_rx.recv();
            drop(guard);
        });
        held_rx.recv().unwrap();
        let release = super::Release(Some(release_tx));

        let heartbeat_registry = registry.clone();
        let heartbeat =
            tokio::spawn(async move { heartbeat_registry.heartbeat("n", Some("online")).await });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while registry
            .inner
            .lock_waits
            .load(std::sync::atomic::Ordering::SeqCst)
            == 0
        {
            if tokio::time::Instant::now() > deadline {
                panic!("heartbeat did not wait on the roster lock");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let stop_registry = registry.clone();
        let stopping = tokio::spawn(async move { stop_registry.stop().await });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !registry
            .inner
            .shutdown
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            if tokio::time::Instant::now() > deadline {
                panic!("stop did not set the shutdown flag");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        assert!(
            !stopping.is_finished(),
            "stop returned while the heartbeat was still waiting on the lock"
        );
        drop(release);
        let stop_result = tokio::time::timeout(std::time::Duration::from_secs(5), stopping)
            .await
            .expect("stop timed out");
        assert!(stop_result.unwrap().is_ok());
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), heartbeat)
            .await
            .expect("heartbeat timed out");
        let raw = std::fs::read_to_string(&registry.inner.file_path).unwrap();
        let saved = protocol::js::parse(&raw).unwrap();
        let status = saved
            .get("nodes")
            .and_then(|nodes| nodes.get("n"))
            .and_then(|node| node.get("status"))
            .and_then(protocol::js::JsValue::as_str);
        assert_eq!(status, Some("offline"));
        let again = registry.heartbeat("n", Some("online")).await.unwrap_err();
        assert!(again.is_stopped());
        let raw = std::fs::read_to_string(&registry.inner.file_path).unwrap();
        let saved = protocol::js::parse(&raw).unwrap();
        let status = saved
            .get("nodes")
            .and_then(|nodes| nodes.get("n"))
            .and_then(|node| node.get("status"))
            .and_then(protocol::js::JsValue::as_str);
        assert_eq!(status, Some("offline"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn queued_blocking_job_keeps_shutdown_busy() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let dir =
                std::env::temp_dir().join(format!("rr7m-queue-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let registry = FileMeshRegistry::new(RegistryConfig {
                storage_dir: dir.display().to_string(),
                heartbeat_interval_ms: Some(60_000),
                stale_threshold_ms: None,
                discovery: None,
                on_event: None,
                tls: None,
            });
            let parsed = protocol::js::parse(
                r#"{"id":"n","name":"n","host":"h","status":"online","lastSeen":1,"port":1}"#,
            )
            .unwrap();
            let node = crate::model::mesh_node_from_value("n", &parsed, "test").unwrap();
            registry.register(node).await.unwrap();
            let before = std::fs::read_to_string(&registry.inner.file_path).unwrap();

            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
            let occupier = tokio::runtime::Handle::current().spawn_blocking(move || {
                entered_tx.send(()).unwrap();
                let _ = release_rx.recv();
            });
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("blocking thread did not start");
            let release = super::Release(Some(release_tx));

            let heartbeat_registry = registry.clone();
            let heartbeat =
                tokio::spawn(
                    async move { heartbeat_registry.heartbeat("n", Some("online")).await },
                );
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            while registry
                .inner
                .flights
                .inflight
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                if tokio::time::Instant::now() > deadline {
                    panic!("queued blocking job was not counted");
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            assert_eq!(
                before,
                std::fs::read_to_string(&registry.inner.file_path).unwrap(),
                "heartbeat ran before the blocking thread was free"
            );
            let idle_registry = registry.clone();
            let idle = tokio::spawn(async move {
                idle_registry.inner.flights.wait_idle().await;
            });
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            assert!(
                !idle.is_finished(),
                "shutdown drain reported idle while a blocking job was queued"
            );
            drop(release);
            occupier.await.unwrap();
            heartbeat.await.unwrap().unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), idle)
                .await
                .expect("gate stayed busy after the queued job finished")
                .expect("queued job task panicked");
            assert_ne!(
                before,
                std::fs::read_to_string(&registry.inner.file_path).unwrap()
            );
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
