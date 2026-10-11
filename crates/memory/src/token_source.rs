use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use protocol::js::js_trim;
use serde_json::Value;

pub const DEFAULT_TOKEN_TTL_MS: i64 = 300_000;
pub const DEFAULT_TOKEN_COMMAND_TIMEOUT_MS: i64 = 5_000;
const TOKEN_COMMAND_MAX_BUFFER: usize = 64 * 1024;

pub type CommandFut = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type CommandRunner = Arc<dyn Fn(Vec<String>, i64) -> CommandFut + Send + Sync>;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
type InflightRx = tokio::sync::watch::Receiver<Option<Result<String, String>>>;

enum MintStart {
    Wait(tokio::sync::watch::Receiver<Option<Result<String, String>>>),
    Lead(tokio::sync::watch::Sender<Option<Result<String, String>>>),
}

struct CacheEntry {
    token: String,
    expires_at: i64,
}

struct Inner {
    argv: Vec<String>,
    ttl_ms: i64,
    timeout_ms: i64,
    run: CommandRunner,
    now: Clock,
    cache: Mutex<Option<CacheEntry>>,
    inflight: Mutex<Option<InflightRx>>,
}

#[derive(Clone)]
pub struct TokenSource {
    inner: Arc<Inner>,
}

pub fn parse_token_command_argv(raw: Option<&Value>) -> Result<Option<Vec<String>>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    if raw.is_string() {
        return Err("token_command must be an argv array (no shell string)".to_string());
    }
    let Some(items) = raw.as_array() else {
        return Err("token_command argv entries must be non-empty strings".to_string());
    };
    if items.is_empty() {
        return Err("token_command must be a non-empty argv array".to_string());
    }
    let mut argv = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(text) if !text.is_empty() => argv.push(text.to_string()),
            _ => {
                return Err("token_command argv entries must be non-empty strings".to_string());
            }
        }
    }
    Ok(Some(argv))
}

impl TokenSource {
    pub fn new(
        argv: Vec<String>,
        ttl_ms: Option<i64>,
        timeout_ms: Option<i64>,
        run: Option<CommandRunner>,
        now: Option<Clock>,
    ) -> Result<Self, String> {
        if argv.is_empty() || argv.first().is_some_and(String::is_empty) {
            return Err("token_command argv is empty".to_string());
        }
        Ok(Self {
            inner: Arc::new(Inner {
                argv,
                ttl_ms: ttl_ms.unwrap_or(DEFAULT_TOKEN_TTL_MS),
                timeout_ms: timeout_ms.unwrap_or(DEFAULT_TOKEN_COMMAND_TIMEOUT_MS),
                run: run.unwrap_or_else(default_runner),
                now: now.unwrap_or_else(|| Arc::new(crate::error::now_ms)),
                cache: Mutex::new(None),
                inflight: Mutex::new(None),
            }),
        })
    }

    pub async fn get_token(&self) -> Result<String, String> {
        let now = (self.inner.now)();
        if let Some(token) = self.cached_at(now) {
            return Ok(token);
        }
        let start = {
            let mut slot = self.inner.inflight.lock();
            if let Some(token) = self.cached_at((self.inner.now)()) {
                return Ok(token);
            }
            if let Some(rx) = slot.clone() {
                MintStart::Wait(rx)
            } else {
                let (tx, rx) = tokio::sync::watch::channel(None);
                *slot = Some(rx);
                MintStart::Lead(tx)
            }
        };
        match start {
            MintStart::Lead(tx) => {
                tokio::task::yield_now().await;
                let minted = self.mint().await;
                {
                    let mut slot = self.inner.inflight.lock();
                    *slot = None;
                }
                let _ = tx.send(Some(minted.clone()));
                minted
            }
            MintStart::Wait(mut rx) => {
                loop {
                    if let Some(result) = rx.borrow().clone() {
                        return result;
                    }
                    if rx.changed().await.is_err() {
                        break;
                    }
                }
                self.mint().await
            }
        }
    }

    pub fn get_cached_token(&self) -> Option<String> {
        self.cached_at((self.inner.now)())
    }

    pub fn invalidate(&self, rejected: Option<&str>) {
        let now = (self.inner.now)();
        let mut cache = self.inner.cache.lock();
        if let (Some(rejected), Some(entry)) = (rejected, cache.as_ref())
            && entry.token != rejected
            && now < entry.expires_at
        {
            return;
        }
        *cache = None;
    }

    pub async fn auth_headers(
        &self,
        extra: BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, String> {
        let token = self.get_token().await?;
        let mut headers = extra;
        headers.insert("Authorization".to_string(), format!("Bearer {token}"));
        Ok(headers)
    }

    fn cached_at(&self, now: i64) -> Option<String> {
        let cache = self.inner.cache.lock();
        let entry = cache.as_ref()?;
        if now < entry.expires_at {
            Some(entry.token.clone())
        } else {
            None
        }
    }

    async fn mint(&self) -> Result<String, String> {
        let stdout = (self.inner.run)(self.inner.argv.clone(), self.inner.timeout_ms).await?;
        let token = js_trim(&stdout).to_string();
        if token.is_empty() {
            return Err("token_command produced empty stdout".to_string());
        }
        if token.contains('\n') || token.contains('\r') {
            return Err("token_command stdout must be a single line".to_string());
        }
        let now = (self.inner.now)();
        *self.inner.cache.lock() = Some(CacheEntry {
            token: token.clone(),
            expires_at: now + self.inner.ttl_ms,
        });
        Ok(token)
    }
}

fn default_runner() -> CommandRunner {
    Arc::new(|argv, timeout_ms| Box::pin(run_token_command(argv, timeout_ms)))
}

fn spawn_fail(err: std::io::Error) -> String {
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "error",
    };
    format!("token_command failed (exit {code})")
}

async fn run_token_command(argv: Vec<String>, timeout_ms: i64) -> Result<String, String> {
    let Some(bin) = argv.first().filter(|bin| !bin.is_empty()) else {
        return Err("token_command argv is empty".to_string());
    };
    let budget = Duration::from_millis(timeout_ms.max(0) as u64);
    let deadline = tokio::time::Instant::now() + budget;
    let bin = bin.clone();
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let spawned = tokio::time::timeout_at(deadline, async move {
        tokio::process::Command::new(bin)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
    })
    .await;
    let mut child = match spawned {
        Err(_) => return Err(format!("token_command timed out after {timeout_ms} ms")),
        Ok(Err(err)) => return Err(spawn_fail(err)),
        Ok(Ok(child)) => child,
    };
    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err("token_command failed (exit error)".to_string());
        }
    };
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let read_result = tokio::select! {
        biased;
        result = read_capped(&mut stdout, TOKEN_COMMAND_MAX_BUFFER) => Some(result),
        _ = tokio::time::sleep(remaining) => None,
    };
    drop(stdout);
    match read_result {
        None => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(format!("token_command timed out after {timeout_ms} ms"))
        }
        Some(Err(())) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err("token_command failed (exit ERR_CHILD_PROCESS_STDIO_MAXBUFFER)".to_string())
        }
        Some(Ok(bytes)) => {
            let status = match child.wait().await {
                Ok(status) => status,
                Err(_) => return Err("token_command failed (exit error)".to_string()),
            };
            finish_token(bytes, status)
        }
    }
}

async fn read_capped(
    stdout: &mut tokio::process::ChildStdout,
    limit: usize,
) -> Result<Vec<u8>, ()> {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = stdout.read(&mut chunk).await.map_err(|_| ())?;
        if n == 0 {
            return Ok(buf);
        }
        if n > limit.saturating_sub(buf.len()) {
            return Err(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn finish_token(bytes: Vec<u8>, status: std::process::ExitStatus) -> Result<String, String> {
    if !status.success() {
        let code = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "error".to_string());
        return Err(format!("token_command failed (exit {code})"));
    }
    String::from_utf8(bytes).map_err(|err| err.to_string())
}

pub struct AuthorizedFetch {
    source: TokenSource,
    header_name: String,
}

impl AuthorizedFetch {
    pub fn new(source: TokenSource, header_name: Option<&str>) -> Self {
        Self {
            source,
            header_name: header_name.unwrap_or("Authorization").to_string(),
        }
    }

    pub async fn execute<F, Fut>(
        &self,
        headers_of: F,
    ) -> Result<(u16, Vec<(String, String)>), String>
    where
        F: Fn(Vec<(String, String)>) -> Fut,
        Fut: Future<Output = u16>,
    {
        let token = self.source.get_token().await?;
        let first_headers = self.apply(&token);
        let status = headers_of(first_headers.clone()).await;
        if status != 401 {
            return Ok((status, first_headers));
        }
        self.source.invalidate(Some(token.as_str()));
        let next = self.source.get_token().await?;
        let next_headers = self.apply(&next);
        let status = headers_of(next_headers.clone()).await;
        Ok((status, next_headers))
    }

    fn apply(&self, token: &str) -> Vec<(String, String)> {
        if self.header_name == "Authorization" {
            vec![("Authorization".to_string(), format!("Bearer {token}"))]
        } else {
            vec![(self.header_name.clone(), token.to_string())]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    fn runner_seq(prefix: &'static str) -> (CommandRunner, Arc<AtomicUsize>) {
        let n = Arc::new(AtomicUsize::new(0));
        let count = n.clone();
        let run: CommandRunner = Arc::new(move |_argv, _timeout| {
            let count = count.clone();
            Box::pin(async move {
                let next = count.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(format!("{prefix}{next}\n"))
            })
        });
        (run, n)
    }

    #[test]
    fn parses_argv() {
        assert!(parse_token_command_argv(None).unwrap().is_none());
        assert!(
            parse_token_command_argv(Some(&Value::Null))
                .unwrap()
                .is_none()
        );
        let shell = parse_token_command_argv(Some(&Value::String("op read".into()))).unwrap_err();
        assert!(shell.contains("argv array"));
        let empty = parse_token_command_argv(Some(&Value::Array(vec![]))).unwrap_err();
        assert!(empty.contains("non-empty"));
        let blank = parse_token_command_argv(Some(&serde_json::json!(["ok", ""]))).unwrap_err();
        assert!(blank.contains("non-empty strings"));
        let bad = parse_token_command_argv(Some(&serde_json::json!(["ok", 1]))).unwrap_err();
        assert!(bad.contains("non-empty strings"));
        let ok = parse_token_command_argv(Some(&serde_json::json!(["/bin/helper", "--out"])))
            .unwrap()
            .unwrap();
        assert_eq!(ok, vec!["/bin/helper".to_string(), "--out".to_string()]);
    }

    #[tokio::test]
    async fn mints_caches_and_expires() {
        let now = Arc::new(AtomicI64::new(1_000));
        let clock_now = now.clone();
        let (run, calls) = runner_seq("token-");
        let src = TokenSource::new(
            vec!["helper".into()],
            Some(100),
            None,
            Some(run),
            Some(Arc::new(move || clock_now.load(Ordering::SeqCst))),
        )
        .unwrap();
        assert_eq!(src.get_token().await.unwrap(), "token-1");
        assert_eq!(src.get_token().await.unwrap(), "token-1");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(src.get_cached_token().as_deref(), Some("token-1"));
        now.store(1_100, Ordering::SeqCst);
        assert!(src.get_cached_token().is_none());
        assert_eq!(src.get_token().await.unwrap(), "token-2");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidate_keeps_a_newer_mint() {
        let (run, _) = runner_seq("t-");
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(run), None).unwrap();
        assert_eq!(src.get_token().await.unwrap(), "t-1");
        src.invalidate(Some("t-1"));
        assert_eq!(src.get_token().await.unwrap(), "t-2");
        src.invalidate(Some("t-1"));
        assert_eq!(src.get_cached_token().as_deref(), Some("t-2"));
        assert_eq!(src.get_token().await.unwrap(), "t-2");
        src.invalidate(src.get_cached_token().as_deref());
        assert!(src.get_cached_token().is_none());
        assert_eq!(src.get_token().await.unwrap(), "t-3");
    }

    #[tokio::test]
    async fn coalesces_concurrent_mints() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let started_tx = Arc::new(Mutex::new(Some(started_tx)));
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        let calls = Arc::new(AtomicUsize::new(0));
        let run: CommandRunner = {
            let started_tx = started_tx.clone();
            let release_rx = release_rx.clone();
            let calls = calls.clone();
            Arc::new(move |_argv, _timeout| {
                let started_tx = started_tx.clone();
                let release_rx = release_rx.clone();
                let calls = calls.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if let Some(tx) = started_tx.lock().take() {
                        let _ = tx.send(());
                    }
                    let rx = release_rx.lock().take();
                    if let Some(rx) = rx {
                        let _ = rx.await;
                    }
                    Ok("shared\n".to_string())
                })
            })
        };
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(run), None).unwrap();
        let left = src.clone();
        let right = src.clone();
        let a = tokio::spawn(async move { left.get_token().await });
        let b = tokio::spawn(async move { right.get_token().await });
        started_rx.await.unwrap();
        tokio::task::yield_now().await;
        release_tx.send(()).unwrap();
        let (a, b) = tokio::join!(a, b);
        assert_eq!(a.unwrap().unwrap(), "shared");
        assert_eq!(b.unwrap().unwrap(), "shared");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rejects_empty_and_multiline_stdout() {
        let empty: CommandRunner = Arc::new(|_, _| Box::pin(async { Ok("   \n".to_string()) }));
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(empty), None).unwrap();
        let err = src.get_token().await.unwrap_err();
        assert!(err.contains("empty stdout"));
        let multi: CommandRunner = Arc::new(|_, _| Box::pin(async { Ok("abc\nleak".to_string()) }));
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(multi), None).unwrap();
        let err = src.get_token().await.unwrap_err();
        assert!(err.contains("single line"));
    }

    #[tokio::test]
    async fn auth_headers_set_bearer() {
        let run: CommandRunner = Arc::new(|_, _| Box::pin(async { Ok("sekrit".to_string()) }));
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(run), None).unwrap();
        let mut extra = BTreeMap::new();
        extra.insert("Accept".into(), "application/json".into());
        let headers = src.auth_headers(extra).await.unwrap();
        assert_eq!(
            headers.get("Accept").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Bearer sekrit")
        );
        assert_eq!(DEFAULT_TOKEN_TTL_MS, 300_000);
    }

    #[tokio::test]
    async fn authorized_fetch_remints_once_on_401() {
        let (run, calls) = runner_seq("tok-");
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(run), None).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let fetch = AuthorizedFetch::new(src.clone(), None);
        let seen_call = seen.clone();
        let (status, _) = fetch
            .execute(move |headers| {
                let seen_call = seen_call.clone();
                async move {
                    let auth = headers
                        .iter()
                        .find(|(k, _)| k == "Authorization")
                        .map(|(_, v)| v.clone());
                    seen_call.lock().push(auth);
                    if seen_call.lock().len() == 1 {
                        401
                    } else {
                        200
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            seen.lock().clone(),
            vec![
                Some("Bearer tok-1".to_string()),
                Some("Bearer tok-2".to_string())
            ]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn authorized_fetch_can_set_api_key_header() {
        let run: CommandRunner = Arc::new(|_, _| Box::pin(async { Ok("anth-key".to_string()) }));
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(run), None).unwrap();
        let fetch = AuthorizedFetch::new(src, Some("x-api-key"));
        let (status, headers) = fetch
            .execute(|headers| async move {
                assert_eq!(
                    headers
                        .iter()
                        .find(|(k, _)| k == "x-api-key")
                        .map(|(_, v)| v.as_str()),
                    Some("anth-key")
                );
                assert!(headers.iter().all(|(k, _)| k != "Authorization"));
                let _ = headers;
                200
            })
            .await
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(headers[0].0, "x-api-key");
    }

    #[tokio::test]
    async fn staggered_401_does_not_wipe_a_newer_mint() {
        let (run, calls) = runner_seq("tok-");
        let src = TokenSource::new(vec!["helper".into()], None, None, Some(run), None).unwrap();
        let fetch = AuthorizedFetch::new(src.clone(), None);
        let src_fetch = src.clone();
        let (status, _) = fetch
            .execute(move |headers| {
                let src_fetch = src_fetch.clone();
                async move {
                    let auth = headers
                        .iter()
                        .find(|(k, _)| k == "Authorization")
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default();
                    if auth == "Bearer tok-1" {
                        src_fetch.invalidate(Some("tok-1"));
                        let _ = src_fetch.get_token().await;
                        401
                    } else {
                        200
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(src.get_cached_token().as_deref(), Some("tok-2"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn default_runner_trims_kills_and_bounds() {
        let minted = TokenSource::new(
            vec!["/bin/echo".into(), "sekret".into()],
            None,
            Some(2_000),
            None,
            None,
        )
        .unwrap();
        assert_eq!(minted.get_token().await.unwrap(), "sekret");
        let failed =
            TokenSource::new(vec!["/bin/false".into()], None, Some(2_000), None, None).unwrap();
        assert_eq!(
            failed.get_token().await.unwrap_err(),
            "token_command failed (exit 1)"
        );
        let missing = TokenSource::new(
            vec!["/bin/no-such-token-helper".into()],
            None,
            Some(2_000),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            missing.get_token().await.unwrap_err(),
            "token_command failed (exit ENOENT)"
        );
        let slow = TokenSource::new(
            vec!["/bin/sleep".into(), "30".into()],
            None,
            Some(300),
            None,
            None,
        )
        .unwrap();
        let err = tokio::time::timeout(Duration::from_secs(3), slow.get_token())
            .await
            .expect("runner returned")
            .expect_err("timeout");
        assert_eq!(err, "token_command timed out after 300 ms");
        let huge = TokenSource::new(
            vec![
                "/bin/dd".into(),
                "if=/dev/zero".into(),
                "bs=1024".into(),
                "count=128".into(),
            ],
            None,
            Some(2_000),
            None,
            None,
        )
        .unwrap();
        let err = tokio::time::timeout(Duration::from_secs(3), huge.get_token())
            .await
            .expect("runner returned")
            .expect_err("overflow");
        assert_eq!(
            err,
            "token_command failed (exit ERR_CHILD_PROCESS_STDIO_MAXBUFFER)"
        );
    }
}
