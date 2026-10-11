use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use protocol::{InboundMessage, JsNumber, QueuedMessage};

use crate::commands::is_known_command;
use crate::lock::with_lock;
use crate::text::js_split_whitespace;
use crate::timefmt::now_millis;

type HandlerFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type Handler = Arc<dyn Fn(InboundMessage) -> HandlerFuture + Send + Sync>;
type ProcessFut = Pin<Box<dyn Future<Output = ()> + Send>>;

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
    queue: Vec<QueuedMessage>,
    processing: bool,
    owner: u64,
    next_owner: u64,
    handler: Option<Handler>,
}

pub struct MessageQueue {
    inner: Arc<Mutex<QueueInner>>,
}

enum Enqueue {
    Dropped,
    Queued,
    Run {
        owner: u64,
        handler: Handler,
        message: Box<InboundMessage>,
    },
}

enum DrainStep {
    Stop,
    Dropped,
    Run {
        owner: u64,
        handler: Handler,
        message: Box<InboundMessage>,
    },
}

impl MessageQueue {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(QueueInner {
                queue: Vec::new(),
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
        let decision = with_lock(&self.inner, |inner| {
            if inner.processing {
                inner.queue.push(QueuedMessage {
                    message,
                    received_at: JsNumber::from(now_millis()),
                });
                Enqueue::Queued
            } else if let Some(handler) = inner.handler.clone() {
                let owner = alloc_owner(inner);
                inner.processing = true;
                inner.owner = owner;
                Enqueue::Run {
                    owner,
                    handler,
                    message: Box::new(message),
                }
            } else {
                Enqueue::Dropped
            }
        });
        if let Enqueue::Run {
            owner,
            handler,
            message,
        } = decision
        {
            run_owned(Arc::clone(&self.inner), owner, handler, *message).await;
        }
    }

    pub fn begin_turn(&self) {
        with_lock(&self.inner, |inner| inner.processing = true);
    }

    pub async fn end_turn(&self) {
        with_lock(&self.inner, |inner| inner.processing = false);
        drain_queue(Arc::clone(&self.inner)).await;
    }
}

impl Default for MessageQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn alloc_owner(inner: &mut QueueInner) -> u64 {
    let owner = inner.next_owner;
    inner.next_owner = inner.next_owner.wrapping_add(1);
    if inner.next_owner == 0 {
        inner.next_owner = 1;
    }
    owner
}

fn release_owner(inner: &Mutex<QueueInner>, owner: u64) {
    with_lock(inner, |state| {
        if state.owner == owner {
            state.processing = false;
            state.owner = 0;
        }
    });
}

fn run_owned(
    inner: Arc<Mutex<QueueInner>>,
    owner: u64,
    handler: Handler,
    message: InboundMessage,
) -> ProcessFut {
    Box::pin(async move {
        let mut guard = OwnerGuard {
            inner: Arc::clone(&inner),
            owner,
            armed: true,
        };
        handler(message).await;
        guard.armed = false;
        release_owner(&inner, owner);
        drain_queue(inner).await;
    })
}

fn drain_queue(inner: Arc<Mutex<QueueInner>>) -> ProcessFut {
    Box::pin(async move {
        loop {
            let step = with_lock(&inner, |state| {
                if state.processing || state.queue.is_empty() {
                    return DrainStep::Stop;
                }
                let message = state.queue.remove(0).message;
                let Some(handler) = state.handler.clone() else {
                    return DrainStep::Dropped;
                };
                let owner = alloc_owner(state);
                state.processing = true;
                state.owner = owner;
                DrainStep::Run {
                    owner,
                    handler,
                    message: Box::new(message),
                }
            });
            match step {
                DrainStep::Stop => break,
                DrainStep::Dropped => {}
                DrainStep::Run {
                    owner,
                    handler,
                    message,
                } => {
                    run_owned(Arc::clone(&inner), owner, handler, *message).await;
                }
            }
        }
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
        let resume = with_lock(&inner, |state| {
            if state.owner != owner {
                return false;
            }
            state.processing = false;
            state.owner = 0;
            !state.queue.is_empty()
        });
        if !resume {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        std::mem::drop(runtime.spawn(async move {
            drain_queue(inner).await;
        }));
    }
}
