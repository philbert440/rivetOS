use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;

use protocol::js::{self, JsValue};

use crate::error::{PinReject, WorkspaceError};
use crate::lock::with_lock;
use crate::posix::{basename, is_absolute, parent_dir, posix_join, posix_resolve};
use crate::prompt::{TurnAssembly, TurnAssemblyInput, apply_turn_extras};
use crate::text::{cap_utf16, kib_one_decimal};
use crate::timefmt::format_en_us_new_york;

pub const FILE_IO_TIMEOUT: Duration = Duration::from_secs(30);
pub const PIN_MAX_BYTES: usize = 50 * 1024;
pub const PIN_TOTAL_MAX_BYTES: usize = 200 * 1024;
pub const DAILY_CONTEXT_UTF16_UNITS: usize = 2000;

const CORE_FILES: [&str; 2] = ["AGENT.md", "MEMORY.md"];

pub const DEFAULT_HEARTBEAT: &str = r#"# HEARTBEAT.md — Background Task Checklist

Instructions injected **only on heartbeat turns** (when the runtime polls you to do background work). Keep this small to limit token burn.

## Rules

- If nothing needs attention, reply `HEARTBEAT_OK`.
- Do not infer or repeat old tasks from prior chats.
- Stay within the checklist below — freelancing wastes tokens.
- Respect quiet hours (late night) unless something is urgent.

## Checklist

Rotate through these across heartbeats, not all in one turn:

- [ ] Check recent `memory/YYYY-MM-DD.md` for anything you committed to do
- [ ] Check `AGENT.md` in any active project directory for pending work
- [ ] Brief memory maintenance (consolidate / index)
- [ ] _(add human-specific reminders as they come up)_

## State

Track what you checked and when in `memory/heartbeat-state.json`:

```json
{
  "lastChecks": {
    "memory_review": null,
    "agent_md": null
  }
}
```
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceFile {
    pub name: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinResult {
    pub name: String,
    pub size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyContext {
    pub date: String,
    pub content: js::JsString,
}

struct PinnedFile {
    name: String,
    content: String,
    size: usize,
}

pub struct WorkspaceLoader {
    base_dir: String,
    cwd: String,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    cache: Mutex<HashMap<String, String>>,
    pins: Mutex<Vec<PinnedFile>>,
    skill_catalog: Mutex<String>,
    read_faults: Mutex<Vec<String>>,
}

impl WorkspaceLoader {
    pub fn new(base_dir: impl Into<String>) -> Self {
        let clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync> = Arc::new(Utc::now);
        Self::with_clock(base_dir, clock)
    }

    pub fn with_unix_seconds(base_dir: impl Into<String>, seconds: i64) -> Self {
        Self::with_clock(
            base_dir,
            Arc::new(move || DateTime::from_timestamp(seconds, 0).unwrap_or_else(Utc::now)),
        )
    }

    pub fn with_clock(
        base_dir: impl Into<String>,
        clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    ) -> Self {
        let cwd = std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_string());
        Self {
            base_dir: base_dir.into(),
            cwd,
            clock,
            cache: Mutex::new(HashMap::new()),
            pins: Mutex::new(Vec::new()),
            skill_catalog: Mutex::new(String::new()),
            read_faults: Mutex::new(Vec::new()),
        }
    }

    pub async fn load(&self) -> Vec<WorkspaceFile> {
        let mut files = Vec::new();
        for name in CORE_FILES {
            match self.read_hit(name).await {
                FileRead::Found(content) if !content.is_empty() => {
                    files.push(WorkspaceFile {
                        name: name.to_string(),
                        path: posix_join(&self.base_dir, name),
                        content,
                    });
                }
                FileRead::Found(_) | FileRead::Missing => {}
                FileRead::Failed(error) => self.record_fault(&error),
            }
        }
        files
    }

    pub async fn read(&self, filename: &str) -> Option<String> {
        match self.read_hit(filename).await {
            FileRead::Found(content) => Some(content),
            FileRead::Missing => None,
            FileRead::Failed(error) => {
                self.record_fault(&error);
                None
            }
        }
    }

    pub fn read_faults(&self) -> Vec<String> {
        with_lock(&self.read_faults, |faults| faults.clone())
    }

    pub async fn write(&self, filename: &str, content: &str) -> Result<(), WorkspaceError> {
        let path = posix_join(&self.base_dir, filename);
        write_utf8(&path, content).await?;
        with_lock(&self.cache, |cache| {
            cache.insert(filename.to_string(), content.to_string());
        });
        Ok(())
    }

    pub async fn pin_file(&self, file_path: &str) -> Result<PinResult, PinReject> {
        let (resolved, name) = self.pin_location(file_path);
        let Some(content) = self.read_pin(&resolved).await else {
            return Err(PinReject::new(format!("File not found: {file_path}")));
        };
        let size = content.len();
        if size > PIN_MAX_BYTES {
            return Err(PinReject::new(format!(
                "File too large: {name} is {}KB (max 50KB)",
                kib_one_decimal(size)
            )));
        }
        with_lock(&self.pins, |pins| {
            let mut total = size;
            for pin in pins.iter() {
                if pin.name != name {
                    total += pin.size;
                }
            }
            if total > PIN_TOTAL_MAX_BYTES {
                return Err(PinReject::new(
                    "Total pinned context would exceed 200KB limit. Unpin some files first."
                        .to_string(),
                ));
            }
            if let Some(slot) = pins.iter_mut().find(|pin| pin.name == name) {
                slot.content = content;
                slot.size = size;
            } else {
                pins.push(PinnedFile {
                    name: name.clone(),
                    content,
                    size,
                });
            }
            Ok(PinResult { name, size })
        })
    }

    pub fn unpin_file(&self, file_path: &str) -> bool {
        let name = self.pin_name(file_path);
        with_lock(&self.pins, |pins| {
            let before = pins.len();
            pins.retain(|pin| pin.name != name);
            pins.len() != before
        })
    }

    pub fn pinned_files(&self) -> Vec<PinResult> {
        with_lock(&self.pins, |pins| {
            pins.iter()
                .map(|pin| PinResult {
                    name: pin.name.clone(),
                    size: pin.size,
                })
                .collect()
        })
    }

    pub fn clear_pinned_files(&self) -> usize {
        with_lock(&self.pins, |pins| {
            let count = pins.len();
            pins.clear();
            count
        })
    }

    pub async fn resolve_profile(&self, user_id: Option<&str>) -> Option<String> {
        let user_id = user_id.filter(|value| !value.is_empty())?;
        let raw = self.read("users/profiles.json").await?;
        if raw.is_empty() {
            return None;
        }
        let value = protocol::js::parse(&raw).ok()?;
        let entry = profile_entry(&value, user_id)?;
        if !js::js_boolean(entry) {
            return None;
        }
        Some(js::js_string(entry).to_utf8().to_string())
    }

    pub fn set_skill_catalog(&self, text: &str) {
        let trimmed = protocol::js::js_trim(text).to_string();
        with_lock(&self.skill_catalog, |catalog| *catalog = trimmed);
    }

    pub async fn build_system_prompt(
        &self,
        agent_id: Option<&str>,
        user_id: Option<&str>,
    ) -> String {
        let before = self.fault_len();
        let files = self.load().await;
        if files.is_empty() && self.fault_len() == before {
            tracing::warn!(
                "No workspace files loaded from {} — agent will boot without personality files",
                self.base_dir
            );
        }
        let profile = self.resolve_profile(user_id).await;
        let profile_body = match &profile {
            Some(name) => self.read(&format!("users/{name}.md")).await,
            None => None,
        };
        let pins = with_lock(&self.pins, |pins| {
            pins.iter()
                .map(|pin| (pin.name.clone(), pin.content.clone()))
                .collect::<Vec<_>>()
        });
        let catalog = with_lock(&self.skill_catalog, |catalog| catalog.clone());
        let mut prompt = String::new();
        for file in &files {
            prompt.push_str("\n\n## ");
            prompt.push_str(&file.name);
            prompt.push('\n');
            prompt.push_str(&file.content);
        }
        if let Some(profile) = &profile
            && let Some(body) = profile_body.as_deref()
            && !body.is_empty()
        {
            prompt.push_str("\n\n## USER.md (");
            prompt.push_str(profile);
            prompt.push_str(")\n");
            prompt.push_str(body);
        }
        for (name, content) in &pins {
            prompt.push_str("\n\n## Pinned: ");
            prompt.push_str(name);
            prompt.push('\n');
            prompt.push_str(content);
        }
        if let Some(agent_id) = agent_id.filter(|value| !value.is_empty()) {
            let time = format_en_us_new_york((self.clock)());
            prompt.push_str("\n\n## Runtime\nAgent: ");
            prompt.push_str(agent_id);
            prompt.push_str(" | Time: ");
            prompt.push_str(&time);
        }
        if !catalog.is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(&catalog);
        }
        protocol::js::js_trim(&prompt).to_string()
    }

    pub async fn build_heartbeat_prompt(&self, agent_id: Option<&str>) -> String {
        let base = self.build_system_prompt(agent_id, None).await;
        let heartbeat = match self.read("HEARTBEAT.md").await {
            Some(text) if !text.is_empty() => text,
            _ => DEFAULT_HEARTBEAT.to_string(),
        };
        let mut prompt = base;
        prompt.push_str("\n\n## HEARTBEAT.md\n");
        prompt.push_str(&heartbeat);
        prompt
    }

    pub fn clear_cache(&self) {
        with_lock(&self.cache, |cache| cache.clear());
        with_lock(&self.pins, |pins| pins.clear());
    }

    pub async fn read_daily_context(&self) -> Option<DailyContext> {
        let ms = (self.clock)().timestamp_millis() as f64;
        let date = js::utc_day(ms).ok()?;
        let relative = format!("memory/{date}.md");
        let path = posix_join(&self.base_dir, &relative);
        let content = match read_file(&path).await {
            FileRead::Found(content) => content,
            FileRead::Missing => return None,
            FileRead::Failed(error) => {
                self.record_fault(&error);
                return None;
            }
        };
        if content.is_empty() {
            return None;
        }
        Some(DailyContext {
            date,
            content: cap_utf16(&content, DAILY_CONTEXT_UTF16_UNITS),
        })
    }

    pub async fn assemble_turn(&self, input: TurnAssemblyInput<'_>) -> TurnAssembly {
        let base = self
            .build_system_prompt(input.agent_id, input.user_id)
            .await;
        let system_prompt = apply_turn_extras(base, input.chat_type, input.extra_system_prompt);
        TurnAssembly { system_prompt }
    }

    async fn read_hit(&self, filename: &str) -> FileRead {
        if let Some(hit) = with_lock(&self.cache, |cache| cache.get(filename).cloned()) {
            return FileRead::Found(hit);
        }
        let path = posix_join(&self.base_dir, filename);
        match read_file(&path).await {
            FileRead::Found(content) => {
                with_lock(&self.cache, |cache| {
                    cache.insert(filename.to_string(), content.clone());
                });
                FileRead::Found(content)
            }
            other => other,
        }
    }

    async fn read_pin(&self, path: &str) -> Option<String> {
        match read_file(path).await {
            FileRead::Found(content) => Some(content),
            FileRead::Missing => None,
            FileRead::Failed(error) => {
                self.record_fault(&error);
                None
            }
        }
    }

    fn record_fault(&self, error: &WorkspaceError) {
        tracing::warn!("{error}");
        with_lock(&self.read_faults, |faults| faults.push(error.to_string()));
    }

    fn fault_len(&self) -> usize {
        with_lock(&self.read_faults, |faults| faults.len())
    }

    fn pin_location(&self, file_path: &str) -> (String, String) {
        if is_absolute(file_path) {
            (file_path.to_string(), basename(file_path).to_string())
        } else {
            (
                posix_resolve(&self.base_dir, file_path, &self.cwd),
                file_path.to_string(),
            )
        }
    }

    fn pin_name(&self, file_path: &str) -> String {
        if is_absolute(file_path) {
            basename(file_path).to_string()
        } else {
            file_path.to_string()
        }
    }
}

enum FileRead {
    Found(String),
    Missing,
    Failed(WorkspaceError),
}

fn profile_entry<'a>(value: &'a JsValue, user_id: &str) -> Option<&'a JsValue> {
    if let Some(object) = value.as_object() {
        return object.get(user_id);
    }
    let items = value.as_array()?;
    let index = js_array_index(user_id)?;
    items.get(index)
}

fn js_array_index(key: &str) -> Option<usize> {
    if key.is_empty() || key.len() > 10 {
        return None;
    }
    let bytes = key.as_bytes();
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    if !bytes.iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    if value > 4_294_967_294 {
        return None;
    }
    usize::try_from(value).ok()
}

async fn read_file(path: &str) -> FileRead {
    match tokio::time::timeout(FILE_IO_TIMEOUT, tokio::fs::read(path)).await {
        Ok(Ok(bytes)) => FileRead::Found(String::from_utf8_lossy(&bytes).into_owned()),
        Ok(Err(source)) if source.kind() == std::io::ErrorKind::NotFound => FileRead::Missing,
        Ok(Err(source)) => {
            let syscall = if source.raw_os_error() == Some(21) {
                "read"
            } else {
                "open"
            };
            FileRead::Failed(WorkspaceError::io(path, syscall, source))
        }
        Err(_) => FileRead::Failed(WorkspaceError::Timeout(path.to_string())),
    }
}

async fn write_utf8(path: &str, content: &str) -> Result<(), WorkspaceError> {
    let parent = parent_dir(path);
    match tokio::time::timeout(FILE_IO_TIMEOUT, tokio::fs::create_dir_all(&parent)).await {
        Ok(Ok(())) => {}
        Ok(Err(source)) => return Err(WorkspaceError::io(&parent, "mkdir", source)),
        Err(_) => return Err(WorkspaceError::Timeout(parent)),
    }
    let target = path.to_string();
    let body = content.to_string();
    let wrote =
        tokio::task::spawn_blocking(move || protocol::host::write_text(Path::new(&target), &body));
    match tokio::time::timeout(FILE_IO_TIMEOUT, wrote).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(WorkspaceError::Io(error.to_string())),
        Ok(Err(error)) => Err(WorkspaceError::Io(error.to_string())),
        Err(_) => Err(WorkspaceError::Timeout(path.to_string())),
    }
}
