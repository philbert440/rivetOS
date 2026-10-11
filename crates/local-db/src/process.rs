use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::AsyncReadExt;

use crate::error::{LocalDbError, Result};
use crate::lock::{EmbeddedPgLog, PidProbe, probe_lock_pid};
use crate::paths::{lexical_absolute, real_or_lexical};

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
}

pub fn read_postmaster_pid(pgdata: &Path) -> Option<i64> {
    let text = protocol::host::read_text(&pgdata.join("postmaster.pid")).ok()?;
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
    lines.next()?.trim().parse::<i64>().ok()?;
    Some(PostmasterPid { pid, data_dir })
}

pub fn identity_proven(process_dir: &Path, pgdata: &Path) -> bool {
    same_data_dir(process_dir, pgdata)
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
    let read_path = pid_path.clone();
    let text =
        match tokio::task::spawn_blocking(move || protocol::host::read_text(&read_path)).await {
            Ok(Ok(text)) => text,
            _ => return remove_pid(&pid_path).await,
        };
    let Some(parsed) = parse_postmaster_pid(&text) else {
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
    if postmaster_is_ours(parsed.pid, pgdata).await {
        log.warn(&format!(
            "embedded postgres: stopping stray postmaster pid {} for {}",
            parsed.pid,
            pgdata.display()
        ));
        stop_proven(parsed.pid, pgdata, pg_ctl).await?;
    } else {
        log.warn(&format!(
            "embedded postgres: removing postmaster.pid for live pid {} that is not this cluster's postgres",
            parsed.pid
        ));
    }
    remove_pid(&pid_path).await
}

async fn postmaster_is_ours(pid: i64, pgdata: &Path) -> bool {
    let Ok(native) = i32::try_from(pid) else {
        return false;
    };
    let joined = tokio::task::spawn_blocking(move || postgres_data_dir(native)).await;
    let Ok(found) = joined else {
        return false;
    };
    let Some(data_dir) = found else {
        return false;
    };
    identity_proven(&data_dir, pgdata)
}

async fn stop_proven(pid: i64, pgdata: &Path, pg_ctl: Option<&Path>) -> Result<()> {
    if let Some(pg_ctl) = pg_ctl {
        return crate::supervisor::stop_cluster(pg_ctl, pgdata).await;
    }
    let native = match i32::try_from(pid) {
        Ok(native) => native,
        Err(_) => {
            return Err(LocalDbError::message(format!(
                "embedded postgres: postmaster pid {pid} does not fit this platform"
            )));
        }
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
fn executable_name(pid: i32) -> Option<String> {
    let link = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let mut text = link.to_string_lossy().into_owned();
    if let Some(stripped) = text.strip_suffix(" (deleted)") {
        text = stripped.to_string();
    }
    Path::new(&text)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

#[cfg(target_os = "linux")]
fn postgres_data_dir(pid: i32) -> Option<PathBuf> {
    let name = executable_name(pid)?;
    if name != "postgres" && name != "postgres.exe" {
        return None;
    }
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
fn postgres_data_dir(pid: i32) -> Option<PathBuf> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let comm = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let name = Path::new(&comm).file_name()?.to_str()?;
    if name != "postgres" && name != "postgres.exe" {
        return None;
    }
    let listed = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !listed.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&listed.stdout);
    for line in text.lines() {
        if let Some(path) = line.strip_prefix('n')
            && !path.is_empty()
        {
            return Some(PathBuf::from(path));
        }
    }
    None
}

#[cfg(windows)]
fn postgres_data_dir(pid: i32) -> Option<PathBuf> {
    let script = format!(
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\"; if ($null -ne $p) {{ Write-Output $p.ExecutablePath; Write-Output $p.CommandLine }}"
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let exe = lines.next()?.trim();
    let command = lines.next()?.trim();
    let name = Path::new(exe).file_name()?.to_str()?;
    if name != "postgres" && name != "postgres.exe" {
        return None;
    }
    data_dir_flag(command)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn postgres_data_dir(_pid: i32) -> Option<PathBuf> {
    None
}

#[cfg(any(windows, test))]
fn data_dir_flag(command: &str) -> Option<PathBuf> {
    let tokens = argv_tokens(command);
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "-D" {
            return tokens.get(index + 1).map(PathBuf::from);
        }
        if let Some(path) = token.strip_prefix("-D")
            && !path.is_empty()
        {
            return Some(PathBuf::from(path));
        }
        index += 1;
    }
    None
}

#[cfg(any(windows, test))]
fn argv_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        match quote {
            Some(mark) if ch == mark => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
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
    async fn dead_postmaster_pid_is_removed_and_a_live_non_postgres_pid_is_removed() {
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
        clear_stale_postmaster(&dir, None, &TracingLog)
            .await
            .expect("live short pid");
        assert!(!pid_path.exists());
        std::fs::write(
            &pid_path,
            format!("{}\n{}\n0\n", std::process::id(), dir.display()),
        )
        .expect("pid");
        clear_stale_postmaster(&dir, None, &TracingLog)
            .await
            .expect("live unproven");
        assert!(!pid_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_uses_the_process_data_directory() {
        let dir = Path::new("/tmp/pgdata");
        let other = Path::new("/tmp/other");
        assert!(identity_proven(dir, dir));
        assert!(!identity_proven(other, dir));
        let parsed = parse_postmaster_pid("4242\n/tmp/pgdata\n1700000000\n5433\n");
        let parsed = parsed.expect("parsed");
        assert_eq!(parsed.pid, 4242);
        assert_eq!(parsed.data_dir, PathBuf::from("/tmp/pgdata"));
        assert!(parse_postmaster_pid("4242\n").is_none());
        assert!(parse_postmaster_pid("4242\n/tmp/pgdata\n").is_none());
        assert!(parse_postmaster_pid("4242\n/tmp/pgdata\nnot-a-time\n").is_none());
    }

    #[test]
    fn this_process_is_not_a_postgres_postmaster() {
        let pid = i32::try_from(std::process::id()).expect("pid");
        assert!(postgres_data_dir(pid).is_none());
    }

    #[test]
    fn data_directory_flag_is_a_discrete_argv_token() {
        assert_eq!(
            data_dir_flag("postgres -D /tmp/pg data"),
            Some(PathBuf::from("/tmp/pg"))
        );
        assert_eq!(
            data_dir_flag("postgres -D \"/tmp/my cluster\""),
            Some(PathBuf::from("/tmp/my cluster"))
        );
        assert_eq!(
            data_dir_flag("postgres -D/tmp/pgdata -c listen_addresses=127.0.0.1"),
            Some(PathBuf::from("/tmp/pgdata"))
        );
        assert_eq!(data_dir_flag("postgres --describe-config"), None);
    }
}
