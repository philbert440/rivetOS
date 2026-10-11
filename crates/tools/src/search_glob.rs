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
        let segments = split_pattern(pattern);
        let mut matchers = Vec::with_capacity(segments.len());
        for segment in &segments {
            if segment == "**" {
                matchers.push(None);
                continue;
            }
            match compile_segment(segment) {
                Ok(matcher) => matchers.push(Some(matcher)),
                Err(err) => return text(format!("Error: {err}")),
            }
        }
        match collect(
            &search_dir,
            &segments,
            &matchers,
            &self.exclude_dirs,
            self.max_results,
        )
        .await
        {
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

struct Frame {
    path: std::path::PathBuf,
    rel: String,
    index: usize,
}

fn split_pattern(pattern: &str) -> Vec<String> {
    pattern
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn compile_segment(segment: &str) -> Result<GlobMatcher, String> {
    GlobBuilder::new(segment)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map(|glob| glob.compile_matcher())
        .map_err(|err| err.to_string())
}

async fn collect(
    root: &Path,
    segments: &[String],
    matchers: &[Option<GlobMatcher>],
    exclude: &HashSet<String>,
    max_results: usize,
) -> Result<Vec<String>, std::io::Error> {
    let mut matched = Vec::new();
    let mut stack = vec![Frame {
        path: root.to_path_buf(),
        rel: String::new(),
        index: 0,
    }];
    let mut walk = Walk {
        stack: &mut stack,
        exclude,
        matched: &mut matched,
        max_results,
    };
    while let Some(frame) = walk.stack.pop() {
        if walk.matched.len() >= walk.max_results {
            break;
        }
        if frame.index >= segments.len() {
            continue;
        }
        let segment = &segments[frame.index];
        if segment == "**" {
            push_globstar(&mut walk, &frame, segments).await?;
        } else if let Some(matcher) = matchers.get(frame.index).and_then(Option::as_ref) {
            push_segment(&mut walk, &frame, matcher, segments).await?;
        }
    }
    Ok(matched)
}

struct Walk<'a> {
    stack: &'a mut Vec<Frame>,
    exclude: &'a HashSet<String>,
    matched: &'a mut Vec<String>,
    max_results: usize,
}

async fn push_globstar(
    walk: &mut Walk<'_>,
    frame: &Frame,
    segments: &[String],
) -> Result<(), std::io::Error> {
    let entries = read_entries(&frame.path).await?;
    let last = frame.index + 1 == segments.len();
    let later_dot = segments[frame.index + 1..]
        .iter()
        .any(|segment| segment.starts_with('.'));
    let mut descents = Vec::new();
    for entry in &entries {
        if walk.matched.len() >= walk.max_results {
            break;
        }
        let name = entry_name(entry);
        if walk.exclude.contains(&name) {
            continue;
        }
        if name.starts_with('.') && !later_dot {
            continue;
        }
        let file_type = entry.file_type().await?;
        let rel = join_rel(&frame.rel, &name);
        if last {
            walk.matched.push(rel.clone());
        }
        if file_type.is_dir() {
            descents.push(Frame {
                path: entry.path(),
                rel,
                index: frame.index,
            });
        }
    }
    for descent in descents.into_iter().rev() {
        walk.stack.push(descent);
    }
    if !last {
        walk.stack.push(Frame {
            path: frame.path.clone(),
            rel: frame.rel.clone(),
            index: frame.index + 1,
        });
    }
    Ok(())
}

async fn push_segment(
    walk: &mut Walk<'_>,
    frame: &Frame,
    matcher: &GlobMatcher,
    segments: &[String],
) -> Result<(), std::io::Error> {
    let entries = read_entries(&frame.path).await?;
    let last = frame.index + 1 == segments.len();
    let segment = &segments[frame.index];
    let mut descents = Vec::new();
    for entry in entries {
        if walk.matched.len() >= walk.max_results {
            break;
        }
        let name = entry_name(&entry);
        if walk.exclude.contains(&name) {
            continue;
        }
        if name.starts_with('.') && !segment.starts_with('.') {
            continue;
        }
        if !matcher.is_match(name.as_str()) {
            continue;
        }
        let rel = join_rel(&frame.rel, &name);
        let file_type = entry.file_type().await?;
        if last {
            walk.matched.push(rel);
        } else if file_type.is_dir() {
            descents.push(Frame {
                path: entry.path(),
                rel,
                index: frame.index + 1,
            });
        }
    }
    for descent in descents.into_iter().rev() {
        walk.stack.push(descent);
    }
    Ok(())
}

async fn read_entries(path: &Path) -> Result<Vec<tokio::fs::DirEntry>, std::io::Error> {
    let mut entries = Vec::new();
    let mut read = tokio::fs::read_dir(path).await?;
    while let Some(entry) = read.next_entry().await? {
        entries.push(entry);
    }
    Ok(entries)
}

fn entry_name(entry: &tokio::fs::DirEntry) -> String {
    entry.file_name().to_string_lossy().into_owned()
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}
