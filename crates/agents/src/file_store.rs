use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;

use serde_json::{Map, Value};
use uuid::Uuid;

use crate::directory::{mkdir_p_700, set_mode};
use crate::error::PresetError;
use crate::preset::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentRegistryBackend, fresh_preset_map,
    name_key, preset_from_map, write_preset_fields,
};
use crate::store::{
    AgentPresetStore, BoxFuture, find_preset_by_handle, preset_from_create, preset_from_patch,
    sort_presets, system_now_ms,
};
use crate::validate::is_agent_preset;

pub struct FileAgentPresetStore {
    file: String,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    lock: Arc<Mutex<()>>,
}

impl FileAgentPresetStore {
    pub fn new(file: impl Into<String>) -> Self {
        Self::with_now(file, Arc::new(system_now_ms))
    }

    pub fn with_now(file: impl Into<String>, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            file: file.into(),
            now,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> &str {
        &self.file
    }
}

impl AgentPresetStore for FileAgentPresetStore {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::File
    }

    fn file(&self) -> Option<String> {
        Some(self.file.clone())
    }

    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async { Ok(true) })
    }

    fn list(&self, node: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        let file = self.file.clone();
        let node = node.map(str::to_string);
        Box::pin(async move {
            let maps = load_blocking(&file).await?;
            let mut presets = Vec::new();
            for map in maps {
                let preset = preset_from_map(&map)?;
                if node
                    .as_deref()
                    .is_none_or(|filter| preset.node.as_deref() == Some(filter))
                {
                    presets.push(preset);
                }
            }
            Ok(sort_presets(presets))
        })
    }

    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let file = self.file.clone();
        let id = id.to_string();
        Box::pin(async move {
            let maps = load_blocking(&file).await?;
            for map in maps {
                if map.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                    return Ok(Some(preset_from_map(&map)?));
                }
            }
            Ok(None)
        })
    }

    fn find_by_handle(
        &self,
        handle: &str,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let file = self.file.clone();
        let handle = handle.to_string();
        Box::pin(async move {
            let maps = load_blocking(&file).await?;
            let mut presets = Vec::new();
            for map in maps {
                presets.push(preset_from_map(&map)?);
            }
            Ok(find_preset_by_handle(&presets, &handle).cloned())
        })
    }

    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let file = self.file.clone();
        let lock = Arc::clone(&self.lock);
        let now = Arc::clone(&self.now);
        Box::pin(async move {
            spawn_io(move || {
                let _guard = lock.lock();
                let mut maps = load_registry(&file)?;
                let preset = preset_from_create(&input, &Uuid::new_v4().to_string(), now())?;
                if maps
                    .iter()
                    .any(|map| map.get("id").and_then(Value::as_str) == Some(preset.id.as_str()))
                {
                    return Err(PresetError::conflict(format!(
                        "agent id already exists: {}",
                        preset.id
                    )));
                }
                assert_name_available(&maps, &preset.name, None)?;
                maps.push(fresh_preset_map(&preset));
                save_registry(&file, &maps)?;
                Ok(preset)
            })
            .await
        })
    }

    fn update(
        &self,
        id: &str,
        patch: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let file = self.file.clone();
        let lock = Arc::clone(&self.lock);
        let now = Arc::clone(&self.now);
        let id = id.to_string();
        Box::pin(async move {
            spawn_io(move || {
                let _guard = lock.lock();
                let mut maps = load_registry(&file)?;
                let Some(index) = maps
                    .iter()
                    .position(|map| map.get("id").and_then(Value::as_str) == Some(id.as_str()))
                else {
                    return Ok(None);
                };
                let current = preset_from_map(&maps[index])?;
                let next = preset_from_patch(&current, &patch, now())?;
                assert_name_available(&maps, &next.name, Some(&id))?;
                write_preset_fields(&mut maps[index], &next);
                save_registry(&file, &maps)?;
                Ok(Some(next))
            })
            .await
        })
    }

    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        let file = self.file.clone();
        let lock = Arc::clone(&self.lock);
        let id = id.to_string();
        Box::pin(async move {
            spawn_io(move || {
                let _guard = lock.lock();
                let maps = load_registry(&file)?;
                let original_len = maps.len();
                let next: Vec<Map<String, Value>> = maps
                    .into_iter()
                    .filter(|map| map.get("id").and_then(Value::as_str) != Some(id.as_str()))
                    .collect();
                if next.len() == original_len {
                    return Ok(false);
                }
                save_registry(&file, &next)?;
                Ok(true)
            })
            .await
        })
    }
}

fn assert_name_available(
    maps: &[Map<String, Value>],
    name: &str,
    except_id: Option<&str>,
) -> Result<(), PresetError> {
    let key = name_key(name);
    let clash = maps.iter().any(|map| {
        let id = map.get("id").and_then(Value::as_str);
        if except_id.is_some() && id == except_id {
            return false;
        }
        map.get("name")
            .and_then(Value::as_str)
            .is_some_and(|stored| name_key(stored) == key)
    });
    if clash {
        return Err(PresetError::conflict(format!(
            "agent name already exists: {}",
            protocol::js::js_trim(name)
        )));
    }
    Ok(())
}

async fn load_blocking(file: &str) -> Result<Vec<Map<String, Value>>, PresetError> {
    let file = file.to_string();
    spawn_io(move || load_registry(&file)).await
}

async fn spawn_io<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, PresetError> + Send + 'static,
) -> Result<T, PresetError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| PresetError::message(err.to_string()))?
}

fn load_registry(file: &str) -> Result<Vec<Map<String, Value>>, PresetError> {
    if !Path::new(file).exists() {
        return Ok(Vec::new());
    }
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(err) => {
            quarantine(file, "parse failed", &err);
            return Ok(Vec::new());
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => {
            quarantine_message(file, "parse failed", "invalid utf-8");
            return Ok(Vec::new());
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            quarantine_message(file, "parse failed", "invalid json");
            return Ok(Vec::new());
        }
    };
    let Some(root) = parsed.as_object() else {
        quarantine_message(file, "shape invalid", "root");
        return Ok(Vec::new());
    };
    let Some(agents) = root.get("agents").and_then(Value::as_array) else {
        quarantine_message(file, "shape invalid", "agents");
        return Ok(Vec::new());
    };
    let mut kept = Vec::new();
    for row in agents {
        let Some(cleaned) = without_invalid_sort_order(row) else {
            continue;
        };
        if is_agent_preset(&Value::Object(cleaned.clone())) {
            kept.push(cleaned);
        }
    }
    Ok(kept)
}

fn without_invalid_sort_order(row: &Value) -> Option<Map<String, Value>> {
    let map = row.as_object()?.clone();
    let Some(sort_order) = map.get("sortOrder") else {
        return Some(map);
    };
    if sort_order
        .as_number()
        .is_some_and(crate::validate::json_is_integer)
    {
        return Some(map);
    }
    let mut next = map;
    next.remove("sortOrder");
    Some(next)
}

fn save_registry(file: &str, agents: &[Map<String, Value>]) -> Result<(), PresetError> {
    let mut root = Map::new();
    root.insert(
        "agents".to_string(),
        Value::Array(agents.iter().cloned().map(Value::Object).collect()),
    );
    let body = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|err| PresetError::message(err.to_string()))?;
    write_atomic(file, &body)?;
    Ok(())
}

fn write_atomic(file: &str, body: &str) -> Result<(), PresetError> {
    let path = Path::new(file);
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        mkdir_p_700(parent)?;
    }
    let tmp = format!("{file}.tmp-{}", std::process::id());
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        let mut handle = options.open(&tmp)?;
        handle.write_all(body.as_bytes())?;
    }
    set_mode(Path::new(&tmp), 0o600)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn quarantine(file: &str, reason: &str, err: &std::io::Error) {
    quarantine_message(file, reason, &err.to_string());
}

fn quarantine_message(file: &str, reason: &str, detail: &str) {
    let dest = format!("{file}.corrupt-{}", system_now_ms());
    let existed = Path::new(file).exists();
    let renamed = if existed {
        std::fs::rename(file, &dest).is_ok()
    } else {
        true
    };
    if renamed {
        tracing::warn!("[den-server] agents.json {reason}; quarantined to {dest}");
    } else {
        tracing::warn!("[den-server] agents.json {reason}; quarantine rename failed: {detail}");
    }
}
