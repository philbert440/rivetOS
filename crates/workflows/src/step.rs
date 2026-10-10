use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use protocol::JsNumber;
use serde_json::{Map, Value};

use crate::case::{RunPatch, merge_fields, update_run};
use crate::error::WorkflowError;
use crate::error::{ContractReason, ContractValidationIssue};
use crate::executors::{AgentExecuteOpts, ReportUsageFn, RunExecuteOpts};
use crate::flags;
use crate::io_fs::{self, try_exists};
use crate::journal::{append_journal, find_cached_step_result, is_open_gate};
use crate::pathutil::{node_join_paths, path_text};
use crate::registry::{CallContext, NamespacedCallRegistry};
use crate::timeutil::now_iso;
use crate::types::{
    AgentDef, Field, JournalEntry, LoadedWorkflow, StepKind, StepUsage, WorkflowBudgets,
    make_step_id,
};

pub struct AgentStepOpts {
    pub agent: Option<String>,
    pub prompt: Option<String>,
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
        self.prompt = Some(prompt.into());
        self
    }
}

pub struct RunStepOpts {
    pub script: Option<String>,
    pub skill: Option<String>,
    pub input: Option<Map<String, Value>>,
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
        self.input = Some(input);
        self
    }
}

pub struct HumanStepOpts {
    pub prompt: Option<String>,
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
        self.prompt = Some(prompt.into());
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
    pub result: Option<Value>,
    pub token: String,
    pub branches: Vec<StepScope>,
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
    Replay { result: Value },
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
    done_output: Mutex<Option<Map<String, Value>>>,
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
        self.inner
            .done_output
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    fn scoped_label(&self, label: &str) -> String {
        if self.scope.label_prefix.is_empty() {
            label.to_string()
        } else {
            format!("{}{label}", self.scope.label_prefix)
        }
    }

    pub async fn agent(&self, label: &str, opts: AgentStepOpts) -> Result<Value, WorkflowError> {
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Agent).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(result),
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
    ) -> Result<Value, WorkflowError> {
        let agent_def = match &opts.agent {
            Some(name) => Some(self.known_agent(name, full)?),
            None => None,
        };
        let slot: Arc<Mutex<Option<StepUsage>>> = Arc::new(Mutex::new(None));
        let report_slot = Arc::clone(&slot);
        let report_usage: ReportUsageFn = Arc::new(move |usage| {
            let mut guard = report_slot.lock().unwrap_or_else(|err| err.into_inner());
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
        let usage = slot.lock().unwrap_or_else(|err| err.into_inner()).clone();
        self.inner.accumulate(usage.as_ref());
        self.inner
            .finish_step(full, seq, step_id, StepKind::Agent, result.clone(), usage)
            .await?;
        Ok(result)
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
                ts: now_iso(),
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

    pub async fn run(&self, label: &str, opts: RunStepOpts) -> Result<Value, WorkflowError> {
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Run).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(result),
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
    ) -> Result<Value, WorkflowError> {
        let slot: Arc<Mutex<Option<StepUsage>>> = Arc::new(Mutex::new(None));
        let report_slot = Arc::clone(&slot);
        let report_usage: ReportUsageFn = Arc::new(move |usage| {
            let mut guard = report_slot.lock().unwrap_or_else(|err| err.into_inner());
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
        let usage = slot.lock().unwrap_or_else(|err| err.into_inner()).clone();
        self.inner.accumulate(usage.as_ref());
        self.inner
            .finish_step(full, seq, step_id, StepKind::Run, result.clone(), usage)
            .await?;
        Ok(result)
    }

    pub async fn human(&self, label: &str, opts: HumanStepOpts) -> Result<Value, WorkflowError> {
        if !self.scope.allow_human {
            return Err(WorkflowError::message(format!(
                "step.human(\"{label}\") is not allowed inside a step.parallel branch (partial suspension is undefined in v1)"
            )));
        }
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Human).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(result),
            Phase::Live { step_id, seq } => (step_id, seq),
        };
        if !is_open_gate(&self.inner.journal.lock().await, &full, seq) {
            let entry = JournalEntry::GateOpened {
                ts: now_iso(),
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
    ) -> Result<Value, WorkflowError> {
        let full = self.scoped_label(label);
        let phase = self.inner.begin_step(&full, StepKind::Call).await?;
        let (step_id, seq) = match phase {
            Phase::Replay { result } => return Ok(result),
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
                self.inner
                    .finish_step(&full, seq, &step_id, StepKind::Call, result.clone(), None)
                    .await?;
                Ok(result)
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
        if !self.scope.allow_done {
            return Err(WorkflowError::message(
                "step.done() is not allowed inside a step.parallel branch — return a value from the branch function instead",
            ));
        }
        self.inner.check_kill().await?;
        self.inner.check_budget()?;
        let missing: Vec<&Field> = self
            .inner
            .output_fields
            .iter()
            .filter(|field| {
                field.is_required()
                    && match output.get(&field.name) {
                        None | Some(Value::Null) => true,
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
            let mut slot = self
                .inner
                .done_output
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            *slot = Some(output.clone());
        }
        merge_fields(Path::new(&self.inner.case_dir), &output).await?;
        self.inner
            .finish_step(
                "done",
                seq,
                &step_id,
                StepKind::Done,
                Value::Object(output),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn parallel(
        &self,
        label: &str,
        branches: Vec<BranchFn>,
    ) -> Result<Value, WorkflowError> {
        if !self.scope.allow_parallel {
            return Err(WorkflowError::message(format!(
                "nested step.parallel(\"{label}\") is not allowed — parallel branches cannot contain step.parallel"
            )));
        }
        let begin = self.parallel_begin(label, branches.len()).await?;
        if begin.replay {
            return Ok(begin.result.unwrap_or(Value::Null));
        }
        let token = begin.token.clone();
        let mut futures = Vec::with_capacity(branches.len());
        for (scope, function) in begin.branches.into_iter().zip(branches) {
            futures.push(function(self.with_scope(scope)));
        }
        let joined = futures::future::join_all(futures).await;
        let mut results = Vec::with_capacity(joined.len());
        for item in joined {
            match item {
                Ok(value) => results.push(value),
                Err(err) if err.is_suspension() => return Err(err),
                Err(err) => {
                    self.parallel_fail(&token, &err).await?;
                    return Err(err);
                }
            }
        }
        let value = Value::Array(results);
        self.parallel_finish(&token, value.clone()).await?;
        Ok(value)
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
                    result: Some(result),
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
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(
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

    pub async fn parallel_finish(&self, token: &str, result: Value) -> Result<(), WorkflowError> {
        let pending = {
            self.inner
                .pending
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(token)
        };
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
                result,
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
        let pending = {
            self.inner
                .pending
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(token)
        };
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
        let mut counts = self
            .label_counts
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let next = counts.get(label).copied().unwrap_or(0) + 1;
        counts.insert(label.to_string(), next);
        next
    }

    fn accumulate(&self, usage: Option<&StepUsage>) {
        let Some(usage) = usage else {
            return;
        };
        let mut spend = self.spend.lock().unwrap_or_else(|err| err.into_inner());
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
        let spend = self.spend.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(limit) = budgets.max_tokens
            && limit.is_finite()
            && limit > 0.0
            && spend.tokens > limit
        {
            return Err(WorkflowError::budget("maxTokens", limit, spend.tokens));
        }
        if let Some(limit) = budgets.max_cost
            && limit.is_finite()
            && limit > 0.0
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
        if let Some(result) = cached.result() {
            return Ok(Phase::Replay {
                result: result.clone(),
            });
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
                ts: now_iso(),
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
        result: Value,
        usage: Option<StepUsage>,
    ) -> Result<(), WorkflowError> {
        let usage = usage.filter(|item| !item.is_empty());
        let entry = JournalEntry::StepFinished {
            ts: now_iso(),
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
            ts: now_iso(),
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
