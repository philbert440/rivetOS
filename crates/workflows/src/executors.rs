use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::error::WorkflowError;
use crate::types::{AgentDef, LoadedWorkflow, StepUsage};

pub type ReportUsageFn = Arc<dyn Fn(StepUsage) + Send + Sync>;

pub struct AgentExecuteOpts {
    pub label: String,
    pub step_id: String,
    pub agent: Option<String>,
    pub prompt: Option<String>,
    pub out: Vec<String>,
    pub agent_def: Option<AgentDef>,
    pub case_dir: String,
    pub workflow: LoadedWorkflow,
    pub timeout_ms: f64,
    pub extra: Map<String, Value>,
    pub report_usage: ReportUsageFn,
}

pub struct RunExecuteOpts {
    pub label: String,
    pub step_id: String,
    pub script: Option<String>,
    pub skill: Option<String>,
    pub input: Option<Map<String, Value>>,
    pub case_dir: String,
    pub workflow: LoadedWorkflow,
    pub timeout_ms: f64,
    pub extra: Map<String, Value>,
    pub report_usage: ReportUsageFn,
}

pub trait AgentExecutor: Send + Sync {
    fn execute(
        &self,
        opts: AgentExecuteOpts,
    ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send + '_>>;
}

pub trait RunExecutor: Send + Sync {
    fn execute(
        &self,
        opts: RunExecuteOpts,
    ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send + '_>>;
}

pub trait ExecutorRegistry: Send + Sync {
    fn agent(&self) -> &dyn AgentExecutor;
    fn run(&self) -> &dyn RunExecutor;
}

pub type MockAgentHandler = Arc<
    dyn Fn(AgentExecuteOpts) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send>>
        + Send
        + Sync,
>;

pub type MockRunHandler = Arc<
    dyn Fn(RunExecuteOpts) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct MockCall {
    pub kind: &'static str,
    pub label: String,
    pub step_id: String,
    pub case_dir: String,
    pub script: Option<String>,
    pub agent: Option<String>,
}

pub struct MockExecutorRegistry {
    pub calls: Arc<Mutex<Vec<MockCall>>>,
    agent_handler: MockAgentHandler,
    run_handler: MockRunHandler,
}

pub fn agent_handler<F, Fut>(function: F) -> MockAgentHandler
where
    F: Fn(AgentExecuteOpts) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, WorkflowError>> + Send + 'static,
{
    Arc::new(move |opts| Box::pin(function(opts)))
}

pub fn run_handler<F, Fut>(function: F) -> MockRunHandler
where
    F: Fn(RunExecuteOpts) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, WorkflowError>> + Send + 'static,
{
    Arc::new(move |opts| Box::pin(function(opts)))
}

fn default_agent_handler() -> MockAgentHandler {
    agent_handler(|opts| async move {
        let mut result = Map::new();
        for key in opts.out {
            result.insert(key.clone(), Value::String(format!("mock:{key}")));
        }
        Ok(Value::Object(result))
    })
}

fn default_run_handler() -> MockRunHandler {
    run_handler(|_opts| async move {
        let mut result = Map::new();
        result.insert("ok".to_string(), Value::Bool(true));
        Ok(Value::Object(result))
    })
}

impl MockExecutorRegistry {
    pub fn new() -> Self {
        Self::with_handlers(default_agent_handler(), default_run_handler())
    }

    pub fn with_agent(agent: MockAgentHandler) -> Self {
        Self::with_handlers(agent, default_run_handler())
    }

    pub fn with_run(run: MockRunHandler) -> Self {
        Self::with_handlers(default_agent_handler(), run)
    }

    pub fn with_handlers(agent_handler: MockAgentHandler, run_handler: MockRunHandler) -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            agent_handler,
            run_handler,
        }
    }
}

impl Default for MockExecutorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentExecutor for MockExecutorRegistry {
    fn execute(
        &self,
        opts: AgentExecuteOpts,
    ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send + '_>> {
        let calls = Arc::clone(&self.calls);
        let handler = Arc::clone(&self.agent_handler);
        Box::pin(async move {
            calls.lock().await.push(MockCall {
                kind: "agent",
                label: opts.label.clone(),
                step_id: opts.step_id.clone(),
                case_dir: opts.case_dir.clone(),
                script: None,
                agent: opts.agent.clone(),
            });
            handler(opts).await
        })
    }
}

impl RunExecutor for MockExecutorRegistry {
    fn execute(
        &self,
        opts: RunExecuteOpts,
    ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send + '_>> {
        let calls = Arc::clone(&self.calls);
        let handler = Arc::clone(&self.run_handler);
        Box::pin(async move {
            calls.lock().await.push(MockCall {
                kind: "run",
                label: opts.label.clone(),
                step_id: opts.step_id.clone(),
                case_dir: opts.case_dir.clone(),
                script: opts.script.clone(),
                agent: None,
            });
            handler(opts).await
        })
    }
}

impl ExecutorRegistry for MockExecutorRegistry {
    fn agent(&self) -> &dyn AgentExecutor {
        self
    }

    fn run(&self) -> &dyn RunExecutor {
        self
    }
}

pub struct LocalExecutorRegistry;

impl AgentExecutor for LocalExecutorRegistry {
    fn execute(
        &self,
        opts: AgentExecuteOpts,
    ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send + '_>> {
        Box::pin(async move {
            Err(WorkflowError::message(format!(
                "LocalExecutorRegistry.agent is a stub (step \"{}\"). Wire ros_task-backed executor before production use.",
                opts.label
            )))
        })
    }
}

impl RunExecutor for LocalExecutorRegistry {
    fn execute(
        &self,
        opts: RunExecuteOpts,
    ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send + '_>> {
        Box::pin(async move {
            Err(WorkflowError::message(format!(
                "LocalExecutorRegistry.run is a stub (step \"{}\"). Wire script/skill/API executor before production use.",
                opts.label
            )))
        })
    }
}

impl ExecutorRegistry for LocalExecutorRegistry {
    fn agent(&self) -> &dyn AgentExecutor {
        self
    }

    fn run(&self) -> &dyn RunExecutor {
        self
    }
}
