use std::path::PathBuf;

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
}
