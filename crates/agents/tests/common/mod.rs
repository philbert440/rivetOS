use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use agents::{AgentPreset, AgentPresetInput, AgentPresetPatch, BoxFuture, JsNumber};

pub mod contract;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct TempDir {
    pub path: PathBuf,
}

impl TempDir {
    pub fn new(prefix: &str) -> Self {
        let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub fn path_str(&self, name: &str) -> String {
        self.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn preset(id: &str, name: &str) -> AgentPreset {
    AgentPreset {
        id: id.to_string(),
        name: name.to_string(),
        color: String::new(),
        harness_id: None,
        model: String::new(),
        effort: "medium".to_string(),
        system_prompt: String::new(),
        node: Some("n".to_string()),
        directory: Some("/d".to_string()),
        shared_link: Some(true),
        node_base_url: Some(String::new()),
        sort_order: None,
        created_at: JsNumber::from(1),
        updated_at: JsNumber::from(1),
    }
}

pub fn input(name: &str) -> AgentPresetInput {
    AgentPresetInput {
        name: name.to_string(),
        color: None,
        harness_id: None,
        model: None,
        effort: None,
        system_prompt: None,
        node: "node-f".to_string(),
        directory: "/tmp/agents/reviewer".to_string(),
        shared_link: None,
        node_base_url: None,
        id: None,
        created_at: None,
    }
}

pub fn patch() -> AgentPresetPatch {
    AgentPresetPatch::default()
}

pub fn looks_like_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
}

pub type Fut<'a, T> = BoxFuture<'a, T>;
