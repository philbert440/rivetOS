use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use protocol::InboundMessage;
use protocol::js::JsValue;
use thiserror::Error;

use crate::error::ProviderError;
use crate::lock::with_lock;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("agent config requires string id, name, and provider")]
pub struct AgentConfigError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: Option<String>,
    pub default_thinking: Option<protocol::ThinkingLevel>,
    pub local: bool,
    pub original: JsValue,
}

impl AgentConfig {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        provider: impl Into<String>,
        model: Option<String>,
        default_thinking: Option<protocol::ThinkingLevel>,
        local: bool,
    ) -> Self {
        let id = id.into();
        let name = name.into();
        let provider = provider.into();
        let original = synthesize_original(
            &id,
            &name,
            &provider,
            model.as_deref(),
            default_thinking,
            local,
        );
        Self {
            id,
            name,
            provider,
            model,
            default_thinking,
            local,
            original,
        }
    }

    pub fn from_js(value: JsValue) -> Result<Self, AgentConfigError> {
        let Some(object) = value.as_object() else {
            return Err(AgentConfigError);
        };
        let id = object
            .get("id")
            .and_then(JsValue::as_str)
            .ok_or(AgentConfigError)?
            .to_string();
        let name = object
            .get("name")
            .and_then(JsValue::as_str)
            .ok_or(AgentConfigError)?
            .to_string();
        let provider = object
            .get("provider")
            .and_then(JsValue::as_str)
            .ok_or(AgentConfigError)?
            .to_string();
        let model = object
            .get("model")
            .and_then(JsValue::as_str)
            .map(str::to_string);
        let default_thinking = object
            .get("defaultThinking")
            .and_then(JsValue::as_str)
            .and_then(|text| text.parse().ok());
        let local = object.get("local").and_then(JsValue::as_bool) == Some(true);
        Ok(Self {
            id,
            name,
            provider,
            model,
            default_thinking,
            local,
            original: value,
        })
    }
}

fn synthesize_original(
    id: &str,
    name: &str,
    provider: &str,
    model: Option<&str>,
    default_thinking: Option<protocol::ThinkingLevel>,
    local: bool,
) -> JsValue {
    let mut json = String::from("{");
    push_entry(&mut json, "id", &json_string(id), true);
    push_entry(&mut json, "name", &json_string(name), false);
    push_entry(&mut json, "provider", &json_string(provider), false);
    if let Some(model) = model {
        push_entry(&mut json, "model", &json_string(model), false);
    }
    if let Some(level) = default_thinking {
        push_entry(
            &mut json,
            "defaultThinking",
            &json_string(level.as_str()),
            false,
        );
    }
    push_entry(
        &mut json,
        "local",
        if local { "true" } else { "false" },
        false,
    );
    json.push('}');
    protocol::js::parse(&json).unwrap_or(JsValue::Null)
}

fn push_entry(out: &mut String, key: &str, value: &str, first: bool) {
    if !first {
        out.push(',');
    }
    out.push_str(&json_string(key));
    out.push(':');
    out.push_str(value);
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
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
