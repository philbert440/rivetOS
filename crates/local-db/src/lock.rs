use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::config_resolve::{ATTACH_TIMEOUT_MS, embedded_pg_url};
use crate::error::{LocalDbError, Result};

pub const EMBEDDED_PG_LOCKFILE: &str = "rivetos-owner.lock";
pub const LOCK_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedPgLock {
    pub pid: i64,
    pub port: i64,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockClaim {
    Owned { lock_path: PathBuf },
    Attached { pid: i64, port: u16, pg_url: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AttachDecision {
    Alive { pid: i64, port: u16 },
    Stale,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidProbe {
    Alive,
    Dead,
}

pub trait EmbeddedPgLog: Send + Sync {
    fn info(&self, message: &str);
    fn warn(&self, message: &str);
    fn error(&self, message: &str);
}

pub struct TracingLog;

impl EmbeddedPgLog for TracingLog {
    fn info(&self, message: &str) {
        tracing::info!("{message}");
    }

    fn warn(&self, message: &str) {
        tracing::warn!("{message}");
    }

    fn error(&self, message: &str) {
        tracing::error!("{message}");
    }
}

pub fn attach_timeout() -> Duration {
    Duration::from_millis(ATTACH_TIMEOUT_MS)
}

pub fn lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(EMBEDDED_PG_LOCKFILE)
}

pub fn read_embedded_pg_lock(data_dir: &Path) -> Option<EmbeddedPgLock> {
    let text = std::fs::read_to_string(lock_path(data_dir)).ok()?;
    parse_lock(&text)
}

pub fn embedded_pg_lock_alive(lock: &EmbeddedPgLock) -> bool {
    probe_lock_pid(lock.pid) != PidProbe::Dead
}

pub async fn claim_owner_lock(
    data_dir: &Path,
    configured_port: u16,
    log: &dyn EmbeddedPgLog,
    timeout: Duration,
) -> Result<LockClaim> {
    tokio::fs::create_dir_all(data_dir).await?;
    let path = lock_path(data_dir);
    for _ in 0..LOCK_ATTEMPTS {
        match create_exclusive(&path).await {
            Ok(mut file) => {
                let started_at = protocol::js::to_iso_string(protocol::js::date_now())
                    .map_err(|error| LocalDbError::message(error.to_string()))?;
                let payload = serde_json::json!({
                    "pid": std::process::id(),
                    "port": configured_port,
                    "startedAt": started_at,
                });
                let body = serde_json::to_string(&payload)
                    .map_err(|error| LocalDbError::Json(error.to_string()))?;
                if let Err(error) = file.write_all(body.as_bytes()).await {
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(error.into());
                }
                if let Err(error) = file.flush().await {
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(error.into());
                }
                drop(file);
                return Ok(LockClaim::Owned { lock_path: path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                match classify_existing(&path, configured_port, log).await? {
                    AttachDecision::Alive { pid, port } => {
                        if port != configured_port {
                            log.warn(&format!(
                                "embedded postgres: owner pid {pid} listens on {port}, config says {configured_port} — using the owner's port"
                            ));
                        }
                        if !wait_for_port(port, timeout).await {
                            return Err(LocalDbError::message(format!(
                                "embedded postgres: owner pid {pid} holds {} but nothing listens on 127.0.0.1:{port} after {}ms — if that process is dead, remove the lock",
                                path.display(),
                                timeout.as_millis()
                            )));
                        }
                        return Ok(LockClaim::Attached {
                            pid,
                            port,
                            pg_url: embedded_pg_url(i64::from(port)),
                        });
                    }
                    AttachDecision::Stale => {
                        let _ = tokio::fs::remove_file(&path).await;
                    }
                    AttachDecision::Missing => {}
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(LocalDbError::message(format!(
        "embedded postgres: could not acquire lock {}",
        path.display()
    )))
}

pub async fn release_owner_lock(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn probe_lock_pid(pid: i64) -> PidProbe {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return PidProbe::Alive;
    }
    let Ok(native) = i32::try_from(pid) else {
        return PidProbe::Alive;
    };
    if pid_is_alive(native) {
        PidProbe::Alive
    } else {
        PidProbe::Dead
    }
}

fn parse_lock(text: &str) -> Option<EmbeddedPgLock> {
    let value: Value = serde_json::from_str(text).ok()?;
    let pid = value.get("pid")?.as_i64()?;
    let port = value.get("port")?.as_i64()?;
    let started_at = value
        .get("startedAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(EmbeddedPgLock {
        pid,
        port,
        started_at,
    })
}

fn classify_text(
    text: &str,
    configured_port: u16,
    probe: impl Fn(i64) -> PidProbe,
) -> AttachDecision {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return AttachDecision::Stale,
    };
    let Some(pid) = value.get("pid").and_then(Value::as_i64) else {
        return AttachDecision::Stale;
    };
    if pid <= 0 {
        return AttachDecision::Stale;
    }
    let port = value
        .get("port")
        .and_then(Value::as_i64)
        .filter(|port| *port > 0 && *port <= i64::from(u16::MAX))
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(configured_port);
    match probe(pid) {
        PidProbe::Dead => AttachDecision::Stale,
        PidProbe::Alive => AttachDecision::Alive { pid, port },
    }
}

async fn classify_existing(
    path: &Path,
    configured_port: u16,
    log: &dyn EmbeddedPgLog,
) -> Result<AttachDecision> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AttachDecision::Missing);
        }
        Err(error) => return Err(error.into()),
    };
    let decision = classify_text(&text, configured_port, probe_lock_pid);
    if let AttachDecision::Alive { pid, port } = &decision {
        log.info(&format!(
            "embedded postgres: attaching to owner pid {pid} on 127.0.0.1:{port}"
        ));
    }
    Ok(decision)
}

async fn create_exclusive(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    options.open(path).await
}

pub async fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if connect_once(port).await {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn connect_once(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(address),
        )
        .await,
        Ok(Ok(_))
    )
}

#[cfg(unix)]
fn pid_is_alive(pid: i32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    if pid <= 0 {
        return false;
    }
    match kill(Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(Errno::ESRCH) => false,
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn pid_is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output();
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()),
        Err(_) => true,
    }
}

enum LockTry {
    Busy,
    Failed(std::io::Error),
}

#[cfg(unix)]
type HeldLock = nix::fcntl::Flock<std::fs::File>;
#[cfg(not(unix))]
type HeldLock = std::fs::File;

#[derive(Debug)]
pub struct FileLock {
    path: PathBuf,
    file: Option<HeldLock>,
}

impl FileLock {
    pub async fn acquire(path: &Path, timeout: Duration, busy: String) -> Result<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await?;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let owned = path.to_path_buf();
        loop {
            let attempt = owned.clone();
            let outcome = tokio::task::spawn_blocking(move || try_file_lock(&attempt))
                .await
                .map_err(|error| LocalDbError::message(error.to_string()))?;
            match outcome {
                Ok(lock) => return Ok(lock),
                Err(LockTry::Busy) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(LocalDbError::message(busy));
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(LockTry::Failed(error)) => return Err(error.into()),
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let Some(file) = self.file.take() else {
            return;
        };
        release_file_lock(file, &self.path);
    }
}

fn write_lock_owner(file: &mut std::fs::File) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    writeln!(file, "{}", std::process::id())?;
    file.sync_all()
}

#[cfg(unix)]
fn try_file_lock(path: &Path) -> std::result::Result<FileLock, LockTry> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600);
    let mut file = options.open(path).map_err(LockTry::Failed)?;
    let mut locked = loop {
        match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
            Ok(locked) => break locked,
            Err((returned, nix::errno::Errno::EINTR)) => {
                file = returned;
            }
            Err((_, errno))
                if errno == nix::errno::Errno::EWOULDBLOCK
                    || errno == nix::errno::Errno::EAGAIN =>
            {
                return Err(LockTry::Busy);
            }
            Err((_, errno)) => {
                return Err(LockTry::Failed(std::io::Error::other(errno.to_string())));
            }
        }
    };
    if !held_matches_path(&locked, path) {
        let _ = locked.unlock();
        return Err(LockTry::Busy);
    }
    if let Err(error) = write_lock_owner(&mut locked) {
        let _ = locked.unlock();
        return Err(LockTry::Failed(error));
    }
    if !held_matches_path(&locked, path) {
        let _ = locked.unlock();
        return Err(LockTry::Busy);
    }
    Ok(FileLock {
        path: path.to_path_buf(),
        file: Some(locked),
    })
}

#[cfg(unix)]
fn held_matches_path(file: &HeldLock, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (file.metadata(), std::fs::metadata(path)) {
        (Ok(ours), Ok(current)) => ours.dev() == current.dev() && ours.ino() == current.ino(),
        _ => false,
    }
}

#[cfg(unix)]
fn release_file_lock(file: HeldLock, _path: &Path) {
    let _ = file.unlock();
}

#[cfg(not(unix))]
fn try_file_lock(path: &Path) -> std::result::Result<FileLock, LockTry> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(LockTry::Failed)?;
    if let Err(error) = write_lock_owner(&mut file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(LockTry::Failed(error));
    }
    drop(file);
    match std::fs::hard_link(&tmp, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&tmp);
            let held = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .map_err(LockTry::Failed)?;
            Ok(FileLock {
                path: path.to_path_buf(),
                file: Some(held),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&tmp);
            if lock_text_is_dead(path) {
                let _ = std::fs::remove_file(path);
            }
            Err(LockTry::Busy)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            Err(LockTry::Failed(error))
        }
    }
}

#[cfg(not(unix))]
fn lock_text_is_dead(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return true;
    };
    let Ok(pid) = text.trim().parse::<i64>() else {
        return true;
    };
    probe_lock_pid(pid) == PidProbe::Dead
}

#[cfg(not(unix))]
fn release_file_lock(file: HeldLock, path: &Path) {
    let _ = file;
    let ours = std::process::id().to_string();
    if std::fs::read_to_string(path).ok().as_deref() == Some(ours.as_str())
        || std::fs::read_to_string(path)
            .ok()
            .is_some_and(|text| text.trim() == ours)
    {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    struct CollectLog(Mutex<Vec<String>>);

    impl EmbeddedPgLog for CollectLog {
        fn info(&self, message: &str) {
            self.0.lock().push(format!("info:{message}"));
        }

        fn warn(&self, message: &str) {
            self.0.lock().push(format!("warn:{message}"));
        }

        fn error(&self, message: &str) {
            self.0.lock().push(format!("error:{message}"));
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "local-db-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp");
        dir
    }

    #[test]
    fn classify_matches_typescript_attach_rules() {
        let stale_json = classify_text("not-json", 5433, |_| PidProbe::Alive);
        assert_eq!(stale_json, AttachDecision::Stale);
        let bad_pid = classify_text(r#"{"pid":0,"port":5433}"#, 5433, |_| PidProbe::Alive);
        assert_eq!(bad_pid, AttachDecision::Stale);
        let fractional = classify_text(r#"{"pid":1.5,"port":5433}"#, 5433, |_| PidProbe::Alive);
        assert_eq!(fractional, AttachDecision::Stale);
        let dead = classify_text(r#"{"pid":42,"port":5433}"#, 5433, |_| PidProbe::Dead);
        assert_eq!(dead, AttachDecision::Stale);
        let alive = classify_text(r#"{"pid":42,"port":6000,"startedAt":"t"}"#, 5433, |_| {
            PidProbe::Alive
        });
        assert_eq!(
            alive,
            AttachDecision::Alive {
                pid: 42,
                port: 6000
            }
        );
        let missing_port = classify_text(r#"{"pid":7}"#, 5433, |_| PidProbe::Alive);
        assert_eq!(missing_port, AttachDecision::Alive { pid: 7, port: 5433 });
    }

    #[test]
    fn read_lock_requires_numeric_pid_and_port() {
        let dir = temp_dir("read-lock");
        assert!(read_embedded_pg_lock(&dir).is_none());
        std::fs::write(lock_path(&dir), "nope").expect("write");
        assert!(read_embedded_pg_lock(&dir).is_none());
        std::fs::write(
            lock_path(&dir),
            r#"{"pid":15,"port":5433,"startedAt":"2026-01-02T03:04:05.006Z"}"#,
        )
        .expect("write");
        let lock = read_embedded_pg_lock(&dir).expect("lock");
        assert_eq!(lock.pid, 15);
        assert_eq!(lock.port, 5433);
        assert_eq!(lock.started_at, "2026-01-02T03:04:05.006Z");
        std::fs::write(lock_path(&dir), r#"{"pid":15,"port":5433}"#).expect("write");
        assert_eq!(read_embedded_pg_lock(&dir).expect("lock").started_at, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn this_process_is_alive_and_an_unused_pid_is_dead() {
        assert_eq!(
            probe_lock_pid(i64::from(std::process::id())),
            PidProbe::Alive
        );
        assert_eq!(probe_lock_pid(i32::MAX.into()), PidProbe::Dead);
        assert_eq!(probe_lock_pid(0), PidProbe::Alive);
    }

    #[tokio::test]
    async fn stale_lock_is_replaced_and_a_live_lock_attaches() {
        let dir = temp_dir("claim");
        std::fs::write(lock_path(&dir), "{").expect("write");
        let log = CollectLog(Mutex::new(Vec::new()));
        let claim = claim_owner_lock(&dir, 5433, &log, Duration::from_millis(50))
            .await
            .expect("claim");
        assert!(matches!(claim, LockClaim::Owned { .. }));
        let owned = read_embedded_pg_lock(&dir).expect("lock");
        assert_eq!(owned.pid, i64::from(std::process::id()));
        assert!(embedded_pg_lock_alive(&owned));
        assert!(owned.started_at.contains('T'));
        assert!(owned.started_at.ends_with('Z'));

        let other = temp_dir("claim-live");
        std::fs::create_dir_all(&other).expect("dir");
        std::fs::write(
            lock_path(&other),
            serde_json::json!({
                "pid": std::process::id(),
                "port": 5433,
                "startedAt": "t"
            })
            .to_string(),
        )
        .expect("write");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::fs::write(
            lock_path(&other),
            serde_json::json!({
                "pid": std::process::id(),
                "port": port,
                "startedAt": "t"
            })
            .to_string(),
        )
        .expect("write");
        let attached = claim_owner_lock(&other, 5433, &log, Duration::from_secs(2))
            .await
            .expect("attach");
        match attached {
            LockClaim::Attached {
                pid,
                port: got,
                pg_url,
            } => {
                assert_eq!(pid, i64::from(std::process::id()));
                assert_eq!(got, port);
                assert_eq!(pg_url, embedded_pg_url(i64::from(port)));
            }
            LockClaim::Owned { .. } => panic!("expected attach"),
        }
        let lines = log.0.lock();
        assert!(
            lines
                .iter()
                .any(|line| line.contains("attaching to owner pid"))
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("using the owner's port"))
        );
        drop(listener);
        drop(lines);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[tokio::test]
    async fn live_lock_with_nothing_listening_errors_with_the_typescript_text() {
        let dir = temp_dir("claim-dead-port");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        std::fs::write(
            lock_path(&dir),
            serde_json::json!({
                "pid": std::process::id(),
                "port": port,
                "startedAt": "t"
            })
            .to_string(),
        )
        .expect("write");
        let log = TracingLog;
        let error = claim_owner_lock(&dir, port, &log, Duration::from_millis(300))
            .await
            .expect_err("timeout");
        let text = error.to_string();
        assert!(text.contains("holds"));
        assert!(text.contains("nothing listens on 127.0.0.1:"));
        assert!(text.contains("if that process is dead, remove the lock"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_lock_waits_out_an_empty_publication_and_recovers_a_dead_holder() {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let dir = temp_dir("file-lock");
        let path = dir.join("migrated-sources.lock");
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .expect("open");
        let held = match nix::fcntl::Flock::lock(held, nix::fcntl::FlockArg::LockExclusiveNonblock)
        {
            Ok(locked) => locked,
            Err((_, errno)) => panic!("flock {errno}"),
        };
        held.set_len(0).expect("truncate");
        let started = std::time::Instant::now();
        let error = FileLock::acquire(&path, Duration::from_millis(200), "lock busy".to_string())
            .await
            .expect_err("held");
        assert_eq!(error.to_string(), "lock busy");
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(std::fs::read(&path).expect("empty"), b"");
        drop(held);
        std::fs::write(&path, format!("{}\n", std::process::id())).expect("reused pid");
        let recovered =
            FileLock::acquire(&path, Duration::from_millis(500), "lock busy".to_string())
                .await
                .expect("recovered");
        let text = std::fs::read_to_string(&path).expect("pid");
        assert_eq!(text.trim(), std::process::id().to_string());
        let inode = std::fs::metadata(&path).expect("meta").ino();
        drop(recovered);
        let kept = std::fs::metadata(&path).expect("lock file stays");
        assert_eq!(kept.ino(), inode);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_lock_keeps_one_inode_so_an_open_holder_blocks_a_new_path() {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let dir = temp_dir("file-lock-handoff");
        let path = dir.join("migrated-sources.lock");
        let first = FileLock::acquire(&path, Duration::from_secs(1), "lock busy".to_string())
            .await
            .expect("first");
        let inode = std::fs::metadata(&path).expect("meta").ino();
        let opened = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .expect("open");
        assert_eq!(opened.metadata().expect("open meta").ino(), inode);
        drop(first);
        assert_eq!(std::fs::metadata(&path).expect("still").ino(), inode);
        let held =
            match nix::fcntl::Flock::lock(opened, nix::fcntl::FlockArg::LockExclusiveNonblock) {
                Ok(locked) => locked,
                Err((_, errno)) => panic!("opened lock {errno}"),
            };
        let started = std::time::Instant::now();
        let error = FileLock::acquire(&path, Duration::from_millis(200), "lock busy".to_string())
            .await
            .expect_err("overlap");
        assert_eq!(error.to_string(), "lock busy");
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert_eq!(std::fs::metadata(&path).expect("same").ino(), inode);
        drop(held);
        let third = FileLock::acquire(&path, Duration::from_secs(1), "lock busy".to_string())
            .await
            .expect("third");
        assert_eq!(std::fs::metadata(&path).expect("third meta").ino(), inode);
        drop(third);
        assert_eq!(std::fs::metadata(&path).expect("after").ino(), inode);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
