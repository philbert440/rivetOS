use std::collections::VecDeque;
use std::fmt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use command_fds::{CommandFdExt, FdMapping};
use protocol::js::{JsObject, JsValue, js_trim, parse, stringify};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::error::{ContractReason, ContractValidationIssue, WorkflowError};
use crate::step::{
    AgentStepOpts, HumanStepOpts, ParallelBegin, RunStepOpts, Step, StepOutput, StepScope,
};
use crate::timeutil::js_number_text;
use crate::types::LoadedWorkflow;
use crate::wire::{JsonLine, WireJson, js_to_value, typed_raw};

const BRIDGE: &str = r#"
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { writeSync } from 'node:fs'

const runPath = process.env.RIVET_WF_RUN_PATH
const lines = []
const waiters = []
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (waiters.length) waiters.shift()(line)
  else lines.push(line)
})
function nextLine() {
  if (lines.length) return Promise.resolve(lines.shift())
  return new Promise((resolve) => waiters.push(resolve))
}
const errorFields = ['stepId', 'label', 'seq', 'runId', 'timeoutMs', 'issues', 'budget', 'limit', 'spent', 'workflowId', 'max', 'current', 'ref', 'namespace', 'knownNamespaces']
function copyFields(target, source) {
  if (!source || typeof source !== 'object') return
  for (const key of errorFields) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key]
  }
}
function write(obj) {
  const data = Buffer.from(JSON.stringify(obj) + '\n')
  let offset = 0
  while (offset < data.length) {
    const n = writeSync(3, data, offset, data.length - offset)
    if (n <= 0) throw new Error('protocol write wrote no bytes')
    offset += n
  }
}
const pending = new Map()
let branchesLive = 0
let seq = 0
let settled = false
function maybeExit() {
  if (settled && pending.size === 0 && branchesLive === 0) process.exit(0)
}
function watchBranch(promise) {
  branchesLive++
  const done = () => {
    branchesLive--
    queueMicrotask(maybeExit)
  }
  promise.then(done, done)
  return promise
}
function rpc(op, payload) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    write(Object.assign({ id, op }, payload))
  })
}
function makeStep(scope) {
  return {
    agent(label, opts) { return rpc('agent', { label, opts, scope }) },
    run(label, opts) { return rpc('run', { label, opts, scope }) },
    human(label, opts) { return rpc('human', { label, opts, scope }) },
    call(label, ref, input) { return rpc('call', { label, ref, input: input ?? {}, scope }) },
    done(output) { return rpc('done', { output, scope }) },
    async parallel(label, branches) {
      const prep = await rpc('parallel_begin', { label, count: branches.length, scope })
      if (prep.replay) return prep.result
      try {
        const results = await Promise.all(branches.map((fn, i) => watchBranch(Promise.resolve().then(() => fn(makeStep(prep.branches[i].scope))))))
        await rpc('parallel_end', { token: prep.token, results, scope })
        return results
      } catch (err) {
        if (!err || err.name !== 'WorkflowSuspension') {
          await rpc('parallel_fail', {
            token: prep.token,
            error: err && err.message ? err.message : String(err),
            scope,
          })
        }
        throw err
      }
    },
  }
}
const start = JSON.parse(await nextLine())
const reader = (async () => {
  for (;;) {
    const line = await nextLine()
    if (line == null) return
    const msg = JSON.parse(line)
    if (msg.op === 'shutdown') return
    if (msg.op !== 'response') continue
    const item = pending.get(msg.id)
    if (!item) continue
    pending.delete(msg.id)
    if (msg.ok) item.resolve(msg.result)
    else {
      const error = new Error(msg.error || 'step failed')
      error.name = msg.name || 'Error'
      copyFields(error, msg)
      item.reject(error)
    }
    queueMicrotask(maybeExit)
  }
})()
try {
  const mod = await import(pathToFileURL(runPath).href)
  const fn = mod.default ?? mod.run
  if (typeof fn !== 'function') {
    throw new Error('run script at ' + runPath + ' must default-export an async function (step, ctx) => void')
  }
  await fn(makeStep(null), start.ctx)
  write({ op: 'script_done' })
} catch (err) {
  const payload = {
    op: 'script_error',
    message: err && err.message ? err.message : String(err),
    name: err && err.name,
  }
  copyFields(payload, err)
  write(payload)
}
settled = true
queueMicrotask(maybeExit)
"#;

const DEFAULT_INSTALL_ROOT: &str = "/opt/rivetos";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NodeVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl fmt::Display for NodeVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TypeStrip {
    None,
    Flag,
    Default,
}

struct LaunchPlan {
    node: PathBuf,
    strategy: &'static str,
    detail: String,
    args_prefix: Vec<&'static str>,
    current_dir: Option<PathBuf>,
}

pub struct HostContext {
    pub run_id: String,
    pub input: WireJson,
    pub case_dir: String,
    pub workflow: LoadedWorkflow,
    pub fields: WireJson,
}

const STDERR_CAP: usize = 64 * 1024;
const SILENCE: Duration = Duration::from_secs(60);

struct Frame {
    op: String,
    id_raw: String,
    object: JsObject,
    results_raw: Option<String>,
    raw: String,
}

struct SiblingDrain {
    frame_rx: tokio::sync::mpsc::UnboundedReceiver<ProtocolEvent>,
    step: Step,
    inflight: Arc<AtomicUsize>,
    write_tx: tokio::sync::mpsc::UnboundedSender<String>,
    idle_tx: tokio::sync::mpsc::UnboundedSender<()>,
    idle_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    writer: tokio::task::JoinHandle<()>,
    child: tokio::process::Child,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    rpcs: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
    sibling_limit: Duration,
}

enum ProtocolEvent {
    Line(String),
    Eof,
    Io(String),
}

pub async fn drive_node(
    run_path: &str,
    step: Step,
    ctx: HostContext,
    sibling_limit: Duration,
) -> Result<(), WorkflowError> {
    let run_path = absolute_text(run_path);
    let plan = launch_plan(&run_path).await?;
    tracing::info!(
        strategy = plan.strategy,
        node = %plan.node.display(),
        detail = %plan.detail,
        "workflow script loader"
    );
    let mut command = Command::new(&plan.node);
    command
        .args(&plan.args_prefix)
        .arg("--input-type=module")
        .arg("-e")
        .arg(BRIDGE)
        .env("RIVET_WF_RUN_PATH", &run_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(root) = &plan.current_dir {
        command.current_dir(root);
    }
    let (read_end, write_end) = StdUnixStream::pair()
        .map_err(|err| WorkflowError::message(format!("failed to create protocol pipe: {err}")))?;
    read_end.set_nonblocking(true).map_err(|err| {
        WorkflowError::message(format!("failed to configure protocol pipe: {err}"))
    })?;
    command
        .as_std_mut()
        .fd_mappings(vec![FdMapping {
            parent_fd: write_end.into(),
            child_fd: 3,
        }])
        .map_err(|err| WorkflowError::message(format!("failed to map protocol fd: {err}")))?;
    let mut child = command.spawn().map_err(|err| {
        WorkflowError::message(format!(
            "failed to spawn {} for {} (loader {}): {err}",
            plan.node.display(),
            Path::new(&run_path).display(),
            plan.strategy
        ))
    })?;
    drop(command);
    let protocol = tokio::net::UnixStream::from_std(read_end)
        .map_err(|err| WorkflowError::message(format!("failed to take protocol pipe: {err}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| WorkflowError::message("node stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorkflowError::message("node stdout unavailable"))?;
    let stderr_ring = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    let stderr_task = child.stderr.take().map(|stderr| {
        let ring = Arc::clone(&stderr_ring);
        tokio::spawn(async move { drain_stderr(stderr, &ring).await })
    });
    tokio::spawn(async move { drain_stdout(stdout).await });
    let (write_tx, mut write_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = write_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });
    let start = start_line(&ctx)?;
    write_tx
        .send(start)
        .map_err(|_| WorkflowError::message("node stdin closed"))?;
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move { read_protocol(protocol, frame_tx).await });
    let inflight = Arc::new(AtomicUsize::new(0));
    let rpcs = Arc::new(Mutex::new(Vec::new()));
    let (idle_tx, mut idle_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let silence = tokio::time::sleep(SILENCE);
    tokio::pin!(silence);
    let mut outcome = Ok(());
    let mut detach = false;
    loop {
        tokio::select! {
            biased;
            event = frame_rx.recv() => {
                silence.as_mut().reset(tokio::time::Instant::now() + SILENCE);
                match event {
                    Some(ProtocolEvent::Line(line)) => {
                        if js_trim(&line).is_empty() {
                            continue;
                        }
                        let frame = match parse_frame(&line) {
                            Ok(frame) => frame,
                            Err(err) => {
                                outcome = Err(err);
                                break;
                            }
                        };
                        if frame.op == "script_done" {
                            break;
                        }
                        if frame.op == "script_error" {
                            outcome = Err(script_error_frame(&frame.raw));
                            detach = true;
                            break;
                        }
                        spawn_rpc(
                            step.clone(),
                            frame,
                            Arc::clone(&inflight),
                            write_tx.clone(),
                            idle_tx.clone(),
                            Arc::clone(&rpcs),
                        );
                    }
                    Some(ProtocolEvent::Eof) | None => {
                        outcome = Err(WorkflowError::message(format!(
                            "node script closed protocol for {run_path}"
                        )));
                        break;
                    }
                    Some(ProtocolEvent::Io(err)) => {
                        outcome = Err(WorkflowError::message(format!("node protocol: {err}")));
                        break;
                    }
                }
            }
            _ = idle_rx.recv() => {
                silence.as_mut().reset(tokio::time::Instant::now() + SILENCE);
            }
            _ = &mut silence, if inflight.load(Ordering::SeqCst) == 0 => {
                outcome = Err(WorkflowError::message(format!(
                    "node script timed out waiting for output: {run_path}"
                )));
                break;
            }
        }
    }
    if detach {
        tokio::spawn(drain_siblings(SiblingDrain {
            frame_rx,
            step,
            inflight,
            write_tx,
            idle_tx,
            idle_rx,
            writer,
            child,
            stderr_task,
            rpcs,
            sibling_limit,
        }));
        return outcome;
    }
    drop(write_tx);
    let _ = writer.await;
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    if let Some(task) = stderr_task {
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }
    if let Ok(Ok(status)) = status
        && !status.success()
    {
        let tail = ring_text(&stderr_ring);
        let note = format!("node exited {status}: {tail}");
        outcome = match outcome {
            Ok(()) => Err(WorkflowError::message(note)),
            Err(err) => Err(WorkflowError::message(format!("{err}\n{note}"))),
        };
    }
    outcome
}

async fn drain_siblings(mut drain: SiblingDrain) {
    let silence = tokio::time::sleep(SILENCE);
    tokio::pin!(silence);
    let limit = tokio::time::sleep(drain.sibling_limit);
    tokio::pin!(limit);
    let mut timed_out = false;
    loop {
        tokio::select! {
            biased;
            event = drain.frame_rx.recv() => {
                silence.as_mut().reset(tokio::time::Instant::now() + SILENCE);
                match event {
                    Some(ProtocolEvent::Line(line)) => {
                        if js_trim(&line).is_empty() {
                            continue;
                        }
                        let Ok(frame) = parse_frame(&line) else {
                            break;
                        };
                        if frame.op == "script_done" || frame.op == "script_error" {
                            continue;
                        }
                        spawn_rpc(
                            drain.step.clone(),
                            frame,
                            Arc::clone(&drain.inflight),
                            drain.write_tx.clone(),
                            drain.idle_tx.clone(),
                            Arc::clone(&drain.rpcs),
                        );
                    }
                    _ => break,
                }
            }
            _ = drain.idle_rx.recv() => {
                silence.as_mut().reset(tokio::time::Instant::now() + SILENCE);
            }
            _ = &mut silence, if drain.inflight.load(Ordering::SeqCst) == 0 => {
                break;
            }
            _ = &mut limit => {
                timed_out = true;
                break;
            }
        }
    }
    if timed_out {
        abort_rpcs(&drain.rpcs);
    }
    drop(drain.write_tx);
    let _ = tokio::time::timeout(Duration::from_secs(5), drain.writer).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), drain.child.wait()).await;
    if let Some(task) = drain.stderr_task {
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }
}

async fn drain_stdout(mut stdout: tokio::process::ChildStdout) {
    let mut buf = [0u8; 4096];
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                tracing::debug!("{text}");
            }
        }
    }
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr, ring: &Mutex<VecDeque<u8>>) {
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => push_ring(ring, &buf[..n]),
        }
    }
}

fn push_ring(ring: &Mutex<VecDeque<u8>>, bytes: &[u8]) {
    let mut guard = ring.lock().unwrap_or_else(|err| err.into_inner());
    guard.extend(bytes);
    while guard.len() > STDERR_CAP {
        guard.pop_front();
    }
}

fn ring_text(ring: &Mutex<VecDeque<u8>>) -> String {
    let mut guard = ring.lock().unwrap_or_else(|err| err.into_inner());
    String::from_utf8_lossy(guard.make_contiguous()).into_owned()
}

async fn read_protocol(
    protocol: tokio::net::UnixStream,
    frame_tx: tokio::sync::mpsc::UnboundedSender<ProtocolEvent>,
) {
    let mut lines = BufReader::new(protocol).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if frame_tx.send(ProtocolEvent::Line(line)).is_err() {
                    break;
                }
            }
            Ok(None) => {
                let _ = frame_tx.send(ProtocolEvent::Eof);
                break;
            }
            Err(err) => {
                let _ = frame_tx.send(ProtocolEvent::Io(err.to_string()));
                break;
            }
        }
    }
}

fn spawn_rpc(
    step: Step,
    frame: Frame,
    inflight: Arc<AtomicUsize>,
    write_tx: tokio::sync::mpsc::UnboundedSender<String>,
    idle_tx: tokio::sync::mpsc::UnboundedSender<()>,
    rpcs: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
) {
    inflight.fetch_add(1, Ordering::SeqCst);
    let task = tokio::spawn(async move {
        let id_raw = frame.id_raw.clone();
        let line = match dispatch(&step, &frame).await {
            Ok(result) => response_ok_line(&id_raw, result.as_deref()),
            Err(err) => response_err_line(&id_raw, &err),
        };
        let _ = write_tx.send(line);
        if inflight.fetch_sub(1, Ordering::SeqCst) == 1 {
            let _ = idle_tx.send(());
        }
    });
    rpcs.lock()
        .unwrap_or_else(|err| err.into_inner())
        .push(task.abort_handle());
}

fn abort_rpcs(rpcs: &Mutex<Vec<tokio::task::AbortHandle>>) {
    let guard = rpcs.lock().unwrap_or_else(|err| err.into_inner());
    for handle in guard.iter() {
        handle.abort();
    }
}

fn start_line(ctx: &HostContext) -> Result<String, WorkflowError> {
    let workflow = typed_raw(&ctx.workflow)?;
    let mut body = JsonLine::new();
    body.string("runId", &ctx.run_id);
    body.raw("input", ctx.input.raw());
    body.string("caseDir", &ctx.case_dir);
    body.raw("workflow", &workflow);
    body.raw("fields", ctx.fields.raw());
    let mut start = JsonLine::new();
    start.string("op", "start");
    start.raw("ctx", &body.finish());
    let mut line = start.finish();
    line.push('\n');
    Ok(line)
}

fn parse_frame(line: &str) -> Result<Frame, WorkflowError> {
    let parsed = parse(line)
        .map_err(|err| WorkflowError::message(format!("node script sent invalid json: {err}")))?;
    let Some(object) = parsed.as_object() else {
        return Err(WorkflowError::message(
            "node script sent invalid json: expected object",
        ));
    };
    let op = object
        .get("op")
        .and_then(JsValue::as_str)
        .unwrap_or("")
        .to_string();
    let id_raw = object
        .get("id")
        .map(stringify)
        .unwrap_or_else(|| "null".to_string());
    let results_raw = object.get("results").map(stringify);
    Ok(Frame {
        op,
        id_raw,
        object: object.clone(),
        results_raw,
        raw: line.to_string(),
    })
}

fn response_ok_line(id_raw: &str, result: Option<&str>) -> String {
    let mut line = JsonLine::new();
    line.string("op", "response");
    line.raw("id", id_raw);
    line.raw("ok", "true");
    if let Some(result) = result {
        line.raw("result", result);
    }
    finish_line(line)
}

fn response_err_line(id_raw: &str, err: &WorkflowError) -> String {
    let mut line = JsonLine::new();
    line.string("op", "response");
    line.raw("id", id_raw);
    line.raw("ok", "false");
    line.string("error", &err.to_string());
    line.string("name", err.name());
    match err {
        WorkflowError::Suspension {
            step_id,
            label,
            seq,
            ..
        } => {
            line.string("stepId", step_id);
            line.string("label", label);
            line.i64("seq", *seq);
        }
        WorkflowError::Killed { run_id, .. } | WorkflowError::RunNotFound { run_id, .. } => {
            line.string("runId", run_id);
        }
        WorkflowError::Contract { issues, .. } => {
            line.raw("issues", &issues_raw(issues));
        }
        WorkflowError::UnknownCallNamespace {
            reference,
            namespace,
            known_namespaces,
            ..
        } => {
            line.string("ref", reference);
            line.string("namespace", namespace);
            line.raw("knownNamespaces", &strings_raw(known_namespaces));
        }
        WorkflowError::WorkflowNotFound { reference, .. } => {
            line.string("ref", reference);
        }
        WorkflowError::StepTimeout {
            step_id,
            timeout_ms,
            ..
        } => {
            line.string("stepId", step_id);
            line.raw("timeoutMs", &js_number_text(*timeout_ms));
        }
        WorkflowError::RunTimeout {
            run_id, timeout_ms, ..
        } => {
            line.string("runId", run_id);
            line.raw("timeoutMs", &js_number_text(*timeout_ms));
        }
        WorkflowError::BudgetExceeded {
            budget,
            limit,
            spent,
            ..
        } => {
            line.string("budget", budget);
            line.raw("limit", &js_number_text(*limit));
            line.raw("spent", &js_number_text(*spent));
        }
        WorkflowError::MaxConcurrentRuns {
            workflow_id,
            max,
            current,
            ..
        } => {
            line.string("workflowId", workflow_id);
            line.raw("max", &js_number_text(*max));
            line.raw("current", &current.to_string());
        }
        WorkflowError::Message(_) => {}
    }
    finish_line(line)
}

fn finish_line(line: JsonLine) -> String {
    let mut text = line.finish();
    text.push('\n');
    text
}

fn issues_raw(issues: &[ContractValidationIssue]) -> String {
    let Ok(text) = serde_json::to_string(issues) else {
        return "[]".to_string();
    };
    match WireJson::parse(&text) {
        Ok(wire) => wire.raw().to_string(),
        Err(_) => text,
    }
}

fn strings_raw(items: &[String]) -> String {
    let mut out = String::from("[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&stringify(&JsValue::from_text(item)));
    }
    out.push(']');
    out
}

fn script_error_frame(raw: &str) -> WorkflowError {
    let Ok(parsed) = parse(raw) else {
        return WorkflowError::message("run script failed");
    };
    let Some(object) = parsed.as_object() else {
        return WorkflowError::message("run script failed");
    };
    let text = js_string(object, "message");
    let text = if text.is_empty() {
        "run script failed".to_string()
    } else {
        text
    };
    let name = js_string(object, "name");
    match name.as_str() {
        "WorkflowSuspension" => WorkflowError::suspension(
            js_string(object, "stepId"),
            js_string(object, "label"),
            js_i64(object, "seq"),
        ),
        "WorkflowKilled" => {
            let run_id = js_string(object, "runId");
            if run_id.is_empty() {
                WorkflowError::message(text)
            } else {
                WorkflowError::killed(run_id)
            }
        }
        "ContractValidationError" => match object.get("issues").and_then(JsValue::as_array) {
            Some(items) => {
                let issues = items
                    .iter()
                    .filter_map(|item| item.as_object())
                    .map(|item| ContractValidationIssue {
                        field: js_string(item, "field"),
                        reason: reason_from(&js_string(item, "reason")),
                        message: js_string(item, "message"),
                    })
                    .collect();
                WorkflowError::contract(issues)
            }
            None => WorkflowError::message(text),
        },
        "UnknownCallNamespaceError" => WorkflowError::unknown_namespace(
            js_string(object, "ref"),
            js_string(object, "namespace"),
            js_strings(object, "knownNamespaces"),
        ),
        "WorkflowNotFoundError" => {
            WorkflowError::workflow_not_found(js_string(object, "ref"), Some(text))
        }
        "RunNotFoundError" => WorkflowError::run_not_found(js_string(object, "runId")),
        "StepTimeoutError" => {
            WorkflowError::step_timeout(js_string(object, "stepId"), js_f64(object, "timeoutMs"))
        }
        "RunTimeoutError" => {
            WorkflowError::run_timeout(js_string(object, "runId"), js_f64(object, "timeoutMs"))
        }
        "BudgetExceededError" => {
            let budget = match js_string(object, "budget").as_str() {
                "maxTokens" => "maxTokens",
                "maxCost" => "maxCost",
                _ => return WorkflowError::message(text),
            };
            WorkflowError::budget(budget, js_f64(object, "limit"), js_f64(object, "spent"))
        }
        "MaxConcurrentRunsError" => {
            let current = js_i64(object, "current");
            let current = usize::try_from(current).unwrap_or(0);
            WorkflowError::max_concurrent(
                js_string(object, "workflowId"),
                js_f64(object, "max"),
                current,
            )
        }
        _ => WorkflowError::message(text),
    }
}

fn js_string(object: &JsObject, key: &str) -> String {
    object
        .get(key)
        .and_then(JsValue::as_str)
        .unwrap_or("")
        .to_string()
}

fn js_i64(object: &JsObject, key: &str) -> i64 {
    object.get(key).and_then(JsValue::as_i64).unwrap_or(0)
}

fn js_f64(object: &JsObject, key: &str) -> f64 {
    match object.get(key) {
        Some(JsValue::Number(value)) => *value,
        _ => 0.0,
    }
}

fn js_strings(object: &JsObject, key: &str) -> Vec<String> {
    let Some(items) = object.get(key).and_then(JsValue::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect()
}

fn reason_from(text: &str) -> ContractReason {
    match text {
        "missing" => ContractReason::Missing,
        "type_mismatch" => ContractReason::TypeMismatch,
        "file_missing" => ContractReason::FileMissing,
        _ => ContractReason::Invalid,
    }
}

async fn dispatch(step: &Step, frame: &Frame) -> Result<Option<String>, WorkflowError> {
    let message = &frame.object;
    let op = frame.op.as_str();
    let scoped = step_for(step, message);
    let label = message.get("label").and_then(JsValue::as_str).unwrap_or("");
    match op {
        "agent" => output_raw(scoped.agent(label, agent_opts(message.get("opts"))).await?),
        "run" => output_raw(scoped.run(label, run_opts(message.get("opts"))).await?),
        "human" => output_raw(scoped.human(label, human_opts(message.get("opts"))).await?),
        "call" => {
            let reference = message.get("ref").and_then(JsValue::as_str).unwrap_or("");
            let input = match message.get("input") {
                Some(value) => WireJson::from_js(value),
                None => WireJson::parse("{}")?,
            };
            output_raw(scoped.call_wire(label, reference, input).await?)
        }
        "done" => {
            let output = match message.get("output") {
                Some(value) => WireJson::from_js(value),
                None => WireJson::parse("{}")?,
            };
            scoped.done_wire(output).await?;
            Ok(None)
        }
        "parallel_begin" => {
            let count = message
                .get("count")
                .and_then(JsValue::as_i64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(0);
            let begin = scoped.parallel_begin(label, count).await?;
            Ok(Some(parallel_begin_raw(&begin)?))
        }
        "parallel_end" => {
            let token = message.get("token").and_then(JsValue::as_str).unwrap_or("");
            let raw = frame
                .results_raw
                .clone()
                .unwrap_or_else(|| "null".to_string());
            let results = WireJson::parse(&raw)?;
            scoped.parallel_finish(token, results).await?;
            Ok(None)
        }
        "parallel_fail" => {
            let token = message.get("token").and_then(JsValue::as_str).unwrap_or("");
            let text = message
                .get("error")
                .and_then(JsValue::as_str)
                .unwrap_or("parallel branch failed");
            scoped
                .parallel_fail(token, &WorkflowError::message(text))
                .await?;
            Ok(None)
        }
        _ => Err(WorkflowError::message(format!(
            "unknown script op \"{op}\""
        ))),
    }
}

fn output_raw(output: StepOutput) -> Result<Option<String>, WorkflowError> {
    Ok(output.wire()?.map(|wire| wire.raw().to_string()))
}

fn step_for(step: &Step, message: &JsObject) -> Step {
    let Some(scope) = message.get("scope").and_then(JsValue::as_object) else {
        return step.clone();
    };
    step.with_scope(StepScope {
        label_prefix: js_string(scope, "labelPrefix"),
        executor_case_dir: js_string(scope, "executorCaseDir"),
        allow_human: js_flag(scope, "allowHuman", true),
        allow_parallel: js_flag(scope, "allowParallel", true),
        allow_done: js_flag(scope, "allowDone", true),
        merge_agent_fields: js_flag(scope, "mergeAgentFields", true),
    })
}

fn js_flag(object: &JsObject, key: &str, default: bool) -> bool {
    object
        .get(key)
        .and_then(JsValue::as_bool)
        .unwrap_or(default)
}

fn extra_map(object: &JsObject, skip: &[&str]) -> Map<String, Value> {
    let mut extra = Map::new();
    for (key, value) in object.iter() {
        let name = key.to_utf8();
        if skip.contains(&name) {
            continue;
        }
        extra.insert(name.to_string(), js_to_value(value));
    }
    extra
}

fn agent_opts(value: Option<&JsValue>) -> AgentStepOpts {
    let Some(object) = value.and_then(JsValue::as_object) else {
        return AgentStepOpts::out(Vec::new());
    };
    let out = match object.get("out").and_then(JsValue::as_array) {
        Some(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        None => Vec::new(),
    };
    AgentStepOpts {
        agent: object
            .get("agent")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        prompt: object.get("prompt").map(WireJson::from_js),
        out,
        extra: extra_map(object, &["agent", "prompt", "out"]),
    }
}

fn run_opts(value: Option<&JsValue>) -> RunStepOpts {
    let Some(object) = value.and_then(JsValue::as_object) else {
        return RunStepOpts {
            script: None,
            skill: None,
            input: None,
            extra: Map::new(),
        };
    };
    RunStepOpts {
        script: object
            .get("script")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        skill: object
            .get("skill")
            .and_then(JsValue::as_str)
            .map(str::to_string),
        input: object.get("in").map(WireJson::from_js),
        extra: extra_map(object, &["script", "skill", "in"]),
    }
}

fn human_opts(value: Option<&JsValue>) -> HumanStepOpts {
    let Some(object) = value.and_then(JsValue::as_object) else {
        return HumanStepOpts::fields(Vec::new());
    };
    let fields = match object.get("fields").and_then(JsValue::as_array) {
        Some(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        None => Vec::new(),
    };
    HumanStepOpts {
        prompt: object.get("prompt").map(WireJson::from_js),
        fields,
        extra: extra_map(object, &["prompt", "fields"]),
    }
}

fn parallel_begin_raw(begin: &ParallelBegin) -> Result<String, WorkflowError> {
    let mut line = JsonLine::new();
    line.raw("replay", if begin.replay { "true" } else { "false" });
    if begin.replay {
        if let Some(result) = &begin.result {
            line.raw("result", result.raw());
        }
        return Ok(line.finish());
    }
    line.string("token", &begin.token);
    let mut branches = String::from("[");
    for (index, scope) in begin.branches.iter().enumerate() {
        if index > 0 {
            branches.push(',');
        }
        branches.push_str("{\"scope\":");
        branches.push_str(&scope_raw(scope));
        branches.push('}');
    }
    branches.push(']');
    line.raw("branches", &branches);
    Ok(line.finish())
}

fn scope_raw(scope: &StepScope) -> String {
    let mut line = JsonLine::new();
    line.string("labelPrefix", &scope.label_prefix);
    line.string("executorCaseDir", &scope.executor_case_dir);
    line.raw(
        "allowHuman",
        if scope.allow_human { "true" } else { "false" },
    );
    line.raw(
        "allowParallel",
        if scope.allow_parallel {
            "true"
        } else {
            "false"
        },
    );
    line.raw("allowDone", if scope.allow_done { "true" } else { "false" });
    line.raw(
        "mergeAgentFields",
        if scope.merge_agent_fields {
            "true"
        } else {
            "false"
        },
    );
    line.finish()
}

async fn launch_plan(run_path: &str) -> Result<LaunchPlan, WorkflowError> {
    let node = find_node().await?;
    if !needs_typescript(run_path) {
        return Ok(LaunchPlan {
            node,
            strategy: "plain",
            detail: "javascript".to_string(),
            args_prefix: Vec::new(),
            current_dir: None,
        });
    }
    if let Some(root) = find_tsx_root().await {
        let detail = root.display().to_string();
        return Ok(LaunchPlan {
            node,
            strategy: "tsx",
            detail,
            args_prefix: vec!["--import", "tsx"],
            current_dir: Some(root),
        });
    }
    match read_node_version(&node).await {
        Ok(version) => match type_strip(version) {
            TypeStrip::Flag => Ok(LaunchPlan {
                node,
                strategy: "strip-types",
                detail: format!("{version} --experimental-strip-types"),
                args_prefix: vec!["--experimental-strip-types"],
                current_dir: None,
            }),
            TypeStrip::Default => Ok(LaunchPlan {
                node,
                strategy: "strip-types",
                detail: format!("{version} default"),
                args_prefix: Vec::new(),
                current_dir: None,
            }),
            TypeStrip::None => Err(typescript_unavailable(run_path, &version.to_string())),
        },
        Err(err) => Err(typescript_unavailable(run_path, &err.to_string())),
    }
}

fn typescript_unavailable(run_path: &str, detail: &str) -> WorkflowError {
    WorkflowError::message(format!(
        "cannot execute TypeScript run script {run_path}: tsx was not found at $RIVETOS_ROOT/node_modules/tsx or the install root node_modules, and Node type stripping is unavailable ({detail}). Install tsx and use node --import tsx, or use Node >= 22.18 or >= 23.6 (pass --experimental-strip-types where that version needs the flag; Node 24 strips erasable syntax by default)"
    ))
}

fn needs_typescript(path: &str) -> bool {
    let Some(ext) = Path::new(path).extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "ts" | "mts" | "cts" | "tsx"
    )
}

fn type_strip(version: NodeVersion) -> TypeStrip {
    if version.major >= 24 {
        return TypeStrip::Default;
    }
    if version.major == 23 && version.minor >= 6 {
        return TypeStrip::Flag;
    }
    if version.major == 22 && version.minor >= 18 {
        return TypeStrip::Flag;
    }
    TypeStrip::None
}

fn parse_node_version(text: &str) -> Option<NodeVersion> {
    let text = text.trim();
    let rest = text.strip_prefix('v').or_else(|| text.strip_prefix('V'))?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch_text = parts.next().unwrap_or("0");
    let patch_digits: String = patch_text
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    let patch = if patch_digits.is_empty() {
        0
    } else {
        patch_digits.parse().ok()?
    };
    Some(NodeVersion {
        major,
        minor,
        patch,
    })
}

fn env_trimmed(key: &str) -> Option<String> {
    let value = std::env::var(key).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn find_node() -> Result<PathBuf, WorkflowError> {
    if let Some(overridden) = env_trimmed("RIVETOS_NODE") {
        if let Some(path) = resolve_program(&overridden).await {
            return Ok(path);
        }
        return Err(WorkflowError::message(format!(
            "RIVETOS_NODE={overridden} is not an executable node binary"
        )));
    }
    resolve_program("node").await.ok_or_else(|| {
        WorkflowError::message("node was not found on PATH; set RIVETOS_NODE to the node binary")
    })
}

async fn resolve_program(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        let path = absolutize(Path::new(name));
        if is_executable(&path).await {
            return Some(path);
        }
        return None;
    }
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = absolutize(&dir.join(name));
        if is_executable(&candidate).await {
            return Some(candidate);
        }
    }
    None
}

fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn absolute_text(path: &str) -> String {
    absolutize(Path::new(path)).display().to_string()
}

async fn is_executable(path: &Path) -> bool {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

async fn find_tsx_root() -> Option<PathBuf> {
    for root in tsx_roots() {
        if has_tsx(&root).await {
            return Some(root);
        }
    }
    None
}

fn tsx_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = env_trimmed("RIVETOS_ROOT") {
        push_unique(&mut roots, PathBuf::from(root));
    }
    push_unique(&mut roots, PathBuf::from(DEFAULT_INSTALL_ROOT));
    roots
}

fn push_unique(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() || roots.iter().any(|item| item == &path) {
        return;
    }
    roots.push(path);
}

async fn has_tsx(root: &Path) -> bool {
    let manifest = root.join("node_modules").join("tsx").join("package.json");
    match tokio::fs::metadata(&manifest).await {
        Ok(meta) => meta.is_file(),
        Err(_) => false,
    }
}

async fn read_node_version(node: &Path) -> Result<NodeVersion, WorkflowError> {
    let mut command = Command::new(node);
    command.arg("--version").kill_on_drop(true);
    let output = match tokio::time::timeout(Duration::from_secs(10), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => {
            return Err(WorkflowError::message(format!(
                "failed to run node --version: {err}"
            )));
        }
        Err(_) => return Err(WorkflowError::message("node --version timed out")),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(WorkflowError::message(format!(
            "node --version failed: {stderr}"
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_node_version(&text).ok_or_else(|| {
        WorkflowError::message(format!("could not parse node --version output: {text}"))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        NodeVersion, TypeStrip, needs_typescript, parse_node_version, response_err_line,
        response_ok_line, type_strip, typescript_unavailable,
    };
    use crate::error::{ContractReason, ContractValidationIssue, WorkflowError};

    fn version(major: u64, minor: u64, patch: u64) -> NodeVersion {
        NodeVersion {
            major,
            minor,
            patch,
        }
    }

    #[test]
    fn node_version_parse_accepts_the_cli_text() {
        assert_eq!(parse_node_version("v22.18.0\n"), Some(version(22, 18, 0)));
        assert_eq!(parse_node_version("v24.0.0"), Some(version(24, 0, 0)));
        assert_eq!(parse_node_version("V23.6.1"), Some(version(23, 6, 1)));
        assert_eq!(parse_node_version("v22.18"), Some(version(22, 18, 0)));
        assert_eq!(
            parse_node_version("v22.18.0-nightly"),
            Some(version(22, 18, 0))
        );
        assert_eq!(parse_node_version("22.18.0"), None);
    }

    #[test]
    fn type_stripping_follows_the_node_version_gate() {
        assert_eq!(type_strip(version(22, 17, 9)), TypeStrip::None);
        assert_eq!(type_strip(version(22, 18, 0)), TypeStrip::Flag);
        assert_eq!(type_strip(version(22, 19, 1)), TypeStrip::Flag);
        assert_eq!(type_strip(version(23, 5, 0)), TypeStrip::None);
        assert_eq!(type_strip(version(23, 6, 0)), TypeStrip::Flag);
        assert_eq!(type_strip(version(23, 11, 0)), TypeStrip::Flag);
        assert_eq!(type_strip(version(24, 0, 0)), TypeStrip::Default);
        assert_eq!(type_strip(version(25, 1, 0)), TypeStrip::Default);
        assert_eq!(type_strip(version(18, 20, 0)), TypeStrip::None);
    }

    #[test]
    fn typescript_extensions_are_the_ones_the_loader_must_execute() {
        assert!(needs_typescript("/wf/run.ts"));
        assert!(needs_typescript("/wf/run.mts"));
        assert!(needs_typescript("/wf/run.cts"));
        assert!(needs_typescript("/wf/run.tsx"));
        assert!(needs_typescript("/wf/run.TS"));
        assert!(!needs_typescript("/wf/run.js"));
        assert!(!needs_typescript("/wf/run.mjs"));
        assert!(!needs_typescript("/wf/run.ts.bak"));
    }

    #[test]
    fn unavailable_typescript_names_both_loaders() {
        let message = typescript_unavailable("/wf/run.ts", "v20.11.0").to_string();
        assert!(message.contains("node --import tsx"), "{message}");
        assert!(message.contains("--experimental-strip-types"), "{message}");
        assert!(message.contains("22.18"), "{message}");
        assert!(message.contains("23.6"), "{message}");
        assert!(message.contains("Node 24"), "{message}");
        assert!(message.contains("v20.11.0"), "{message}");
        assert!(message.contains("/wf/run.ts"), "{message}");
    }

    #[test]
    fn response_omits_undefined_and_keeps_null_and_surrogates() {
        let missing = response_ok_line("1", None);
        assert_eq!(missing, "{\"op\":\"response\",\"id\":1,\"ok\":true}\n");
        let null_result = response_ok_line("2", Some("null"));
        assert!(null_result.contains("\"result\":null"), "{null_result}");
        let surrogate = response_ok_line("3", Some("\"\\ud800\""));
        assert!(surrogate.contains("\\ud800"), "{surrogate}");
    }

    #[test]
    fn response_err_includes_contract_issues_and_budget() {
        let err = WorkflowError::contract(vec![ContractValidationIssue {
            field: "name".into(),
            reason: ContractReason::Missing,
            message: "required string field \"name\" is missing".into(),
        }]);
        let line = response_err_line("4", &err);
        assert!(line.contains("\"issues\":"), "{line}");
        assert!(line.contains("\"field\":\"name\""), "{line}");
        let budget = WorkflowError::budget("maxTokens", 1000.0, 1001.0);
        let line = response_err_line("5", &budget);
        assert!(line.contains("\"budget\":\"maxTokens\""), "{line}");
        assert!(line.contains("\"limit\":1000"), "{line}");
        assert!(line.contains("\"spent\":1001"), "{line}");
        assert!(!line.contains("1000.0"), "{line}");
    }
}
