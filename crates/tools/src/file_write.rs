use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::context::{ToolContext, ToolSurface};
use crate::fsutil::map_file_err;
use crate::pathutil::resolve_user_path;
use crate::schema::{schema_of, set_property_description};
use crate::{Tool, text};

const AGENT_DESCRIPTION: &str = "Write content to a file. Creates parent directories if needed.";
const SIDECAR_DESCRIPTION: &str = "Write content to a file. Creates parent directories if needed. Optional `backup: true` writes a `.bak` copy of the previous content before overwriting. Mirrors the in-process `file_write` tool.";

pub struct FileWriteTool {
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct FileWriteParams {
    path: String,
    content: String,
    backup: Option<bool>,
}

impl FileWriteTool {
    pub fn new() -> Self {
        Self {
            surface: ToolSurface::Agent,
        }
    }

    pub fn sidecar() -> Self {
        Self {
            surface: ToolSurface::Sidecar,
        }
    }
}

impl Default for FileWriteTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Tool for FileWriteTool {
    fn name(&self) -> &'static str {
        "file_write"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(FileWriteParams {
            path,
            content,
            backup
        });
        let mut schema = schema_of::<FileWriteParams>();
        let path = match self.surface {
            ToolSurface::Agent => "File path (absolute or relative to working directory)",
            ToolSurface::Sidecar => "File path (absolute or relative to MCP server cwd)",
        };
        set_property_description(&mut schema, "path", path);
        set_property_description(&mut schema, "content", "Content to write");
        set_property_description(
            &mut schema,
            "backup",
            "Create .bak backup if file exists (default: false)",
        );
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        context: &ToolContext,
    ) -> protocol::ToolResult {
        let file_path = string(&args, "path").unwrap_or("");
        if file_path.is_empty() {
            return text("Error: No file path provided");
        }
        let content = string(&args, "content").unwrap_or("");
        let backup = args::bool_true(&args, "backup");
        let resolved = resolve_user_path(file_path, context);
        let parent = resolved.parent().unwrap_or(std::path::Path::new("."));
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            return text(map_file_err(&err, &resolved, false));
        }
        let existed = tokio::fs::metadata(&resolved).await.is_ok();
        if backup && existed {
            let bak = format!("{}.bak", resolved.display());
            if let Err(err) = tokio::fs::copy(&resolved, &bak).await {
                return text(map_file_err(&err, &resolved, false));
            }
        }
        if let Err(err) = tokio::fs::write(&resolved, content).await {
            return text(map_file_err(&err, &resolved, false));
        }
        let bytes = content.len();
        let action = if existed { "Updated" } else { "Created" };
        let backup_note = if backup && existed {
            " (backup saved as .bak)"
        } else {
            ""
        };
        text(format!(
            "{action} {} ({bytes} bytes){backup_note}",
            resolved.display()
        ))
    }
}
