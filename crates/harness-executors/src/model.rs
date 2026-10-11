use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;
use protocol::{JsNumber, TaskBudget, TaskResult, TaskUsage, TaskVerdict};
use serde_json::{Map, Value};
use tokio::sync::{Notify, watch};

use crate::standard_helpers::now_ms;

pub type KillHook = Arc<dyn Fn() + Send + Sync>;
pub type KillSlot = Arc<Mutex<Option<KillHook>>>;
pub type AbortHook = Arc<dyn Fn(String) + Send + Sync>;
pub type AbortSlot = Arc<Mutex<Option<AbortHook>>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptanceCriterion {
    pub id: String,
    pub description: String,
}

#[derive(Clone, Debug)]
pub struct TaskSpec {
    pub task_id: String,
    pub agent_id: String,
    pub goal: String,
    pub resolved_context: String,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    pub budget: TaskBudget,
    pub working_dir: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub system_prompt_append: Option<String>,
    pub resume_message: Option<String>,
    pub max_session_turns: Option<u32>,
}

impl TaskSpec {
    pub fn conformance(goal: impl Into<String>) -> Self {
        Self {
            task_id: format!("conformance-{}", uuid::Uuid::new_v4().simple()),
            agent_id: "conformance-agent".to_string(),
            goal: goal.into(),
            resolved_context: String::new(),
            acceptance_criteria: Vec::new(),
            budget: TaskBudget {
                max_usd: None,
                max_tokens: None,
                max_turns: None,
                max_wall_clock_ms: None,
            },
            working_dir: None,
            model: None,
            effort: None,
            system_prompt_append: None,
            resume_message: None,
            max_session_turns: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub steerable: bool,
    pub multi_turn: bool,
    pub structured_stream: bool,
    pub usage_in_result: bool,
    pub session_id_capture: bool,
    pub slash_commands: bool,
    pub effort_selection: bool,
    pub mcp_injection: &'static str,
}

impl Capabilities {
    pub fn argv(effort_selection: bool) -> Self {
        Self {
            steerable: true,
            multi_turn: true,
            structured_stream: true,
            usage_in_result: true,
            session_id_capture: true,
            slash_commands: false,
            effort_selection,
            mcp_injection: "persistent-config",
        }
    }

    pub fn none() -> Self {
        Self {
            steerable: false,
            multi_turn: false,
            structured_stream: false,
            usage_in_result: false,
            session_id_capture: false,
            slash_commands: false,
            effort_selection: false,
            mcp_injection: "none",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DenBody {
    MessageAgent { text: String },
    ToolStart { tool: Option<String> },
    ToolEnd { tool: Option<String> },
    ThinkingDelta { text: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum TaskEvent {
    Den {
        ts: i64,
        body: DenBody,
    },
    TurnStart {
        ts: i64,
        turn: i64,
    },
    TurnEnd {
        ts: i64,
        turn: i64,
        usage: TaskUsage,
        harness_session_id: Option<String>,
    },
    Log {
        ts: i64,
        level: String,
        message: String,
    },
    Cost {
        ts: i64,
        cost_usd: f64,
    },
}

impl TaskEvent {
    pub fn is_turn_start(&self) -> bool {
        matches!(self, Self::TurnStart { .. })
    }

    pub fn is_turn_end(&self) -> bool {
        matches!(self, Self::TurnEnd { .. })
    }

    pub fn log_message(&self) -> Option<&str> {
        match self {
            Self::Log { message, .. } => Some(message),
            _ => None,
        }
    }

    pub fn den_body(&self) -> Option<&DenBody> {
        match self {
            Self::Den { body, .. } => Some(body),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct UsageAcc {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cost_usd: Option<f64>,
    pub turns: i64,
    pub wall_clock_ms: i64,
}

impl UsageAcc {
    pub fn new() -> Self {
        Self {
            input_tokens: 0.0,
            output_tokens: 0.0,
            cost_usd: None,
            turns: 0,
            wall_clock_ms: 0,
        }
    }

    pub fn to_usage(&self) -> TaskUsage {
        let mut cost = self.cost_usd;
        if cost == Some(0.0) {
            cost = None;
        }
        TaskUsage {
            input_tokens: JsNumber::from(self.input_tokens),
            output_tokens: JsNumber::from(self.output_tokens),
            total_tokens: JsNumber::from(self.input_tokens + self.output_tokens),
            cost_usd: cost.map(JsNumber::from),
            turns: JsNumber::from(self.turns),
            wall_clock_ms: JsNumber::from(self.wall_clock_ms),
        }
    }
}

impl Default for UsageAcc {
    fn default() -> Self {
        Self::new()
    }
}

pub fn empty_usage() -> TaskUsage {
    UsageAcc::new().to_usage()
}

pub fn failed_result(
    summary: impl Into<String>,
    error: impl Into<String>,
    usage: TaskUsage,
) -> TaskResult {
    let summary = summary.into();
    TaskResult {
        verdict: TaskVerdict::Failed,
        summary,
        output: None,
        artifacts: Vec::new(),
        criteria_self_report: None,
        usage,
        error: Some(error.into()),
    }
}

pub fn result_with_output(mut result: TaskResult, text: &str) -> TaskResult {
    if result.output.is_none() && !text.is_empty() {
        result.output = Some(text.to_string());
    }
    result
}

struct QueueInner {
    buffer: Mutex<VecDeque<TaskEvent>>,
    closed: Mutex<bool>,
    notify: Notify,
}

#[derive(Clone)]
pub struct EventQueue {
    inner: Arc<QueueInner>,
}

impl EventQueue {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(QueueInner {
                buffer: Mutex::new(VecDeque::new()),
                closed: Mutex::new(false),
                notify: Notify::new(),
            }),
        }
    }

    pub fn push(&self, event: TaskEvent) {
        if *self.inner.closed.lock() {
            return;
        }
        self.inner.buffer.lock().push_back(event);
        self.inner.notify.notify_waiters();
    }

    pub fn close(&self) {
        *self.inner.closed.lock() = true;
        self.inner.notify.notify_waiters();
    }

    pub async fn recv(&self) -> Option<TaskEvent> {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            if let Some(event) = self.inner.buffer.lock().pop_front() {
                return Some(event);
            }
            if *self.inner.closed.lock() {
                return None;
            }
            notified.await;
        }
    }

    pub async fn drain(&self) -> Vec<TaskEvent> {
        let mut out = Vec::new();
        while let Some(event) = self.recv().await {
            out.push(event);
        }
        out
    }
}

impl Default for EventQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
pub struct SteerError {
    pub code: String,
    pub message: String,
    pub harness_id: Option<String>,
    pub retryable: bool,
    pub context: Map<String, Value>,
}

#[derive(Clone)]
pub struct AbortFlag {
    aborted: Arc<std::sync::atomic::AtomicBool>,
    reason: Arc<Mutex<Option<String>>>,
    on_abort: AbortSlot,
}

impl AbortFlag {
    pub fn new() -> Self {
        Self {
            aborted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reason: Arc::new(Mutex::new(None)),
            on_abort: Arc::new(Mutex::new(None)),
        }
    }

    pub fn arm(&self, callback: AbortHook) -> Option<String> {
        let mut slot = self.on_abort.lock();
        if self.aborted.load(std::sync::atomic::Ordering::SeqCst) {
            return Some(
                self.reason
                    .lock()
                    .clone()
                    .unwrap_or_else(|| "aborted".to_string()),
            );
        }
        *slot = Some(callback);
        None
    }

    pub fn abort(&self, reason: impl Into<String>) {
        let reason = reason.into();
        let callback = {
            let slot = self.on_abort.lock();
            if self.aborted.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            *self.reason.lock() = Some(reason.clone());
            slot.clone()
        };
        if let Some(callback) = callback {
            callback(reason);
        }
    }
}

impl Default for AbortFlag {
    fn default() -> Self {
        Self::new()
    }
}

pub struct TaskHandle {
    pub events: EventQueue,
    result_rx: watch::Receiver<Option<TaskResult>>,
    steer_q: Arc<Mutex<VecDeque<String>>>,
    finished: Arc<std::sync::atomic::AtomicBool>,
    kill_fn: Arc<dyn Fn(&str) + Send + Sync>,
    steer_reject: Option<SteerError>,
}

impl TaskHandle {
    pub fn kill_hook(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        Arc::clone(&self.kill_fn)
    }

    pub async fn result(&self) -> TaskResult {
        let mut rx = self.result_rx.clone();
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result;
            }
            if rx.changed().await.is_err() {
                return failed_result("Executor crashed: closed", "closed", empty_usage());
            }
        }
    }

    pub async fn steer(&self, message: &str) -> Result<(), Box<SteerError>> {
        if let Some(error) = &self.steer_reject {
            return Err(Box::new(error.clone()));
        }
        if !self.finished.load(std::sync::atomic::Ordering::SeqCst) {
            self.steer_q.lock().push_back(message.to_string());
        }
        Ok(())
    }

    pub async fn kill(&self, reason: &str) {
        (self.kill_fn)(reason);
    }

    pub fn push_steer_for_test(&self, message: &str) {
        self.steer_q.lock().push_back(message.to_string());
    }
}

#[derive(Clone)]
pub struct HandleParts {
    pub events: EventQueue,
    pub result_tx: watch::Sender<Option<TaskResult>>,
    pub steer_q: Arc<Mutex<VecDeque<String>>>,
    pub finished: Arc<std::sync::atomic::AtomicBool>,
    pub killed: Arc<std::sync::atomic::AtomicBool>,
    pub kill_reason: Arc<Mutex<Option<String>>>,
    pub active: KillSlot,
}

pub fn open_handle(steer_reject: Option<SteerError>) -> (TaskHandle, HandleParts) {
    let events = EventQueue::new();
    let (result_tx, result_rx) = watch::channel(None);
    let steer_q = Arc::new(Mutex::new(VecDeque::new()));
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let kill_reason = Arc::new(Mutex::new(None));
    let active: KillSlot = Arc::new(Mutex::new(None));
    let kill_fn = {
        let killed = Arc::clone(&killed);
        let kill_reason = Arc::clone(&kill_reason);
        let active = Arc::clone(&active);
        Arc::new(move |reason: &str| {
            killed.store(true, std::sync::atomic::Ordering::SeqCst);
            let mut slot = kill_reason.lock();
            if slot.is_none() {
                *slot = Some(reason.to_string());
            }
            if let Some(kill) = active.lock().clone() {
                kill();
            }
        }) as Arc<dyn Fn(&str) + Send + Sync>
    };
    let handle = TaskHandle {
        events: events.clone(),
        result_rx,
        steer_q: Arc::clone(&steer_q),
        finished: Arc::clone(&finished),
        kill_fn,
        steer_reject,
    };
    let parts = HandleParts {
        events,
        result_tx,
        steer_q,
        finished,
        killed,
        kill_reason,
        active,
    };
    (handle, parts)
}

pub fn publish(parts: &HandleParts, result: TaskResult) {
    parts
        .finished
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = parts.result_tx.send(Some(result));
    parts.events.close();
}

pub fn log_event(level: &str, message: impl Into<String>) -> TaskEvent {
    TaskEvent::Log {
        ts: now_ms(),
        level: level.to_string(),
        message: message.into(),
    }
}

pub fn den_message(text: impl Into<String>) -> TaskEvent {
    TaskEvent::Den {
        ts: now_ms(),
        body: DenBody::MessageAgent { text: text.into() },
    }
}

pub fn den_tool_start(tool: impl Into<String>) -> TaskEvent {
    TaskEvent::Den {
        ts: now_ms(),
        body: DenBody::ToolStart {
            tool: Some(tool.into()),
        },
    }
}

pub fn den_tool_end(tool: Option<String>) -> TaskEvent {
    TaskEvent::Den {
        ts: now_ms(),
        body: DenBody::ToolEnd { tool },
    }
}

pub fn den_thinking(text: impl Into<String>) -> TaskEvent {
    TaskEvent::Den {
        ts: now_ms(),
        body: DenBody::ThinkingDelta { text: text.into() },
    }
}

pub fn next_steer(queue: &Mutex<VecDeque<String>>) -> Option<String> {
    queue.lock().pop_front()
}
