use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use protocol::{InboundMessage, JsNumber, QueuedMessage};

use crate::commands::is_known_command;
use crate::lock::with_lock;
use crate::text::js_split_whitespace;

type HandlerFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type Handler = Arc<dyn Fn(InboundMessage) -> HandlerFuture + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommand {
    pub command: String,
    pub args: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intake {
    Command(ParsedCommand),
    Message(Box<InboundMessage>),
}

pub fn is_command(text: &str) -> bool {
    parse_command(text).is_some()
}

pub fn parse_command(text: &str) -> Option<ParsedCommand> {
    if !text.starts_with('/') {
        return None;
    }
    let parts = js_split_whitespace(&text[1..]);
    let command = parts.first().copied().unwrap_or("");
    if command.is_empty() || !is_known_command(command) {
        return None;
    }
    let args = if parts.len() <= 1 {
        String::new()
    } else {
        parts[1..].join(" ")
    };
    Some(ParsedCommand {
        command: command.to_string(),
        args,
    })
}

struct QueueInner {
    queue: VecDeque<QueuedMessage>,
    processing: bool,
    owner: u64,
    next_owner: u64,
    handler: Option<Handler>,
}

struct Job {
    owner: u64,
    handler: Handler,
    message: Box<InboundMessage>,
}

pub struct MessageQueue {
    inner: Arc<Mutex<QueueInner>>,
}

enum Enqueue {
    Dropped,
    Queued,
    Run(Job),
}

enum DropAction {
    Ignore,
    Idle,
    Resume,
}

impl MessageQueue {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(QueueInner {
                queue: VecDeque::new(),
                processing: false,
                owner: 0,
                next_owner: 1,
                handler: None,
            })),
        }
    }

    pub fn set_handler<F, Fut>(&self, handler: F)
    where
        F: Fn(InboundMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let handler: Handler = Arc::new(move |message: InboundMessage| -> HandlerFuture {
            Box::pin(handler(message))
        });
        with_lock(&self.inner, |inner| {
            inner.handler = Some(handler);
        });
    }

    pub fn is_processing(&self) -> bool {
        with_lock(&self.inner, |inner| inner.processing)
    }

    pub fn depth(&self) -> usize {
        with_lock(&self.inner, |inner| inner.queue.len())
    }

    pub fn clear(&self) {
        with_lock(&self.inner, |inner| inner.queue.clear());
    }

    pub fn accept(message: &InboundMessage) -> Intake {
        match parse_command(&message.text) {
            Some(command) => Intake::Command(command),
            None => Intake::Message(Box::new(message.clone())),
        }
    }

    pub async fn enqueue(&self, message: InboundMessage) {
        let decision = with_lock(&self.inner, |inner| decide_enqueue(inner, message));
        if let Enqueue::Run(job) = decision {
            drive(Arc::clone(&self.inner), Some(job)).await;
        }
    }

    pub fn begin_turn(&self) {
        with_lock(&self.inner, |inner| inner.processing = true);
    }

    pub async fn end_turn(&self) {
        let job = with_lock(&self.inner, |state| {
            if state.owner != 0 {
                return None;
            }
            state.processing = false;
            take_job(state)
        });
        drive(Arc::clone(&self.inner), job).await;
    }
}

impl Default for MessageQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn decide_enqueue(inner: &mut QueueInner, message: InboundMessage) -> Enqueue {
    if inner.processing {
        push_back(inner, message);
        return Enqueue::Queued;
    }
    let Some(handler) = inner.handler.clone() else {
        return Enqueue::Dropped;
    };
    if !inner.queue.is_empty() {
        push_back(inner, message);
        return match take_job(inner) {
            Some(job) => Enqueue::Run(job),
            None => Enqueue::Dropped,
        };
    }
    let owner = alloc_owner(inner);
    inner.processing = true;
    inner.owner = owner;
    Enqueue::Run(Job {
        owner,
        handler,
        message: Box::new(message),
    })
}

fn push_back(inner: &mut QueueInner, message: InboundMessage) {
    inner.queue.push_back(QueuedMessage {
        message,
        received_at: JsNumber::from(protocol::js::date_now()),
    });
}

fn alloc_owner(inner: &mut QueueInner) -> u64 {
    let owner = inner.next_owner;
    inner.next_owner = inner.next_owner.wrapping_add(1);
    if inner.next_owner == 0 {
        inner.next_owner = 1;
    }
    owner
}

fn take_job(state: &mut QueueInner) -> Option<Job> {
    loop {
        let Some(queued) = state.queue.pop_front() else {
            state.processing = false;
            state.owner = 0;
            return None;
        };
        let Some(handler) = state.handler.clone() else {
            continue;
        };
        let owner = alloc_owner(state);
        state.processing = true;
        state.owner = owner;
        return Some(Job {
            owner,
            handler,
            message: Box::new(queued.message),
        });
    }
}

async fn drive(inner: Arc<Mutex<QueueInner>>, mut job: Option<Job>) {
    while let Some(current) = job.take() {
        let mut guard = OwnerGuard {
            inner: Arc::clone(&inner),
            owner: current.owner,
            armed: true,
        };
        (current.handler)(*current.message).await;
        guard.armed = false;
        job = claim_next_owned(&inner, current.owner);
    }
}

fn claim_next_owned(inner: &Mutex<QueueInner>, owner: u64) -> Option<Job> {
    with_lock(inner, |state| {
        if state.owner != owner {
            return None;
        }
        take_job(state)
    })
}

struct OwnerGuard {
    inner: Arc<Mutex<QueueInner>>,
    owner: u64,
    armed: bool,
}

impl Drop for OwnerGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        let inner = Arc::clone(&self.inner);
        let owner = self.owner;
        let action = with_lock(&inner, |state| {
            if state.owner != owner {
                return DropAction::Ignore;
            }
            if state.queue.is_empty() {
                state.processing = false;
                state.owner = 0;
                return DropAction::Idle;
            }
            DropAction::Resume
        });
        if !matches!(action, DropAction::Resume) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            with_lock(&inner, |state| {
                if state.owner == owner {
                    state.processing = false;
                    state.owner = 0;
                }
            });
            return;
        };
        std::mem::drop(runtime.spawn(async move {
            let job = with_lock(&inner, |state| {
                if state.owner != owner {
                    return None;
                }
                take_job(state)
            });
            drive(inner, job).await;
        }));
    }
}
