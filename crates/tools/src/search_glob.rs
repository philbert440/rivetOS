use std::collections::HashSet;
use std::path::Path;

use globset::{GlobBuilder, GlobMatcher};
use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::string;
use crate::context::{ToolContext, ToolSurface};
use crate::pathutil::resolve_user_path;
use crate::schema::{schema_of, set_property_description};
use crate::{Tool, text};

const DEFAULT_MAX_RESULTS: usize = 200;
const DEFAULT_EXCLUDE: &[&str] = &["node_modules", ".git", "dist", "build", ".next", "coverage"];

const AGENT_DESCRIPTION: &str =
    "Find files matching a glob pattern. Searches from the working directory.";
const SIDECAR_DESCRIPTION: &str = "Find files matching a glob pattern. Searches from the MCP server cwd unless `cwd` is provided. Excludes node_modules, .git, dist, build, .next, coverage by default. Mirrors the in-process `search_glob` tool.";

#[derive(Debug, Clone)]
pub struct SearchGlobConfig {
    pub max_results: usize,
    pub exclude_dirs: Option<Vec<String>>,
    pub surface: ToolSurface,
}

impl Default for SearchGlobConfig {
    fn default() -> Self {
        Self {
            max_results: DEFAULT_MAX_RESULTS,
            exclude_dirs: None,
            surface: ToolSurface::Agent,
        }
    }
}

pub struct SearchGlobTool {
    max_results: usize,
    exclude_dirs: HashSet<String>,
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct SearchGlobParams {
    pattern: String,
    cwd: Option<String>,
}

impl SearchGlobTool {
    pub fn new(config: SearchGlobConfig) -> Self {
        let exclude_dirs = config.exclude_dirs.unwrap_or_else(|| {
            DEFAULT_EXCLUDE
                .iter()
                .map(|item| (*item).to_string())
                .collect()
        });
        Self {
            max_results: config.max_results,
            exclude_dirs: exclude_dirs.into_iter().collect(),
            surface: config.surface,
        }
    }

    pub fn sidecar(mut config: SearchGlobConfig) -> Self {
        config.surface = ToolSurface::Sidecar;
        Self::new(config)
    }
}

#[async_trait::async_trait]
impl Tool for SearchGlobTool {
    fn name(&self) -> &'static str {
        "search_glob"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(SearchGlobParams { pattern, cwd });
        let mut schema = schema_of::<SearchGlobParams>();
        set_property_description(
            &mut schema,
            "pattern",
            "Glob pattern (e.g. \"**/*.ts\", \"src/**/*.test.ts\")",
        );
        let cwd = match self.surface {
            ToolSurface::Agent => {
                "Directory to search from (optional, defaults to working directory)"
            }
            ToolSurface::Sidecar => {
                "Directory to search from (optional, defaults to MCP server cwd)"
            }
        };
        set_property_description(&mut schema, "cwd", cwd);
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        context: &ToolContext,
    ) -> protocol::ToolResult {
        let pattern = string(&args, "pattern").unwrap_or("");
        if pattern.is_empty() {
            return text("Error: No glob pattern provided");
        }
        let search_dir = match string(&args, "cwd") {
            Some(cwd) => resolve_user_path(cwd, context),
            None => context.base_dir(),
        };
        let matcher = match compile_glob(pattern) {
            Ok(matcher) => matcher,
            Err(err) => return text(format!("Error: {err}")),
        };
        match collect(&search_dir, &matcher, &self.exclude_dirs, self.max_results).await {
            Ok(mut results) => {
                if results.is_empty() {
                    return text(format!(
                        "No files matching \"{pattern}\" in {}",
                        search_dir.display()
                    ));
                }
                results.sort();
                let truncated = results.len() >= self.max_results;
                let mark = if truncated { "+" } else { "" };
                text(format!(
                    "Found {}{mark} files:\n{}",
                    results.len(),
                    results.join("\n")
                ))
            }
            Err(err) => text(format!("Error: {err}")),
        }
    }
}

fn compile_glob(pattern: &str) -> Result<GlobMatcher, String> {
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map(|glob| glob.compile_matcher())
        .map_err(|err| err.to_string())
}

async fn collect(
    root: &Path,
    matcher: &GlobMatcher,
    exclude: &HashSet<String>,
    max_results: usize,
) -> Result<Vec<String>, std::io::Error> {
    let mut matched = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir).await?;
        let mut children = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            children.push(entry);
        }
        for entry in children {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = entry.file_type().await?;
            let path = entry.path();
            if file_type.is_dir() {
                if exclude.contains(name.as_ref()) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let is_file = if file_type.is_file() {
                true
            } else if file_type.is_symlink() {
                tokio::fs::metadata(&path)
                    .await
                    .map(|meta| meta.is_file())
                    .unwrap_or(false)
            } else {
                false
            };
            if !is_file || exclude.contains(name.as_ref()) {
                continue;
            }
            let rel = relative_unix(root, &path);
            if matcher.is_match(&rel) {
                matched.push(rel);
                if matched.len() >= max_results {
                    return Ok(matched);
                }
            }
        }
    }
    Ok(matched)
}

fn relative_unix(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
