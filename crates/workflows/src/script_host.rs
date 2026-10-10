use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::error::WorkflowError;
use crate::step::{AgentStepOpts, HumanStepOpts, ParallelBegin, RunStepOpts, Step, StepScope};

const NODE_BIN: &str = "/usr/bin/node";
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

pub struct HostContext {
    pub run_id: String,
    pub input: Map<String, Value>,
    pub case_dir: String,
    pub fields: Map<String, Value>,
}

pub async fn drive_node(run_path: &str, step: Step, ctx: HostContext) -> Result<(), WorkflowError> {
    let mut child = Command::new(NODE_BIN)
        .arg("--input-type=module")
        .arg("-e")
        .arg(BRIDGE)
        .env("RIVET_WF_RUN_PATH", run_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| {
            WorkflowError::message(format!(
                "failed to spawn node for {}: {err}",
                Path::new(run_path).display()
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
