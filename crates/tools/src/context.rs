use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolSurface {
    #[default]
    Agent,
    Sidecar,
}

#[derive(Debug, Clone, Default)]
pub struct ToolContext {
    pub agent_id: Option<String>,
    pub working_dir: Option<PathBuf>,
    pub session_working_dir: Option<PathBuf>,
}

impl ToolContext {
    pub fn with_working_dir(dir: impl Into<PathBuf>) -> Self {
        Self {
            working_dir: Some(dir.into()),
            ..Self::default()
        }
    }

    pub fn base_dir(&self) -> PathBuf {
        if let Some(dir) = &self.session_working_dir {
            return dir.clone();
        }
        if let Some(dir) = &self.working_dir {
            return dir.clone();
        }
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }

    pub(crate) fn resolve_user_path(&self, file_path: &str) -> PathBuf {
        if protocol::js::posix_is_absolute(file_path) {
            return PathBuf::from(file_path);
        }
        resolve_against(&self.base_dir(), file_path)
    }
}

pub(crate) fn resolve_against(base: &Path, target: &str) -> PathBuf {
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());
    let base = base.to_string_lossy();
    PathBuf::from(protocol::js::posix_resolve(&cwd, &[base.as_ref(), target]))
}
