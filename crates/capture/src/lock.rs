use std::fs::{FileTimes, OpenOptions};
use std::future::Future;
use std::io::{self, ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use thiserror::Error;
use tokio::task::JoinHandle;

use crate::timeutil;
use crate::types::LogFn;

pub type BeforeReaddir = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub type UnlinkHook = Arc<dyn Fn() + Send + Sync>;

const HOLDER_PREFIX: &str = "holder.";
const PUBLISH_PREFIX: &str = ".holderpub.";
const MAX_SAFE_PID: u64 = 9_007_199_254_740_991;
static TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum LockError {
    #[error("lock timeout: {lock_dir}")]
    Timeout { lock_dir: String },
    #[error("{message}")]
    Io {
        code: Option<String>,
        message: String,
    },
}

impl LockError {
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Io { code, .. } => code.as_deref(),
            Self::Timeout { .. } => None,
        }
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Timeout { .. })
    }

    fn from_io(error: io::Error, path: &Path) -> Self {
        let code = io_code(&error).map(str::to_string);
        Self::Io {
            code,
            message: format!("Error: {error}: {}", path.display()),
        }
    }

    fn enospc(path: &Path) -> Self {
        Self::Io {
            code: Some("ENOSPC".to_string()),
            message: format!("Error: ENOSPC: no space left on device: {}", path.display()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ReadFault {
    pub path: PathBuf,
    pub code: String,
}

#[derive(Clone, Default)]
pub struct FileLockOptions {
    pub stale_ms: Option<u64>,
    pub wait_ms: Option<u64>,
    pub poll_ms: Option<u64>,
    pub log: Option<LogFn>,
    pub before_readdir: Option<BeforeReaddir>,
    pub host: Option<String>,
    pub read_fault: Option<Arc<Mutex<Option<ReadFault>>>>,
    pub publish_fault: Option<Arc<AtomicBool>>,
    pub unlink_hook: Option<UnlinkHook>,
}

impl std::fmt::Debug for FileLockOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FileLockOptions")
            .field("stale_ms", &self.stale_ms)
            .field("wait_ms", &self.wait_ms)
            .field("poll_ms", &self.poll_ms)
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

pub fn system_hostname() -> String {
    let raw = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
    let name = raw.trim();
    if name.is_empty() {
        "localhost".to_string()
    } else {
        name.to_string()
    }
}

pub fn hex_host(host: &str) -> String {
    hex::encode(host.as_bytes())
}

pub fn pid_dead(pid: u64) -> bool {
    if pid == 0 || pid > MAX_SAFE_PID {
        return false;
    }
    match std::fs::metadata(format!("/proc/{pid}")) {
        Ok(_) => false,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

pub async fn with_file_lock<T, F, Fut>(
    lock_dir: impl Into<PathBuf>,
    opts: FileLockOptions,
    body: F,
) -> Result<T, LockError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    let lock_dir = lock_dir.into();
    let stale_ms = opts.stale_ms.unwrap_or(120_000);
    let wait_ms = opts.wait_ms.unwrap_or(10_000);
    let poll_ms = opts.poll_ms.unwrap_or(100);
    let host = match opts.host.clone() {
        Some(host) => host,
        None => tokio::task::spawn_blocking(system_hostname)
            .await
            .unwrap_or_else(|_| "localhost".to_string()),
    };
    let dir = lock_dir.clone();
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(dir))
        .await
        .map_err(|error| LockError::Io {
            code: None,
            message: error.to_string(),
        })?
        .map_err(|error| LockError::from_io(error, &lock_dir))?;
    let owner_path = acquire(&lock_dir, &host, wait_ms, poll_ms, &opts).await?;
    let stop = Arc::new(AtomicBool::new(false));
    let heartbeat_ms = (stale_ms / 3).max(1);
    let heartbeat = spawn_heartbeat(owner_path.clone(), heartbeat_ms, Arc::clone(&stop));
    let mut guard = HoldGuard {
        path: Some(owner_path),
        stop,
        heartbeat: Some(heartbeat),
        unlink_hook: opts.unlink_hook.clone(),
    };
    let value = body().await;
    guard.release().await;
    Ok(value)
}

struct HoldGuard {
    path: Option<PathBuf>,
    stop: Arc<AtomicBool>,
    heartbeat: Option<JoinHandle<()>>,
    unlink_hook: Option<UnlinkHook>,
}

impl HoldGuard {
    async fn release(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.heartbeat.take() {
            handle.abort();
        }
        if let Some(path) = self.path.take() {
            unlink_await(path, self.unlink_hook.clone()).await;
        }
    }
}

impl Drop for HoldGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.heartbeat.take() {
            handle.abort();
        }
        if let Some(path) = self.path.take() {
            schedule_unlink(path, self.unlink_hook.clone());
        }
    }
}

async fn unlink_await(path: PathBuf, hook: Option<UnlinkHook>) {
    let _ = tokio::task::spawn_blocking(move || unlink_now(&path, hook.as_ref())).await;
}

fn schedule_unlink(path: PathBuf, hook: Option<UnlinkHook>) {
    let work = move || unlink_now(&path, hook.as_ref());
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let _ = handle.spawn_blocking(work);
    } else {
        std::thread::spawn(work);
    }
}

fn unlink_now(path: &Path, hook: Option<&UnlinkHook>) {
    if let Some(hook) = hook {
        hook();
    }
    let _ = std::fs::remove_file(path);
}

fn spawn_heartbeat(path: PathBuf, every_ms: u64, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(every_ms)).await;
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let touched = path.clone();
            let _ = tokio::task::spawn_blocking(move || touch_file(&touched)).await;
        }
    })
}

struct AttemptGuard {
    paths: Vec<PathBuf>,
    armed: bool,
}

impl AttemptGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn cleanup(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        for path in std::mem::take(&mut self.paths) {
            unlink_await(path, None).await;
        }
    }
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        for path in std::mem::take(&mut self.paths) {
            schedule_unlink(path, None);
        }
    }
}

async fn acquire(
    lock_dir: &Path,
    host: &str,
    wait_ms: u64,
    poll_ms: u64,
    opts: &FileLockOptions,
) -> Result<PathBuf, LockError> {
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    loop {
        let host_for_token = host.to_string();
        let token = tokio::task::spawn_blocking(move || make_token(&host_for_token))
            .await
            .unwrap_or_else(|_| format!("{:x}", std::process::id()));
        let temp_path = lock_dir.join(format!("{PUBLISH_PREFIX}{token}"));
        let owner_path = lock_dir.join(format!("{HOLDER_PREFIX}{token}"));
        let record = owner_json(std::process::id(), host, &token);
        let mut attempt = AttemptGuard {
            paths: vec![temp_path.clone(), owner_path.clone()],
            armed: true,
        };
        let publish = {
            let temp_path = temp_path.clone();
            let owner_path = owner_path.clone();
            let record = record.clone();
            let fault = opts.publish_fault.clone();
            let log = opts.log.clone();
            tokio::task::spawn_blocking(move || {
                publish_owner(&temp_path, &owner_path, &record, fault, &log)
            })
            .await
            .map_err(|error| LockError::Io {
                code: None,
                message: error.to_string(),
            })?
        };
        if let Err(error) = publish {
            if error.code() == Some("EEXIST") {
                attempt.disarm();
                continue;
            }
            attempt.cleanup().await;
            return Err(error);
        }
        let owned = owner_path.clone();
        let wait_result =
            wait_for_turn(lock_dir, &owner_path, &token, host, deadline, poll_ms, opts).await;
        match wait_result {
            Ok(Turn::Acquired) => {
                attempt.disarm();
                return Ok(owned);
            }
            Ok(Turn::Retry) => {
                if Instant::now() >= deadline {
                    attempt.cleanup().await;
                    return Err(LockError::Timeout {
                        lock_dir: lock_dir.display().to_string(),
                    });
                }
                tokio::time::sleep(Duration::from_millis(poll_ms)).await;
                attempt.cleanup().await;
            }
            Err(error) => {
                attempt.cleanup().await;
                return Err(error);
            }
        }
    }
}

enum Turn {
    Acquired,
    Retry,
}

async fn wait_for_turn(
    lock_dir: &Path,
    owner_path: &Path,
    token: &str,
    host: &str,
    deadline: Instant,
    poll_ms: u64,
    opts: &FileLockOptions,
) -> Result<Turn, LockError> {
    if let Some(hook) = &opts.before_readdir {
        hook().await;
    }
    loop {
        let decision = judge_async(lock_dir, owner_path, token, host, opts).await?;
        match decision {
            Decision::Acquired => return Ok(Turn::Acquired),
            Decision::Lost => return Ok(Turn::Retry),
            Decision::Pending => {
                if Instant::now() >= deadline {
                    return Err(LockError::Timeout {
                        lock_dir: lock_dir.display().to_string(),
                    });
                }
                tokio::time::sleep(Duration::from_millis(poll_ms)).await;
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Decision {
    Acquired,
    Pending,
    Lost,
}

async fn judge_async(
    lock_dir: &Path,
    owner_path: &Path,
    token: &str,
    host: &str,
    opts: &FileLockOptions,
) -> Result<Decision, LockError> {
    let input = JudgeInput {
        lock_dir: lock_dir.to_path_buf(),
        owner_path: owner_path.to_path_buf(),
        token: token.to_string(),
        host: host.to_string(),
        log: opts.log.clone(),
        read_fault: opts.read_fault.clone(),
    };
    tokio::task::spawn_blocking(move || judge(&input))
        .await
        .map_err(|error| LockError::Io {
            code: None,
            message: error.to_string(),
        })?
}

struct JudgeInput {
    lock_dir: PathBuf,
    owner_path: PathBuf,
    token: String,
    host: String,
    log: Option<LogFn>,
    read_fault: Option<Arc<Mutex<Option<ReadFault>>>>,
}

fn judge(input: &JudgeInput) -> Result<Decision, LockError> {
    let first = inspect(input)?;
    if first == Presence::Lost {
        return Ok(if unlink_own(&input.owner_path, &input.log) {
            Decision::Lost
        } else {
            Decision::Pending
        });
    }
    if first == Presence::Pending {
        return Ok(if touch_file(&input.owner_path) {
            Decision::Pending
        } else {
            Decision::Lost
        });
    }
    let second = inspect(input)?;
    if second == Presence::Lost {
        return Ok(if unlink_own(&input.owner_path, &input.log) {
            Decision::Lost
        } else {
            Decision::Pending
        });
    }
    if second == Presence::Pending {
        return Ok(if touch_file(&input.owner_path) {
            Decision::Pending
        } else {
            Decision::Lost
        });
    }
    if !our_file_exists(&input.owner_path)? {
        return Ok(Decision::Lost);
    }
    Ok(Decision::Acquired)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Presence {
    Alone,
    Pending,
    Lost,
}

fn inspect(input: &JudgeInput) -> Result<Presence, LockError> {
    let names = match std::fs::read_dir(&input.lock_dir) {
        Ok(entries) => collect_names(entries)?,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Presence::Lost),
        Err(error) => return Err(LockError::from_io(error, &input.lock_dir)),
    };
    for name in &names {
        if !name.starts_with(PUBLISH_PREFIX) {
            continue;
        }
        let publish_token = &name[PUBLISH_PREFIX.len()..];
        let publish_path = input.lock_dir.join(name);
        if !same_host_dead(publish_token, &input.host, &publish_path, &input.read_fault) {
            continue;
        }
        emit(&input.log, &format!("removing dead publish {name}"));
        let _ = unlink_other(&publish_path, &input.log);
    }
    let ours = format!("{HOLDER_PREFIX}{}", input.token);
    let mut live = 0usize;
    let mut smallest = true;
    let mut blocked = false;
    for name in &names {
        if name == &ours || name.starts_with(PUBLISH_PREFIX) {
            continue;
        }
        let full = input.lock_dir.join(name);
        if !owner_still_there(&full) {
            continue;
        }
        if !name.starts_with(HOLDER_PREFIX) {
            blocked = true;
            continue;
        }
        let other_token = &name[HOLDER_PREFIX.len()..];
        if same_host_dead(other_token, &input.host, &full, &input.read_fault) {
            emit(
                &input.log,
                &format!(
                    "removing dead holder {name}: {}",
                    owner_body_note(&full, other_token, &input.read_fault)
                ),
            );
            if unlink_other(&full, &input.log) {
                continue;
            }
        }
        live += 1;
        if other_token <= input.token.as_str() {
            smallest = false;
        }
    }
    if live > 0 && !smallest {
        return Ok(Presence::Lost);
    }
    if blocked || live > 0 {
        return Ok(Presence::Pending);
    }
    Ok(Presence::Alone)
}

fn collect_names(entries: std::fs::ReadDir) -> Result<Vec<String>, LockError> {
    let mut names = Vec::new();
    for (index, entry) in entries.enumerate() {
        let entry = entry.map_err(|error| LockError::Io {
            code: io_code(&error).map(str::to_string),
            message: error.to_string(),
        })?;
        match entry.file_name().into_string() {
            Ok(name) => names.push(name),
            Err(_) => names.push(format!("non-utf8-{index}")),
        }
    }
    Ok(names)
}

fn same_host_dead(
    token: &str,
    host: &str,
    path: &Path,
    fault: &Option<Arc<Mutex<Option<ReadFault>>>>,
) -> bool {
    let Some(parsed) = parse_token(token) else {
        return false;
    };
    if parsed.host_hex != hex_host(host) || !pid_dead(parsed.pid) {
        return false;
    }
    match body_host(path, fault) {
        BodyHost::Unreadable => false,
        BodyHost::Host(recorded) => recorded == host,
        BodyHost::Missing | BodyHost::Unchecked => true,
    }
}

struct ParsedToken {
    host_hex: String,
    pid: u64,
}

fn parse_token(token: &str) -> Option<ParsedToken> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let host = parts[0];
    let pid_raw = parts[1];
    let start_raw = parts[2];
    let random = parts[3];
    if host.is_empty()
        || !host.len().is_multiple_of(2)
        || !host
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    if random.is_empty()
        || start_raw.is_empty()
        || !start_raw.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    if pid_raw.is_empty()
        || pid_raw.starts_with('0')
        || !pid_raw.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let pid = pid_raw.parse::<u64>().ok()?;
    if pid == 0 || pid > MAX_SAFE_PID {
        return None;
    }
    Some(ParsedToken {
        host_hex: host.to_string(),
        pid,
    })
}

enum BodyHost {
    Missing,
    Unreadable,
    Unchecked,
    Host(String),
}

fn body_host(path: &Path, fault: &Option<Arc<Mutex<Option<ReadFault>>>>) -> BodyHost {
    match read_body(path, fault) {
        Err(ReadFail::Missing) => BodyHost::Missing,
        Err(ReadFail::Unreadable) => BodyHost::Unreadable,
        Ok(text) => match parse_owner(&text).map(|record| record.host) {
            Some(host) => BodyHost::Host(host),
            None => BodyHost::Unchecked,
        },
    }
}

enum ReadFail {
    Missing,
    Unreadable,
}

fn read_body(
    path: &Path,
    fault: &Option<Arc<Mutex<Option<ReadFault>>>>,
) -> Result<String, ReadFail> {
    if let Some(slot) = fault
        && let Ok(guard) = slot.lock()
        && let Some(injected) = guard.as_ref()
        && injected.path == path
    {
        return if injected.code == "ENOENT" {
            Err(ReadFail::Missing)
        } else {
            Err(ReadFail::Unreadable)
        };
    }
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(ReadFail::Missing),
        Err(_) => Err(ReadFail::Unreadable),
    }
}

struct OwnerRecord {
    host: String,
    token: String,
}

fn parse_owner(text: &str) -> Option<OwnerRecord> {
    let value: Value = serde_json::from_str(text).ok()?;
    let map = value.as_object()?;
    let pid = map.get("pid")?;
    if !pid.is_number() {
        return None;
    }
    let host = map.get("host")?.as_str()?.to_string();
    let _ts = map.get("ts")?.as_str()?;
    let token = map.get("token")?.as_str()?.to_string();
    Some(OwnerRecord { host, token })
}

fn owner_body_note(
    path: &Path,
    token: &str,
    fault: &Option<Arc<Mutex<Option<ReadFault>>>>,
) -> String {
    match read_body(path, fault) {
        Err(ReadFail::Missing) => "body missing".to_string(),
        Err(ReadFail::Unreadable) => "body unreadable".to_string(),
        Ok(text) if text.is_empty() => "body empty".to_string(),
        Ok(text) => match parse_owner(&text) {
            None => "body invalid".to_string(),
            Some(record) if record.token != token => "body token differs from name".to_string(),
            Some(_) => "body ok".to_string(),
        },
    }
}

fn owner_still_there(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn our_file_exists(path: &Path) -> Result<bool, LockError> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(LockError::from_io(error, path)),
    }
}

fn unlink_other(path: &Path, log: &Option<LogFn>) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => {
            emit(
                log,
                &format!("not removing {}: Error: {error}", path.display()),
            );
            false
        }
    }
}

fn unlink_own(path: &Path, log: &Option<LogFn>) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => {
            emit(
                log,
                &format!("release {} failed: Error: {error}", path.display()),
            );
            false
        }
    }
}

fn touch_file(path: &Path) -> bool {
    let file = match OpenOptions::new().write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    let now = SystemTime::now();
    let times = FileTimes::new().set_accessed(now).set_modified(now);
    match file.set_times(times) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn path_exists(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

#[derive(Clone, Copy)]
enum Created {
    None,
    Temp,
    Final,
}

fn publish_owner(
    temp_path: &Path,
    owner_path: &Path,
    body: &str,
    fault: Option<Arc<AtomicBool>>,
    log: &Option<LogFn>,
) -> Result<(), LockError> {
    if fault.is_some_and(|flag| flag.swap(false, Ordering::SeqCst)) {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        match options.open(temp_path) {
            Ok(_) => {
                let _ = std::fs::remove_file(temp_path);
                return Err(LockError::enospc(temp_path));
            }
            Err(error) if io_code(&error) == Some("EEXIST") => {
                return Err(LockError::from_io(error, temp_path));
            }
            Err(error) => {
                if path_exists(temp_path) {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(LockError::from_io(error, temp_path));
            }
        }
    }
    let mut created = Created::None;
    let written = (|| -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = options.open(temp_path)?;
        created = Created::Temp;
        file.write_all(body.as_bytes())?;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_mode(0o600);
        file.set_permissions(permissions)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(temp_path, owner_path)?;
        created = Created::Final;
        Ok(())
    })();
    if let Err(error) = written {
        if matches!(created, Created::None)
            && io_code(&error) != Some("EEXIST")
            && path_exists(temp_path)
        {
            created = Created::Temp;
        }
        if matches!(created, Created::Temp) {
            let _ = unlink_own(temp_path, log);
        }
        if matches!(created, Created::Final) {
            let _ = unlink_own(owner_path, log);
        }
        return Err(LockError::from_io(error, temp_path));
    }
    Ok(())
}

fn owner_json(pid: u32, host: &str, token: &str) -> String {
    let record = serde_json::json!({
        "pid": pid,
        "host": host,
        "ts": timeutil::iso_now(),
        "token": token,
    });
    serde_json::to_string(&record).unwrap_or_else(|_| "{}".to_string())
}

fn make_token(host: &str) -> String {
    let seq = TOKEN_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let mut counter = to_base36(seq);
    while counter.len() < 6 {
        counter.insert(0, '0');
    }
    let random = format!("{counter}{}", uuid::Uuid::new_v4().simple());
    format!(
        "{}.{}.{}.{}",
        hex_host(host),
        std::process::id(),
        timeutil::unix_ms_now(),
        random
    )
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut bytes = Vec::new();
    while value > 0 {
        bytes.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    bytes.reverse();
    String::from_utf8(bytes).unwrap_or_else(|_| "0".to_string())
}

fn emit(log: &Option<LogFn>, line: &str) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Some(callback) = log {
            callback(line);
        } else {
            eprintln!("{line}");
        }
    }));
}

fn io_code(error: &io::Error) -> Option<&'static str> {
    if error.raw_os_error() == Some(28) {
        return Some("ENOSPC");
    }
    match error.kind() {
        ErrorKind::NotFound => Some("ENOENT"),
        ErrorKind::AlreadyExists => Some("EEXIST"),
        ErrorKind::PermissionDenied => Some("EACCES"),
        _ => None,
    }
}
