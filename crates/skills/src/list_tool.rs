use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde_json::Value;

use crate::helpers::{ALLOWED_SUBDIRS, list_subdir, read_meta};
use crate::manager::SkillManager;
use crate::text;
use tools::{CancellationToken, Tool, ToolContext, ToolSurface};

const AGENT_DESCRIPTION: &str = "List all available skills with their names and descriptions.";

const SIDECAR_DESCRIPTION: &str = "List all available RivetOS skills with their names and descriptions. Skills are reusable knowledge/workflow definitions discovered from the configured skill directories. Mirrors the in-process `skill_list` tool exposed to local agents.";

pub struct SkillListTool {
    manager: SkillManager,
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct SkillListParams {}

impl SkillListTool {
    pub fn new(manager: SkillManager) -> Self {
        Self {
            manager,
            surface: ToolSurface::Agent,
        }
    }

    pub fn surface(mut self, surface: ToolSurface) -> Self {
        self.surface = surface;
        self
    }
}

#[async_trait::async_trait]
impl Tool for SkillListTool {
    fn name(&self) -> &'static str {
        "skill_list"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
            ToolSurface::Agent => AGENT_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        let _params = SkillListParams {};
        let mut schema = tools::schema_of::<SkillListParams>();
        if let Some(object) = schema.as_object_mut() {
            object.insert("type".to_string(), Value::String("object".to_string()));
            object
                .entry("properties")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
        }
        schema
    }

    async fn execute(
        &self,
        _args: Value,
        _cancellation: &CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let skills = self.manager.list();
        if skills.is_empty() {
            return text("No skills discovered.");
        }
        let mut lines = Vec::new();
        for skill in skills {
            let skill_dir = node_dirname(Path::new(&skill.location));
            let version = read_meta(&skill_dir).await.map(|meta| meta.version);
            let mut file_count = 0usize;
            for subdir in ALLOWED_SUBDIRS {
                file_count += list_subdir(&skill_dir, subdir).await.len();
            }
            let mut parts = Vec::new();
            if let Some(version) = version {
                parts.push(format!("v{version}"));
            }
            if file_count > 0 {
                let label = if file_count > 1 { "files" } else { "file" };
                parts.push(format!("{file_count} {label}"));
            }
            let suffix = if parts.is_empty() {
                String::new()
            } else {
                format!(" [{}]", parts.join(", "))
            };
            lines.push(format!(
                "**{}** — {}{suffix}",
                skill.name, skill.description
            ));
        }
        text(lines.join("\n"))
    }
}

pub(crate) fn node_dirname(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        Some(_) if path.has_root() => PathBuf::from("/"),
        _ => PathBuf::from("."),
    }
}
