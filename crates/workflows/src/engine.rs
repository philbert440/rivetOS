use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::case::{
    RunPatch, case_path, case_state, child_case_dir, is_terminal_status, read_case, update_run,
    write_case,
};
use crate::config::{
    EngineConfig, resolve_case_dir_root, resolve_max_run_runtime_ms, resolve_step_timeout_ms,
};
use crate::error::WorkflowError;
use crate::error::{ContractReason, ContractValidationIssue};
use crate::flags;
use crate::io_fs::{self, read_string, try_exists};
use crate::journal::{append_journal, ensure_journal, find_open_gate, read_journal};
use crate::list_runs::{ListRunsOptions, list_runs};
use crate::loader::{load_workflow_dir, resolve_workflow_dir};
use crate::manifest::validate_start_input;
use crate::pathutil::{node_join_paths, path_text};
use crate::registry::NamespacedCallRegistry;
use crate::script_host::{self, HostContext};
use crate::step::{Step, StepRuntimeOptions, create_step_runtime};
use crate::timeutil::now_iso;
use crate::types::{
    JournalEntry, LoadedWorkflow, ParentRef, Run, RunFinishedStatus, RunStatus, StartedBy,
    StartedByType,
};

pub struct RunScriptContext {
    pub run_id: String,
    pub input: Map<String, Value>,
    pub case_dir: String,
    pub workflow: LoadedWorkflow,
    pub fields: Map<String, Value>,
}

pub type RunScript = Arc<
    dyn Fn(
            Step,
            RunScriptContext,
        ) -> Pin<Box<dyn Future<Output = Result<(), WorkflowError>> + Send>>
        + Send
        + Sync,
>;

pub fn run_script<F, Fut>(function: F) -> RunScript
where
    F: Fn(Step, RunScriptContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), WorkflowError>> + Send + 'static,
{
    Arc::new(move |step, ctx| Box::pin(function(step, ctx)))
}

#[derive(Default)]
pub struct StartRunOptions {
    pub run_id: Option<String>,
    pub case_dir: Option<PathBuf>,
    pub parent: Option<ParentRef>,
    pub run_script: Option<RunScript>,
    pub workflow: Option<LoadedWorkflow>,
}

#[derive(Default)]
pub struct ResumeRunOptions {
    pub gate_response: Option<Map<String, Value>>,
    pub run_script: Option<RunScript>,
    pub workflow: Option<LoadedWorkflow>,
}

#[derive(Debug)]
pub struct SuspensionInfo {
    pub step_id: String,
    pub label: String,
    pub seq: i64,
}

#[derive(Debug)]
pub struct StartRunResult {
    pub run: Run,
    pub case_dir: String,
    pub suspended: bool,
    pub suspension: Option<SuspensionInfo>,
}

struct EngineInner {
    config: EngineConfig,
    registry: NamespacedCallRegistry,
    run_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

#[derive(Clone)]
pub struct WorkflowEngine {
    inner: Arc<EngineInner>,
}

impl WorkflowEngine {
    pub fn new(config: EngineConfig) -> Self {
        let inner = Arc::new_cyclic(|weak: &Weak<EngineInner>| {
            let registry = config.call_registry.clone().unwrap_or_default();
            install_native(&registry, weak.clone());
            EngineInner {
                config,
                registry,
                run_locks: Mutex::new(HashMap::new()),
            }
        });
        Self { inner }
    }

    pub async fn start_run(
        &self,
        workflow_ref: &str,
        input: Map<String, Value>,
        started_by: StartedBy,
        options: StartRunOptions,
    ) -> Result<StartRunResult, WorkflowError> {
        let workflow = match options.workflow.clone() {
            Some(workflow) => workflow,
            None => {
                let dir = resolve_workflow_dir(
                    workflow_ref,
                    &self.inner.config.workflow_dirs,
                    &self.inner.config.workflows_roots,
                )
                .await?;
                load_workflow_dir(&dir).await?
            }
        };
        validate_start_input(&workflow.manifest.input, &input)?;
        let root = resolve_case_dir_root(self.inner.config.case_dir_root.as_deref());
        assert_under_concurrent_cap(
            &root,
            &workflow.manifest.id,
            workflow
                .manifest
                .budgets
                .as_ref()
                .and_then(|budgets| budgets.max_concurrent_runs),
        )
        .await?;
        let run_id = options
            .run_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string());
        let case_dir = options
            .case_dir
            .clone()
            .unwrap_or_else(|| node_join_paths(&root, &run_id));
        tracing::info!(run_id = %run_id, workflow_id = %workflow.manifest.id, "start_run");
        io_fs::create_dir_all(&case_dir).await?;
        ensure_journal(&case_dir).await?;
        let run = Run {
            id: run_id.clone(),
            workflow_id: workflow.manifest.id.clone(),
            version: workflow.manifest.version.clone(),
            started_by: started_by.clone(),
            parent: options.parent.clone(),
            case_dir: path_text(&case_dir),
            status: RunStatus::Running,
            current: None,
            workflow_dir: Some(workflow.dir.clone()),
            error: None,
            output: None,
            started_at: Some(now_iso()),
            finished_at: None,
        };
        let state = case_state(run, input.clone())?;
        write_case(&case_dir, &state).await?;
        let started = JournalEntry::RunStarted {
            ts: now_iso(),
            run_id,
            workflow_id: workflow.manifest.id.clone(),
            version: workflow.manifest.version.clone(),
            input,
            started_by,
            parent: options.parent,
        };
        append_journal(&case_dir, &started).await?;
        self.execute(&case_dir, &workflow, options.run_script).await
    }

    pub async fn resume_run(
        &self,
        run_id: &str,
        options: ResumeRunOptions,
    ) -> Result<StartRunResult, WorkflowError> {
        let engine = self.clone();
        let owned = run_id.to_string();
        self.with_run_lock(run_id, move || async move {
            engine.resume_run_inner(&owned, options).await
        })
        .await
    }

    pub async fn continue_run(
        &self,
        run_id: &str,
        options: ResumeRunOptions,
    ) -> Result<StartRunResult, WorkflowError> {
        let engine = self.clone();
        let owned = run_id.to_string();
        self.with_run_lock(run_id, move || async move {
            engine.continue_run_inner(&owned, options).await
        })
        .await
    }

    pub async fn kill_run(&self, run_id: &str) -> Result<(), WorkflowError> {
        let case_dir = self.find_case_dir(run_id).await?;
        tracing::info!(run_id = %run_id, "kill_run");
        flags::set_kill_flag(run_id);
        io_fs::write_bytes(&node_join_paths(&case_dir, "KILLED"), now_iso().as_bytes()).await?;
        update_run(
            &case_dir,
            RunPatch {
                status: Some(RunStatus::Killed),
                finished_at: Some(now_iso()),
                ..RunPatch::default()
            },
        )
        .await?;
        append_journal(
            &case_dir,
            &JournalEntry::RunFinished {
                ts: now_iso(),
                run_id: run_id.to_string(),
                status: RunFinishedStatus::Killed,
                output: None,
                error: None,
            },
        )
        .await?;
        cascade_kill(&case_dir).await;
        Ok(())
    }

    pub async fn resolve_case_dir(&self, run_id: &str) -> Result<PathBuf, WorkflowError> {
        self.find_case_dir(run_id).await
    }

    async fn with_run_lock<T, F, Fut>(&self, run_id: &str, function: F) -> Result<T, WorkflowError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, WorkflowError>>,
    {
        let mutex = {
            let mut locks = self.inner.run_locks.lock().await;
            locks
                .entry(run_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = mutex.lock().await;
        function().await
    }

    async fn resume_run_inner(
        &self,
        run_id: &str,
        options: ResumeRunOptions,
    ) -> Result<StartRunResult, WorkflowError> {
        let case_dir = self.find_case_dir(run_id).await?;
        let case_state = read_case(&case_dir).await?;
        if case_state.run.status != RunStatus::PausedHuman {
            return Err(WorkflowError::not_paused(
                run_id,
                case_state.run.status.as_str(),
            ));
        }
        let journal = read_journal(&case_dir).await?;
        let Some(open) = find_open_gate(&journal) else {
            let message = format!(
                "resumeRun: run {run_id} is paused_human with no open gate (crashed mid-resume); continuing"
            );
            (self.inner.config.warn)(&message);
            tracing::warn!("{message}");
            update_run(
                &case_dir,
                RunPatch {
                    status: Some(RunStatus::Running),
                    ..RunPatch::default()
                },
            )
            .await?;
            let workflow = self
                .resolve_run_workflow(&case_state, options.workflow)
                .await?;
            return self.execute(&case_dir, &workflow, options.run_script).await;
        };
        let values = options.gate_response.unwrap_or_default();
        let missing: Vec<&String> = open
            .fields
            .iter()
            .filter(|field| match values.get(*field) {
                None | Some(Value::Null) => true,
                Some(_) => false,
            })
            .collect();
        if !missing.is_empty() {
            let issues = missing
                .into_iter()
                .map(|field| ContractValidationIssue {
                    field: field.clone(),
                    reason: ContractReason::Missing,
                    message: format!(
                        "gate \"{}\" requires field \"{field}\" in gateResponse",
                        open.label
                    ),
                })
                .collect();
            return Err(WorkflowError::contract(issues));
        }
        append_journal(
            &case_dir,
            &JournalEntry::GateResolved {
                ts: now_iso(),
                step_id: open.step_id,
                label: open.label,
                seq: open.seq,
                values: values.clone(),
            },
        )
        .await?;
        crate::case::merge_fields(&case_dir, &values).await?;
        update_run(
            &case_dir,
            RunPatch {
                status: Some(RunStatus::Running),
                ..RunPatch::default()
            },
        )
        .await?;
        let workflow = self
            .resolve_run_workflow(&case_state, options.workflow)
            .await?;
        self.execute(&case_dir, &workflow, options.run_script).await
    }

    async fn continue_run_inner(
        &self,
        run_id: &str,
        options: ResumeRunOptions,
    ) -> Result<StartRunResult, WorkflowError> {
        let case_dir = self.find_case_dir(run_id).await?;
        let case_state = read_case(&case_dir).await?;
        if is_terminal_status(case_state.run.status) {
            return Err(WorkflowError::terminal_continue(
                run_id,
                case_state.run.status.as_str(),
            ));
        }
        if case_state.run.status == RunStatus::PausedHuman {
            let open = find_open_gate(&read_journal(&case_dir).await?);
            if open.is_some() {
                return Err(WorkflowError::paused_gate(run_id));
            }
            update_run(
                &case_dir,
                RunPatch {
                    status: Some(RunStatus::Running),
                    ..RunPatch::default()
                },
            )
            .await?;
        }
        let workflow = self
            .resolve_run_workflow(&case_state, options.workflow)
            .await?;
        self.execute(&case_dir, &workflow, options.run_script).await
    }

    async fn resolve_run_workflow(
        &self,
        case_state: &crate::types::CaseState,
        workflow: Option<LoadedWorkflow>,
    ) -> Result<LoadedWorkflow, WorkflowError> {
        if let Some(workflow) = workflow {
            return Ok(workflow);
        }
        if let Some(dir) = &case_state.run.workflow_dir {
            return load_workflow_dir(Path::new(dir)).await;
        }
        let dir = resolve_workflow_dir(
            &case_state.run.workflow_id,
            &self.inner.config.workflow_dirs,
            &self.inner.config.workflows_roots,
        )
        .await?;
        load_workflow_dir(&dir).await
    }

    async fn execute(
        &self,
        case_dir: &Path,
        workflow: &LoadedWorkflow,
        run_script: Option<RunScript>,
    ) -> Result<StartRunResult, WorkflowError> {
        let outcome = self.run_body(case_dir, workflow, run_script).await;
        match outcome {
            Ok(output) => {
                update_run(
                    case_dir,
                    RunPatch {
                        status: Some(RunStatus::Done),
                        output: Some(output.clone()),
                        finished_at: Some(now_iso()),
                        ..RunPatch::default()
                    },
                )
                .await?;
                let state = read_case(case_dir).await?;
                append_journal(
                    case_dir,
                    &JournalEntry::RunFinished {
                        ts: now_iso(),
                        run_id: state.run.id.clone(),
                        status: RunFinishedStatus::Done,
                        output: Some(output),
                        error: None,
                    },
                )
                .await?;
                let state = read_case(case_dir).await?;
                Ok(finished_result(state.run, case_dir))
            }
            Err(err) if err.is_suspension() => {
                let state = read_case(case_dir).await?;
                if is_terminal_status(state.run.status) {
                    return Ok(finished_result(state.run, case_dir));
                }
                let (step_id, label, seq) = match &err {
                    WorkflowError::Suspension {
                        step_id,
                        label,
                        seq,
                        ..
                    } => (step_id.clone(), label.clone(), *seq),
                    _ => (String::new(), String::new(), 0),
                };
                Ok(StartRunResult {
                    run: state.run,
                    case_dir: path_text(case_dir),
                    suspended: true,
                    suspension: Some(SuspensionInfo {
                        step_id,
                        label,
                        seq,
                    }),
                })
            }
            Err(err) if err.is_killed_error() => {
                let state = read_case(case_dir).await?;
                update_run(
                    case_dir,
                    RunPatch {
                        status: Some(RunStatus::Killed),
                        finished_at: Some(now_iso()),
                        error: Some(err.to_string()),
                        ..RunPatch::default()
                    },
                )
                .await?;
                append_journal(
                    case_dir,
                    &JournalEntry::RunFinished {
                        ts: now_iso(),
                        run_id: state.run.id.clone(),
                        status: RunFinishedStatus::Killed,
                        output: None,
                        error: Some(err.to_string()),
                    },
                )
                .await?;
                let state = read_case(case_dir).await?;
                Ok(finished_result(state.run, case_dir))
            }
            Err(err) => {
                let state = read_case(case_dir).await?;
                update_run(
                    case_dir,
                    RunPatch {
                        status: Some(RunStatus::Failed),
                        error: Some(err.to_string()),
                        finished_at: Some(now_iso()),
                        ..RunPatch::default()
                    },
                )
                .await?;
                append_journal(
                    case_dir,
                    &JournalEntry::RunFinished {
                        ts: now_iso(),
                        run_id: state.run.id,
                        status: RunFinishedStatus::Failed,
                        output: None,
                        error: Some(err.to_string()),
                    },
                )
                .await?;
                let state = read_case(case_dir).await?;
                Ok(finished_result(state.run, case_dir))
            }
        }
    }

    async fn run_body(
        &self,
        case_dir: &Path,
        workflow: &LoadedWorkflow,
        run_script: Option<RunScript>,
    ) -> Result<Value, WorkflowError> {
        let case_state = read_case(case_dir).await?;
        let run_id = case_state.run.id.clone();
        let journal = read_journal(case_dir).await?;
        let step = create_step_runtime(StepRuntimeOptions {
            case_dir: path_text(case_dir),
            run_id: run_id.clone(),
            workflow: workflow.clone(),
            journal,
            executors: Arc::clone(&self.inner.config.executors),
            call_registry: self.inner.registry.clone(),
            step_timeout_ms: resolve_step_timeout_ms(self.inner.config.default_step_timeout_ms),
            output_fields: workflow.manifest.output.clone(),
            budgets: workflow.manifest.budgets.clone(),
            warn: Arc::clone(&self.inner.config.warn),
        });
        let ctx = RunScriptContext {
            run_id: run_id.clone(),
            input: case_state.fields.clone(),
            case_dir: path_text(case_dir),
            workflow: workflow.clone(),
            fields: case_state.fields,
        };
        let script = run_script.unwrap_or_else(|| node_script(workflow.run_path.clone()));
        let max_runtime = resolve_max_run_runtime_ms(self.inner.config.max_run_runtime_ms);
        if !max_runtime.is_finite() || max_runtime <= 0.0 {
            return Err(WorkflowError::run_timeout(&run_id, max_runtime));
        }
        let timeout = Duration::from_millis(max_runtime as u64);
        match tokio::time::timeout(timeout, script(step.clone(), ctx)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => return Err(WorkflowError::run_timeout(&run_id, max_runtime)),
        }
        if let Some(output) = step.done_output() {
            return Ok(Value::Object(output));
        }
        Ok(Value::Object(read_case(case_dir).await?.fields))
    }

    async fn find_case_dir(&self, run_id: &str) -> Result<PathBuf, WorkflowError> {
        let root = resolve_case_dir_root(self.inner.config.case_dir_root.as_deref());
        let direct = node_join_paths(&root, run_id);
        if try_exists(&case_path(&direct)).await? {
            return Ok(direct);
        }
        let as_path = PathBuf::from(run_id);
        if try_exists(&case_path(&as_path)).await? {
            return Ok(as_path);
        }
        if let Some(found) = find_case_dir_recursive(&root, run_id, 4).await? {
            return Ok(found);
        }
        Err(WorkflowError::run_not_found(run_id))
    }

    async fn native_call(
        &self,
        name: &str,
        input: Map<String, Value>,
        ctx: crate::registry::CallContext,
    ) -> Result<Value, WorkflowError> {
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let short = id.split('-').next().unwrap_or("00000000");
        let case_dir = child_case_dir(
            Path::new(&ctx.parent_case_dir),
            &format!("child-{name}-{short}"),
        );
        let result = self
            .start_run(
                name,
                input,
                StartedBy::with_id(StartedByType::Workflow, ctx.parent_run_id.clone()),
                StartRunOptions {
                    case_dir: Some(case_dir),
                    parent: Some(ParentRef {
                        run_id: ctx.parent_run_id,
                        step_id: ctx.parent_step_id,
                    }),
                    ..StartRunOptions::default()
                },
            )
            .await?;
        if result.suspended {
            let step_id = result
                .suspension
                .as_ref()
                .map(|item| item.step_id.as_str())
                .unwrap_or("");
            return Err(WorkflowError::child_suspended(name, step_id));
        }
        if result.run.status == RunStatus::Failed || result.run.status == RunStatus::Killed {
            return Err(WorkflowError::child_ended(
                name,
                result.run.status.as_str(),
                result.run.error.as_deref().unwrap_or(""),
            ));
        }
        if let Some(output) = result.run.output
            && !output.is_null()
        {
            return Ok(output);
        }
        Ok(Value::Object(
            read_case(Path::new(&result.case_dir)).await?.fields,
        ))
    }
}

fn finished_result(run: Run, case_dir: &Path) -> StartRunResult {
    StartRunResult {
        run,
        case_dir: path_text(case_dir),
        suspended: false,
        suspension: None,
    }
}

fn node_script(run_path: String) -> RunScript {
    Arc::new(move |step, ctx| {
        let run_path = run_path.clone();
        Box::pin(async move {
            script_host::drive_node(
                &run_path,
                step,
                HostContext {
                    run_id: ctx.run_id,
                    input: ctx.input,
                    case_dir: ctx.case_dir,
                    fields: ctx.fields,
                },
            )
            .await
        })
    })
}

fn install_native(registry: &NamespacedCallRegistry, weak: Weak<EngineInner>) {
    registry.register(
        "",
        Arc::new(move |name, input, ctx| {
            let weak = weak.clone();
            Box::pin(async move {
                let Some(inner) = weak.upgrade() else {
                    return Err(WorkflowError::message("workflow engine dropped"));
                };
                WorkflowEngine { inner }
                    .native_call(&name, input, ctx)
                    .await
            })
        }),
    );
}

pub async fn assert_under_concurrent_cap(
    case_dir_root: &Path,
    workflow_id: &str,
    max_concurrent_runs: Option<f64>,
) -> Result<(), WorkflowError> {
    let Some(max_concurrent_runs) = max_concurrent_runs else {
        return Ok(());
    };
    if !max_concurrent_runs.is_finite() || max_concurrent_runs <= 0.0 {
        return Ok(());
    }
    let runs = list_runs(
        case_dir_root,
        ListRunsOptions {
            limit: Some(50_000),
            depth: Some(8),
        },
        &|message| tracing::warn!("{message}"),
    )
    .await;
    let active = runs
        .iter()
        .filter(|run| run.workflow_id == workflow_id && !run.status.is_terminal())
        .count();
    if active as f64 >= max_concurrent_runs {
        return Err(WorkflowError::max_concurrent(
            workflow_id,
            max_concurrent_runs,
            active,
        ));
    }
    Ok(())
}

async fn cascade_kill(parent: &Path) {
    let Ok(entries) = io_fs::read_dir(parent).await else {
        return;
    };
    for entry in entries {
        if !entry.is_dir {
            continue;
        }
        let child = node_join_paths(parent, &entry.name);
        if !try_exists(&case_path(&child)).await.unwrap_or(false) {
            continue;
        }
        let _ = io_fs::write_bytes(&node_join_paths(&child, "KILLED"), now_iso().as_bytes()).await;
        if let Ok(state) = read_case(&child).await {
            flags::set_kill_flag(&state.run.id);
            let _ = update_run(
                &child,
                RunPatch {
                    status: Some(RunStatus::Killed),
                    finished_at: Some(now_iso()),
                    ..RunPatch::default()
                },
            )
            .await;
        }
        Box::pin(cascade_kill(&child)).await;
    }
}

async fn find_case_dir_recursive(
    root: &Path,
    run_id: &str,
    depth: i64,
) -> Result<Option<PathBuf>, WorkflowError> {
    if depth < 0 {
        return Ok(None);
    }
    match try_exists(root).await {
        Ok(true) => {}
        _ => return Ok(None),
    }
    let entries = match io_fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    for entry in entries {
        if !entry.is_dir {
            continue;
        }
        let path = node_join_paths(root, &entry.name);
        let has_case = try_exists(&case_path(&path)).await.unwrap_or(false);
        if entry.name == run_id && has_case {
            return Ok(Some(path));
        }
        if has_case
            && let Ok(raw) = read_string(&case_path(&path)).await
            && let Ok(value) = serde_json::from_str::<Value>(&raw)
            && value
                .get("run")
                .and_then(|run| run.get("id"))
                .and_then(Value::as_str)
                == Some(run_id)
        {
            return Ok(Some(path));
        }
        if let Some(found) = Box::pin(find_case_dir_recursive(&path, run_id, depth - 1)).await? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}
