use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::AsyncReadExt;

use crate::error::{LocalDbError, Result};
use crate::lock::{EmbeddedPgLog, PidProbe, probe_lock_pid};
use crate::paths::{lexical_absolute, real_or_lexical};

const START_TOLERANCE_SECS: i64 = 5;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostmasterPid {
    pub pid: i64,
    pub data_dir: PathBuf,
    pub started_at: i64,
}

pub fn read_postmaster_pid(pgdata: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(pgdata.join("postmaster.pid")).ok()?;
    let line = text.lines().next()?.trim();
    let pid = line.parse::<i64>().ok()?;
    if pid > 0 { Some(pid) } else { None }
}

pub fn parse_postmaster_pid(text: &str) -> Option<PostmasterPid> {
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse::<i64>().ok()?;
    if pid <= 0 {
        return None;
    }
    let data_dir = PathBuf::from(lines.next()?.trim());
    if data_dir.as_os_str().is_empty() {
        return None;
    }
    let started_at = lines.next()?.trim().parse::<i64>().ok()?;
    Some(PostmasterPid {
        pid,
        data_dir,
        started_at,
    })
}

pub fn identity_proven(
    recorded_dir: &Path,
    pgdata: &Path,
    recorded_start: i64,
    process_start: Option<i64>,
) -> bool {
    if !same_data_dir(recorded_dir, pgdata) {
        return false;
    }
    let Some(process_start) = process_start else {
        return false;
    };
    (process_start - recorded_start).abs() <= START_TOLERANCE_SECS
}

pub fn process_started_at(pid: i32) -> Option<i64> {
    if pid <= 0 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        linux_started_at(pid)
    }
    #[cfg(target_os = "macos")]
    {
        macos_started_at(pid)
    }
    #[cfg(windows)]
    {
        windows_started_at(pid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        None
    }
}

pub async fn clear_stale_postmaster(
    pgdata: &Path,
    pg_ctl: Option<&Path>,
    log: &dyn EmbeddedPgLog,
) -> Result<()> {
    let pid_path = pgdata.join("postmaster.pid");
    if !pid_path.exists() {
        return Ok(());
    }
    let text = match tokio::fs::read_to_string(&pid_path).await {
        Ok(text) => text,
        Err(_) => return remove_pid(&pid_path).await,
    };
    let Some(parsed) = parse_postmaster_pid(&text) else {
        if let Some(pid) = first_line_pid(&text)
            && probe_lock_pid(pid) != PidProbe::Dead
        {
            return Err(refuse(pid));
        }
        log.warn(&format!(
            "embedded postgres: removing unreadable postmaster.pid at {}",
            pid_path.display()
        ));
        return remove_pid(&pid_path).await;
    };
    if probe_lock_pid(parsed.pid) == PidProbe::Dead {
        log.info(&format!(
            "embedded postgres: removing stale postmaster.pid for dead pid {}",
            parsed.pid
        ));
        return remove_pid(&pid_path).await;
    }
    let started = match i32::try_from(parsed.pid) {
        Ok(native) => tokio::task::spawn_blocking(move || process_started_at(native))
            .await
            .ok()
            .flatten(),
        Err(_) => None,
    };
    let proven = identity_proven(&parsed.data_dir, pgdata, parsed.started_at, started);
    if !proven {
        return Err(refuse(parsed.pid));
    }
    log.warn(&format!(
        "embedded postgres: stopping stray postmaster pid {} for {}",
        parsed.pid,
        pgdata.display()
    ));
    stop_proven(parsed.pid, pgdata, pg_ctl).await?;
    remove_pid(&pid_path).await
}

fn refuse(pid: i64) -> LocalDbError {
    LocalDbError::message(format!(
        "embedded postgres: postmaster.pid pid {pid} is alive but is not a postgres process; refusing to signal it"
    ))
}

fn first_line_pid(text: &str) -> Option<i64> {
    let pid = text.lines().next()?.trim().parse::<i64>().ok()?;
    if pid > 0 { Some(pid) } else { None }
}

async fn stop_proven(pid: i64, pgdata: &Path, pg_ctl: Option<&Path>) -> Result<()> {
    if let Some(pg_ctl) = pg_ctl {
        return crate::supervisor::stop_cluster(pg_ctl, pgdata).await;
    }
    let Some(native) = i32::try_from(pid).ok() else {
        return Err(refuse(pid));
    };
    signal_interrupt(native)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if probe_lock_pid(pid) == PidProbe::Dead {
            return Ok(());
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

fn same_data_dir(recorded: &Path, pgdata: &Path) -> bool {
    real_or_lexical(recorded) == real_or_lexical(pgdata)
        || lexical_absolute(recorded) == lexical_absolute(pgdata)
}

#[cfg(target_os = "linux")]
fn linux_started_at(pid: i32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks = stat_start_ticks(&stat)?;
    let btime = btime_secs()?;
    Some(btime + i64::try_from(ticks / 100).ok()?)
}

#[cfg(target_os = "linux")]
fn stat_start_ticks(stat: &str) -> Option<u64> {
    let end = stat.rfind(')')?;
    let fields: Vec<&str> = stat[end + 1..].split_whitespace().collect();
    fields.get(19)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn btime_secs() -> Option<i64> {
    let text = std::fs::read_to_string("/proc/stat").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("btime ") {
            return rest.trim().parse().ok();
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_started_at(pid: i32) -> Option<i64> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "etime="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let elapsed = parse_etime(&String::from_utf8_lossy(&output.stdout))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    i64::try_from(now).ok().map(|now| now - elapsed)
}

#[cfg(any(test, target_os = "macos"))]
fn parse_etime(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (days, rest) = if let Some((days, rest)) = text.split_once('-') {
        (days.parse::<i64>().ok()?, rest)
    } else {
        (0, text)
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let seconds = match parts.as_slice() {
        [minutes, seconds] => minutes.parse::<i64>().ok()? * 60 + seconds.parse::<i64>().ok()?,
        [hours, minutes, seconds] => {
            hours.parse::<i64>().ok()? * 3600
                + minutes.parse::<i64>().ok()? * 60
                + seconds.parse::<i64>().ok()?
        }
        _ => return None,
    };
    Some(days * 86_400 + seconds)
}

#[cfg(windows)]
fn windows_started_at(pid: i32) -> Option<i64> {
    let script = format!(
        "(Get-Process -Id {pid}).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01Z').TotalSeconds"
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let seconds: f64 = text.trim().parse().ok()?;
    if !seconds.is_finite() {
        return None;
    }
    Some(seconds.floor() as i64)
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
        std::fs::write(
            &pid_path,
            format!("{}\n{dir}\n1\n", i32::MAX, dir = dir.display()),
        )
        .expect("pid");
        clear_stale_postmaster(&dir, None, &TracingLog)
            .await
            .expect("clear");
        assert!(!pid_path.exists());
        std::fs::write(&pid_path, format!("{}\n", std::process::id())).expect("pid");
        let error = clear_stale_postmaster(&dir, None, &TracingLog)
            .await
            .expect_err("refuse");
        assert!(error.to_string().contains("refusing to signal"));
        assert!(pid_path.exists());
        std::fs::write(
            &pid_path,
            format!("{}\n{}\n0\n", std::process::id(), dir.display()),
        )
        .expect("pid");
        let error = clear_stale_postmaster(&dir, None, &TracingLog)
            .await
            .expect_err("unproven");
        assert!(error.to_string().contains("refusing to signal"));
        assert!(pid_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_uses_the_data_directory_and_start_time() {
        let dir = Path::new("/tmp/pgdata");
        let other = Path::new("/tmp/other");
        assert!(identity_proven(dir, dir, 100, Some(100)));
        assert!(identity_proven(dir, dir, 100, Some(104)));
        assert!(!identity_proven(dir, dir, 100, Some(106)));
        assert!(!identity_proven(dir, other, 100, Some(100)));
        assert!(!identity_proven(dir, dir, 100, None));
        let parsed = parse_postmaster_pid("4242\n/tmp/pgdata\n1700000000\n5433\n");
        let parsed = parsed.expect("parsed");
        assert_eq!(parsed.pid, 4242);
        assert_eq!(parsed.data_dir, PathBuf::from("/tmp/pgdata"));
        assert_eq!(parsed.started_at, 1_700_000_000);
        assert!(parse_postmaster_pid("4242\n").is_none());
    }

    #[test]
    fn this_process_has_a_start_time_on_a_supported_platform() {
        let started = process_started_at(std::process::id() as i32);
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        assert!(started.is_some());
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        assert!(started.is_none());
    }

    #[test]
    fn etime_parses_the_ps_layouts() {
        assert_eq!(parse_etime("00:05"), Some(5));
        assert_eq!(parse_etime("01:02:03"), Some(3723));
        assert_eq!(parse_etime("2-01:02:03"), Some(2 * 86_400 + 3723));
        assert_eq!(parse_etime("nope"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stat_start_ticks_reads_past_a_comm_with_spaces() {
        let stat = "12 (postgres worker) S 1 12 12 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 150 1";
        assert_eq!(stat_start_ticks(stat), Some(150));
    }
}
