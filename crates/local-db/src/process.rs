use std::path::Path;
use std::time::Duration;

use tokio::io::AsyncReadExt;

use crate::error::{LocalDbError, Result};
use crate::lock::{EmbeddedPgLog, PidProbe, probe_lock_pid};

pub async fn wait_child(mut child: tokio::process::Child, timeout: Duration) -> Result<()> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let joined = tokio::time::timeout(timeout, async {
        let read_out = async {
            let mut buf = Vec::new();
            if let Some(pipe) = stdout.as_mut() {
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        let read_err = async {
            let mut buf = Vec::new();
            if let Some(pipe) = stderr.as_mut() {
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        let (status, out_buf, err_buf) = tokio::join!(child.wait(), read_out, read_err);
        (status, out_buf, err_buf)
    })
    .await;
    match joined {
        Err(_) => {
            drop(stdout);
            drop(stderr);
            Err(LocalDbError::Timeout(timeout))
        }
        Ok((Ok(status), out_buf, err_buf)) => {
            if status.success() {
                Ok(())
            } else {
                let err_text = String::from_utf8_lossy(&err_buf);
                let out_text = String::from_utf8_lossy(&out_buf);
                let code = status.code().unwrap_or(-1);
                Err(LocalDbError::message(format!(
                    "embedded postgres: command exited {code}: {err_text}{out_text}"
                )))
            }
        }
        Ok((Err(error), _, _)) => Err(error.into()),
    }
}

pub fn read_postmaster_pid(pgdata: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(pgdata.join("postmaster.pid")).ok()?;
    let line = text.lines().next()?.trim();
    let pid = line.parse::<i64>().ok()?;
    if pid > 0 { Some(pid) } else { None }
}

pub async fn clear_stale_postmaster(pgdata: &Path, log: &dyn EmbeddedPgLog) -> Result<()> {
    let pid_path = pgdata.join("postmaster.pid");
    if !pid_path.exists() {
        return Ok(());
    }
    let Some(pid) = read_postmaster_pid(pgdata) else {
        log.warn(&format!(
            "embedded postgres: removing unreadable postmaster.pid at {}",
            pid_path.display()
        ));
        return remove_pid(&pid_path).await;
    };
    if probe_lock_pid(pid) == PidProbe::Dead {
        log.info(&format!(
            "embedded postgres: removing stale postmaster.pid for dead pid {pid}"
        ));
        return remove_pid(&pid_path).await;
    }
    let Some(native) = i32::try_from(pid).ok() else {
        return Err(LocalDbError::message(format!(
            "embedded postgres: postmaster.pid pid {pid} is alive but is not a postgres process; refusing to signal it"
        )));
    };
    if !cmdline_is_postgres(native).await {
        return Err(LocalDbError::message(format!(
            "embedded postgres: postmaster.pid pid {pid} is alive but is not a postgres process; refusing to signal it"
        )));
    }
    log.warn(&format!(
        "embedded postgres: stopping stray postmaster pid {pid} with SIGINT"
    ));
    signal_interrupt(native)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if probe_lock_pid(pid) == PidProbe::Dead {
            return remove_pid(&pid_path).await;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(LocalDbError::message(format!(
                "embedded postgres: postmaster pid {pid} did not exit after SIGINT"
            )));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn remove_pid(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn cmdline_is_postgres(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let bytes = match tokio::fs::read(format!("/proc/{pid}/cmdline")).await {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
    text.contains("postgres") || text.contains("postmaster")
}

#[cfg(unix)]
fn signal_interrupt(pid: i32) -> Result<()> {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid), Some(Signal::SIGINT)).map_err(|error| {
        LocalDbError::message(format!(
            "embedded postgres: failed to signal postmaster pid {pid}: {error}"
        ))
    })
}

#[cfg(not(unix))]
fn signal_interrupt(pid: i32) -> Result<()> {
    Err(LocalDbError::message(format!(
        "embedded postgres: cannot signal postmaster pid {pid} on this platform"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::TracingLog;

    #[tokio::test]
    async fn dead_postmaster_pid_is_removed_and_a_live_non_postgres_pid_is_kept() {
        let dir = std::env::temp_dir().join(format!(
            "local-db-pid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let pid_path = dir.join("postmaster.pid");
        std::fs::write(&pid_path, format!("{}\n", i32::MAX)).expect("pid");
        clear_stale_postmaster(&dir, &TracingLog)
            .await
            .expect("clear");
        assert!(!pid_path.exists());
        std::fs::write(&pid_path, format!("{}\n", std::process::id())).expect("pid");
        let error = clear_stale_postmaster(&dir, &TracingLog)
            .await
            .expect_err("refuse");
        assert!(error.to_string().contains("refusing to signal"));
        assert!(pid_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
