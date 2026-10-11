use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use protocol::host::read_text;
use protocol::js::{JsString, JsValue, parse};
use uuid::Uuid;

use crate::directory::mkdir_p_700;
use crate::error::PresetError;
use crate::js_row::{
    entries_of, file_identity, is_js_integer, js_f64, object_from_entries, object_from_pairs,
    remove_key, stringify_pretty,
};
use crate::preset::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentRegistryBackend, fresh_stored_row,
    migrate_row, patch_stored_row, preset_from_js, submitted_name,
};
use crate::store::{
    AgentPresetStore, BoxFuture, find_preset_by_handle, sort_presets, system_now_ms,
};
use crate::validate::is_effort;

pub struct FileAgentPresetStore {
    file: String,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl FileAgentPresetStore {
    pub fn new(file: impl Into<String>) -> Self {
        Self::with_now(file, Arc::new(system_now_ms))
    }

    pub fn with_now(file: impl Into<String>, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            file: file.into(),
            now,
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
            let rows = load_blocking(&file).await?;
            let mut presets = Vec::new();
            for row in rows {
                let preset = preset_from_js(&row)?;
                if node.as_deref().is_none_or(|filter| {
                    preset
                        .node
                        .as_ref()
                        .is_some_and(|value| value.to_utf8() == filter)
                }) {
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
            let rows = load_blocking(&file).await?;
            let needle = JsString::from_text(&id);
            for row in rows {
                if same_text(&row, "id", &needle) {
                    return Ok(Some(preset_from_js(&row)?));
                }
            }
            Ok(None)
        })
    }

    fn find_by_handle(
        &self,
        handle: &JsString,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let file = self.file.clone();
        let handle = handle.clone();
        Box::pin(async move {
            let rows = load_blocking(&file).await?;
            let mut presets = Vec::new();
            for row in rows {
                presets.push(preset_from_js(&row)?);
            }
            Ok(find_preset_by_handle(&presets, &handle).cloned())
        })
    }

    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let file = self.file.clone();
        let now = Arc::clone(&self.now);
        Box::pin(async move {
            spawn_io(move || {
                let lock = lock_for(&file);
                let _guard = lock.lock();
                let mut rows = load_for_write(&file)?;
                let preset = preset_from_js(&fresh_stored_row(
                    &input,
                    &Uuid::new_v4().to_string(),
                    now(),
                )?)?;
                if rows.iter().any(|row| same_text(row, "id", &preset.id)) {
                    return Err(PresetError::conflict(format!(
                        "agent id already exists: {}",
                        preset.id
                    )));
                }
                assert_name_available(&rows, &preset.name, None)?;
                let Some(document) = preset.document.clone() else {
                    return Err(PresetError::message("preset row is not an object"));
                };
                rows.push((*document).clone());
                save_registry(&file, &rows)?;
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
        let now = Arc::clone(&self.now);
        let id = id.to_string();
        Box::pin(async move {
            spawn_io(move || {
                let lock = lock_for(&file);
                let _guard = lock.lock();
                let mut rows = load_for_write(&file)?;
                let needle = JsString::from_text(&id);
                let Some(index) = rows.iter().position(|row| same_text(row, "id", &needle)) else {
                    return Ok(None);
                };
                let next_row = patch_stored_row(&rows[index], &patch, now())?;
                let next = preset_from_js(&next_row)?;
                assert_name_available(&rows, &next.name, Some(&needle))?;
                rows[index] = next_row;
                save_registry(&file, &rows)?;
                Ok(Some(next))
            })
            .await
        })
    }

    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        let file = self.file.clone();
        let id = id.to_string();
        Box::pin(async move {
            spawn_io(move || {
                let lock = lock_for(&file);
                let _guard = lock.lock();
                let rows = load_for_write(&file)?;
                let original_len = rows.len();
                let needle = JsString::from_text(&id);
                let next: Vec<JsValue> = rows
                    .into_iter()
                    .filter(|row| !same_text(row, "id", &needle))
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

fn same_text(row: &JsValue, key: &str, needle: &JsString) -> bool {
    row.get(key)
        .and_then(JsValue::as_js_string)
        .is_some_and(|stored| stored == needle)
}

fn assert_name_available(
    rows: &[JsValue],
    name: &JsString,
    except_id: Option<&JsString>,
) -> Result<(), PresetError> {
    let key = crate::preset::name_key_text(name);
    let clash = rows.iter().any(|row| {
        if except_id.is_some_and(|id| same_text(row, "id", id)) {
            return false;
        }
        row.get("name")
            .and_then(JsValue::as_js_string)
            .is_some_and(|stored| crate::preset::name_key_text(stored) == key)
    });
    if clash {
        return Err(PresetError::conflict(format!(
            "agent name already exists: {}",
            submitted_name(name)
        )));
    }
    Ok(())
}

async fn load_blocking(file: &str) -> Result<Vec<JsValue>, PresetError> {
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

fn load_for_write(file: &str) -> Result<Vec<JsValue>, PresetError> {
    let rows = load_registry(file)?;
    rows.into_iter().map(|row| migrate_row(&row)).collect()
}

fn load_registry(file: &str) -> Result<Vec<JsValue>, PresetError> {
    if !Path::new(file).exists() {
        return Ok(Vec::new());
    }
    let text = match read_text(Path::new(file)) {
        Ok(text) => text,
        Err(err) => {
            quarantine_message(file, "parse failed", &err.to_string());
            return Ok(Vec::new());
        }
    };
    let parsed = match parse(&text) {
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
    let Some(agents) = root.get("agents").and_then(JsValue::as_array) else {
        quarantine_message(file, "shape invalid", "agents");
        return Ok(Vec::new());
    };
    let mut kept = Vec::new();
    for row in agents {
        let Some(cleaned) = without_invalid_sort_order(row)? else {
            continue;
        };
        if is_agent_preset_value(&cleaned) {
            kept.push(cleaned);
        }
    }
    Ok(kept)
}

fn without_invalid_sort_order(row: &JsValue) -> Result<Option<JsValue>, PresetError> {
    let Some(object) = row.as_object() else {
        return Ok(None);
    };
    let Some(sort_order) = object.get("sortOrder") else {
        return Ok(Some(row.clone()));
    };
    if is_js_integer(sort_order) {
        return Ok(Some(row.clone()));
    }
    let mut entries = entries_of(row)?;
    remove_key(&mut entries, "sortOrder");
    Ok(Some(object_from_entries(entries)?))
}

fn is_agent_preset_value(value: &JsValue) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if let Some(harness) = object.get("harnessId") {
        match harness.as_str() {
            Some(text) if crate::validate::is_harness_id(text) => {}
            _ => return false,
        }
    }
    if let Some(sort_order) = object.get("sortOrder")
        && !is_js_integer(sort_order)
    {
        return false;
    }
    let Some(id) = object.get("id").and_then(JsValue::as_str) else {
        return false;
    };
    if id.is_empty() {
        return false;
    }
    object.get("name").is_some_and(JsValue::is_string)
        && object.get("color").is_some_and(JsValue::is_string)
        && object.get("model").is_some_and(JsValue::is_string)
        && object
            .get("effort")
            .and_then(JsValue::as_str)
            .is_some_and(is_effort)
        && object.get("systemPrompt").is_some_and(JsValue::is_string)
        && object.get("nodeBaseUrl").is_some_and(JsValue::is_string)
        && object.get("createdAt").and_then(js_f64).is_some()
        && object.get("updatedAt").and_then(js_f64).is_some()
}

fn save_registry(file: &str, agents: &[JsValue]) -> Result<(), PresetError> {
    let root = object_from_pairs(vec![("agents", JsValue::Array(agents.to_vec()))])?;
    let path = Path::new(file);
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        mkdir_p_700(parent)?;
    }
    protocol::host::atomic_replace(path, stringify_pretty(&root).as_bytes())?;
    Ok(())
}

fn lock_for(file: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = file_identity(file);
    let mut guard = locks.lock();
    if let Some(existing) = guard.get(&key) {
        return Arc::clone(existing);
    }
    let created = Arc::new(Mutex::new(()));
    guard.insert(key, Arc::clone(&created));
    created
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
