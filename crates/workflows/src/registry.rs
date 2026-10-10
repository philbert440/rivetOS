use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::error::WorkflowError;

#[derive(Clone)]
pub struct CallContext {
    pub parent_run_id: String,
    pub parent_step_id: String,
    pub parent_case_dir: String,
    pub timeout_ms: Option<f64>,
}

pub type CallResolver = Arc<
    dyn Fn(
            String,
            Map<String, Value>,
            CallContext,
        ) -> Pin<Box<dyn Future<Output = Result<Value, WorkflowError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct NamespacedCallRegistry {
    resolvers: Arc<Mutex<IndexMap<String, CallResolver>>>,
}

impl NamespacedCallRegistry {
    pub fn new() -> Self {
        Self {
            resolvers: Arc::new(Mutex::new(IndexMap::new())),
        }
    }

    pub fn register(&self, namespace: impl Into<String>, resolver: CallResolver) {
        let mut map = self.resolvers.lock().unwrap_or_else(|err| err.into_inner());
        map.insert(namespace.into(), resolver);
    }

    pub fn namespaces(&self) -> Vec<String> {
        let map = self.resolvers.lock().unwrap_or_else(|err| err.into_inner());
        map.keys()
            .map(|key| {
                if key.is_empty() {
                    "(native)".to_string()
                } else {
                    key.clone()
                }
            })
            .collect()
    }

    pub async fn call(
        &self,
        reference: &str,
        input: Map<String, Value>,
        ctx: CallContext,
    ) -> Result<Value, WorkflowError> {
        let (namespace, name) = parse_call_ref(reference);
        let resolver = {
            let map = self.resolvers.lock().unwrap_or_else(|err| err.into_inner());
            map.get(&namespace).cloned()
        };
        let Some(resolver) = resolver else {
            let known = {
                let map = self.resolvers.lock().unwrap_or_else(|err| err.into_inner());
                map.keys()
                    .map(|key| {
                        if key.is_empty() {
                            "(native/bare)".to_string()
                        } else {
                            key.clone()
                        }
                    })
                    .collect::<Vec<_>>()
            };
            return Err(WorkflowError::unknown_namespace(
                reference, namespace, known,
            ));
        };
        resolver(name, input, ctx).await
    }
}

impl Default for NamespacedCallRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub fn parse_call_ref(reference: &str) -> (String, String) {
    match reference.find(':') {
        Some(index) => (
            reference[..index].to_string(),
            reference[index + 1..].to_string(),
        ),
        None => (String::new(), reference.to_string()),
    }
}

pub fn create_call_registry(native: Option<CallResolver>) -> NamespacedCallRegistry {
    let registry = NamespacedCallRegistry::new();
    if let Some(native) = native {
        registry.register("", native);
    }
    registry
}
