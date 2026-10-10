use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

use protocol::js::js_trim;

use crate::turn::DEFAULT_TRANSCRIPT_MAX_BYTES;

#[derive(Clone, Debug)]
pub struct Roots {
    pub home: PathBuf,
    pub env: HashMap<String, String>,
    pub use_process_env: bool,
    pub max_bytes: u64,
    pub pi_home: Option<PathBuf>,
    pub qwen_home: Option<PathBuf>,
    pub cursor_home: Option<PathBuf>,
    pub cowork_roots: Option<Vec<PathBuf>>,
    pub cwd: PathBuf,
}

impl Default for Roots {
    fn default() -> Self {
        Self::process()
    }
}

impl Roots {
    pub fn process() -> Self {
        let home = env::var_os("HOME").map(PathBuf::from).filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(|| PathBuf::from("/"));
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        Self {
            home,
            env: HashMap::new(),
            use_process_env: true,
            max_bytes: DEFAULT_TRANSCRIPT_MAX_BYTES,
            pi_home: None,
            qwen_home: None,
            cursor_home: None,
            cowork_roots: None,
            cwd,
        }
    }

    pub fn isolated(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        Self {
            home,
            env: HashMap::new(),
            use_process_env: false,
            max_bytes: DEFAULT_TRANSCRIPT_MAX_BYTES,
            pi_home: None,
            qwen_home: None,
            cursor_home: None,
            cowork_roots: None,
            cwd: PathBuf::from("/"),
        }
    }

    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.use_process_env = false;
        self.env.insert(key.into(), value.into());
    }

    pub fn env_raw(&self, key: &str) -> Option<String> {
        if let Some(value) = self.env.get(key) {
            return Some(value.clone());
        }
        if self.use_process_env { env::var(key).ok() } else { None }
    }

    pub fn env_trim(&self, key: &str) -> Option<String> {
        let raw = self.env_raw(key)?;
        let trimmed = js_trim(&raw);
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    }

    pub fn join_home(&self, parts: &[&str]) -> PathBuf {
        let mut path = self.home.clone();
        for part in parts {
            path.push(part);
        }
        path
    }

    pub fn under(&self, base: &Path, parts: &[&str]) -> PathBuf {
        let mut path = base.to_path_buf();
        for part in parts {
            path.push(part);
        }
        path
    }
}
