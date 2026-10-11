use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::handler::BoxFuture;

pub const SHELL_TIMEOUT: Duration = Duration::from_secs(30);
pub const OUTPUT_CAP: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct ShellError {
    pub message: String,
}

impl ShellError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait ShellExecutor: Send + Sync {
    fn exec_with_env<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a str>,
        env: &'a [(&'a str, &'a str)],
    ) -> BoxFuture<'a, Result<ShellOutput, ShellError>>;

    fn exec<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ShellOutput, ShellError>> {
        self.exec_with_env(command, cwd, &[])
    }
}

pub struct ProcessShell {
    workspace: PathBuf,
    timeout: Duration,
    output_cap: usize,
}

impl ProcessShell {
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self {
            workspace: workspace.into(),
            timeout: SHELL_TIMEOUT,
            output_cap: OUTPUT_CAP,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_output_cap(mut self, output_cap: usize) -> Self {
        self.output_cap = output_cap;
        self
    }

    async fn exec_inner(
        &self,
        command: &str,
        cwd: Option<&str>,
        env: &[(&str, &str)],
    ) -> Result<ShellOutput, ShellError> {
        let dir = cwd.map_or_else(|| self.workspace.clone(), PathBuf::from);
        let mut command_proc = Command::new("sh");
        command_proc
            .arg("-c")
            .arg(command)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        for (key, value) in env {
            command_proc.env(key, value);
        }
        let mut child = match command_proc.spawn() {
            Ok(child) => child,
            Err(_) => return Ok(failed_spawn()),
        };
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let cap = self.output_cap;
        let stdout_buf = Arc::new(Mutex::new(CapBuf::default()));
        let stderr_buf = Arc::new(Mutex::new(CapBuf::default()));
        let stdout_slot = Arc::clone(&stdout_buf);
        let stderr_slot = Arc::clone(&stderr_buf);
        let run = async move {
            let mut guard = GroupGuard::arm(pid);
            let out = capture_pipe(stdout, cap, stdout_slot, pid);
            let err = capture_pipe(stderr, cap, stderr_slot, pid);
            let waited = child.wait();
            let joined = tokio::join!(waited, out, err);
            guard.disarm();
            joined
        };
        match tokio::time::timeout(self.timeout, run).await {
            Ok((Ok(status), _, _)) => {
                let (stdout, stdout_over) = take_text(&stdout_buf);
                let (stderr, stderr_over) = take_text(&stderr_buf);
                if stdout_over || stderr_over {
                    if let Some(pid) = pid {
                        kill_group(pid).await;
                    }
                    Ok(ShellOutput {
                        stdout,
                        stderr,
                        exit_code: 1,
                    })
                } else if status.code() == Some(0) {
                    Ok(ShellOutput {
                        stdout,
                        stderr: String::new(),
                        exit_code: 0,
                    })
                } else {
                    Ok(ShellOutput {
                        stdout,
                        stderr,
                        exit_code: status.code().map(i64::from).unwrap_or(1),
                    })
                }
            }
            Ok((Err(_), _, _)) => {
                let (stdout, _) = take_text(&stdout_buf);
                let (stderr, _) = take_text(&stderr_buf);
                Ok(ShellOutput {
                    stdout,
                    stderr,
                    exit_code: 1,
                })
            }
            Err(_) => {
                tracing::warn!("shell command timed out");
                if let Some(pid) = pid {
                    kill_group(pid).await;
                }
                let (stdout, _) = take_text(&stdout_buf);
                let (stderr, _) = take_text(&stderr_buf);
                Ok(ShellOutput {
                    stdout,
                    stderr,
                    exit_code: 1,
                })
            }
        }
    }
}

impl ShellExecutor for ProcessShell {
    fn exec_with_env<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a str>,
        env: &'a [(&'a str, &'a str)],
    ) -> BoxFuture<'a, Result<ShellOutput, ShellError>> {
        Box::pin(async move { self.exec_inner(command, cwd, env).await })
    }
}

fn failed_spawn() -> ShellOutput {
    ShellOutput {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: 1,
    }
}

#[derive(Default)]
struct CapBuf {
    bytes: Vec<u8>,
    overflow: bool,
}

fn take_text(slot: &Mutex<CapBuf>) -> (String, bool) {
    let guard = slot.lock();
    (
        String::from_utf8_lossy(&guard.bytes).into_owned(),
        guard.overflow,
    )
}

struct GroupGuard {
    pid: Option<u32>,
}

impl GroupGuard {
    fn arm(pid: Option<u32>) -> Self {
        Self { pid }
    }

    fn disarm(&mut self) {
        self.pid = None;
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.pid.take() {
            kill_group_detached(pid);
        }
    }
}

fn kill_group_detached(pid: u32) {
    let target = format!("-{pid}");
    let command = target.clone();
    let started = std::thread::Builder::new()
        .name("hook-kill-group".to_string())
        .spawn(move || kill_group_blocking(&command));
    if started.is_err() {
        kill_group_blocking(&target);
    }
}

fn kill_group_blocking(target: &str) {
    let _ = std::process::Command::new("kill")
        .args(["-s", "KILL", "--", target])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

async fn kill_group(pid: u32) {
    let target = format!("-{pid}");
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        Command::new("kill")
            .args(["-s", "KILL", "--", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await;
}

async fn capture_pipe<R>(
    pipe: Option<R>,
    cap: usize,
    slot: Arc<Mutex<CapBuf>>,
    pid: Option<u32>,
) -> bool
where
    R: AsyncRead + Unpin,
{
    let Some(mut reader) = pipe else {
        return false;
    };
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return overflowed(&slot),
            Ok(count) => {
                let crossed = {
                    let mut guard = slot.lock();
                    if guard.bytes.len() >= cap {
                        guard.overflow = true;
                        true
                    } else {
                        let room = cap - guard.bytes.len();
                        let take = count.min(room);
                        guard.bytes.extend_from_slice(&chunk[..take]);
                        if take < count {
                            guard.overflow = true;
                            true
                        } else {
                            false
                        }
                    }
                };
                if crossed {
                    if let Some(pid) = pid {
                        kill_group(pid).await;
                    }
                    return true;
                }
            }
        }
    }
}

fn overflowed(slot: &Mutex<CapBuf>) -> bool {
    slot.lock().overflow
}
