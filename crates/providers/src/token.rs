use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use protocol::js::js_trim;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::now_ms;
use crate::types::{lock, BoxFuture};

pub const DEFAULT_TOKEN_TTL_MS: i64 = 300_000;
pub const DEFAULT_TOKEN_COMMAND_TIMEOUT_MS: u64 = 5_000;
pub const TOKEN_COMMAND_MAX_BUFFER: usize = 64 * 1024;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct TokenError(pub String);

pub type RunnerFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type Runner = Arc<dyn Fn(Vec<String>, u64) -> RunnerFuture + Send + Sync>;

#[derive(Debug, Clone)]
pub enum TokenEntry {
    String(String),
    Other,
}

#[derive(Debug, Clone)]
pub enum TokenCommandInput {
    Null,
    String(String),
    Array(Vec<TokenEntry>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedArgv {
    Unset,
    Invalid(&'static str),
    Argv(Vec<String>),
}

pub fn parse_token_command_argv(raw: Option<TokenCommandInput>) -> ParsedArgv {
    match raw {
        None | Some(TokenCommandInput::Null) => ParsedArgv::Unset,
        Some(TokenCommandInput::String(_)) => {
            ParsedArgv::Invalid("token_command must be an argv array (no shell string)")
        }
        Some(TokenCommandInput::Array(items)) if items.is_empty() => {
            ParsedArgv::Invalid("token_command must be a non-empty argv array")
        }
        Some(TokenCommandInput::Array(items)) => {
            let mut argv = Vec::new();
            for item in items {
                match item {
                    TokenEntry::String(text) if !text.is_empty() => argv.push(text),
                    _ => {
                        return ParsedArgv::Invalid(
                            "token_command argv entries must be non-empty strings",
                        );
                    }
                }
            }
            ParsedArgv::Argv(argv)
        }
    }
}

struct CacheEntry {
    token: String,
    expires_at: i64,
}

struct TokenInner {
    cache: Option<CacheEntry>,
    inflight: Option<futures_util::future::Shared<RunnerFuture>>,
}

pub struct TokenSource {
    argv: Vec<String>,
    ttl_ms: i64,
    timeout_ms: u64,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    run: Runner,
    env: Option<HashMap<String, String>>,
    inner: Mutex<TokenInner>,
}

impl TokenSource {
    pub fn new(argv: Vec<String>) -> Result<Self, TokenError> {
        Self::build(argv, None, None, None, None, None)
    }

    pub fn build(
        argv: Vec<String>,
        ttl_ms: Option<i64>,
        timeout_ms: Option<u64>,
        now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
        run: Option<Runner>,
        env: Option<HashMap<String, String>>,
    ) -> Result<Self, TokenError> {
        if argv.is_empty() || argv[0].is_empty() {
            return Err(TokenError("token_command argv is empty".to_string()));
        }
        let timeout_ms = timeout_ms.unwrap_or(DEFAULT_TOKEN_COMMAND_TIMEOUT_MS);
        let run = run.unwrap_or_else(|| {
            let env = env.clone();
            Arc::new(move |argv, timeout| {
                let env = env.clone();
                Box::pin(async move { default_run_command(&argv, timeout, env).await })
            })
        });
        Ok(Self {
            argv,
            ttl_ms: ttl_ms.unwrap_or(DEFAULT_TOKEN_TTL_MS),
            timeout_ms,
            now: now.unwrap_or_else(|| Arc::new(now_ms)),
            run,
            env,
            inner: Mutex::new(TokenInner {
                cache: None,
                inflight: None,
            }),
        })
    }

    pub async fn get_token(&self) -> Result<String, TokenError> {
        let now = (self.now)();
        let existing = {
            let guard = lock(&self.inner);
            if let Some(cache) = &guard.cache {
                if now < cache.expires_at {
                    return Ok(cache.token.clone());
                }
            }
            guard.inflight.clone()
        };
        if let Some(inflight) = existing {
            return inflight.await.map_err(TokenError);
        }
        let argv = self.argv.clone();
        let timeout_ms = self.timeout_ms;
        let ttl_ms = self.ttl_ms;
        let now_fn = Arc::clone(&self.now);
        let run = Arc::clone(&self.run);
        let shared = {
            let mut guard = lock(&self.inner);
            if let Some(cache) = &guard.cache {
                if (self.now)() < cache.expires_at {
                    return Ok(cache.token.clone());
                }
            }
            if let Some(inflight) = &guard.inflight {
                let inflight = inflight.clone();
                drop(guard);
                return inflight.await.map_err(TokenError);
            }
            let fut: RunnerFuture = Box::pin(async move {
                let stdout = run(argv, timeout_ms).await?;
                let token = js_trim(&stdout).to_string();
                if token.is_empty() {
                    return Err("token_command produced empty stdout".to_string());
                }
                if token.contains('\n') || token.contains('\r') {
                    return Err("token_command stdout must be a single line".to_string());
                }
                Ok(token)
            });
            let shared = fut.shared();
            guard.inflight = Some(shared.clone());
            shared
        };
        let result = shared.await;
        {
            let mut guard = lock(&self.inner);
            if let Ok(token) = &result {
                let stamped = (now_fn)();
                guard.cache = Some(CacheEntry {
                    token: token.clone(),
                    expires_at: stamped + ttl_ms,
                });
            }
            guard.inflight = None;
        }
        result.map_err(TokenError)
    }

    pub fn get_cached_token(&self) -> Option<String> {
        let guard = lock(&self.inner);
        let cache = guard.cache.as_ref()?;
        if (self.now)() >= cache.expires_at {
            None
        } else {
            Some(cache.token.clone())
        }
    }

    pub fn invalidate(&self, rejected: Option<&str>) {
        let mut guard = lock(&self.inner);
        if let Some(rejected) = rejected {
            if let Some(cache) = &guard.cache {
                if cache.token != rejected && (self.now)() < cache.expires_at {
                    return;
                }
            }
        }
        guard.cache = None;
    }

    pub async fn auth_headers(
        &self,
        extra: Vec<(String, String)>,
    ) -> Result<Vec<(String, String)>, TokenError> {
        let token = self.get_token().await?;
        let mut headers = extra;
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        Ok(headers)
    }

    pub fn warm_log(err: &TokenError) -> String {
        format!("token_command warm failed: {}", err.0)
    }
}

pub async fn authorized_call<F, Fut>(
    source: &TokenSource,
    header_name: &str,
    mut call: F,
) -> Result<u16, TokenError>
where
    F: FnMut(&str, &str) -> Fut,
    Fut: Future<Output = u16>,
{
    let token = source.get_token().await?;
    let status = call(header_name, &token).await;
    if status == 401 {
        source.invalidate(Some(&token));
        let next = source.get_token().await?;
        return Ok(call(header_name, &next).await);
    }
    Ok(status)
}

pub async fn default_run_command(
    argv: &[String],
    timeout_ms: u64,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    if argv.is_empty() || argv[0].is_empty() {
        return Err("token_command argv is empty".to_string());
    }
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(env) = env {
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().map_err(|err| {
        let code = if err.kind() == std::io::ErrorKind::NotFound {
            "ENOENT"
        } else {
            "error"
        };
        format!("token_command failed (exit {code})")
    })?;
    let mut stdout = child.stdout.take();
    let read = async {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            let mut tmp = [0u8; 4096];
            loop {
                let n = pipe
                    .read(&mut tmp)
                    .await
                    .map_err(|_| "token_command failed (exit error)".to_string())?;
                if n == 0 {
                    break;
                }
                if buf.len() + n > TOKEN_COMMAND_MAX_BUFFER {
                    return Err("token_command failed (exit error)".to_string());
                }
                buf.extend_from_slice(&tmp[..n]);
            }
        }
        String::from_utf8(buf).map_err(|_| "token_command failed (exit error)".to_string())
    };
    let timeout = Duration::from_millis(timeout_ms);
    let output = tokio::time::timeout(timeout, read).await;
    let status = child
        .wait()
        .await
        .map_err(|_| "token_command failed (exit error)".to_string());
    match output {
        Err(_) => {
            let _ = child.kill().await;
            Err(format!("token_command timed out after {timeout_ms} ms"))
        }
        Ok(Err(err)) => {
            let _ = child.kill().await;
            Err(err)
        }
        Ok(Ok(text)) => match status {
            Ok(status) if status.success() => Ok(text),
            Ok(status) => {
                let code = status.code().map(|code| code.to_string()).unwrap_or_else(|| "error".to_string());
                Err(format!("token_command failed (exit {code})"))
            }
            Err(err) => Err(err),
        },
    }
}

pub fn _box_future<T: Send + 'static>(
    fut: impl Future<Output = T> + Send + 'static,
) -> Pin<Box<dyn Future<Output = T> + Send>> {
    Box::pin(fut)
}

pub type _Unused = BoxFuture<'static, ()>;
