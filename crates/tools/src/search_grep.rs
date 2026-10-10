use std::path::Path;
use std::time::Duration;

use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::command::run_shell;
use crate::context::{ToolContext, ToolSurface};
use crate::pathutil::resolve_user_path;
use crate::schema::{schema_of, set_property_description};
use crate::textutil::js_trim;
use crate::{Tool, text};

const DEFAULT_MAX_RESULTS: usize = 100;
const DEFAULT_EXCLUDE: &[&str] = &["node_modules", ".git", "dist", "build", ".next", "coverage"];

const AGENT_DESCRIPTION: &str = "Search file contents by regex or string pattern. Returns matching lines with file paths and line numbers.";
const SIDECAR_DESCRIPTION: &str = "Search file contents by regex or literal string. Returns matching lines with `file:line:match` format. Shells out to grep -rn. Mirrors the in-process `search_grep` tool.";

#[derive(Debug, Clone)]
pub struct SearchGrepConfig {
    pub max_results: usize,
    pub exclude_dirs: Option<Vec<String>>,
    pub surface: ToolSurface,
}

impl Default for SearchGrepConfig {
    fn default() -> Self {
        Self {
            max_results: DEFAULT_MAX_RESULTS,
            exclude_dirs: None,
            surface: ToolSurface::Agent,
        }
    }
}

pub struct SearchGrepTool {
    max_results: usize,
    exclude_dirs: Vec<String>,
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct SearchGrepParams {
    pattern: String,
    path: Option<String>,
    include: Option<String>,
    fixed_strings: Option<bool>,
    case_insensitive: Option<bool>,
}

impl SearchGrepTool {
    pub fn new(config: SearchGrepConfig) -> Self {
        let exclude_dirs = config.exclude_dirs.unwrap_or_else(|| {
            DEFAULT_EXCLUDE
                .iter()
                .map(|item| (*item).to_string())
                .collect()
        });
        Self {
            max_results: config.max_results,
            exclude_dirs,
            surface: config.surface,
        }
    }

    pub fn sidecar(mut config: SearchGrepConfig) -> Self {
        config.surface = ToolSurface::Sidecar;
        Self::new(config)
    }
}

#[async_trait::async_trait]
impl Tool for SearchGrepTool {
    fn name(&self) -> &'static str {
        "search_grep"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(SearchGrepParams {
            pattern,
            path,
            include,
            fixed_strings,
            case_insensitive
        });
        let mut schema = schema_of::<SearchGrepParams>();
        let pattern = match self.surface {
            ToolSurface::Agent => "Search pattern (regex supported)",
            ToolSurface::Sidecar => "Search pattern (regex supported by default)",
        };
        let path = match self.surface {
            ToolSurface::Agent => "Directory or file to search (defaults to working directory)",
            ToolSurface::Sidecar => "Directory or file to search (defaults to MCP server cwd)",
        };
        set_property_description(&mut schema, "pattern", pattern);
        set_property_description(&mut schema, "path", path);
        set_property_description(
            &mut schema,
            "include",
            "File pattern to include (e.g. \"*.ts\")",
        );
        set_property_description(
            &mut schema,
            "fixed_strings",
            "Treat pattern as literal string, not regex (default: false)",
        );
        set_property_description(
            &mut schema,
            "case_insensitive",
            "Case-insensitive search (default: false)",
        );
        schema
    }

    async fn execute(
        &self,
        args: Value,
        cancellation: &CancellationToken,
        context: &ToolContext,
    ) -> protocol::ToolResult {
        let pattern = string(&args, "pattern").unwrap_or("");
        if pattern.is_empty() {
            return text("Error: No search pattern provided");
        }
        let search_path = match string(&args, "path") {
            Some(path) => resolve_user_path(path, context),
            None => context.base_dir(),
        };
        let fixed = args::bool_true(&args, "fixed_strings");
        let case_insensitive = args::bool_true(&args, "case_insensitive");
        let include = string(&args, "include");
        let command = grep_command(
            pattern,
            &search_path,
            self.max_results,
            fixed,
            case_insensitive,
            include,
            &self.exclude_dirs,
        );
        let cwd = std::env::current_dir().unwrap_or_else(|_| Path::new("/").to_path_buf());
        let output = run_shell(
            &command,
            &cwd,
            Duration::from_secs(30),
            1024 * 1024,
            cancellation,
        )
        .await;
        if output.aborted {
            return text("Search aborted");
        }
        if let Some(error) = output.error {
            return text(format!("Error: {error}"));
        }
        if output.timed_out {
            return text("Error: Command timed out");
        }
        let body = js_trim(&output.stdout).to_string();
        if body.is_empty() {
            return text(format!(
                "No matches for \"{pattern}\" in {}",
                search_path.display()
            ));
        }
        if let Some(code) = output.code.filter(|code| *code > 1) {
            let stderr = js_trim(&output.stderr);
            let message = if stderr.is_empty() {
                format!("grep exited with code {code}")
            } else {
                stderr.to_string()
            };
            return text(format!("Error: {message}"));
        }
        let lines = body.split('\n').count();
        if lines >= self.max_results {
            text(format!(
                "{body}\n\n[{}+ matches, results truncated]",
                self.max_results
            ))
        } else {
            text(body)
        }
    }
}

fn grep_command(
    pattern: &str,
    search_path: &Path,
    max_results: usize,
    fixed: bool,
    case_insensitive: bool,
    include: Option<&str>,
    exclude_dirs: &[String],
) -> String {
    let mut parts = vec![
        "grep".to_string(),
        "-rn".to_string(),
        "--color=never".to_string(),
        format!("-m {max_results}"),
    ];
    if fixed {
        parts.push("-F".to_string());
    }
    if case_insensitive {
        parts.push("-i".to_string());
    }
    if let Some(include) = include {
        parts.push(format!("--include={}", shell_escape(include)));
    }
    for dir in exclude_dirs {
        parts.push(format!("--exclude-dir={}", shell_escape(dir)));
    }
    parts.push("--".to_string());
    parts.push(shell_escape(pattern));
    parts.push(shell_escape(&search_path.display().to_string()));
    parts.join(" ")
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}
