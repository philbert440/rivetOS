use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::task::JoinHandle;

use crate::error::{MeshError, MeshParseErrorCode};
use crate::model::{
    DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_STALE_THRESHOLD_MS, MESH_FILE_NAME, MeshFile, MeshNode,
    MeshNodeEvent, MeshParseOptions, OnInvalidNode, ParseOutcome, inherit_operator_fields,
    mesh_file_to_pretty, mesh_node_from_value, now_ms, operator_host_warning, parse_mesh_file,
};
use crate::paths::shared_dir;
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
    local_node_id: Mutex<Option<String>>,
    local_node: Mutex<Option<MeshNode>>,
    warnings: Mutex<Vec<String>>,
    fail_next_save: Mutex<Option<String>>,
    heartbeat: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct FileMeshRegistry {
    inner: Arc<Inner>,
}

impl FileMeshRegistry {
    pub fn new(config: RegistryConfig) -> Self {
        let dir = if config.storage_dir.is_empty() {
            shared_dir()
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
            }),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.inner.file_path
    }

    pub fn fail_next_save(&self, message: impl Into<String>) {
        *self
            .inner
            .fail_next_save
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(message.into());
    }

    pub fn warnings(&self) -> Vec<String> {
        self.inner
            .warnings
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub async fn register(&self, node: MeshNode) -> Result<(), MeshError> {
        let inner = Arc::clone(&self.inner);
        let events = blocking(move || inner.register_blocking(node)).await?;
        self.emit_all(events);
        Ok(())
    }

    pub async fn deregister(&self, node_id: &str) -> Result<(), MeshError> {
        let inner = Arc::clone(&self.inner);
        let node_id = node_id.to_string();
        let events = blocking(move || inner.deregister_blocking(&node_id)).await?;
        self.emit_all(events);
        Ok(())
    }

    pub async fn heartbeat(&self, node_id: &str, status: Option<&str>) -> Result<(), MeshError> {
        let inner = Arc::clone(&self.inner);
        let node_id_owned = node_id.to_string();
        let status_owned = status.map(str::to_string);
        let missing =
            blocking(move || inner.heartbeat_blocking(&node_id_owned, status_owned.as_deref()))
                .await?;
        if missing {
            let local = self
                .inner
                .local_node
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone();
            if let Some(mut local) = local
                && local.id == node_id
            {
                tracing::warn!("Local node {node_id} missing from mesh roster — re-registering");
                local.last_seen = now_ms();
                if let Some(status) = status {
                    local.status = status.to_string();
                }
                self.register(local).await?;
            }
        }
        Ok(())
    }

    pub async fn get_nodes(&self) -> Result<Vec<MeshNode>, MeshError> {
        let inner = Arc::clone(&self.inner);
        blocking(move || inner.read_blocking(|file| Ok(file.values()))).await
    }

    pub async fn get_node(&self, node_id: &str) -> Result<Option<MeshNode>, MeshError> {
        let inner = Arc::clone(&self.inner);
        let node_id = node_id.to_string();
        blocking(move || inner.read_blocking(|file| Ok(file.get(&node_id).cloned()))).await
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
        let (pruned, events) = blocking(move || inner.prune_blocking(stale_threshold_ms)).await?;
        self.emit_all(events);
        Ok(pruned)
    }

    pub async fn start(&self, local_node: MeshNode) -> Result<(), MeshError> {
        ensure_runtime()?;
        {
            *self
                .inner
                .local_node_id
                .lock()
                .unwrap_or_else(|err| err.into_inner()) = Some(local_node.id.clone());
            *self
                .inner
                .local_node
                .lock()
                .unwrap_or_else(|err| err.into_inner()) = Some(local_node.clone());
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
        let handle = self
            .inner
            .heartbeat
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take();
        if let Some(handle) = handle {
            handle.abort();
            let _ = handle.await;
        }
        let node_id = self
            .inner
            .local_node_id
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        if let Some(node_id) = node_id
            && let Err(err) = self.deregister(&node_id).await
        {
            tracing::warn!("Failed to deregister on shutdown: {err}");
        }
        tracing::info!("Mesh stopped");
        Ok(())
    }

    fn spawn_heartbeat(&self, node_id: String, interval_ms: u64) {
        if let Some(previous) = self
            .inner
            .heartbeat
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            previous.abort();
        }
        let registry = self.clone();
        let period = Duration::from_millis(interval_ms);
        let handle = tokio::spawn(async move {
            let start = tokio::time::Instant::now() + period;
            let mut ticker = tokio::time::interval_at(start, period);
            loop {
                ticker.tick().await;
                if let Err(err) = registry.heartbeat(&node_id, Some("online")).await {
                    tracing::error!("Mesh heartbeat failed: {err}");
                    continue;
                }
                if let Err(err) = registry.prune(None).await {
                    tracing::error!("Mesh heartbeat failed: {err}");
                }
            }
        });
        *self
            .inner
            .heartbeat
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(handle);
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
        match blocking(move || inner.merge_remote_blocking(nodes)).await {
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
    fn register_blocking(&self, node: MeshNode) -> Result<Vec<MeshNodeEvent>, MeshError> {
        self.with_lock(|| {
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
            let now = now_ms();
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
            self.save_locked(&data)?;
            Ok(vec![event])
        })
    }

    fn deregister_blocking(&self, node_id: &str) -> Result<Vec<MeshNodeEvent>, MeshError> {
        self.with_lock(|| {
            let mut data = self.load_locked()?;
            let Some(mut node) = data.get(node_id).cloned() else {
                return Ok(Vec::new());
            };
            node.status = "offline".to_string();
            let now = now_ms();
            data.insert(node_id.to_string(), node.clone());
            data.updated_at = now;
            self.save_locked(&data)?;
            tracing::info!("Node deregistered: {} ({node_id})", node.name);
            Ok(vec![MeshNodeEvent {
                event_type: "node:left".to_string(),
                node,
                timestamp: now,
            }])
        })
    }

    fn heartbeat_blocking(&self, node_id: &str, status: Option<&str>) -> Result<bool, MeshError> {
        self.with_lock(|| {
            let mut data = self.load_locked()?;
            let Some(node) = data.get_mut(node_id) else {
                return Ok(true);
            };
            let now = now_ms();
            node.last_seen = now;
            if let Some(status) = status {
                node.status = status.to_string();
            }
            data.updated_at = now;
            self.save_locked(&data)?;
            Ok(false)
        })
    }

    fn prune_blocking(
        &self,
        stale_threshold_ms: Option<u64>,
    ) -> Result<(Vec<MeshNode>, Vec<MeshNodeEvent>), MeshError> {
        let threshold = stale_threshold_ms
            .or(self.stale_threshold_ms)
            .unwrap_or(DEFAULT_STALE_THRESHOLD_MS);
        let local_id = self
            .local_node_id
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        self.with_lock(|| {
            let mut data = self.load_locked()?;
            let now = now_ms();
            let now_f = now.as_f64();
            let mut pruned = Vec::new();
            let mut events = Vec::new();
            for (id, node) in &mut data.nodes {
                if local_id.as_deref() == Some(id.as_str()) {
                    continue;
                }
                if node.role.as_deref().is_some_and(|role| role != "agent") {
                    continue;
                }
                let age = now_f - node.last_seen.as_f64();
                if age > threshold as f64 && node.status != "offline" {
                    node.status = "offline".to_string();
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
                self.save_locked(&data)?;
            }
            Ok((pruned, events))
        })
    }

    fn merge_remote_blocking(&self, remotes: Vec<MeshNode>) -> Result<usize, MeshError> {
        self.with_lock(|| {
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
                data.updated_at = now_ms();
                self.save_locked(&data)?;
            }
            Ok(merged)
        })
    }

    fn read_blocking<T>(
        &self,
        read: impl FnOnce(&MeshFile) -> Result<T, MeshError>,
    ) -> Result<T, MeshError> {
        self.with_lock(|| {
            let data = self.load_locked()?;
            read(&data)
        })
    }

    fn with_lock<T>(&self, body: impl FnOnce() -> Result<T, MeshError>) -> Result<T, MeshError> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&self.lock_path)?;
        let mut flock = fd_lock::RwLock::new(file);
        let _guard = flock.write()?;
        body()
    }

    fn load_locked(&self) -> Result<MeshFile, MeshError> {
        let raw = match std::fs::read_to_string(&self.file_path) {
            Ok(raw) => raw,
            Err(_) => {
                self.warnings
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .clear();
                return Ok(MeshFile::empty());
            }
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
                *self.warnings.lock().unwrap_or_else(|err| err.into_inner()) = outcome.warnings;
                Ok(outcome.file)
            }
            Err(err) => {
                if err.code() != MeshParseErrorCode::JsonInvalid {
                    tracing::error!("{}", err.message());
                    return Err(err.into());
                }
                self.warnings
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .clear();
                Ok(MeshFile::empty())
            }
        }
    }

    fn save_locked(&self, file: &MeshFile) -> Result<(), MeshError> {
        if let Some(message) = self
            .fail_next_save
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            return Err(MeshError::message(message));
        }
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let pretty =
            mesh_file_to_pretty(file).map_err(|err| MeshError::message(err.to_string()))?;
        let tmp = format!("{}.tmp-{}", self.file_path.display(), std::process::id());
        if let Err(err) = std::fs::write(&tmp, &pretty) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err.into());
        }
        if let Err(err) = std::fs::rename(&tmp, &self.file_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err.into());
        }
        Ok(())
    }
}

pub fn load_mesh_file_blocking(
    paths: &[String],
    options: MeshParseOptions,
) -> Result<Option<ParseOutcome>, MeshError> {
    for path in paths {
        let raw = match std::fs::read_to_string(path) {
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
    blocking(move || load_mesh_file_blocking(&paths, options)).await
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
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(MeshError::message(format!(
            "Seed responded {status}: {text}"
        )));
    }
    let value: Value = response.json().await?;
    let Some(items) = value.as_array() else {
        return Err(MeshError::message("seed mesh response is not an array"));
    };
    let mut nodes = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let key = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("remote")
            .to_string();
        let node = mesh_node_from_value(&key, item, url)
            .map_err(|err| MeshError::message(format!("seed node {index}: {err}")))?;
        nodes.push(node);
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

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, MeshError> + Send + 'static,
) -> Result<T, MeshError> {
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| MeshError::message("mesh registry needs a tokio runtime"))?;
    let joined = tokio::time::timeout(FILE_OP_TIMEOUT, handle.spawn_blocking(work))
        .await
        .map_err(|_| MeshError::message("mesh file operation timed out after 30s"))?;
    match joined {
        Ok(result) => result,
        Err(_) => Err(MeshError::message("mesh file task panicked")),
    }
}
