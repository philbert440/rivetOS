use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::context::HookContext;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookErrorMode {
    Continue,
    Abort,
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSignal {
    Continue,
    Abort,
    Skip,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct HookFailure {
    pub message: String,
}

impl HookFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

trait Invoke: Send + Sync {
    fn invoke<'a>(
        &'a self,
        ctx: &'a mut HookContext,
    ) -> BoxFuture<'a, Result<HookSignal, HookFailure>>;
}

struct SyncInvoke<F> {
    function: F,
}

impl<F> Invoke for SyncInvoke<F>
where
    F: Fn(&mut HookContext) -> Result<HookSignal, HookFailure> + Send + Sync,
{
    fn invoke<'a>(
        &'a self,
        ctx: &'a mut HookContext,
    ) -> BoxFuture<'a, Result<HookSignal, HookFailure>> {
        let result = (self.function)(ctx);
        Box::pin(async move { result })
    }
}

struct FutureInvoke<F> {
    function: F,
}

impl<F> Invoke for FutureInvoke<F>
where
    F: for<'a> Fn(&'a mut HookContext) -> BoxFuture<'a, Result<HookSignal, HookFailure>>
        + Send
        + Sync,
{
    fn invoke<'a>(
        &'a self,
        ctx: &'a mut HookContext,
    ) -> BoxFuture<'a, Result<HookSignal, HookFailure>> {
        (self.function)(ctx)
    }
}

#[derive(Clone)]
pub struct HookHandler {
    inner: Arc<dyn Invoke>,
}

impl HookHandler {
    pub fn from_sync<F>(function: F) -> Self
    where
        F: Fn(&mut HookContext) -> Result<HookSignal, HookFailure> + Send + Sync + 'static,
    {
        Self {
            inner: Arc::new(SyncInvoke { function }),
        }
    }

    pub fn from_future<F>(function: F) -> Self
    where
        F: for<'a> Fn(&'a mut HookContext) -> BoxFuture<'a, Result<HookSignal, HookFailure>>
            + Send
            + Sync
            + 'static,
    {
        Self {
            inner: Arc::new(FutureInvoke { function }),
        }
    }

    pub fn invoke<'a>(
        &'a self,
        ctx: &'a mut HookContext,
    ) -> BoxFuture<'a, Result<HookSignal, HookFailure>> {
        self.inner.invoke(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::{HookErrorMode, HookFailure, HookHandler, HookSignal};
    use crate::context::HookContext;
    use protocol::HookEventName;

    #[test]
    fn error_mode_json_is_lowercase() {
        assert_eq!(
            serde_json::to_string(&HookErrorMode::Continue).expect("json"),
            "\"continue\""
        );
        assert_eq!(
            serde_json::from_str::<HookErrorMode>("\"retry\"").expect("parse"),
            HookErrorMode::Retry
        );
        assert_eq!(HookFailure::new("boom").message, "boom");
    }

    #[tokio::test]
    async fn sync_and_future_handlers_run() {
        let sync = HookHandler::from_sync(|ctx| {
            ctx.metadata
                .insert("sync".to_string(), serde_json::Value::Bool(true));
            Ok(HookSignal::Continue)
        });
        let future = HookHandler::from_future(|ctx| {
            Box::pin(async move {
                ctx.metadata
                    .insert("future".to_string(), serde_json::Value::Bool(true));
                Ok(HookSignal::Skip)
            })
        });
        let mut ctx = HookContext::new(HookEventName::ProviderBefore);
        assert_eq!(
            sync.invoke(&mut ctx).await.expect("sync"),
            HookSignal::Continue
        );
        assert_eq!(
            future.invoke(&mut ctx).await.expect("future"),
            HookSignal::Skip
        );
        assert_eq!(
            ctx.metadata.get("sync"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            ctx.metadata.get("future"),
            Some(&serde_json::Value::Bool(true))
        );
    }
}
