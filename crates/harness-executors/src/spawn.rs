use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};

use crate::standard_helpers::{Env, now_ms};

pub const KILL_GRACE_MS: u64 = 10_000;
pub const STDERR_CAP: usize = 64 * 1024;
pub const STDOUT_CAP: usize = 64 * 1024;
const LINE_CAP: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdinMode {
    PipeEof,
    Ignore,
}

pub struct SpawnRequest<'a> {
    pub binary: &'a str,
    pub args: &'a [String],
    pub cwd: Option<&'a str>,
    pub env: &'a BTreeMap<String, String>,
    pub stdin: StdinMode,
    pub kill_grace: Duration,
    pub capture_stdout: bool,
}

pub struct Spawned {
    pub args: Vec<String>,
    pub started_at_ms: i64,
    lines: mpsc::Receiver<String>,
    stderr: Arc<Mutex<String>>,
    stdout_cap: Arc<Mutex<String>>,
    exit_rx: watch::Receiver<Option<Option<i32>>>,
    exited: Arc<AtomicBool>,
    killing: Arc<AtomicBool>,
    pid: Option<u32>,
    grace: Duration,
}

impl Spawned {
    pub async fn next_line(&mut self) -> Option<String> {
        self.lines.recv().await
    }

    pub fn stderr_text(&self) -> String {
        self.stderr.lock().clone()
    }

    pub fn stdout_text(&self) -> String {
        self.stdout_cap.lock().clone()
    }

    pub fn kill(&self) {
        signal_pid(
            self.pid,
            Arc::clone(&self.exited),
            Arc::clone(&self.killing),
            self.grace,
        );
    }

    pub fn share_kill(&self) -> Arc<dyn Fn() + Send + Sync> {
        let pid = self.pid;
        let exited = Arc::clone(&self.exited);
        let killing = Arc::clone(&self.killing);
        let grace = self.grace;
        Arc::new(move || signal_pid(pid, Arc::clone(&exited), Arc::clone(&killing), grace))
    }

    pub async fn wait_exit(&self) -> Option<i32> {
        let mut rx = self.exit_rx.clone();
        loop {
            if let Some(code) = *rx.borrow_and_update() {
                return code;
            }
            if rx.changed().await.is_err() {
                return None;
            }
        }
    }
}

pub fn child_env(
    base: &dyn Env,
    overrides: &[(String, Option<String>)],
    scrub: &[&str],
    preset: &[(String, String)],
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for (key, value) in base.pairs() {
        env.insert(key, value);
    }
    for (key, value) in preset {
        env.insert(key.clone(), value.clone());
    }
    for (key, value) in overrides {
        match value {
            Some(value) => {
                env.insert(key.clone(), value.clone());
            }
            None => {
                env.remove(key);
            }
        }
    }
    for key in scrub {
        env.remove(*key);
    }
    env
}

pub async fn spawn_child(request: SpawnRequest<'_>) -> Result<Spawned, std::io::Error> {
    let mut command = Command::new(request.binary);
    command.args(request.args);
    command.env_clear();
    for (key, value) in request.env {
        command.env(key, value);
    }
    if let Some(cwd) = request.cwd {
        command.current_dir(cwd);
    }
    command.kill_on_drop(false);
    match request.stdin {
        StdinMode::PipeEof => {
            command.stdin(std::process::Stdio::piped());
        }
        StdinMode::Ignore => {
            command.stdin(std::process::Stdio::null());
        }
    }
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let started_at_ms = now_ms();
    let mut child = command.spawn()?;
    if matches!(request.stdin, StdinMode::PipeEof) {
        drop(child.stdin.take());
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stdout_cap = Arc::new(Mutex::new(String::new()));
    let (line_tx, line_rx) = mpsc::channel(LINE_CAP);
    let stdout_for_reader = Arc::clone(&stdout_cap);
    let capture_stdout = request.capture_stdout;
    if let Some(stdout) = stdout {
        tokio::spawn(async move {
            read_stdout(stdout, line_tx, stdout_for_reader, capture_stdout).await;
        });
    }
    let stderr_for_reader = Arc::clone(&stderr_buf);
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            read_stderr(stderr, stderr_for_reader).await;
        }
    });
    let (exit_tx, exit_rx) = watch::channel(None);
    let exited = Arc::new(AtomicBool::new(false));
    let exited_for_wait = Arc::clone(&exited);
    tokio::spawn(async move {
        let status = child.wait().await;
        let _ = stderr_task.await;
        exited_for_wait.store(true, Ordering::SeqCst);
        let code = match status {
            Ok(status) => status.code(),
            Err(_) => None,
        };
        let _ = exit_tx.send(Some(code));
    });
    Ok(Spawned {
        args: request.args.to_vec(),
        started_at_ms,
        lines: line_rx,
        stderr: stderr_buf,
        stdout_cap,
        exit_rx,
        exited,
        killing: Arc::new(AtomicBool::new(false)),
        pid,
        grace: request.kill_grace,
    })
}

async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    tx: mpsc::Sender<String>,
    cap: Arc<Mutex<String>>,
    capture: bool,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if capture {
                    let mut slot = cap.lock();
                    if slot.len() < STDOUT_CAP {
                        let room = STDOUT_CAP - slot.len();
                        slot.push_str(byte_prefix(&buf, room));
                    }
                }
                let line = buf.trim_end_matches(['\n', '\r']).to_string();
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        }
    }
}

fn byte_prefix(buf: &str, room: usize) -> &str {
    let mut end = room.min(buf.len());
    while end > 0 && !buf.is_char_boundary(end) {
        end -= 1;
    }
    &buf[..end]
}

async fn read_stderr(stderr: tokio::process::ChildStderr, slot: Arc<Mutex<String>>) {
    let mut reader = BufReader::new(stderr);
    let mut chunk = [0u8; 4096];
    let mut acc = Vec::new();
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if acc.len() < STDERR_CAP {
                    let room = STDERR_CAP - acc.len();
                    acc.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
    }
    *slot.lock() = String::from_utf8_lossy(&acc).into_owned();
}

pub fn signal_pid(
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    killing: Arc<AtomicBool>,
    grace: Duration,
) {
    if exited.load(Ordering::SeqCst) {
        return;
    }
    if killing.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(pid) = pid else {
        return;
    };
    tokio::spawn(async move {
        if exited.load(Ordering::SeqCst) {
            return;
        }
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .await;
        tokio::time::sleep(grace).await;
        if !exited.load(Ordering::SeqCst) {
            let _ = Command::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .status()
                .await;
        }
    });
}

pub fn exit_label(code: Option<i32>) -> String {
    match code {
        Some(code) => code.to_string(),
        None => "null".to_string(),
    }
}

pub fn stderr_tail(text: &str) -> String {
    transcripts::value::js_slice(text, 0, Some(500))
}

pub async fn probe_binary(binary: &str, base: &dyn Env, scrub: &[&str]) -> bool {
    let env = child_env(base, &[], scrub, &[]);
    let mut command = Command::new(binary);
    command.arg("--version");
    command.env_clear();
    for (key, value) in &env {
        command.env(key, value);
    }
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    command.kill_on_drop(false);
    let mut child: Child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let pid = child.id();
    let exited = Arc::new(AtomicBool::new(false));
    let sleep = tokio::time::sleep(Duration::from_millis(3_000));
    tokio::pin!(sleep);
    tokio::select! {
        status = child.wait() => {
            exited.store(true, Ordering::SeqCst);
            matches!(status, Ok(status) if status.success())
        }
        _ = &mut sleep => {
            if let Some(pid) = pid
                && !exited.load(Ordering::SeqCst)
            {
                let _ = Command::new("kill")
                    .arg("-KILL")
                    .arg(pid.to_string())
                    .status()
                    .await;
            }
            let _ = child.wait().await;
            false
        }
    }
}
