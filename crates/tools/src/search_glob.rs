use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

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
const DEFAULT_WALK_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_EXCLUDE: &[&str] = &["node_modules", ".git", "dist", "build", ".next", "coverage"];

const AGENT_DESCRIPTION: &str =
    "Find files matching a glob pattern. Searches from the working directory.";
const SIDECAR_DESCRIPTION: &str = "Find files matching a glob pattern. Searches from the MCP server cwd unless `cwd` is provided. Excludes node_modules, .git, dist, build, .next, coverage by default. Mirrors the in-process `search_glob` tool.";

#[derive(Debug, Clone)]
pub struct SearchGlobConfig {
    pub max_results: usize,
    pub exclude_dirs: Option<Vec<String>>,
    pub surface: ToolSurface,
    pub walk_timeout: Duration,
}

impl Default for SearchGlobConfig {
    fn default() -> Self {
        Self {
            max_results: DEFAULT_MAX_RESULTS,
            exclude_dirs: None,
            surface: ToolSurface::Agent,
            walk_timeout: DEFAULT_WALK_TIMEOUT,
        }
    }
}

pub struct SearchGlobTool {
    max_results: usize,
    exclude_dirs: HashSet<String>,
    surface: ToolSurface,
    walk_timeout: Duration,
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
            walk_timeout: config.walk_timeout,
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
        cancellation: &CancellationToken,
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
        let (absolute, segments) = normalize_segments(pattern);
        let (start, prefix, segments) = anchor(&search_dir, absolute, segments);
        if segments.is_empty() {
            return text(format!(
                "No files matching \"{pattern}\" in {}",
                search_dir.display()
            ));
        }
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
        let deadline = tokio::time::Instant::now() + self.walk_timeout;
        let plan = Plan {
            start: &start,
            prefix: &prefix,
            absolute,
            segments: &segments,
            matchers: &matchers,
            exclude: &self.exclude_dirs,
            max_results: self.max_results,
            cancellation,
            deadline,
        };
        match bounded(cancellation, deadline, collect(&plan)).await {
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
    path: PathBuf,
    rel: String,
    index: usize,
}

struct Plan<'a> {
    start: &'a Path,
    prefix: &'a str,
    absolute: bool,
    segments: &'a [String],
    matchers: &'a [Option<GlobMatcher>],
    exclude: &'a HashSet<String>,
    max_results: usize,
    cancellation: &'a CancellationToken,
    deadline: tokio::time::Instant,
}

struct Walk<'a> {
    stack: &'a mut Vec<Frame>,
    exclude: &'a HashSet<String>,
    matched: &'a mut Vec<String>,
    segments: &'a [String],
    matchers: &'a [Option<GlobMatcher>],
    max_results: usize,
    cancellation: &'a CancellationToken,
    deadline: tokio::time::Instant,
    absolute: bool,
}

fn is_pattern_magic(segment: &str) -> bool {
    segment.contains(['*', '?', '[', '{'])
}

fn normalize_segments(pattern: &str) -> (bool, Vec<String>) {
    let absolute = pattern.starts_with('/');
    let mut segments: Vec<String> = Vec::new();
    for segment in pattern.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            let collapse = segments
                .last()
                .is_some_and(|prev| !is_pattern_magic(prev) && prev != "..");
            if collapse {
                segments.pop();
                continue;
            }
            if absolute && segments.is_empty() {
                continue;
            }
            segments.push("..".to_string());
            continue;
        }
        segments.push(segment.to_string());
    }
    (absolute, segments)
}

fn anchor(cwd: &Path, absolute: bool, mut segments: Vec<String>) -> (PathBuf, String, Vec<String>) {
    let mut ups = 0usize;
    if !absolute {
        while segments.first().is_some_and(|segment| segment == "..") {
            segments.remove(0);
            ups += 1;
        }
    }
    let mut start = if absolute {
        PathBuf::from("/")
    } else {
        cwd.to_path_buf()
    };
    let mut parts = Vec::new();
    for _ in 0..ups {
        start.pop();
        parts.push("..".to_string());
    }
    if absolute {
        let mut keep = 0usize;
        while keep + 1 < segments.len() && !is_pattern_magic(&segments[keep]) {
            keep += 1;
        }
        for segment in segments.drain(..keep) {
            start.push(&segment);
            parts.push(segment);
        }
    }
    let prefix = if absolute {
        if parts.is_empty() {
            String::new()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else {
        parts.join("/")
    };
    (start, prefix, segments)
}

fn compile_segment(segment: &str) -> Result<GlobMatcher, String> {
    GlobBuilder::new(segment)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map(|glob| glob.compile_matcher())
        .map_err(|err| err.to_string())
}

async fn collect(plan: &Plan<'_>) -> Result<Vec<String>, std::io::Error> {
    if plan.segments.is_empty() {
        return Ok(Vec::new());
    }
    if plan.absolute {
        match bounded(
            plan.cancellation,
            plan.deadline,
            tokio::fs::metadata(plan.start),
        )
        .await
        {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        }
    }
    let mut matched = Vec::new();
    let mut stack = vec![Frame {
        path: plan.start.to_path_buf(),
        rel: plan.prefix.to_string(),
        index: 0,
    }];
    let mut walk = Walk {
        stack: &mut stack,
        exclude: plan.exclude,
        matched: &mut matched,
        segments: plan.segments,
        matchers: plan.matchers,
        max_results: plan.max_results,
        cancellation: plan.cancellation,
        deadline: plan.deadline,
        absolute: plan.absolute,
    };
    while let Some(frame) = walk.stack.pop() {
        check_limits(walk.cancellation, walk.deadline)?;
        if walk.matched.len() >= walk.max_results {
            break;
        }
        if frame.index >= walk.segments.len() {
            continue;
        }
        if walk.segments[frame.index] == "**" {
            push_globstar(&mut walk, &frame).await?;
        } else if walk
            .matchers
            .get(frame.index)
            .and_then(Option::as_ref)
            .is_some()
        {
            push_segment(&mut walk, &frame).await?;
        }
    }
    Ok(matched)
}

fn check_limits(
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<(), std::io::Error> {
    if cancellation.is_cancelled() {
        Err(aborted_error())
    } else if tokio::time::Instant::now() >= deadline {
        Err(timed_out_error())
    } else {
        Ok(())
    }
}

fn aborted_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "glob walk aborted")
}

fn timed_out_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "glob walk timed out")
}

async fn bounded<T>(
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
    op: impl std::future::Future<Output = Result<T, std::io::Error>>,
) -> Result<T, std::io::Error> {
    check_limits(cancellation, deadline)?;
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(aborted_error()),
        _ = tokio::time::sleep_until(deadline) => Err(timed_out_error()),
        result = op => result,
    }
}

fn remember(walk: &mut Walk<'_>, rel: String) {
    if rel.is_empty() {
        return;
    }
    if walk.absolute && !rel.starts_with('/') {
        walk.matched.push(format!("/{rel}"));
    } else {
        walk.matched.push(rel);
    }
}

async fn push_globstar(walk: &mut Walk<'_>, frame: &Frame) -> Result<(), std::io::Error> {
    let entries = read_entries(&frame.path, walk.cancellation, walk.deadline).await?;
    check_limits(walk.cancellation, walk.deadline)?;
    let last = frame.index + 1 == walk.segments.len();
    let later_dot = walk.segments[frame.index + 1..]
        .iter()
        .any(|segment| segment.starts_with('.'));
    let mut descents = Vec::new();
    for entry in &entries {
        check_limits(walk.cancellation, walk.deadline)?;
        if walk.matched.len() >= walk.max_results {
            break;
        }
        let name = entry_name(entry);
        if is_dot_dir(&entry.file_name()) || walk.exclude.contains(&name) {
            continue;
        }
        if name.starts_with('.') && !later_dot {
            continue;
        }
        let file_type = bounded(walk.cancellation, walk.deadline, entry.file_type()).await?;
        let rel = join_rel(&frame.rel, &name);
        if last {
            remember(walk, rel.clone());
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

async fn push_segment(walk: &mut Walk<'_>, frame: &Frame) -> Result<(), std::io::Error> {
    let entries = read_entries(&frame.path, walk.cancellation, walk.deadline).await?;
    check_limits(walk.cancellation, walk.deadline)?;
    let last = frame.index + 1 == walk.segments.len();
    let allow_dot = walk
        .segments
        .get(frame.index)
        .is_some_and(|segment| segment.starts_with('.'));
    let Some(matcher) = walk.matchers.get(frame.index).cloned().flatten() else {
        return Ok(());
    };
    let mut descents = Vec::new();
    for entry in entries {
        check_limits(walk.cancellation, walk.deadline)?;
        if walk.matched.len() >= walk.max_results {
            break;
        }
        let name = entry_name(&entry);
        if is_dot_dir(&entry.file_name()) || walk.exclude.contains(&name) {
            continue;
        }
        if name.starts_with('.') && !allow_dot {
            continue;
        }
        if !matcher.is_match(name.as_str()) {
            continue;
        }
        let rel = join_rel(&frame.rel, &name);
        let file_type = bounded(walk.cancellation, walk.deadline, entry.file_type()).await?;
        if last {
            remember(walk, rel);
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

async fn read_entries(
    path: &Path,
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<Vec<tokio::fs::DirEntry>, std::io::Error> {
    let mut entries = Vec::new();
    let mut read = bounded(cancellation, deadline, tokio::fs::read_dir(path)).await?;
    loop {
        check_limits(cancellation, deadline)?;
        match bounded(cancellation, deadline, read.next_entry()).await? {
            Some(entry) => {
                if is_dot_dir(&entry.file_name()) {
                    continue;
                }
                entries.push(entry);
            }
            None => break,
        }
    }
    Ok(entries)
}

fn is_dot_dir(name: &OsStr) -> bool {
    name == OsStr::new(".") || name == OsStr::new("..")
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    #[tokio::test]
    async fn bounded_io_times_out_while_the_read_is_pending() {
        let cancellation = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(40);
        let started = std::time::Instant::now();
        let err = bounded(
            &cancellation,
            deadline,
            std::future::pending::<Result<(), std::io::Error>>(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(err.to_string(), "glob walk timed out");
        assert!(started.elapsed() >= Duration::from_millis(20));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn bounded_io_aborts_while_the_read_is_pending() {
        let cancellation = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let err = bounded(
            &cancellation,
            deadline,
            std::future::pending::<Result<(), std::io::Error>>(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(err.to_string(), "glob walk aborted");
        assert!(started.elapsed() >= Duration::from_millis(20));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn bounded_io_does_not_start_after_the_deadline() {
        let cancellation = CancellationToken::new();
        let deadline = tokio::time::Instant::now();
        let started = AtomicBool::new(false);
        let op = async {
            started.store(true, Ordering::SeqCst);
            Ok::<(), std::io::Error>(())
        };
        let err = bounded(&cancellation, deadline, op).await.unwrap_err();
        assert_eq!(err.to_string(), "glob walk timed out");
        assert!(!started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn bounded_io_does_not_start_after_cancel() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let started = AtomicBool::new(false);
        let op = async {
            started.store(true, Ordering::SeqCst);
            Ok::<(), std::io::Error>(())
        };
        let err = bounded(&cancellation, deadline, op).await.unwrap_err();
        assert_eq!(err.to_string(), "glob walk aborted");
        assert!(!started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn bounded_io_returns_a_finished_read() {
        let cancellation = CancellationToken::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let value = bounded(
            &cancellation,
            deadline,
            std::future::ready(Ok::<u8, std::io::Error>(7)),
        )
        .await
        .unwrap();
        assert_eq!(value, 7);
    }
}
