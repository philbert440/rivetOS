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
    handler: Option<Handler>,
}

pub struct MessageQueue {
    inner: Mutex<QueueInner>,
}

enum Decision {
    Dropped,
    Queued,
    Run(Box<InboundMessage>),
}

enum DrainStep {
    Stop,
    Dropped,
    Run(Box<InboundMessage>),
}

impl MessageQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(QueueInner {
                queue: Vec::new(),
                processing: false,
                handler: None,
            }),
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
                Decision::Queued
            } else if inner.handler.is_none() {
                Decision::Dropped
            } else {
                inner.processing = true;
                Decision::Run(Box::new(message))
            }
        });
        if let Decision::Run(message) = decision {
            self.invoke(*message).await;
            with_lock(&self.inner, |inner| inner.processing = false);
            self.drain().await;
        }
    }

    pub fn begin_turn(&self) {
        with_lock(&self.inner, |inner| inner.processing = true);
    }

    pub async fn end_turn(&self) {
        with_lock(&self.inner, |inner| inner.processing = false);
        self.drain().await;
    }

    async fn invoke(&self, message: InboundMessage) {
        let handler = with_lock(&self.inner, |inner| inner.handler.clone());
        if let Some(handler) = handler {
            handler(message).await;
        }
    }

    async fn drain(&self) {
        loop {
            let step = with_lock(&self.inner, |inner| {
                if inner.processing || inner.queue.is_empty() {
                    return DrainStep::Stop;
                }
                let message = inner.queue.remove(0).message;
                if inner.handler.is_some() {
                    inner.processing = true;
                    DrainStep::Run(Box::new(message))
                } else {
                    DrainStep::Dropped
                }
            });
            match step {
                DrainStep::Stop => break,
                DrainStep::Dropped => {}
                DrainStep::Run(message) => {
                    self.invoke(*message).await;
                    with_lock(&self.inner, |inner| inner.processing = false);
                }
            }
        }
    }
}

impl Default for MessageQueue {
    fn default() -> Self {
        Self::new()
    }
}
