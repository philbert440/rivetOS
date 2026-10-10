use std::fmt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::error::WorkflowError;
use crate::step::{AgentStepOpts, HumanStepOpts, ParallelBegin, RunStepOpts, Step, StepScope};

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
function write(obj) {
  writeSync(1, JSON.stringify(obj) + '\n')
}
const pending = new Map()
let seq = 0
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
        const results = await Promise.all(branches.map((fn, i) => fn(makeStep(prep.branches[i].scope))))
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
    if (msg.ok) item.resolve(msg.result === undefined ? null : msg.result)
    else {
      const error = new Error(msg.error || 'step failed')
      error.name = msg.name || 'Error'
      if (msg.stepId !== undefined) error.stepId = msg.stepId
      if (msg.label !== undefined) error.label = msg.label
      if (msg.seq !== undefined) error.seq = msg.seq
      if (msg.runId !== undefined) error.runId = msg.runId
      item.reject(error)
    }
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
  write({
    op: 'script_error',
    message: err && err.message ? err.message : String(err),
    name: err && err.name,
    stepId: err && err.stepId,
    label: err && err.label,
    seq: err && err.seq,
    runId: err && err.runId,
  })
}
process.exit(0)
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
    pub input: Map<String, Value>,
    pub case_dir: String,
    pub fields: Map<String, Value>,
}

pub async fn drive_node(run_path: &str, step: Step, ctx: HostContext) -> Result<(), WorkflowError> {
    let plan = launch_plan(run_path).await?;
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
        .env("RIVET_WF_RUN_PATH", run_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(root) = &plan.current_dir {
        command.current_dir(root);
    }
    let mut child = command.spawn().map_err(|err| {
        WorkflowError::message(format!(
            "failed to spawn {} for {} (loader {}): {err}",
            plan.node.display(),
            Path::new(run_path).display(),
            plan.strategy
        ))
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| WorkflowError::message("node stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorkflowError::message("node stdout unavailable"))?;
    let stderr = child.stderr.take();
    let (stderr_tx, mut stderr_rx) = tokio::sync::mpsc::channel(1);
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut text = String::new();
            let _ = reader.read_to_string(&mut text).await;
            let _ = stderr_tx.send(text).await;
        });
    }
    let mut ctx_map = Map::new();
    ctx_map.insert("runId".to_string(), Value::String(ctx.run_id));
    ctx_map.insert("input".to_string(), Value::Object(ctx.input));
    ctx_map.insert("caseDir".to_string(), Value::String(ctx.case_dir));
    ctx_map.insert("fields".to_string(), Value::Object(ctx.fields));
    let mut start = Map::new();
    start.insert("op".to_string(), Value::String("start".to_string()));
    start.insert("ctx".to_string(), Value::Object(ctx_map));
    write_line(&mut stdin, &Value::Object(start)).await?;
    let mut lines = BufReader::new(stdout).lines();
    let outcome = loop {
        let next = tokio::time::timeout(Duration::from_secs(60), lines.next_line()).await;
        let line = match next {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                let stderr_text = stderr_rx.try_recv().unwrap_or_default();
                break Err(WorkflowError::message(format!(
                    "node script closed stdout for {run_path} {stderr_text}"
                )));
            }
            Ok(Err(err)) => break Err(WorkflowError::message(format!("node stdout: {err}"))),
            Err(_) => {
                break Err(WorkflowError::message(format!(
                    "node script timed out waiting for output: {run_path}"
                )));
            }
        };
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(err) => {
                break Err(WorkflowError::message(format!(
                    "node script sent invalid json: {err}"
                )));
            }
        };
        let op = message.get("op").and_then(Value::as_str).unwrap_or("");
        if op == "script_done" {
            break Ok(());
        }
        if op == "script_error" {
            break Err(script_error(&message));
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let result = dispatch(&step, &message).await;
        let response = match result {
            Ok(value) => response_ok(id, value),
            Err(err) => response_err(id, &err),
        };
        if let Err(err) = write_line(&mut stdin, &response).await {
            break Err(err);
        }
    };
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    outcome
}

async fn write_line(
    stdin: &mut tokio::process::ChildStdin,
    value: &Value,
) -> Result<(), WorkflowError> {
    let mut line =
        serde_json::to_string(value).map_err(|err| WorkflowError::message(err.to_string()))?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|err| WorkflowError::message(format!("node stdin: {err}")))?;
    stdin
        .flush()
        .await
        .map_err(|err| WorkflowError::message(format!("node stdin: {err}")))?;
    Ok(())
}

fn script_error(message: &Value) -> WorkflowError {
    let text = message
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("run script failed")
        .to_string();
    let name = message.get("name").and_then(Value::as_str).unwrap_or("");
    match name {
        "WorkflowSuspension" => {
            let step_id = message
                .get("stepId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let label = message
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let seq = message.get("seq").and_then(Value::as_i64).unwrap_or(0);
            WorkflowError::Suspension {
                message: text,
                step_id,
                label,
                seq,
            }
        }
        "WorkflowKilled" => {
            let run_id = message
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if run_id.is_empty() {
                WorkflowError::message(text)
            } else {
                WorkflowError::killed(run_id)
            }
        }
        _ => WorkflowError::message(text),
    }
}

fn response_ok(id: Value, result: Value) -> Value {
    let mut map = Map::new();
    map.insert("op".to_string(), Value::String("response".to_string()));
    map.insert("id".to_string(), id);
    map.insert("ok".to_string(), Value::Bool(true));
    map.insert("result".to_string(), result);
    Value::Object(map)
}

fn response_err(id: Value, err: &WorkflowError) -> Value {
    let mut map = Map::new();
    map.insert("op".to_string(), Value::String("response".to_string()));
    map.insert("id".to_string(), id);
    map.insert("ok".to_string(), Value::Bool(false));
    map.insert("error".to_string(), Value::String(err.to_string()));
    map.insert("name".to_string(), Value::String(err.name().to_string()));
    match err {
        WorkflowError::Suspension {
            step_id,
            label,
            seq,
            ..
        } => {
            map.insert("stepId".to_string(), Value::String(step_id.clone()));
            map.insert("label".to_string(), Value::String(label.clone()));
            map.insert("seq".to_string(), Value::from(*seq));
        }
        WorkflowError::Killed { run_id, .. } => {
            map.insert("runId".to_string(), Value::String(run_id.clone()));
        }
        _ => {}
    }
    Value::Object(map)
}

async fn dispatch(step: &Step, message: &Value) -> Result<Value, WorkflowError> {
    let op = message.get("op").and_then(Value::as_str).unwrap_or("");
    let scoped = step_for(step, message);
    let label = message.get("label").and_then(Value::as_str).unwrap_or("");
    match op {
        "agent" => scoped.agent(label, agent_opts(message.get("opts"))).await,
        "run" => scoped.run(label, run_opts(message.get("opts"))).await,
        "human" => scoped.human(label, human_opts(message.get("opts"))).await,
        "call" => {
            let reference = message.get("ref").and_then(Value::as_str).unwrap_or("");
            let input = message
                .get("input")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            scoped.call(label, reference, input).await
        }
        "done" => {
            let output = message
                .get("output")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            scoped.done(output).await?;
            Ok(Value::Null)
        }
        "parallel_begin" => {
            let count = message.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
            let begin = scoped.parallel_begin(label, count).await?;
            Ok(parallel_begin_value(begin))
        }
        "parallel_end" => {
            let token = message.get("token").and_then(Value::as_str).unwrap_or("");
            let results = message
                .get("results")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            scoped.parallel_finish(token, results).await?;
            Ok(Value::Null)
        }
        "parallel_fail" => {
            let token = message.get("token").and_then(Value::as_str).unwrap_or("");
            let text = message
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("parallel branch failed");
            scoped
                .parallel_fail(token, &WorkflowError::message(text))
                .await?;
            Ok(Value::Null)
        }
        _ => Err(WorkflowError::message(format!(
            "unknown script op \"{op}\""
        ))),
    }
}

fn step_for(step: &Step, message: &Value) -> Step {
    match message.get("scope") {
        Some(Value::Object(scope)) => step.with_scope(StepScope {
            label_prefix: scope
                .get("labelPrefix")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            executor_case_dir: scope
                .get("executorCaseDir")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            allow_human: scope
                .get("allowHuman")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            allow_parallel: scope
                .get("allowParallel")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            allow_done: scope
                .get("allowDone")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            merge_agent_fields: scope
                .get("mergeAgentFields")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }),
        _ => step.clone(),
    }
}

fn agent_opts(value: Option<&Value>) -> AgentStepOpts {
    let Some(object) = value.and_then(Value::as_object) else {
        return AgentStepOpts::out(Vec::new());
    };
    let out = match object.get("out") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let mut extra = object.clone();
    extra.shift_remove("agent");
    extra.shift_remove("prompt");
    extra.shift_remove("out");
    AgentStepOpts {
        agent: object
            .get("agent")
            .and_then(Value::as_str)
            .map(str::to_string),
        prompt: object
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_string),
        out,
        extra,
    }
}

fn run_opts(value: Option<&Value>) -> RunStepOpts {
    let Some(object) = value.and_then(Value::as_object) else {
        return RunStepOpts {
            script: None,
            skill: None,
            input: None,
            extra: Map::new(),
        };
    };
    let input = object.get("in").and_then(Value::as_object).cloned();
    let mut extra = object.clone();
    extra.shift_remove("script");
    extra.shift_remove("skill");
    extra.shift_remove("in");
    RunStepOpts {
        script: object
            .get("script")
            .and_then(Value::as_str)
            .map(str::to_string),
        skill: object
            .get("skill")
            .and_then(Value::as_str)
            .map(str::to_string),
        input,
        extra,
    }
}

fn human_opts(value: Option<&Value>) -> HumanStepOpts {
    let Some(object) = value.and_then(Value::as_object) else {
        return HumanStepOpts::fields(Vec::new());
    };
    let fields = match object.get("fields") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let mut extra = object.clone();
    extra.shift_remove("prompt");
    extra.shift_remove("fields");
    HumanStepOpts {
        prompt: object
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_string),
        fields,
        extra,
    }
}

fn parallel_begin_value(begin: ParallelBegin) -> Value {
    let mut map = Map::new();
    if begin.replay {
        map.insert("replay".to_string(), Value::Bool(true));
        map.insert("result".to_string(), begin.result.unwrap_or(Value::Null));
        return Value::Object(map);
    }
    let branches = begin
        .branches
        .into_iter()
        .map(|scope| {
            let mut scope_map = Map::new();
            scope_map.insert("labelPrefix".to_string(), Value::String(scope.label_prefix));
            scope_map.insert(
                "executorCaseDir".to_string(),
                Value::String(scope.executor_case_dir),
            );
            scope_map.insert("allowHuman".to_string(), Value::Bool(scope.allow_human));
            scope_map.insert(
                "allowParallel".to_string(),
                Value::Bool(scope.allow_parallel),
            );
            scope_map.insert("allowDone".to_string(), Value::Bool(scope.allow_done));
            scope_map.insert(
                "mergeAgentFields".to_string(),
                Value::Bool(scope.merge_agent_fields),
            );
            let mut item = Map::new();
            item.insert("scope".to_string(), Value::Object(scope_map));
            Value::Object(item)
        })
        .collect();
    map.insert("replay".to_string(), Value::Bool(false));
    map.insert("token".to_string(), Value::String(begin.token));
    map.insert("branches".to_string(), Value::Array(branches));
    Value::Object(map)
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
        let path = PathBuf::from(name);
        if is_executable(&path).await {
            return Some(path);
        }
        return None;
    }
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(name);
        if is_executable(&candidate).await {
            return Some(candidate);
        }
    }
    None
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
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd;
        loop {
            push_unique(&mut roots, dir.clone());
            if !dir.pop() {
                break;
            }
        }
    }
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
        NodeVersion, TypeStrip, needs_typescript, parse_node_version, type_strip,
        typescript_unavailable,
    };

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
}
