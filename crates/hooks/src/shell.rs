use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::handler::BoxFuture;

pub const SHELL_TIMEOUT: Duration = Duration::from_secs(30);
pub const OUTPUT_CAP: usize = 8 * 1024 * 1024;

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
    fn exec<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ShellOutput, ShellError>>;
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
    ) -> Result<ShellOutput, ShellError> {
        let dir = cwd.map_or_else(|| self.workspace.clone(), PathBuf::from);
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .map_err(|err| ShellError::new(err.to_string()))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let cap = self.output_cap;
        let stdout_task = tokio::spawn(async move { read_capped(stdout, cap).await });
        let stderr_task = tokio::spawn(async move { read_capped(stderr, cap).await });
        match tokio::time::timeout(self.timeout, child.wait()).await {
            Ok(Ok(status)) => {
                let code = i64::from(status.code().unwrap_or(1));
                let out = task_text(stdout_task).await;
                let err = task_text(stderr_task).await;
                if code == 0 {
                    Ok(ShellOutput {
                        stdout: out,
                        stderr: String::new(),
                        exit_code: 0,
                    })
                } else {
                    Ok(ShellOutput {
                        stdout: out,
                        stderr: err,
                        exit_code: code,
                    })
                }
            }
            Ok(Err(err)) => {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                Err(ShellError::new(err.to_string()))
            }
            Err(_) => {
                tracing::warn!("shell command timed out");
                if let Some(pid) = child.id() {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        Command::new("kill")
                            .args(["-s", "KILL", "--", &format!("-{pid}")])
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status(),
                    )
                    .await;
                }
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                Ok(ShellOutput {
                    stdout: bounded_text(stdout_task).await,
                    stderr: bounded_text(stderr_task).await,
                    exit_code: 1,
                })
            }
        }
    }
}

impl ShellExecutor for ProcessShell {
    fn exec<'a>(
        &'a self,
        command: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ShellOutput, ShellError>> {
        Box::pin(async move { self.exec_inner(command, cwd).await })
    }
}

async fn task_text(task: tokio::task::JoinHandle<Vec<u8>>) -> String {
    match task.await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    }
}

async fn bounded_text(mut task: tokio::task::JoinHandle<Vec<u8>>) -> String {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => {
            task.abort();
            String::new()
        }
    }
}

async fn read_capped<R>(pipe: Option<R>, cap: usize) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let Some(mut reader) = pipe else {
        return Vec::new();
    };
    let mut stored = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if stored.len() < cap {
                    let room = cap - stored.len();
                    let take = count.min(room);
                    stored.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }
    stored
}
