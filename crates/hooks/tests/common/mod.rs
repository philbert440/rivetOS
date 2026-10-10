use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use hooks::{
    AuditEntry, AuditError, AuditWriter, BoxFuture, FileError, FileWriter, HookContext,
    HookHandler, HookLogger, HookSignal, ShellError, ShellExecutor, ShellOutput,
};
use serde_json::{Map, Value};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn calls() -> Arc<Mutex<Vec<String>>> {
    Arc::new(Mutex::new(Vec::new()))
}

pub fn push_call(calls: &Arc<Mutex<Vec<String>>>, label: &str) -> HookHandler {
    let calls = Arc::clone(calls);
    let label = label.to_string();
    HookHandler::from_sync(move |_| {
        calls
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(label.clone());
        Ok(HookSignal::Continue)
    })
}

pub fn provider_before() -> HookContext {
    HookContext::provider_before("google", "gemini-2.5-pro", Vec::new())
}

pub fn tool_before(name: &str, args: Value) -> HookContext {
    HookContext::tool_before(name, object(args))
}

pub fn tool_after(name: &str, args: Value, is_error: bool) -> HookContext {
    tool_after_duration(name, args, 10, is_error)
}

pub fn tool_after_duration(
    name: &str,
    args: Value,
    duration_ms: i64,
    is_error: bool,
) -> HookContext {
    HookContext::tool_after(
        name,
        object(args),
        hooks::ToolResult::Text("ok".to_string()),
        duration_ms,
        is_error,
    )
}

fn object(args: Value) -> Map<String, Value> {
    match args {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub struct CaptureLog {
    pub lines: Mutex<Vec<(String, String)>>,
}

impl CaptureLog {
    pub fn new() -> Self {
        Self {
            lines: Mutex::new(Vec::new()),
        }
    }

    pub fn messages(&self, level: &str) -> Vec<String> {
        self.lines
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .filter(|(kind, _)| kind == level)
            .map(|(_, message)| message.clone())
            .collect()
    }
}

impl HookLogger for CaptureLog {
    fn debug(&self, message: &str) {
        self.push("debug", message);
    }

    fn warn(&self, message: &str) {
        self.push("warn", message);
    }

    fn error(&self, message: &str) {
        self.push("error", message);
    }
}

impl CaptureLog {
    fn push(&self, level: &str, message: &str) {
        self.lines
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push((level.to_string(), message.to_string()));
    }
}

pub struct MemAudit {
    pub entries: Mutex<Vec<AuditEntry>>,
    pub fail: Mutex<Option<String>>,
}

impl MemAudit {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            fail: Mutex::new(None),
        }
    }
}

impl AuditWriter for MemAudit {
    fn write<'a>(&'a self, entry: &'a AuditEntry) -> BoxFuture<'a, Result<(), AuditError>> {
        let entry = entry.clone();
        Box::pin(async move {
            if let Some(message) = self
                .fail
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone()
            {
                return Err(AuditError::new(message));
            }
            self.entries
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push(entry);
            Ok(())
        })
    }
}

pub struct ScriptShell {
    pub calls: Mutex<Vec<(String, Option<String>)>>,
    results: Mutex<Vec<Result<ShellOutput, ShellError>>>,
}

impl ScriptShell {
    pub fn sequence(results: Vec<Result<ShellOutput, ShellError>>) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(results),
        })
    }

    pub fn ok(exit_code: i64, stdout: &str, stderr: &str) -> Arc<Self> {
        Self::sequence(vec![Ok(ShellOutput {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
        })])
    }

    pub fn fail(message: &str) -> Arc<Self> {
        Self::sequence(vec![Err(ShellError::new(message))])
    }

    pub fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

impl ShellExecutor for ScriptShell {
    fn exec<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ShellOutput, ShellError>> {
        let command = command.to_string();
        let cwd = cwd.map(str::to_string);
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push((command, cwd));
            let mut results = self.results.lock().unwrap_or_else(|err| err.into_inner());
            if results.is_empty() {
                return Err(ShellError::new("script exhausted"));
            }
            results.remove(0)
        })
    }
}

pub struct ScriptFiles {
    pub reads: Mutex<Vec<Result<Option<String>, FileError>>>,
    pub appends: Mutex<Vec<(String, String)>>,
    pub writes: Mutex<Vec<(String, String)>>,
    pub fail_append: Mutex<Option<String>>,
}

impl ScriptFiles {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            reads: Mutex::new(Vec::new()),
            appends: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            fail_append: Mutex::new(None),
        })
    }

    pub fn appends(&self) -> Vec<(String, String)> {
        self.appends
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

impl FileWriter for ScriptFiles {
    fn write<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), FileError>> {
        let path = path.to_string();
        let content = content.to_string();
        Box::pin(async move {
            self.writes
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push((path, content));
            Ok(())
        })
    }

    fn read<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Result<Option<String>, FileError>> {
        Box::pin(async move {
            let mut reads = self.reads.lock().unwrap_or_else(|err| err.into_inner());
            if reads.is_empty() {
                Ok(None)
            } else {
                reads.remove(0)
            }
        })
    }

    fn append<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), FileError>> {
        let path = path.to_string();
        let content = content.to_string();
        Box::pin(async move {
            if let Some(message) = self
                .fail_append
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone()
            {
                return Err(FileError::new(message));
            }
            self.appends
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push((path, content));
            Ok(())
        })
    }
}

pub fn temp_path() -> PathBuf {
    let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("rr-6h-hooks-{}-{n}", std::process::id()))
}

pub async fn make_temp() -> PathBuf {
    let dir = temp_path();
    tokio::fs::create_dir_all(&dir).await.expect("temp dir");
    dir
}
