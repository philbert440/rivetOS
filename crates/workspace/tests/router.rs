use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use protocol::js::{parse, stringify};
use protocol::{InboundMessage, JsNumber, ThinkingLevel};
use workspace::{AgentConfig, LlmProvider, ProviderError, Router};

struct Stub {
    id: &'static str,
    result: Mutex<Result<bool, ProviderError>>,
}

#[async_trait]
impl LlmProvider for Stub {
    fn id(&self) -> &str {
        self.id
    }

    async fn is_available(&self) -> Result<bool, ProviderError> {
        self.result.lock().unwrap().clone()
    }
}

fn agent(id: &str, provider: &str) -> AgentConfig {
    AgentConfig::new(id, id, provider, None, None, false)
}

fn provider(id: &'static str, available: Result<bool, ProviderError>) -> Arc<Stub> {
    Arc::new(Stub {
        id,
        result: Mutex::new(available),
    })
}

fn message(agent: Option<&str>) -> InboundMessage {
    InboundMessage {
        id: "1".to_string(),
        user_id: "user-1".to_string(),
        username: None,
        display_name: None,
        channel_id: "chan-1".to_string(),
        chat_type: "private".to_string(),
        text: "test".to_string(),
        platform: "test".to_string(),
        agent: agent.map(str::to_string),
        reply_to_message_id: None,
        attachments: None,
        metadata: None,
        timestamp: JsNumber::from(0_i64),
    }
}

fn router() -> Router {
    let router = Router::new("default-agent");
    router.register_agent(agent("default-agent", "anthropic"));
    router.register_agent(agent("fast-agent", "xai"));
    router.register_provider(provider("anthropic", Ok(true)));
    router.register_provider(provider("xai", Ok(true)));
    router
}

#[test]
fn routes_to_the_default_or_named_agent() {
    let router = router();
    let default = router.route(&message(None)).unwrap();
    assert_eq!(default.agent.id, "default-agent");
    assert_eq!(default.provider_id, "anthropic");
    assert_eq!(default.provider.id(), "anthropic");

    let named = router.route(&message(Some("fast-agent"))).unwrap();
    assert_eq!(named.agent.id, "fast-agent");
    assert_eq!(named.provider.id(), "xai");
}

#[test]
fn empty_agent_id_is_not_the_default() {
    let router = router();
    let err = router.route(&message(Some(""))).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Unknown agent: \"\". Registered: [default-agent, fast-agent]"
    );
}

#[test]
fn unknown_agent_and_provider_use_the_typescript_messages() {
    let router = router();
    let err = router.route(&message(Some("nonexistent"))).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Unknown agent: \"nonexistent\". Registered: [default-agent, fast-agent]"
    );

    router.register_agent(agent("orphan-agent", "missing-provider"));
    let err = router.route(&message(Some("orphan-agent"))).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Unknown provider: \"missing-provider\" for agent \"orphan-agent\". Registered: [anthropic, xai]"
    );
}

#[test]
fn registration_keeps_insertion_order_when_replaced() {
    let router = router();
    router.register_agent(AgentConfig::new(
        "default-agent",
        "renamed",
        "xai",
        Some("grok".to_string()),
        None,
        true,
    ));
    let agents = router.agents();
    assert_eq!(agents.len(), 2);
    assert_eq!(agents[0].id, "default-agent");
    assert_eq!(agents[0].name, "renamed");
    assert_eq!(agents[0].provider, "xai");
    assert!(agents[0].local);
    assert_eq!(agents[1].id, "fast-agent");

    router.register_provider(provider("anthropic", Ok(false)));
    let providers = router.providers();
    assert_eq!(providers.len(), 2);
    assert_eq!(providers[0].id(), "anthropic");
    assert_eq!(providers[1].id(), "xai");
}

#[tokio::test]
async fn health_check_preserves_order_and_treats_errors_as_down() {
    let router = router();
    let health = router.health_check().await;
    assert_eq!(
        health,
        vec![("anthropic".to_string(), true), ("xai".to_string(), true)]
    );

    let down = Router::new("a");
    down.register_agent(agent("a", "down"));
    down.register_provider(provider("down", Ok(false)));
    down.register_provider(provider("boom", Err(ProviderError("nope".to_string()))));
    assert_eq!(
        down.health_check().await,
        vec![("down".to_string(), false), ("boom".to_string(), false)]
    );
}

#[test]
fn route_and_agents_keep_the_original_config_object() {
    let raw = r#"{"id":"opus","name":"Opus","provider":"mock","model":"test-model","defaultThinking":"high","local":true,"workspaceFiles":["EXTRA.md"],"providerConfig":{"baseUrl":"http://example"},"hooks":[{"event":"start","command":"echo"}],"tools":{"include":["memory_search"]},"customFlag":"kept"}"#;
    let parsed = parse(raw).unwrap();
    let expected = stringify(&parsed);
    let router = Router::new("opus");
    router.register_agent(AgentConfig::from_js(parsed).unwrap());
    router.register_provider(provider("mock", Ok(true)));
    let route = router.route(&message(Some("opus"))).unwrap();
    assert_eq!(route.agent.id, "opus");
    assert_eq!(route.agent.name, "Opus");
    assert_eq!(route.agent.provider, "mock");
    assert_eq!(route.agent.model.as_deref(), Some("test-model"));
    assert_eq!(route.agent.default_thinking, Some(ThinkingLevel::High));
    assert!(route.agent.local);
    assert_eq!(stringify(&route.agent.original), expected);
    let agents = router.agents();
    assert_eq!(stringify(&agents[0].original), expected);
    assert!(expected.contains("\"workspaceFiles\""));
    assert!(expected.contains("\"customFlag\""));
    assert!(expected.contains("\"tools\""));

    let omitted = parse(r#"{"id":"plain","name":"Plain","provider":"mock"}"#).unwrap();
    let plain = AgentConfig::from_js(omitted).unwrap();
    assert!(!plain.local);
    assert!(plain.default_thinking.is_none());
    let text = stringify(&plain.original);
    assert!(!text.contains("local"));
    assert!(!text.contains("defaultThinking"));

    let unknown = parse(
        r#"{"id":"odd","name":"Odd","provider":"mock","defaultThinking":"turbo","local":"yes"}"#,
    )
    .unwrap();
    let odd = AgentConfig::from_js(unknown.clone()).unwrap();
    assert!(odd.default_thinking.is_none());
    assert!(!odd.local);
    assert_eq!(stringify(&odd.original), stringify(&unknown));
}
