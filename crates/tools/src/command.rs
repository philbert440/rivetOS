use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub aborted: bool,
    pub timed_out: bool,
    pub buffer_exceeded: bool,
    pub error: Option<String>,
}

pub async fn run_shell(
    script: &str,
    cwd: &Path,
    timeout: Duration,
    max_buffer: usize,
    cancellation: &CancellationToken,
) -> CommandOutput {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(script);
    command.current_dir(cwd);
    command.env("TERM", "dumb");
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                code: None,
                aborted: false,
                timed_out: false,
                buffer_exceeded: false,
                error: Some(err.to_string()),
            };
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let notify = Arc::new(Notify::new());
    let exceeded = Arc::new(AtomicBool::new(false));
    let notified = notify.notified();
    let stdout_task = tokio::spawn(read_capped(
        stdout,
        max_buffer,
        Arc::clone(&exceeded),
        Arc::clone(&notify),
    ));
    let stderr_task = tokio::spawn(read_capped(
        stderr,
        max_buffer,
        Arc::clone(&exceeded),
        Arc::clone(&notify),
    ));
    tokio::pin!(notified);
    let status = tokio::select! {
        _ = cancellation.cancelled() => {
            terminate(&mut child).await;
            None
        }
        _ = tokio::time::sleep(timeout) => {
            signal_group(&child, Signal::SIGKILL);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            None
        }
        _ = &mut notified => {
            signal_group(&child, Signal::SIGKILL);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            None
        }
        status = child.wait() => status.ok(),
    };
    let aborted = cancellation.is_cancelled();
    let timed_out = !aborted && status.is_none() && !exceeded.load(Ordering::Relaxed);
    let buffer_exceeded = exceeded.load(Ordering::Relaxed);
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let code = status.and_then(|status| status.code());
    CommandOutput {
        stdout,
        stderr,
        code,
        aborted,
        timed_out,
        buffer_exceeded,
        error: None,
    }
}

async fn terminate(child: &mut Child) {
    signal_group(child, Signal::SIGTERM);
    let finished = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if finished.is_err() {
        signal_group(child, Signal::SIGKILL);
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}

fn signal_group(child: &Child, signal: Signal) {
    let Some(pid) = child.id() else {
        return;
    };
    let _ = kill(Pid::from_raw(-(pid as i32)), signal);
}

async fn read_capped(
    reader: Option<impl AsyncRead + Unpin>,
    cap: usize,
    exceeded: Arc<AtomicBool>,
    notify: Arc<Notify>,
) -> String {
    let Some(mut reader) = reader else {
        return String::new();
    };
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                let room = cap.saturating_sub(buf.len());
                if room == 0 || n > room {
                    if room > 0 {
                        buf.extend_from_slice(&tmp[..room]);
                    }
                    exceeded.store(true, Ordering::Relaxed);
                    notify.notify_one();
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}
