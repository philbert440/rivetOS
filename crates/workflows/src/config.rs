use std::path::{Path, PathBuf};
use std::sync::Arc;

use protocol::js::js_trim;

use crate::executors::ExecutorRegistry;
use crate::pathutil::{node_join, normalize_posix, path_text, strip_trailing_slashes};
use crate::registry::NamespacedCallRegistry;

pub const DEFAULT_STEP_TIMEOUT_MS: f64 = 30.0 * 60.0 * 1000.0;
pub const DEFAULT_MAX_RUN_RUNTIME_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const DEFAULT_SHARED_DIR: &str = "/rivet-shared";

pub fn shared_dir() -> PathBuf {
    match std::env::var("RIVETOS_SHARED_DIR") {
        Ok(raw) => {
            let trimmed = js_trim(&raw);
            if trimmed.is_empty() {
                PathBuf::from(DEFAULT_SHARED_DIR)
            } else {
                PathBuf::from(trimmed)
            }
        }
        Err(_) => PathBuf::from(DEFAULT_SHARED_DIR),
    }
}

pub fn shared_path(segments: &[&str]) -> PathBuf {
    let mut parts = Vec::with_capacity(segments.len() + 1);
    let root = path_text(&shared_dir());
    parts.push(root);
    for segment in segments {
        parts.push((*segment).to_string());
    }
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    node_join(&refs)
}

pub fn default_case_dir_root() -> PathBuf {
    shared_path(&["workflows", "runs"])
}

pub fn default_workflows_defs_root() -> PathBuf {
    shared_path(&["workflows", "defs"])
}

pub struct EngineConfig {
    pub case_dir_root: Option<PathBuf>,
    pub workflows_roots: Vec<PathBuf>,
    pub default_step_timeout_ms: Option<f64>,
    pub max_run_runtime_ms: Option<f64>,
    pub executors: Arc<dyn ExecutorRegistry>,
    pub call_registry: Option<NamespacedCallRegistry>,
    pub workflow_dirs: Vec<(String, PathBuf)>,
    pub warn: Arc<dyn Fn(&str) + Send + Sync>,
}

impl EngineConfig {
    pub fn new(executors: Arc<dyn ExecutorRegistry>) -> Self {
        Self {
            case_dir_root: None,
            workflows_roots: Vec::new(),
            default_step_timeout_ms: None,
            max_run_runtime_ms: None,
            executors,
            call_registry: None,
            workflow_dirs: Vec::new(),
            warn: default_warn(),
        }
    }
}

pub fn default_warn() -> Arc<dyn Fn(&str) + Send + Sync> {
    Arc::new(|message: &str| {
        tracing::warn!("{message}");
    })
}

pub fn resolve_case_dir_root(case_dir_root: Option<&Path>) -> PathBuf {
    case_dir_root
        .map(Path::to_path_buf)
        .unwrap_or_else(default_case_dir_root)
}

pub fn resolve_step_timeout_ms(configured: Option<f64>) -> f64 {
    configured.unwrap_or(DEFAULT_STEP_TIMEOUT_MS)
}

pub fn resolve_max_run_runtime_ms(configured: Option<f64>) -> f64 {
    configured.unwrap_or(DEFAULT_MAX_RUN_RUNTIME_MS)
}

pub fn resolve_runs_dir(runs_dir: Option<&str>) -> PathBuf {
    let trimmed = runs_dir.and_then(|value| {
        let trimmed = js_trim(value);
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    match trimmed {
        Some(path) => PathBuf::from(path),
        None => default_case_dir_root(),
    }
}

pub fn workflows_enabled(enabled: Option<bool>) -> bool {
    enabled != Some(false)
}

pub fn resolve_defs_roots(
    configured: Option<&[String]>,
    install_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut kept = Vec::new();
    if let Some(roots) = configured {
        for root in roots {
            if !js_trim(root).is_empty() {
                kept.push(PathBuf::from(root));
            }
        }
    }
    if !kept.is_empty() {
        return kept;
    }
    let mut roots = vec![default_workflows_defs_root()];
    if let Some(install_root) = install_root {
        roots.push(node_join(&[path_text(install_root).as_str(), "workflows"]));
    }
    roots
}

pub fn is_workflow_allowed(workflow_id: &str, allowlist: Option<&[String]>) -> bool {
    let Some(allowlist) = allowlist else {
        return false;
    };
    if allowlist.is_empty() {
        return false;
    }
    if allowlist.iter().any(|entry| entry == "*") {
        return true;
    }
    allowlist.iter().any(|entry| entry == workflow_id)
}

pub fn edit_path_for_def_dir(abs_dir: &str, files_root: Option<&str>) -> Option<String> {
    let files_root = files_root?;
    if js_trim(files_root).is_empty() {
        return None;
    }
    let root = normalize_posix(strip_trailing_slashes(files_root));
    let dir = normalize_posix(strip_trailing_slashes(abs_dir));
    if root.is_empty() || root == "." || dir.is_empty() || dir == "." {
        return None;
    }
    if dir == root {
        return Some(String::new());
    }
    let prefix = format!("{root}/");
    let rel = dir.strip_prefix(&prefix)?;
    if rel.is_empty() || rel.starts_with("..") || rel.contains("/../") {
        return None;
    }
    Some(rel.replace('\\', "/"))
}
