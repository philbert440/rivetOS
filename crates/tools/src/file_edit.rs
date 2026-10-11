use std::path::Path;

use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::string;
use crate::context::{ToolContext, ToolSurface};
use crate::fsutil::edit_write_error;
use crate::schema::{schema_of, set_property_description};
use crate::textutil::js_replace_once;
use crate::{Tool, text};

const CONTEXT_LINES: usize = 3;
const AGENT_DESCRIPTION: &str = "Edit a file by replacing an exact string match. Fails if old_string is not found or matches multiple times.";
const SIDECAR_DESCRIPTION: &str = "Edit a file by replacing an exact string match. Fails if `old_string` is not found or matches multiple times — caller must add surrounding context to disambiguate. Mirrors the in-process `file_edit` tool.";

pub struct FileEditTool {
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct FileEditParams {
    path: String,
    old_string: String,
    new_string: String,
}

impl FileEditTool {
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

impl Default for FileEditTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Tool for FileEditTool {
    fn name(&self) -> &'static str {
        "file_edit"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(FileEditParams {
            path,
            old_string,
            new_string
        });
        let mut schema = schema_of::<FileEditParams>();
        let path = match self.surface {
            ToolSurface::Agent => "File path (absolute or relative to working directory)",
            ToolSurface::Sidecar => "File path (absolute or relative to MCP server cwd)",
        };
        let old_string = match self.surface {
            ToolSurface::Agent => "Exact string to find (must match exactly once)",
            ToolSurface::Sidecar => "Exact string to find — must match exactly once in the file",
        };
        set_property_description(&mut schema, "path", path);
        set_property_description(&mut schema, "old_string", old_string);
        set_property_description(&mut schema, "new_string", "Replacement string");
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        context: &ToolContext,
    ) -> protocol::ToolResult {
        let file_path = string(&args, "path").unwrap_or("");
        let old_string = string(&args, "old_string").unwrap_or("");
        let new_string = string(&args, "new_string").unwrap_or("");
        if file_path.is_empty() {
            return text("Error: No file path provided");
        }
        if old_string.is_empty() {
            return text("Error: old_string cannot be empty");
        }
        let resolved = context.resolve_user_path(file_path);
        let content = match read_edit_file(&resolved).await {
            Ok(content) => content,
            Err(message) => return text(message),
        };
        let count = count_overlapping(&content, old_string);
        if count == 0 {
            return text("Error: old_string not found in file");
        }
        if count > 1 {
            return text(format!(
                "Error: old_string matches {count} times — be more specific"
            ));
        }
        let updated = js_replace_once(&content, old_string, new_string);
        if let Err(err) = tokio::fs::write(&resolved, &updated).await {
            return text(edit_write_error(&err, &resolved));
        }
        let snippet = edit_snippet(&updated, new_string, CONTEXT_LINES);
        text(format!("Edited {}\n\n{snippet}", resolved.display()))
    }
}

async fn read_edit_file(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    let reported = path.clone();
    match tokio::task::spawn_blocking(move || protocol::host::read_text(&path)).await {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(err)) => Err(map_edit_read(&err, &reported)),
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn map_edit_read(err: &protocol::host::FsError, path: &Path) -> String {
    match err.code {
        "ENOENT" => format!("Error: File not found: {}", path.display()),
        "EACCES" => format!("Error: Permission denied: {}", path.display()),
        _ => err.node_string(),
    }
}

fn count_overlapping(content: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut rest = content;
    while let Some(found) = rest.find(needle) {
        count += 1;
        let step = rest[found..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
        let next = found + step;
        if next > rest.len() {
            break;
        }
        rest = &rest[next..];
    }
    count
}

fn edit_snippet(content: &str, new_string: &str, context_lines: usize) -> String {
    let Some(insert_idx) = content.find(new_string) else {
        return "(edit applied)".to_string();
    };
    let lines: Vec<&str> = content.split('\n').collect();
    let new_lines = new_string.split('\n').count();
    let lines_before = content[..insert_idx].split('\n').count();
    let start_line = lines_before;
    let end_line = start_line + new_lines - 1;
    let snippet_start = start_line.saturating_sub(1).saturating_sub(context_lines);
    let snippet_end = (end_line + context_lines).min(lines.len());
    let width = snippet_end.to_string().len();
    lines[snippet_start..snippet_end]
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let num = snippet_start + index + 1;
            format!("{num:>width$} | {line}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}
