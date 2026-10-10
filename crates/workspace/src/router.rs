use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use protocol::InboundMessage;
use thiserror::Error;

use crate::error::ProviderError;
use crate::lock::with_lock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: Option<String>,
    pub default_thinking: Option<protocol::ThinkingLevel>,
    pub local: bool,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &str;
    async fn is_available(&self) -> Result<bool, ProviderError>;
}

pub struct Route {
    pub agent: AgentConfig,
    pub provider_id: String,
    pub provider: Arc<dyn LlmProvider>,
}

impl std::fmt::Debug for Route {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Route")
            .field("agent", &self.agent)
            .field("provider_id", &self.provider_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RouteError {
    #[error("Unknown agent: \"{agent_id}\". Registered: [{registered}]")]
    UnknownAgent {
        agent_id: String,
        registered: String,
    },
    #[error(
        "Unknown provider: \"{provider}\" for agent \"{agent_id}\". Registered: [{registered}]"
    )]
    UnknownProvider {
        provider: String,
        agent_id: String,
        registered: String,
    },
}

struct RouterInner {
    agents: Vec<AgentConfig>,
    providers: Vec<Arc<dyn LlmProvider>>,
    default_agent_id: String,
}

pub struct Router {
    inner: Mutex<RouterInner>,
}

impl Router {
    pub fn new(default_agent_id: impl Into<String>) -> Self {
        Self {
            inner: Mutex::new(RouterInner {
                agents: Vec::new(),
                providers: Vec::new(),
                default_agent_id: default_agent_id.into(),
            }),
        }
    }

    pub fn register_agent(&self, agent: AgentConfig) {
        with_lock(&self.inner, |inner| {
            if let Some(index) = inner.agents.iter().position(|item| item.id == agent.id) {
                inner.agents[index] = agent;
            } else {
                inner.agents.push(agent);
            }
        });
    }

    pub fn register_provider(&self, provider: Arc<dyn LlmProvider>) {
        with_lock(&self.inner, |inner| {
            let id = provider.id().to_string();
            if let Some(index) = inner.providers.iter().position(|item| item.id() == id) {
                inner.providers[index] = provider;
            } else {
                inner.providers.push(provider);
            }
        });
    }

    pub fn route(&self, message: &InboundMessage) -> Result<Route, RouteError> {
        with_lock(&self.inner, |inner| {
            let agent_id = message
                .agent
                .clone()
                .unwrap_or_else(|| inner.default_agent_id.clone());
            let Some(agent) = inner
                .agents
                .iter()
                .find(|agent| agent.id == agent_id)
                .cloned()
            else {
                let registered = inner
                    .agents
                    .iter()
                    .map(|agent| agent.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(RouteError::UnknownAgent {
                    agent_id,
                    registered,
                });
            };
            let Some(provider) = inner
                .providers
                .iter()
                .find(|provider| provider.id() == agent.provider)
                .cloned()
            else {
                let registered = inner
                    .providers
                    .iter()
                    .map(|provider| provider.id())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(RouteError::UnknownProvider {
                    provider: agent.provider,
                    agent_id,
                    registered,
                });
            };
            let provider_id = provider.id().to_string();
            Ok(Route {
                agent,
                provider_id,
                provider,
            })
        })
    }

    pub fn agents(&self) -> Vec<AgentConfig> {
        with_lock(&self.inner, |inner| inner.agents.clone())
    }

    pub fn providers(&self) -> Vec<Arc<dyn LlmProvider>> {
        with_lock(&self.inner, |inner| inner.providers.clone())
    }

    pub async fn health_check(&self) -> Vec<(String, bool)> {
        let providers = self.providers();
        let mut results = Vec::with_capacity(providers.len());
        for provider in providers {
            let id = provider.id().to_string();
            let available = provider.is_available().await.unwrap_or(false);
            results.push((id, available));
        }
        results
    }
}
