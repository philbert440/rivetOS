use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub aborted: bool,
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
                buffer_exceeded: false,
                error: Some(err.to_string()),
            };
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let notify = Arc::new(Notify::new());
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_buf = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::new()));
    let notified = notify.notified();
    let stdout_task = tokio::spawn(read_capped(
        stdout,
        max_buffer,
        Arc::clone(&exceeded),
        Arc::clone(&notify),
        Arc::clone(&stdout_buf),
    ));
    let stderr_task = tokio::spawn(read_capped(
        stderr,
        max_buffer,
        Arc::clone(&exceeded),
        Arc::clone(&notify),
        Arc::clone(&stderr_buf),
    ));
    tokio::pin!(notified);
    let started = tokio::time::Instant::now();
    let deadline = started + timeout;
    let mut natural = None;
    let mut aborted = false;
    let mut timed_out = false;
    tokio::select! {
        _ = cancellation.cancelled() => {
            terminate(pid, &mut child).await;
            aborted = true;
        }
        _ = &mut notified => {
            kill_group(pid, Signal::SIGKILL);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        _ = tokio::time::sleep_until(deadline) => {
            kill_group(pid, Signal::SIGKILL);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            timed_out = true;
        }
        status = child.wait() => {
            natural = status.ok();
        }
    }
    let buffer_exceeded = exceeded.load(Ordering::Relaxed);
    let mut drain = Drain {
        pid,
        had_exit: natural.is_some(),
        aborted,
        buffer_exceeded,
        timed_out,
        deadline,
    };
    drain_readers(stdout_task, stderr_task, &mut drain).await;
    let code = if aborted || buffer_exceeded || natural.is_none() {
        None
    } else {
        natural.and_then(|status| status.code())
    };
    CommandOutput {
        stdout: bytes_to_string(&stdout_buf),
        stderr: bytes_to_string(&stderr_buf),
        code,
        aborted,
        buffer_exceeded,
        error: None,
    }
}

struct Drain {
    pid: Option<u32>,
    had_exit: bool,
    aborted: bool,
    buffer_exceeded: bool,
    timed_out: bool,
    deadline: tokio::time::Instant,
}

async fn drain_readers(
    mut stdout_task: JoinHandle<()>,
    mut stderr_task: JoinHandle<()>,
    drain: &mut Drain,
) {
    let mut out_done = false;
    let mut err_done = false;
    let mut grace_deadline = if drain.had_exit && !drain.aborted && !drain.buffer_exceeded {
        drain.deadline
    } else {
        tokio::time::Instant::now() + Duration::from_secs(2)
    };
    let mut killed_holders = drain.timed_out || drain.aborted || drain.buffer_exceeded;
    loop {
        if out_done && err_done {
            break;
        }
        let now = tokio::time::Instant::now();
        if now >= grace_deadline {
            if drain.had_exit && !killed_holders {
                kill_group(drain.pid, Signal::SIGKILL);
                killed_holders = true;
                grace_deadline = now + Duration::from_secs(2);
                continue;
            }
            if !out_done {
                stdout_task.abort();
            }
            if !err_done {
                stderr_task.abort();
            }
            break;
        }
        let left = grace_deadline.saturating_duration_since(now);
        tokio::select! {
            result = &mut stdout_task, if !out_done => {
                out_done = true;
                let _ = result;
            }
            result = &mut stderr_task, if !err_done => {
                err_done = true;
                let _ = result;
            }
            _ = tokio::time::sleep(left) => {}
        }
    }
}

async fn terminate(pid: Option<u32>, child: &mut Child) {
    kill_group(pid, Signal::SIGTERM);
    let finished = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if finished.is_err() {
        kill_group(pid, Signal::SIGKILL);
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}

fn kill_group(pid: Option<u32>, signal: Signal) {
    let Some(pid) = pid else {
        return;
    };
    let Ok(raw) = i32::try_from(pid) else {
        return;
    };
    let _ = kill(Pid::from_raw(-raw), signal);
}

fn bytes_to_string(buf: &Mutex<Vec<u8>>) -> String {
    let guard = buf.lock().unwrap_or_else(|err| err.into_inner());
    String::from_utf8_lossy(&guard).into_owned()
}

async fn read_capped(
    reader: Option<impl AsyncRead + Unpin>,
    cap: usize,
    exceeded: Arc<AtomicBool>,
    notify: Arc<Notify>,
    buf: Arc<Mutex<Vec<u8>>>,
) {
    let Some(mut reader) = reader else {
        return;
    };
    let mut tmp = [0u8; 8192];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                let mut guard = buf.lock().unwrap_or_else(|err| err.into_inner());
                let room = cap.saturating_sub(guard.len());
                if room == 0 || n > room {
                    if room > 0 {
                        guard.extend_from_slice(&tmp[..room]);
                    }
                    drop(guard);
                    exceeded.store(true, Ordering::Relaxed);
                    notify.notify_one();
                    break;
                }
                guard.extend_from_slice(&tmp[..n]);
            }
            Err(_) => break,
        }
    }
}
