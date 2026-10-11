use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;

use protocol::JsNumber;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::case::{RunPatch, merge_fields, merge_fields_raw, update_run};
use crate::error::WorkflowError;
use crate::error::{ContractReason, ContractValidationIssue};
use crate::executors::{AgentExecuteOpts, ReportUsageFn, RunExecuteOpts};
use crate::flags;
use crate::io_fs::{self, try_exists};
use crate::journal::{append_journal, find_cached_step_result, is_open_gate};
use crate::pathutil::{node_join_paths, path_text};
use crate::registry::{CallContext, NamespacedCallRegistry};
use crate::timeutil::current_iso;
use crate::types::{
    AgentDef, CachedStep, Field, JournalEntry, LoadedWorkflow, StepKind, StepUsage,
    WorkflowBudgets, make_step_id,
};
use crate::wire::WireJson;

pub struct AgentStepOpts {
    pub agent: Option<String>,
    pub prompt: Option<WireJson>,
    pub out: Vec<String>,
    pub extra: Map<String, Value>,
}

impl AgentStepOpts {
    pub fn out(out: Vec<String>) -> Self {
        Self {
            agent: None,
            prompt: None,
            out,
            extra: Map::new(),
        }
    }

    pub fn agent(agent: impl Into<String>, out: Vec<String>) -> Self {
        Self {
            agent: Some(agent.into()),
            prompt: None,
            out,
            extra: Map::new(),
        }
    }

    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(WireJson::from_js(&protocol::js::JsValue::from_text(
            &prompt.into(),
        )));
        self
    }

    pub fn with_prompt_wire(mut self, prompt: WireJson) -> Self {
        self.prompt = Some(prompt);
        self
    }
}

pub struct RunStepOpts {
    pub script: Option<String>,
    pub skill: Option<String>,
    pub input: Option<WireJson>,
    pub extra: Map<String, Value>,
}

impl RunStepOpts {
    pub fn script(script: impl Into<String>) -> Self {
        Self {
            script: Some(script.into()),
            skill: None,
            input: None,
            extra: Map::new(),
        }
    }

    pub fn with_input(mut self, input: Map<String, Value>) -> Self {
        self.input = WireJson::from_value(&Value::Object(input)).ok();
        self
    }

    pub fn with_input_wire(mut self, input: WireJson) -> Self {
        self.input = Some(input);
        self
    }
}

pub struct HumanStepOpts {
    pub prompt: Option<WireJson>,
    pub fields: Vec<String>,
    pub extra: Map<String, Value>,
}

impl HumanStepOpts {
    pub fn fields(fields: Vec<String>) -> Self {
        Self {
            prompt: None,
            fields,
            extra: Map::new(),
        }
    }

    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(WireJson::from_js(&protocol::js::JsValue::from_text(
            &prompt.into(),
        )));
        self
    }

    pub fn with_prompt_wire(mut self, prompt: WireJson) -> Self {
        self.prompt = Some(prompt);
        self
    }
}

#[derive(Clone)]
pub struct StepScope {
    pub label_prefix: String,
    pub executor_case_dir: String,
    pub allow_human: bool,
    pub allow_parallel: bool,
    pub allow_done: bool,
    pub merge_agent_fields: bool,
}

pub struct ParallelBegin {
    pub replay: bool,
    pub result: Option<WireJson>,
    pub token: String,
    pub branches: Vec<StepScope>,
}

#[derive(Clone, Debug)]
pub struct StepOutput {
    defined: bool,
    value: Value,
    raw: Option<String>,
}

impl StepOutput {
    pub fn from_value(value: Value) -> Result<Self, WorkflowError> {
        let wire = WireJson::from_value(&value)?;
        Ok(Self {
            defined: true,
            value: wire.to_value(),
            raw: Some(wire.raw().to_string()),
        })
    }

    pub fn undefined() -> Self {
        Self {
            defined: false,
            value: Value::Null,
            raw: None,
        }
    }

    pub fn from_wire(wire: Option<WireJson>) -> Self {
        match wire {
            Some(wire) => Self {
                defined: true,
                value: wire.to_value(),
                raw: Some(wire.raw().to_string()),
            },
            None => Self::undefined(),
        }
    }

    pub fn wire(&self) -> Result<Option<WireJson>, WorkflowError> {
        if !self.defined {
            return Ok(None);
        }
        match &self.raw {
            Some(raw) => Ok(Some(WireJson::parse(raw)?)),
            None => Ok(Some(WireJson::from_value(&self.value)?)),
        }
    }

    pub fn into_value(self) -> Value {
        self.value
    }
}

impl std::ops::Deref for StepOutput {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl Serialize for StepOutput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.value.serialize(serializer)
    }
}

pub type BranchFn = Box<
    dyn FnOnce(Step) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send>> + Send,
>;

pub fn branch<F, Fut>(function: F) -> BranchFn
where
    F: FnOnce(Step) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, WorkflowError>> + Send + 'static,
{
    Box::new(move |step| Box::pin(function(step)))
}

enum Phase {
    Replay { result: Option<WireJson> },
    Live { step_id: String, seq: i64 },
}

struct PendingParallel {
    label: String,
    seq: i64,
    step_id: String,
}

struct Spend {
    tokens: f64,
    cost: f64,
}

struct StepInner {
    case_dir: String,
    run_id: String,
    workflow: LoadedWorkflow,
    journal: tokio::sync::Mutex<Vec<JournalEntry>>,
    executors: Arc<dyn crate::executors::ExecutorRegistry>,
    call_registry: NamespacedCallRegistry,
    step_timeout_ms: f64,
    output_fields: Vec<Field>,
    budgets: Option<WorkflowBudgets>,
    warn: Arc<dyn Fn(&str) + Send + Sync>,
    label_counts: Mutex<HashMap<String, i64>>,
    done_output: Mutex<Option<WireJson>>,
    spend: Mutex<Spend>,
    pending: Mutex<HashMap<String, PendingParallel>>,
}

pub struct StepRuntimeOptions {
    pub case_dir: String,
    pub run_id: String,
    pub workflow: LoadedWorkflow,
    pub journal: Vec<JournalEntry>,
    pub executors: Arc<dyn crate::executors::ExecutorRegistry>,
    pub call_registry: NamespacedCallRegistry,
    pub step_timeout_ms: f64,
    pub output_fields: Vec<Field>,
    pub budgets: Option<WorkflowBudgets>,
    pub warn: Arc<dyn Fn(&str) + Send + Sync>,
}

#[derive(Clone)]
pub struct Step {
    inner: Arc<StepInner>,
    scope: StepScope,
}

pub fn create_step_runtime(options: StepRuntimeOptions) -> Step {
    let mut tokens = 0.0;
    let mut cost = 0.0;
    for entry in &options.journal {
        if let JournalEntry::StepFinished {
            usage: Some(usage), ..
        } = entry
        {
            if let Some(value) = usage.token_f64() {
                tokens += value;
            }
            if let Some(value) = usage.cost_f64() {
                cost += value;
            }
        }
    }
    let scope = StepScope {
        label_prefix: String::new(),
        executor_case_dir: options.case_dir.clone(),
        allow_human: true,
        allow_parallel: true,
        allow_done: true,
        merge_agent_fields: true,
    };
    Step {
        inner: Arc::new(StepInner {
            case_dir: options.case_dir,
            run_id: options.run_id,
            workflow: options.workflow,
            journal: tokio::sync::Mutex::new(options.journal),
            executors: options.executors,
            call_registry: options.call_registry,
            step_timeout_ms: options.step_timeout_ms,
            output_fields: options.output_fields,
            budgets: options.budgets,
            warn: options.warn,
            label_counts: Mutex::new(HashMap::new()),
            done_output: Mutex::new(None),
            spend: Mutex::new(Spend { tokens, cost }),
            pending: Mutex::new(HashMap::new()),
        }),
        scope,
    }
}

impl Step {
    pub fn with_scope(&self, scope: StepScope) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            scope,
        }
    }

    pub fn done_output(&self) -> Option<Map<String, Value>> {
        self.done_output_wire()
            .and_then(|wire| wire.value().as_object().cloned())
    }

    pub fn done_output_wire(&self) -> Option<WireJson> {
        self.inner.done_output.lock().clone()
    }

    fn scoped_label(&self, label: &str) -> String {
        if self.scope.label_prefix.is_empty() {
            label.to_string()
        } else {
            format!("{}{label}", self.scope.label_prefix)
        }
    }

    pub async fn agent(
        &self,
        label: &str,
        opts: AgentStepOpts,
    ) -> Result<StepOutput, WorkflowError> {
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Agent).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(StepOutput::from_wire(result)),
            Phase::Live { step_id, seq } => (step_id, seq),
        };
        match self.agent_live(&full, &step_id, seq, opts).await {
            Ok(value) => Ok(value),
            Err(err) if err.is_suspension() => Err(err),
            Err(err) => {
                self.inner
                    .fail_step(&full, seq, &step_id, StepKind::Agent, &err)
                    .await?;
                Err(err)
            }
        }
    }

    async fn agent_live(
        &self,
        full: &str,
        step_id: &str,
        seq: i64,
        opts: AgentStepOpts,
    ) -> Result<StepOutput, WorkflowError> {
        let agent_def = match &opts.agent {
            Some(name) => Some(self.known_agent(name, full)?),
            None => None,
        };
        let slot: Arc<Mutex<Option<StepUsage>>> = Arc::new(Mutex::new(None));
        let report_slot = Arc::clone(&slot);
        let report_usage: ReportUsageFn = Arc::new(move |usage| {
            let mut guard = report_slot.lock();
            *guard = Some(merge_usage(guard.clone(), usage));
        });
        let result = self
            .inner
            .executors
            .agent()
            .execute(AgentExecuteOpts {
                label: full.to_string(),
                step_id: step_id.to_string(),
                agent: opts.agent,
                prompt: opts.prompt,
                out: opts.out.clone(),
                agent_def,
                case_dir: self.scope.executor_case_dir.clone(),
                workflow: self.inner.workflow.clone(),
                timeout_ms: self.inner.step_timeout_ms,
                extra: opts.extra,
                report_usage,
            })
            .await?;
        if self.scope.merge_agent_fields {
            self.merge_agent_result(full, step_id, seq, &opts.out, &result)
                .await?;
        }
        let usage = slot.lock().clone();
        self.inner.accumulate(usage.as_ref());
        let output = StepOutput::from_value(result)?;
        self.inner
            .finish_step(full, seq, step_id, StepKind::Agent, output.wire()?, usage)
            .await?;
        Ok(output)
    }

    fn known_agent(&self, name: &str, label: &str) -> Result<AgentDef, WorkflowError> {
        if let Some(agent) = self.inner.workflow.agents.get(name) {
            return Ok(agent.clone());
        }
        let known = if self.inner.workflow.agents.is_empty() {
            "none".to_string()
        } else {
            self.inner
                .workflow
                .agents
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        };
        Err(WorkflowError::message(format!(
            "Unknown agent \"{name}\" in step \"{label}\" — no agents/{name}.md in workflow \"{}\" (known: {known})",
            self.inner.workflow.manifest.id
        )))
    }

    async fn merge_agent_result(
        &self,
        full: &str,
        step_id: &str,
        seq: i64,
        out: &[String],
        result: &Value,
    ) -> Result<(), WorkflowError> {
        let Some(object) = result.as_object() else {
            return Ok(());
        };
        let mut declared = Map::new();
        let mut undeclared = Vec::new();
        for (key, value) in object {
            if out.iter().any(|name| name == key) {
                declared.insert(key.clone(), value.clone());
            } else {
                undeclared.push(key.clone());
            }
        }
        if !declared.is_empty() {
            merge_fields(Path::new(&self.inner.case_dir), &declared).await?;
        }
        if !undeclared.is_empty() {
            let message = format!(
                "Agent step \"{full}\" returned undeclared fields (not merged): {}",
                undeclared.join(", ")
            );
            let entry = JournalEntry::ManifestWarn {
                ts: current_iso(),
                step_id: step_id.to_string(),
                label: full.to_string(),
                seq,
                undeclared,
                message: message.clone(),
            };
            append_journal(Path::new(&self.inner.case_dir), &entry).await?;
            self.inner.journal.lock().await.push(entry);
            (self.inner.warn)(&message);
            tracing::warn!("{message}");
        }
        Ok(())
    }

    pub async fn run(&self, label: &str, opts: RunStepOpts) -> Result<StepOutput, WorkflowError> {
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Run).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(StepOutput::from_wire(result)),
            Phase::Live { step_id, seq } => (step_id, seq),
        };
        match self.run_live(&full, &step_id, seq, opts).await {
            Ok(value) => Ok(value),
            Err(err) if err.is_suspension() => Err(err),
            Err(err) => {
                self.inner
                    .fail_step(&full, seq, &step_id, StepKind::Run, &err)
                    .await?;
                Err(err)
            }
        }
    }

    async fn run_live(
        &self,
        full: &str,
        step_id: &str,
        seq: i64,
        opts: RunStepOpts,
    ) -> Result<StepOutput, WorkflowError> {
        let slot: Arc<Mutex<Option<StepUsage>>> = Arc::new(Mutex::new(None));
        let report_slot = Arc::clone(&slot);
        let report_usage: ReportUsageFn = Arc::new(move |usage| {
            let mut guard = report_slot.lock();
            *guard = Some(merge_usage(guard.clone(), usage));
        });
        let result = self
            .inner
            .executors
            .run()
            .execute(RunExecuteOpts {
                label: full.to_string(),
                step_id: step_id.to_string(),
                script: opts.script,
                skill: opts.skill,
                input: opts.input,
                case_dir: self.scope.executor_case_dir.clone(),
                workflow: self.inner.workflow.clone(),
                timeout_ms: self.inner.step_timeout_ms,
                extra: opts.extra,
                report_usage,
            })
            .await?;
        let usage = slot.lock().clone();
        self.inner.accumulate(usage.as_ref());
        let output = StepOutput::from_value(result)?;
        self.inner
            .finish_step(full, seq, step_id, StepKind::Run, output.wire()?, usage)
            .await?;
        Ok(output)
    }

    pub async fn human(
        &self,
        label: &str,
        opts: HumanStepOpts,
    ) -> Result<StepOutput, WorkflowError> {
        if !self.scope.allow_human {
            return Err(WorkflowError::message(format!(
                "step.human(\"{label}\") is not allowed inside a step.parallel branch (partial suspension is undefined in v1)"
            )));
        }
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Human).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(StepOutput::from_wire(result)),
            Phase::Live { step_id, seq } => (step_id, seq),
        };
        if !is_open_gate(&self.inner.journal.lock().await, &full, seq) {
            let entry = JournalEntry::GateOpened {
                ts: current_iso(),
                step_id: step_id.clone(),
                label: full.clone(),
                seq,
                prompt: opts.prompt,
                fields: opts.fields,
            };
            append_journal(Path::new(&self.inner.case_dir), &entry).await?;
            self.inner.journal.lock().await.push(entry);
        }
        update_run(
            Path::new(&self.inner.case_dir),
            RunPatch {
                status: Some(crate::types::RunStatus::PausedHuman),
                current: Some(step_id.clone()),
                ..RunPatch::default()
            },
        )
        .await?;
        Err(WorkflowError::suspension(step_id, full, seq))
    }

    pub async fn call(
        &self,
        label: &str,
        reference: &str,
        input: Map<String, Value>,
    ) -> Result<StepOutput, WorkflowError> {
        let wire = WireJson::from_value(&Value::Object(input))?;
        self.call_wire(label, reference, wire).await
    }

    pub async fn call_wire(
        &self,
        label: &str,
        reference: &str,
        input: WireJson,
    ) -> Result<StepOutput, WorkflowError> {
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Call).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(StepOutput::from_wire(result)),
            Phase::Live { step_id, seq } => (step_id, seq),
        };
        let called = self
            .inner
            .call_registry
            .call(
                reference,
                input,
                CallContext {
                    parent_run_id: self.inner.run_id.clone(),
                    parent_step_id: step_id.clone(),
                    parent_case_dir: self.inner.case_dir.clone(),
                    timeout_ms: Some(self.inner.step_timeout_ms),
                },
            )
            .await;
        match called {
            Ok(result) => {
                let output = StepOutput::from_wire(Some(result));
                self.inner
                    .finish_step(&full, seq, &step_id, StepKind::Call, output.wire()?, None)
                    .await?;
                Ok(output)
            }
            Err(err) if err.is_suspension() => Err(err),
            Err(err) => {
                self.inner
                    .fail_step(&full, seq, &step_id, StepKind::Call, &err)
                    .await?;
                Err(err)
            }
        }
    }

    pub async fn done(&self, output: Map<String, Value>) -> Result<(), WorkflowError> {
        let wire = WireJson::from_value(&Value::Object(output))?;
        self.done_wire_store(wire).await
    }

    pub async fn done_wire(&self, output: WireJson) -> Result<(), WorkflowError> {
        self.done_wire_store(output).await
    }

    async fn done_wire_store(&self, output: WireJson) -> Result<(), WorkflowError> {
        if !self.scope.allow_done {
            return Err(WorkflowError::message(
                "step.done() is not allowed inside a step.parallel branch — return a value from the branch function instead",
            ));
        }
        self.inner.check_kill().await?;
        self.inner.check_budget()?;
        let entries = output.entries()?;
        let missing: Vec<&Field> = self
            .inner
            .output_fields
            .iter()
            .filter(|field| {
                field.is_required()
                    && match entries.iter().find(|(key, _)| key == &field.name) {
                        None => true,
                        Some((_, raw)) if raw == "null" => true,
                        Some(_) => false,
                    }
            })
            .collect();
        if !missing.is_empty() {
            let issues = missing
                .into_iter()
                .map(|field| ContractValidationIssue {
                    field: field.name.clone(),
                    reason: ContractReason::Missing,
                    message: format!(
                        "required {} output field \"{}\" is missing from step.done()",
                        field.field_type.as_str(),
                        field.name
                    ),
                })
                .collect();
            return Err(WorkflowError::contract(issues));
        }
        let seq = self.inner.next_seq("done");
        let step_id = make_step_id("done", seq);
        {
            let mut slot = self.inner.done_output.lock();
            *slot = Some(output.clone());
        }
        merge_fields_raw(Path::new(&self.inner.case_dir), entries).await?;
        self.inner
            .finish_step("done", seq, &step_id, StepKind::Done, Some(output), None)
            .await?;
        Ok(())
    }

    pub async fn parallel(
        &self,
        label: &str,
        branches: Vec<BranchFn>,
    ) -> Result<StepOutput, WorkflowError> {
        if !self.scope.allow_parallel {
            return Err(WorkflowError::message(format!(
                "nested step.parallel(\"{label}\") is not allowed — parallel branches cannot contain step.parallel"
            )));
        }
        let begin = self.parallel_begin(label, branches.len()).await?;
        if begin.replay {
            return Ok(StepOutput::from_wire(begin.result));
        }
        let token = begin.token.clone();
        let count = branches.len();
        if count == 0 {
            return self.finish_parallel_values(&token, Vec::new()).await;
        }
        let (tx, mut rx) =
            tokio::sync::mpsc::channel::<(usize, Result<Value, WorkflowError>)>(count);
        for (index, (scope, function)) in begin.branches.into_iter().zip(branches).enumerate() {
            let tx = tx.clone();
            let step = self.with_scope(scope);
            tokio::spawn(async move {
                let result = function(step).await;
                let _ = tx.send((index, result)).await;
            });
        }
        drop(tx);
        let mut slots = vec![None; count];
        let mut got = 0usize;
        while let Some((index, result)) = rx.recv().await {
            match result {
                Ok(value) => {
                    if index < slots.len() && slots[index].is_none() {
                        slots[index] = Some(value);
                        got += 1;
                    }
                    if got == count {
                        let mut results = Vec::with_capacity(count);
                        for slot in slots {
                            let Some(value) = slot else {
                                return Err(WorkflowError::message(
                                    "parallel branch did not return a result",
                                ));
                            };
                            results.push(value);
                        }
                        return self.finish_parallel_values(&token, results).await;
                    }
                }
                Err(err) if err.is_suspension() => return Err(err),
                Err(err) => {
                    self.parallel_fail(&token, &err).await?;
                    return Err(err);
                }
            }
        }
        Err(WorkflowError::message("parallel branch stopped"))
    }

    async fn finish_parallel_values(
        &self,
        token: &str,
        results: Vec<Value>,
    ) -> Result<StepOutput, WorkflowError> {
        let output = StepOutput::from_value(Value::Array(results))?;
        let Some(wire) = output.wire()? else {
            return Err(WorkflowError::message("parallel result missing"));
        };
        self.parallel_finish(token, wire).await?;
        Ok(output)
    }

    pub async fn parallel_begin(
        &self,
        label: &str,
        count: usize,
    ) -> Result<ParallelBegin, WorkflowError> {
        if !self.scope.allow_parallel {
            return Err(WorkflowError::message(format!(
                "nested step.parallel(\"{label}\") is not allowed — parallel branches cannot contain step.parallel"
            )));
        }
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Parallel).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => {
                return Ok(ParallelBegin {
                    replay: true,
                    result,
                    token: String::new(),
                    branches: Vec::new(),
                });
            }
            Phase::Live { step_id, seq } => (step_id, seq),
        };
        let mut branches = Vec::with_capacity(count);
        for index in 0..count {
            let rel = format!("{step_id}/b{index}");
            let dir = node_join_paths(Path::new(&self.inner.case_dir), &rel);
            if let Err(err) = io_fs::create_dir_all(&dir).await {
                self.inner
                    .fail_step(&full, seq, &step_id, StepKind::Parallel, &err)
                    .await?;
                return Err(err);
            }
            branches.push(StepScope {
                label_prefix: format!("{step_id}/b{index}:"),
                executor_case_dir: path_text(&dir),
                allow_human: false,
                allow_parallel: false,
                allow_done: false,
                merge_agent_fields: false,
            });
        }
        self.inner.pending.lock().insert(
            step_id.clone(),
            PendingParallel {
                label: full,
                seq,
                step_id: step_id.clone(),
            },
        );
        Ok(ParallelBegin {
            replay: false,
            result: None,
            token: step_id,
            branches,
        })
    }

    pub async fn parallel_finish(
        &self,
        token: &str,
        result: WireJson,
    ) -> Result<(), WorkflowError> {
        let pending = { self.inner.pending.lock().remove(token) };
        let Some(pending) = pending else {
            return Err(WorkflowError::message(format!(
                "unknown parallel token \"{token}\""
            )));
        };
        self.inner
            .finish_step(
                &pending.label,
                pending.seq,
                &pending.step_id,
                StepKind::Parallel,
                Some(result),
                None,
            )
            .await
    }

    pub async fn parallel_fail(
        &self,
        token: &str,
        err: &WorkflowError,
    ) -> Result<(), WorkflowError> {
        if err.is_suspension() {
            return Ok(());
        }
        let pending = { self.inner.pending.lock().remove(token) };
        let Some(pending) = pending else {
            return Ok(());
        };
        self.inner
            .fail_step(
                &pending.label,
                pending.seq,
                &pending.step_id,
                StepKind::Parallel,
                err,
            )
            .await
    }
}

impl StepInner {
    fn next_seq(&self, label: &str) -> i64 {
        let mut counts = self.label_counts.lock();
        let next = counts.get(label).copied().unwrap_or(0) + 1;
        counts.insert(label.to_string(), next);
        next
    }

    fn accumulate(&self, usage: Option<&StepUsage>) {
        let Some(usage) = usage else {
            return;
        };
        let mut spend = self.spend.lock();
        if let Some(tokens) = usage.token_f64() {
            spend.tokens += tokens;
        }
        if let Some(cost) = usage.cost_f64() {
            spend.cost += cost;
        }
    }

    fn check_budget(&self) -> Result<(), WorkflowError> {
        let Some(budgets) = &self.budgets else {
            return Ok(());
        };
        let spend = self.spend.lock();
        if let Some(limit) = positive_limit(budgets.max_tokens)
            && spend.tokens > limit
        {
            return Err(WorkflowError::budget("maxTokens", limit, spend.tokens));
        }
        if let Some(limit) = positive_limit(budgets.max_cost)
            && spend.cost > limit
        {
            return Err(WorkflowError::budget("maxCost", limit, spend.cost));
        }
        Ok(())
    }

    async fn check_kill(&self) -> Result<(), WorkflowError> {
        if flags::kill_flag(&self.run_id) {
            return Err(WorkflowError::killed(&self.run_id));
        }
        let path = node_join_paths(Path::new(&self.case_dir), "KILLED");
        if try_exists(&path).await? {
            return Err(WorkflowError::killed(&self.run_id));
        }
        Ok(())
    }

    async fn begin_step(&self, label: &str, kind: StepKind) -> Result<Phase, WorkflowError> {
        self.check_kill().await?;
        self.check_budget()?;
        let seq = self.next_seq(label);
        let step_id = make_step_id(label, seq);
        let cached = {
            let journal = self.journal.lock().await;
            find_cached_step_result(&journal, label, seq, Some(kind.as_str()))?
        };
        if let CachedStep::Hit { result, .. } = cached {
            return Ok(Phase::Replay { result });
        }
        let already_started = {
            let journal = self.journal.lock().await;
            journal.iter().any(|entry| {
                matches!(
                    entry,
                    JournalEntry::StepStarted {
                        label: entry_label,
                        seq: entry_seq,
                        ..
                    } if entry_label == label && *entry_seq == seq
                )
            })
        };
        if !already_started {
            let started = JournalEntry::StepStarted {
                ts: current_iso(),
                step_id: step_id.clone(),
                label: label.to_string(),
                seq,
                kind,
            };
            append_journal(Path::new(&self.case_dir), &started).await?;
            self.journal.lock().await.push(started);
        }
        update_run(
            Path::new(&self.case_dir),
            RunPatch {
                current: Some(step_id.clone()),
                status: Some(crate::types::RunStatus::Running),
                ..RunPatch::default()
            },
        )
        .await?;
        tracing::debug!(step_id = %step_id, kind = kind.as_str(), "step_live");
        Ok(Phase::Live { step_id, seq })
    }

    async fn finish_step(
        &self,
        label: &str,
        seq: i64,
        step_id: &str,
        kind: StepKind,
        result: Option<WireJson>,
        usage: Option<StepUsage>,
    ) -> Result<(), WorkflowError> {
        let usage = usage.filter(|item| !item.is_empty());
        let entry = JournalEntry::StepFinished {
            ts: current_iso(),
            step_id: step_id.to_string(),
            label: label.to_string(),
            seq,
            kind,
            result,
            usage,
        };
        append_journal(Path::new(&self.case_dir), &entry).await?;
        self.journal.lock().await.push(entry);
        Ok(())
    }

    async fn fail_step(
        &self,
        label: &str,
        seq: i64,
        step_id: &str,
        kind: StepKind,
        err: &WorkflowError,
    ) -> Result<(), WorkflowError> {
        let entry = JournalEntry::StepFailed {
            ts: current_iso(),
            step_id: step_id.to_string(),
            label: label.to_string(),
            seq,
            kind,
            error: err.to_string(),
        };
        append_journal(Path::new(&self.case_dir), &entry).await?;
        self.journal.lock().await.push(entry);
        Ok(())
    }
}

fn positive_limit(limit: Option<JsNumber>) -> Option<f64> {
    let value = limit?.as_f64();
    if value.is_finite() && value > 0.0 {
        Some(value)
    } else {
        None
    }
}

fn merge_usage(current: Option<StepUsage>, next: StepUsage) -> StepUsage {
    let mut tokens = current.as_ref().and_then(StepUsage::token_f64);
    let mut cost = current.as_ref().and_then(StepUsage::cost_f64);
    if let Some(value) = next.token_f64() {
        tokens = Some(tokens.unwrap_or(0.0) + value);
    }
    if let Some(value) = next.cost_f64() {
        cost = Some(cost.unwrap_or(0.0) + value);
    }
    StepUsage {
        tokens: tokens.map(JsNumber::from),
        cost_usd: cost.map(JsNumber::from),
    }
}
