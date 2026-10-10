use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use protocol::HookEventName;
use tracing::{debug, error, warn};

use crate::context::HookContext;
use crate::handler::{HookErrorMode, HookFailure, HookHandler, HookSignal};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookErrorRecord {
    pub hook_id: String,
    pub error: HookFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookPipelineResult {
    pub aborted: bool,
    pub skipped: bool,
    pub errors: Vec<HookErrorRecord>,
    pub ran: Vec<String>,
}

pub trait HookLogger: Send + Sync {
    fn debug(&self, message: &str);
    fn warn(&self, message: &str);
    fn error(&self, message: &str);
}

#[derive(Clone)]
pub struct HookRegistration {
    pub id: String,
    pub event: HookEventName,
    pub handler: HookHandler,
    pub priority: i64,
    pub on_error: HookErrorMode,
    pub agent_filter: Option<Vec<String>>,
    pub tool_filter: Option<Vec<String>>,
    pub description: Option<String>,
    pub enabled: bool,
}

impl HookRegistration {
    pub fn new(id: impl Into<String>, event: HookEventName, handler: HookHandler) -> Self {
        Self {
            id: id.into(),
            event,
            handler,
            priority: 50,
            on_error: HookErrorMode::Continue,
            agent_filter: None,
            tool_filter: None,
            description: None,
            enabled: true,
        }
    }

    pub fn priority(mut self, priority: i64) -> Self {
        self.priority = priority;
        self
    }

    pub fn on_error(mut self, on_error: HookErrorMode) -> Self {
        self.on_error = on_error;
        self
    }

    pub fn agent_filter<I, S>(mut self, agents: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.agent_filter = Some(agents.into_iter().map(Into::into).collect());
        self
    }

    pub fn tool_filter<I, S>(mut self, tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.tool_filter = Some(tools.into_iter().map(Into::into).collect());
        self
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
}

struct Inner {
    hooks: Vec<HookRegistration>,
    sorted: HashMap<HookEventName, Vec<HookRegistration>>,
    dirty: bool,
}

pub struct HookPipeline {
    inner: Mutex<Inner>,
    logger: Option<Arc<dyn HookLogger>>,
}

impl HookPipeline {
    pub fn new() -> Self {
        Self::with_logger(None)
    }

    pub fn with_logger(logger: Option<Arc<dyn HookLogger>>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                hooks: Vec::new(),
                sorted: HashMap::new(),
                dirty: false,
            }),
            logger,
        }
    }

    pub fn register(&self, hook: HookRegistration) {
        let mut inner = lock(&self.inner);
        if inner.hooks.iter().any(|existing| existing.id == hook.id) {
            let message = format!("Hook \"{}\" already registered — replacing", hook.id);
            warn!("{message}");
            if let Some(logger) = &self.logger {
                logger.warn(&message);
            }
            if let Some(slot) = inner
                .hooks
                .iter_mut()
                .find(|existing| existing.id == hook.id)
            {
                *slot = hook;
            }
        } else {
            inner.hooks.push(hook);
        }
        inner.dirty = true;
    }

    pub fn unregister(&self, hook_id: &str) -> bool {
        let mut inner = lock(&self.inner);
        let before = inner.hooks.len();
        inner.hooks.retain(|hook| hook.id != hook_id);
        let deleted = inner.hooks.len() != before;
        if deleted {
            inner.dirty = true;
        }
        deleted
    }

    pub fn clear(&self) {
        let mut inner = lock(&self.inner);
        inner.hooks.clear();
        inner.sorted.clear();
        inner.dirty = false;
    }

    pub fn get_hooks(&self, event: Option<HookEventName>) -> Vec<HookRegistration> {
        let mut inner = lock(&self.inner);
        if let Some(event) = event {
            rebuild_if_dirty(&mut inner);
            return inner.sorted.get(&event).cloned().unwrap_or_default();
        }
        inner.hooks.clone()
    }

    pub async fn run(&self, ctx: &mut HookContext) -> HookPipelineResult {
        let hooks = {
            let mut inner = lock(&self.inner);
            rebuild_if_dirty(&mut inner);
            inner.sorted.get(&ctx.event).cloned().unwrap_or_default()
        };
        let mut result = HookPipelineResult {
            aborted: false,
            skipped: false,
            errors: Vec::new(),
            ran: Vec::new(),
        };
        for hook in hooks {
            if !hook.enabled {
                continue;
            }
            if let Some(filter) = hook.agent_filter.as_ref().filter(|items| !items.is_empty())
                && let Some(agent_id) = ctx.agent_id.as_deref().filter(|id| !id.is_empty())
                && !filter.iter().any(|candidate| candidate == agent_id)
            {
                continue;
            }
            if let Some(filter) = hook.tool_filter.as_ref().filter(|items| !items.is_empty())
                && let Some(tool_name) = ctx.tool_name.as_ref()
                && !filter.iter().any(|candidate| candidate == tool_name)
            {
                continue;
            }
            let running = format!("Hook \"{}\" running for {}", hook.id, ctx.event);
            debug!("{running}");
            if let Some(logger) = &self.logger {
                logger.debug(&running);
            }
            match hook.handler.invoke(ctx).await {
                Ok(signal) => {
                    result.ran.push(hook.id.clone());
                    if signal == HookSignal::Abort {
                        let message = format!("Hook \"{}\" aborted pipeline", hook.id);
                        debug!("{message}");
                        if let Some(logger) = &self.logger {
                            logger.debug(&message);
                        }
                        result.aborted = true;
                        break;
                    }
                    if signal == HookSignal::Skip {
                        let message = format!("Hook \"{}\" skipped remaining hooks", hook.id);
                        debug!("{message}");
                        if let Some(logger) = &self.logger {
                            logger.debug(&message);
                        }
                        result.skipped = true;
                        break;
                    }
                }
                Err(failure) => {
                    let message = format!("Hook \"{}\" threw: {}", hook.id, failure.message);
                    error!("{message}");
                    if let Some(logger) = &self.logger {
                        logger.error(&message);
                    }
                    match hook.on_error {
                        HookErrorMode::Abort => {
                            result.errors.push(HookErrorRecord {
                                hook_id: hook.id.clone(),
                                error: failure,
                            });
                            result.aborted = true;
                            return result;
                        }
                        HookErrorMode::Retry => {
                            let retrying = format!("Hook \"{}\" retrying...", hook.id);
                            debug!("{retrying}");
                            if let Some(logger) = &self.logger {
                                logger.debug(&retrying);
                            }
                            match hook.handler.invoke(ctx).await {
                                Ok(signal) => {
                                    result.ran.push(hook.id.clone());
                                    if signal == HookSignal::Abort {
                                        result.aborted = true;
                                        return result;
                                    }
                                    if signal == HookSignal::Skip {
                                        result.skipped = true;
                                        return result;
                                    }
                                }
                                Err(retry_failure) => {
                                    let retry_message = format!(
                                        "Hook \"{}\" retry failed: {}",
                                        hook.id, retry_failure.message
                                    );
                                    error!("{retry_message}");
                                    if let Some(logger) = &self.logger {
                                        logger.error(&retry_message);
                                    }
                                    result.errors.push(HookErrorRecord {
                                        hook_id: hook.id,
                                        error: retry_failure,
                                    });
                                }
                            }
                        }
                        HookErrorMode::Continue => {
                            result.errors.push(HookErrorRecord {
                                hook_id: hook.id.clone(),
                                error: failure,
                            });
                            result.ran.push(hook.id);
                        }
                    }
                }
            }
        }
        result
    }
}

impl Default for HookPipeline {
    fn default() -> Self {
        Self::new()
    }
}

fn rebuild_if_dirty(inner: &mut Inner) {
    if !inner.dirty {
        return;
    }
    inner.sorted.clear();
    for hook in &inner.hooks {
        inner
            .sorted
            .entry(hook.event)
            .or_default()
            .push(hook.clone());
    }
    for list in inner.sorted.values_mut() {
        list.sort_by_key(|hook| hook.priority);
    }
    inner.dirty = false;
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}
