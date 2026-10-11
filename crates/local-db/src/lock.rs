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
}
