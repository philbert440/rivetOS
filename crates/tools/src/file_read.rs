use std::path::PathBuf;

use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::context::{ToolContext, ToolSurface};
use crate::fsutil::{js_to_fixed, map_file_err};
use crate::pathutil::resolve_user_path;
use crate::schema::{schema_of, set_property_description};
use crate::{Tool, text};

const DEFAULT_MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
const BINARY_CHECK_SIZE: usize = 8192;

const AGENT_DESCRIPTION: &str = "Read file contents. Returns text with optional line numbers.";
const SIDECAR_DESCRIPTION: &str = "Read file contents. Returns text with optional line numbers and an optional line range. Binary files are detected and refused. Mirrors the in-process `file_read` tool.";

#[derive(Debug, Clone)]
pub struct FileReadConfig {
    pub max_file_size: u64,
    pub default_line_numbers: bool,
    pub surface: ToolSurface,
}

impl Default for FileReadConfig {
    fn default() -> Self {
        Self {
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            default_line_numbers: true,
            surface: ToolSurface::Agent,
        }
    }
}

pub struct FileReadTool {
    max_file_size: u64,
    default_line_numbers: bool,
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct FileReadParams {
    path: String,
    start_line: Option<f64>,
    end_line: Option<f64>,
    line_numbers: Option<bool>,
}

impl FileReadTool {
    pub fn new(config: FileReadConfig) -> Self {
        Self {
            max_file_size: config.max_file_size,
            default_line_numbers: config.default_line_numbers,
            surface: config.surface,
        }
    }

    pub fn sidecar(mut config: FileReadConfig) -> Self {
        config.surface = ToolSurface::Sidecar;
        Self::new(config)
    }
}

#[async_trait::async_trait]
impl Tool for FileReadTool {
    fn name(&self) -> &'static str {
        "file_read"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(FileReadParams {
            path,
            start_line,
            end_line,
            line_numbers
        });
        let mut schema = schema_of::<FileReadParams>();
        let path = match self.surface {
            ToolSurface::Agent => "File path (absolute or relative to working directory)",
            ToolSurface::Sidecar => "File path (absolute or relative to MCP server cwd)",
        };
        set_property_description(&mut schema, "path", path);
        set_property_description(&mut schema, "start_line", "First line to read (1-indexed)");
        set_property_description(
            &mut schema,
            "end_line",
            "Last line to read (1-indexed, inclusive)",
        );
        set_property_description(
            &mut schema,
            "line_numbers",
            "Show line numbers (default: true)",
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
        let resolved = resolve_user_path(file_path, context);
        let show_line_numbers =
            args::bool_opt(&args, "line_numbers").unwrap_or(self.default_line_numbers);
        let start_line = args::finite_number(&args, "start_line");
        let end_line = args::finite_number(&args, "end_line");
        match read_text(
            &resolved,
            self.max_file_size,
            show_line_numbers,
            start_line,
            end_line,
        )
        .await
        {
            Ok(body) => text(body),
            Err(err) => text(err),
        }
    }
}

async fn read_text(
    resolved: &PathBuf,
    max_file_size: u64,
    show_line_numbers: bool,
    start_line: Option<f64>,
    end_line: Option<f64>,
) -> Result<String, String> {
    let meta = tokio::fs::metadata(resolved)
        .await
        .map_err(|err| map_file_err(&err, resolved, true))?;
    if meta.is_dir() {
        return Err(format!(
            "Error: Path is a directory: {}",
            resolved.display()
        ));
    }
    if meta.len() > max_file_size {
        let size_mb = js_to_fixed(meta.len() as f64 / (1024.0 * 1024.0), 1);
        let max_mb = js_to_fixed(max_file_size as f64 / (1024.0 * 1024.0), 1);
        return Err(format!(
            "Error: File is {size_mb}MB, exceeds {max_mb}MB limit"
        ));
    }
    let buffer = tokio::fs::read(resolved)
        .await
        .map_err(|err| map_file_err(&err, resolved, true))?;
    if is_binary(&buffer) {
        return Ok(format!(
            "Binary file detected ({} bytes). Cannot display as text.",
            meta.len()
        ));
    }
    let content = String::from_utf8_lossy(&buffer);
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let total_lines = lines.len();
    if total_lines == 0 {
        return Ok(String::new());
    }
    let start = line_bound(start_line, 1, total_lines, true);
    let end = line_bound(end_line, total_lines, total_lines, false);
    if start > total_lines {
        return Err(format!(
            "Error: start_line {start} exceeds file length ({total_lines} lines)"
        ));
    }
    let end = end.max(start.saturating_sub(1));
    let sliced = if start == 0 {
        &[]
    } else {
        let from = start - 1;
        let to = end.min(total_lines);
        if from >= lines.len() || from >= to {
            &[]
        } else {
            &lines[from..to]
        }
    };
    if !show_line_numbers {
        return Ok(sliced.join("\n"));
    }
    let width = end.to_string().len();
    let formatted = sliced
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let num = start + index;
            format!("{num:>width$} | {line}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(formatted)
}

fn line_bound(value: Option<f64>, fallback: usize, total: usize, is_start: bool) -> usize {
    let Some(value) = value else {
        return fallback;
    };
    if value == 0.0 || !value.is_finite() {
        return fallback;
    }
    let truncated = value.trunc() as i64;
    if is_start {
        truncated.max(1) as usize
    } else {
        (truncated.max(0) as usize).min(total)
    }
}

fn is_binary(buffer: &[u8]) -> bool {
    buffer.iter().take(BINARY_CHECK_SIZE).any(|byte| *byte == 0)
}
