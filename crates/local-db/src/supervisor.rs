use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{LocalDbError, Result};
use crate::lock::EMBEDDED_PG_LOCKFILE;
use crate::paths::shell_quote;
use crate::process::wait_child;

pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(90);
const STOP_FAST_SECS: u64 = 30;
const STOP_IMMEDIATE_SECS: u64 = 20;
const READY_TIMEOUT: Duration = Duration::from_secs(150);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterStart {
    pub pg_ctl: PathBuf,
    pub pgdata: PathBuf,
    pub port: u16,
    pub timeout: Duration,
    pub configuration: BTreeMap<String, String>,
}

pub struct SupervisorProcess {
    pub lifeline: Option<tokio::process::ChildStdin>,
    pub child: tokio::process::Child,
}

pub fn pg_ctl_name() -> String {
    format!("pg_ctl{}", std::env::consts::EXE_SUFFIX)
}

pub fn find_pg_ctl(installation_dir: &Path) -> Option<PathBuf> {
    let name = pg_ctl_name();
    let direct = installation_dir.join("bin").join(&name);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(installation_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("bin").join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn supervisor_program() -> Result<PathBuf> {
    let current = std::env::current_exe()?;
    if is_supervisor_host(&current) {
        return Ok(current);
    }
    if let Some(found) = sibling_local_db(&current) {
        return Ok(found);
    }
    Ok(current)
}

pub async fn spawn_supervisor(start: &ClusterStart) -> Result<SupervisorProcess> {
    let program = supervisor_program()?;
    let mut command = tokio::process::Command::new(&program);
    command
        .arg("pg-supervisor")
        .arg("--pgdata")
        .arg(&start.pgdata)
        .arg("--pg-ctl")
        .arg(&start.pg_ctl)
        .arg("--port")
        .arg(start.port.to_string())
        .arg("--timeout-secs")
        .arg(start.timeout.as_secs().max(1).to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    for (key, value) in &start.configuration {
        command.arg("--config").arg(format!("{key}={value}"));
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        LocalDbError::message(format!(
            "embedded postgres: failed to spawn supervisor {}: {error}",
            program.display()
        ))
    })?;
    let lifeline = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let ready = wait_ready(&mut child, &mut stdout, &mut stderr).await;
    if let Err(error) = ready {
        let _ = stop_cluster(&start.pg_ctl, &start.pgdata).await;
        let _ = child.start_kill();
        return Err(error);
    }
    let Some(lifeline) = lifeline else {
        let _ = child.start_kill();
        return Err(LocalDbError::message(
            "embedded postgres: supervisor lifeline was not created",
        ));
    };
    Ok(SupervisorProcess {
        lifeline: Some(lifeline),
        child,
    })
}

impl SupervisorProcess {
    pub async fn shutdown(&mut self, pg_ctl: &Path, pgdata: &Path) -> Result<()> {
        self.lifeline.take();
        match tokio::time::timeout(CLOSE_TIMEOUT, self.child.wait()).await {
            Ok(Ok(status)) if status.success() || postmaster_exited(pgdata) => Ok(()),
            Ok(Ok(status)) => {
                let _ = stop_cluster(pg_ctl, pgdata).await;
                Err(LocalDbError::message(format!(
                    "embedded postgres: supervisor exited {}",
                    status.code().unwrap_or(-1)
                )))
            }
            Ok(Err(error)) => Err(error.into()),
            Err(_) => {
                let _ = stop_cluster(pg_ctl, pgdata).await;
                let _ = self.child.start_kill();
                Err(LocalDbError::Timeout(CLOSE_TIMEOUT))
            }
        }
    }
}

pub async fn stop_cluster(pg_ctl: &Path, pgdata: &Path) -> Result<()> {
    let _ = pg_ctl_stop(pg_ctl, pgdata, "fast", STOP_FAST_SECS).await;
    if postmaster_exited(pgdata) {
        return Ok(());
    }
    pg_ctl_stop(pg_ctl, pgdata, "immediate", STOP_IMMEDIATE_SECS).await?;
    if postmaster_exited(pgdata) {
        Ok(())
    } else {
        Err(LocalDbError::message(format!(
            "embedded postgres: postmaster at {} did not exit after pg_ctl stop",
            pgdata.display()
        )))
    }
}

pub fn run_supervisor_args<I>(args: I) -> i32
where
    I: Iterator<Item = String>,
{
    let start = match parse_supervisor_args(args) {
        Ok(start) => start,
        Err(error) => {
            eprintln!("embedded postgres: {error}");
            return 2;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("embedded postgres: {error}");
            return 1;
        }
    };
    match runtime.block_on(supervise(start)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("embedded postgres: {error}");
            1
        }
    }
}

pub fn parse_supervisor_args<I>(args: I) -> Result<ClusterStart>
where
    I: Iterator<Item = String>,
{
    let mut pgdata = None;
    let mut pg_ctl = None;
    let mut port = None;
    let mut timeout_secs = 120u64;
    let mut configuration = BTreeMap::new();
    let mut rest = args.peekable();
    while let Some(arg) = rest.next() {
        let value = rest.next();
        match arg.as_str() {
            "--pgdata" => pgdata = Some(required_value("--pgdata", value)?),
            "--pg-ctl" => pg_ctl = Some(required_value("--pg-ctl", value)?),
            "--port" => {
                let text = required_value("--port", value)?;
                let parsed = text.parse::<u16>().map_err(|_| {
                    LocalDbError::message(format!(
                        "embedded postgres: supervisor port is not a u16 ({text})"
                    ))
                })?;
                if parsed == 0 {
                    return Err(LocalDbError::message(
                        "embedded postgres: supervisor port must be between 1 and 65535",
                    ));
                }
                port = Some(parsed);
            }
            "--timeout-secs" => {
                let text = required_value("--timeout-secs", value)?;
                timeout_secs = text.parse::<u64>().map_err(|_| {
                    LocalDbError::message(format!(
                        "embedded postgres: supervisor timeout is not an integer ({text})"
                    ))
                })?;
            }
            "--config" => {
                let text = required_value("--config", value)?;
                let Some((key, setting)) = text.split_once('=') else {
                    return Err(LocalDbError::message(format!(
                        "embedded postgres: supervisor config must be key=value ({text})"
                    )));
                };
                if key.is_empty() {
                    return Err(LocalDbError::message(
                        "embedded postgres: supervisor config key is empty",
                    ));
                }
                configuration.insert(key.to_string(), setting.to_string());
            }
            other => {
                return Err(LocalDbError::message(format!(
                    "embedded postgres: unknown supervisor argument {other}"
                )));
            }
        }
    }
    let Some(pgdata) = pgdata else {
        return Err(LocalDbError::message(
            "embedded postgres: supervisor requires --pgdata",
        ));
    };
    let Some(pg_ctl) = pg_ctl else {
        return Err(LocalDbError::message(
            "embedded postgres: supervisor requires --pg-ctl",
        ));
    };
    let Some(port) = port else {
        return Err(LocalDbError::message(
            "embedded postgres: supervisor requires --port",
        ));
    };
    Ok(ClusterStart {
        pg_ctl: PathBuf::from(pg_ctl),
        pgdata: PathBuf::from(pgdata),
        port,
        timeout: Duration::from_secs(timeout_secs.max(1)),
        configuration,
    })
}

async fn supervise(start: ClusterStart) -> Result<()> {
    let started = start_cluster(&start).await;
    let session = if started.is_ok() {
        wait_for_owner().await
    } else {
        started
    };
    let stopped = stop_cluster(&start.pg_ctl, &start.pgdata).await;
    if stopped.is_ok() {
        release_cluster_lock(&start.pgdata).await;
    }
    session?;
    stopped
}

async fn wait_for_owner() -> Result<()> {
    let mut stdout = tokio::io::stdout();
    stdout.write_all(b"ready\n").await?;
    stdout.flush().await?;
    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 256];
    loop {
        match stdin.read(&mut buf).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Ok(())
}

async fn release_cluster_lock(pgdata: &Path) {
    let Some(parent) = pgdata.parent() else {
        return;
    };
    if parent.as_os_str().is_empty() {
        return;
    }
    let path = parent.join(EMBEDDED_PG_LOCKFILE);
    let _ = crate::lock::release_owner_lock(&path).await;
}

fn quoted_config(key: &str, value: &str) -> String {
    format!("-c {key}={}", shell_quote(value))
}

pub async fn start_cluster(start: &ClusterStart) -> Result<()> {
    let mut command = tokio::process::Command::new(&start.pg_ctl);
    command
        .arg("start")
        .arg("--pgdata")
        .arg(&start.pgdata)
        .arg("--log")
        .arg(start.pgdata.join("start.log"))
        .arg("--wait")
        .arg("--timeout")
        .arg(
            start
                .timeout
                .as_secs()
                .clamp(1, u64::from(u16::MAX))
                .to_string(),
        )
        .arg("-o")
        .arg(format!("-F -p {}", start.port));
    for (key, value) in &start.configuration {
        command.arg("-o").arg(quoted_config(key, value));
    }
    command
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = command.spawn().map_err(|error| {
        LocalDbError::message(format!(
            "embedded postgres: failed to start pg_ctl {}: {error}",
            start.pg_ctl.display()
        ))
    })?;
    let timeout = start.timeout + Duration::from_secs(30);
    wait_child(child, timeout)
        .await
        .map_err(|error| match error {
            LocalDbError::Message(text) => {
                LocalDbError::message(format!("embedded postgres: pg_ctl start failed: {text}"))
            }
            other => other,
        })
}

async fn pg_ctl_stop(pg_ctl: &Path, pgdata: &Path, mode: &str, timeout_secs: u64) -> Result<()> {
    let mut command = tokio::process::Command::new(pg_ctl);
    command
        .arg("stop")
        .arg("--pgdata")
        .arg(pgdata)
        .arg("--mode")
        .arg(mode)
        .arg("--wait")
        .arg("--timeout")
        .arg(timeout_secs.to_string())
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = command.spawn().map_err(|error| {
        LocalDbError::message(format!(
            "embedded postgres: failed to run pg_ctl stop: {error}"
        ))
    })?;
    wait_child(child, Duration::from_secs(timeout_secs + 15)).await
}

pub fn postmaster_exited(pgdata: &Path) -> bool {
    let Some(pid) = crate::process::read_postmaster_pid(pgdata) else {
        return true;
    };
    crate::lock::probe_lock_pid(pid) == crate::lock::PidProbe::Dead
}

async fn wait_ready(
    child: &mut tokio::process::Child,
    stdout: &mut Option<tokio::process::ChildStdout>,
    stderr: &mut Option<tokio::process::ChildStderr>,
) -> Result<()> {
    let mut out = String::new();
    let mut err = Vec::new();
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(LocalDbError::Timeout(READY_TIMEOUT));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let slice = remaining.min(Duration::from_millis(200));
        if let Some(pipe) = stderr.as_mut() {
            let mut buf = [0u8; 1024];
            if let Ok(Ok(n)) =
                tokio::time::timeout(Duration::from_millis(1), pipe.read(&mut buf)).await
                && n > 0
            {
                err.extend_from_slice(&buf[..n]);
                if err.len() > 8192 {
                    err.drain(..err.len() - 8192);
                }
            }
        }
        if let Some(pipe) = stdout.as_mut() {
            let mut buf = [0u8; 64];
            match tokio::time::timeout(slice, pipe.read(&mut buf)).await {
                Ok(Ok(0)) => {
                    return Err(supervisor_failed(child, &err).await);
                }
                Ok(Ok(n)) => {
                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if out.len() > 1024 {
                        return Err(LocalDbError::message(
                            "embedded postgres: supervisor ready line is too long",
                        ));
                    }
                    if let Some((line, _)) = out.split_once('\n') {
                        if line.trim() == "ready" {
                            return Ok(());
                        }
                        return Err(LocalDbError::message(format!(
                            "embedded postgres: supervisor sent {line}"
                        )));
                    }
                }
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => {}
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            let detail = String::from_utf8_lossy(&err);
            return Err(LocalDbError::message(format!(
                "embedded postgres: supervisor exited {} before ready: {detail}",
                status.code().unwrap_or(-1)
            )));
        }
    }
}

async fn supervisor_failed(child: &mut tokio::process::Child, err: &[u8]) -> LocalDbError {
    let status = child.wait().await.ok();
    let code = status.and_then(|status| status.code()).unwrap_or(-1);
    let detail = String::from_utf8_lossy(err);
    LocalDbError::message(format!(
        "embedded postgres: supervisor exited {code} before ready: {detail}"
    ))
}

fn required_value(flag: &str, value: Option<String>) -> Result<String> {
    value.ok_or_else(|| LocalDbError::message(format!("embedded postgres: {flag} needs a value")))
}

fn is_supervisor_host(path: &Path) -> bool {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => {
            let base = name
                .strip_suffix(std::env::consts::EXE_SUFFIX)
                .unwrap_or(name);
            base == "local-db" || base == "rivetos"
        }
        None => false,
    }
}

fn sibling_local_db(current: &Path) -> Option<PathBuf> {
    let name = format!("local-db{}", std::env::consts::EXE_SUFFIX);
    let parent = current.parent()?;
    if parent.file_name().is_some_and(|name| name == "deps") {
        let candidate = parent.parent()?.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let candidate = parent.join(&name);
    if candidate.is_file() {
        return Some(candidate);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_args_round_trip_config_without_a_password() {
        let start = parse_supervisor_args(
            [
                "--pgdata",
                "/data/pgdata",
                "--pg-ctl",
                "/bin/pg_ctl",
                "--port",
                "5433",
                "--timeout-secs",
                "15",
                "--config",
                "max_connections=4",
                "--config",
                "listen_addresses=127.0.0.1",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .expect("args");
        assert_eq!(start.pgdata, PathBuf::from("/data/pgdata"));
        assert_eq!(start.pg_ctl, PathBuf::from("/bin/pg_ctl"));
        assert_eq!(start.port, 5433);
        assert_eq!(start.timeout, Duration::from_secs(15));
        assert_eq!(
            start
                .configuration
                .get("max_connections")
                .map(String::as_str),
            Some("4")
        );
        assert_eq!(
            start
                .configuration
                .get("listen_addresses")
                .map(String::as_str),
            Some("127.0.0.1")
        );
        let rendered = format!("{start:?}");
        assert!(!rendered.contains("postgres:postgres"));
    }

    #[test]
    fn config_options_quote_shell_metacharacters() {
        assert_eq!(
            quoted_config("unix_socket_directories", "/tmp/my cluster"),
            "-c unix_socket_directories='/tmp/my cluster'"
        );
        assert_eq!(
            quoted_config("listen_addresses", "o'brian"),
            "-c listen_addresses='o'\\''brian'"
        );
    }

    #[test]
    fn supervisor_program_resolves_to_a_file_when_the_bin_is_built() {
        let program = supervisor_program().expect("program");
        assert!(
            program.is_file(),
            "supervisor program {} is missing",
            program.display()
        );
    }
}
