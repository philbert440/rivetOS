use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use protocol::{
    CompactionPending, InboundMessage, JsNumber, MessageContent, MessageRole, ThinkingLevel,
};
use serde_json::json;
use workspace::{
    AgentConfig, LifecycleError, LlmProvider, LoadedSessionSettings, ProviderError,
    RECENT_ACTIVITY_MAX_TOKENS, RECENT_ACTIVITY_QUERY, RouteError, Router, SavedSessionSettings,
    SessionLifecycle, SessionManager, SessionOptions, SessionStore, SessionStoreError, TokenTotals,
    session_key, session_settings_from_json,
};

struct Stub;

#[async_trait]
impl LlmProvider for Stub {
    fn id(&self) -> &str {
        "mock"
    }

    async fn is_available(&self) -> Result<bool, ProviderError> {
        Ok(true)
    }
}

struct Capture {
    starts: Mutex<Vec<workspace::SessionStartContext>>,
    ends: Mutex<Vec<workspace::SessionEndContext>>,
    fail_start: bool,
}

#[async_trait]
impl SessionLifecycle for Capture {
    async fn on_start(&self, ctx: &workspace::SessionStartContext) -> Result<(), LifecycleError> {
        self.starts.lock().unwrap().push(ctx.clone());
        if self.fail_start {
            Err(LifecycleError::new("hook exploded"))
        } else {
            Ok(())
        }
    }

    async fn on_end(&self, ctx: &workspace::SessionEndContext) -> Result<(), LifecycleError> {
        self.ends.lock().unwrap().push(ctx.clone());
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SeenQuery {
    query: String,
    agent_id: String,
    max_tokens: u32,
    user_id: Option<String>,
}

struct Memory {
    context: Mutex<Result<String, SessionStoreError>>,
    settings: Mutex<Result<Option<LoadedSessionSettings>, SessionStoreError>>,
    saved: Mutex<Vec<(String, SavedSessionSettings)>>,
    queries: Mutex<Vec<SeenQuery>>,
}

#[async_trait]
impl SessionStore for Memory {
    async fn get_context_for_turn(
        &self,
        query: &str,
        agent_id: &str,
        max_tokens: u32,
        user_id: Option<&str>,
    ) -> Result<String, SessionStoreError> {
        self.queries.lock().unwrap().push(SeenQuery {
            query: query.to_string(),
            agent_id: agent_id.to_string(),
            max_tokens,
            user_id: user_id.map(str::to_string),
        });
        self.context.lock().unwrap().clone()
    }

    async fn load_session_settings(
        &self,
        _session_id: &str,
    ) -> Result<Option<LoadedSessionSettings>, SessionStoreError> {
        self.settings.lock().unwrap().clone()
    }

    async fn save_session_settings(
        &self,
        session_id: &str,
        settings: &SavedSessionSettings,
    ) -> Result<(), SessionStoreError> {
        self.saved
            .lock()
            .unwrap()
            .push((session_id.to_string(), settings.clone()));
        Ok(())
    }
}

fn agent(local: bool) -> AgentConfig {
    AgentConfig {
        id: "opus".to_string(),
        name: "Opus".to_string(),
        provider: "mock".to_string(),
        model: Some("test-model".to_string()),
        default_thinking: None,
        local,
    }
}

fn router() -> Router {
    let router = Router::new("opus");
    router.register_agent(agent(false));
    router.register_provider(Arc::new(Stub));
    router
}

fn inbound() -> InboundMessage {
    InboundMessage {
        id: "m1".to_string(),
        user_id: "user-1".to_string(),
        username: None,
        display_name: None,
        channel_id: "ch-1".to_string(),
        chat_type: "dm".to_string(),
        text: "hello".to_string(),
        platform: "telegram".to_string(),
        agent: None,
        reply_to_message_id: None,
        attachments: None,
        metadata: None,
        timestamp: JsNumber::from(0_i64),
    }
}

fn memory(context: Result<String, SessionStoreError>) -> Arc<Memory> {
    Arc::new(Memory {
        context: Mutex::new(context),
        settings: Mutex::new(Ok(None)),
        saved: Mutex::new(Vec::new()),
        queries: Mutex::new(Vec::new()),
    })
}

fn hooks(fail_start: bool) -> Arc<Capture> {
    Arc::new(Capture {
        starts: Mutex::new(Vec::new()),
        ends: Mutex::new(Vec::new()),
        fail_start,
    })
}

#[test]
fn session_key_joins_channel_and_user() {
    assert_eq!(session_key("ch-1", "user-1"), "ch-1:user-1");
}

#[test]
fn settings_json_uses_camel_case_and_keeps_invalid_thinking() {
    let loaded = session_settings_from_json(&json!({
        "thinking": "low",
        "reasoningVisible": false,
        "toolsVisible": true
    }))
    .unwrap();
    let mut thinking = ThinkingLevel::Medium;
    let mut reasoning = true;
    let mut tools = false;
    workspace::apply_loaded_settings(&mut thinking, &mut reasoning, &mut tools, &loaded);
    assert_eq!(thinking, ThinkingLevel::Low);
    assert!(!reasoning);
    assert!(tools);

    let invalid = session_settings_from_json(&json!({
        "thinking": "turbo",
        "reasoningVisible": "yes"
    }))
    .unwrap();
    let mut thinking = ThinkingLevel::High;
    let mut reasoning = true;
    let mut tools = false;
    workspace::apply_loaded_settings(&mut thinking, &mut reasoning, &mut tools, &invalid);
    assert_eq!(thinking, ThinkingLevel::High);
    assert!(reasoning);
    assert!(!tools);

    assert!(session_settings_from_json(&json!(null)).is_none());
    assert!(session_settings_from_json(&json!(["low"])).is_none());
    let empty = session_settings_from_json(&json!({})).unwrap();
    assert!(empty.thinking.is_none());

    let saved = SavedSessionSettings {
        thinking: ThinkingLevel::High,
        reasoning_visible: true,
        tools_visible: false,
    };
    let value = serde_json::to_value(&saved).unwrap();
    assert_eq!(value["thinking"], "high");
    assert_eq!(value["reasoningVisible"], true);
    assert_eq!(value["toolsVisible"], false);
    assert!(value.get("reasoning_visible").is_none());
}

#[tokio::test]
async fn create_session_emits_start_and_does_not_insert() {
    let capture = hooks(false);
    let manager = SessionManager::new(router());
    manager.set_lifecycle(capture.clone());
    let session = manager
        .create_session(
            "ch-1:user-1",
            &agent(false),
            SessionOptions {
                platform: Some("telegram".to_string()),
                user_id: Some("user-1".to_string()),
            },
        )
        .await;
    assert_eq!(session.id, "ch-1:user-1");
    assert_eq!(session.thinking, ThinkingLevel::Medium);
    assert!(!session.reasoning_visible);
    assert!(!session.tools_visible);
    assert!(session.history.is_empty());
    assert!(session.system_prompt.is_none());
    assert_eq!(session.compaction_count, 0);
    assert!(session.compaction_pending.is_none());
    assert!(session.nudges_fired.is_empty());
    assert!(!manager.has("ch-1:user-1"));
    let book = manager.book("ch-1:user-1").unwrap();
    assert_eq!(book.agent_id, "opus");
    assert_eq!(book.turn_count, 0);

    let starts = capture.starts.lock().unwrap();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].event, "session:start");
    assert_eq!(starts[0].agent_id, "opus");
    assert_eq!(starts[0].session_id, "ch-1:user-1");
    assert_eq!(starts[0].platform.as_deref(), Some("telegram"));
    assert_eq!(starts[0].user_id.as_deref(), Some("user-1"));
    assert!(starts[0].metadata.is_empty());
    assert!(starts[0].timestamp.as_i64().unwrap() > 0);
}

#[tokio::test]
async fn get_or_create_emits_start_once() {
    let capture = hooks(false);
    let manager = SessionManager::new(router());
    manager.set_lifecycle(capture.clone());
    let message = inbound();
    let first = manager
        .get_or_create_session("ch-1:user-1", &message)
        .await
        .unwrap();
    let second = manager
        .get_or_create_session("ch-1:user-1", &message)
        .await
        .unwrap();
    assert_eq!(first.id, second.id);
    assert!(manager.has("ch-1:user-1"));
    assert_eq!(capture.starts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn start_hook_failure_still_returns_the_session() {
    let manager = SessionManager::new(router());
    manager.set_lifecycle(hooks(true));
    let session = manager
        .create_session("ch-1:user-1", &agent(false), SessionOptions::default())
        .await;
    assert_eq!(session.id, "ch-1:user-1");
}

#[tokio::test]
async fn end_session_emits_turn_totals_and_delete_does_not() {
    let capture = hooks(false);
    let manager = SessionManager::new(router());
    manager.set_lifecycle(capture.clone());
    let session = manager
        .create_session("ch-1:user-1", &agent(false), SessionOptions::default())
        .await;
    manager.set("ch-1:user-1", session);
    manager.record_turn(
        "ch-1:user-1",
        Some(TokenTotals {
            prompt: 100,
            completion: 50,
        }),
    );
    manager.record_turn(
        "ch-1:user-1",
        Some(TokenTotals {
            prompt: 200,
            completion: 75,
        }),
    );
    manager.record_turn("missing", None);
    manager.end_session("ch-1:user-1").await;
    assert!(!manager.has("ch-1:user-1"));
    assert!(manager.book("ch-1:user-1").is_none());

    {
        let ends = capture.ends.lock().unwrap();
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0].event, "session:end");
        assert_eq!(ends[0].agent_id.as_deref(), Some("opus"));
        assert_eq!(ends[0].session_id, "ch-1:user-1");
        assert_eq!(ends[0].turn_count, Some(2));
        assert_eq!(
            ends[0].total_tokens,
            Some(TokenTotals {
                prompt: 300,
                completion: 125
            })
        );
    }

    let session = manager
        .create_session("s1", &agent(false), SessionOptions::default())
        .await;
    manager.set("s1", session);
    manager.delete("s1");
    assert!(!manager.has("s1"));
    assert_eq!(capture.ends.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn end_all_sessions_ends_inserted_sessions_in_order() {
    let capture = hooks(false);
    let manager = SessionManager::new(router());
    manager.set_lifecycle(capture.clone());
    let first = manager
        .create_session("s1", &agent(false), SessionOptions::default())
        .await;
    let second = manager
        .create_session("s2", &agent(false), SessionOptions::default())
        .await;
    let orphan = manager
        .create_session("orphan", &agent(false), SessionOptions::default())
        .await;
    assert_eq!(orphan.id, "orphan");
    manager.set("s1", first);
    manager.set("s2", second);
    manager.end_all_sessions().await;
    assert!(!manager.has("s1"));
    assert!(!manager.has("s2"));
    assert!(manager.book("orphan").is_some());
    let mut ends: Vec<String> = capture
        .ends
        .lock()
        .unwrap()
        .iter()
        .map(|ctx| ctx.session_id.clone())
        .collect();
    ends.sort();
    assert_eq!(ends, ["s1", "s2"]);
}

#[tokio::test]
async fn end_without_bookkeeping_omits_the_turn_fields() {
    let capture = hooks(false);
    let manager = SessionManager::new(router());
    manager.set_lifecycle(capture.clone());
    let session = manager
        .create_session("s1", &agent(false), SessionOptions::default())
        .await;
    manager.delete("s1");
    manager.set("s1", session);
    manager.end_session("s1").await;
    let ends = capture.ends.lock().unwrap();
    assert_eq!(ends.len(), 1);
    assert!(ends[0].agent_id.is_none());
    assert!(ends[0].turn_count.is_none());
    assert!(ends[0].total_tokens.is_none());
}

#[tokio::test]
async fn memory_context_and_settings_follow_the_session_manager() {
    let store = memory(Ok("  kept raw  ".to_string()));
    *store.settings.lock().unwrap() = Ok(Some(LoadedSessionSettings {
        thinking: Some("high".to_string()),
        reasoning_visible: Some(false),
        tools_visible: Some(true),
    }));
    let manager = SessionManager::new(router());
    manager.set_store(store.clone());
    let session = manager
        .create_session(
            "ch-1:user-1",
            &agent(true),
            SessionOptions {
                platform: None,
                user_id: Some("user-1".to_string()),
            },
        )
        .await;
    assert_eq!(session.thinking, ThinkingLevel::High);
    assert!(!session.reasoning_visible);
    assert!(session.tools_visible);
    assert_eq!(session.history.len(), 1);
    assert_eq!(session.history[0].role, MessageRole::System);
    match &session.history[0].content {
        MessageContent::Text(text) => {
            assert_eq!(text, "## Recent Activity (last 48h)\n  kept raw  ");
        }
        MessageContent::Parts(_) => panic!("text"),
    }
    {
        let queries = store.queries.lock().unwrap();
        assert_eq!(
            queries.as_slice(),
            [SeenQuery {
                query: RECENT_ACTIVITY_QUERY.to_string(),
                agent_id: "opus".to_string(),
                max_tokens: RECENT_ACTIVITY_MAX_TOKENS,
                user_id: Some("user-1".to_string()),
            }]
        );
    }

    manager.set("ch-1:user-1", session.clone());
    manager.save_session_settings(&session).await;
    let saved = store.saved.lock().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].0, "ch-1:user-1");
    assert_eq!(saved[0].1.thinking, ThinkingLevel::High);
    assert!(!saved[0].1.reasoning_visible);
    assert!(saved[0].1.tools_visible);
}

#[tokio::test]
async fn blank_or_failed_memory_context_leaves_history_empty() {
    let store = memory(Ok(" \n ".to_string()));
    let manager = SessionManager::new(router());
    manager.set_store(store);
    let session = manager
        .create_session("s", &agent(true), SessionOptions::default())
        .await;
    assert!(session.history.is_empty());
    assert!(session.reasoning_visible);

    let store = memory(Err(SessionStoreError::new("down")));
    *store.settings.lock().unwrap() = Err(SessionStoreError::new("down"));
    let manager = SessionManager::new(router());
    manager.set_store(store);
    let session = manager
        .create_session("s", &agent(false), SessionOptions::default())
        .await;
    assert!(session.history.is_empty());
    assert_eq!(session.thinking, ThinkingLevel::Medium);

    let store = memory(Ok(String::new()));
    *store.settings.lock().unwrap() = Ok(Some(LoadedSessionSettings {
        thinking: Some(String::new()),
        reasoning_visible: None,
        tools_visible: None,
    }));
    let manager = SessionManager::new(router());
    manager.set_store(store);
    let session = manager
        .create_session("s", &agent(false), SessionOptions::default())
        .await;
    assert_eq!(session.thinking, ThinkingLevel::Medium);
}

#[tokio::test]
async fn compaction_replaces_history_and_clears_pending_nudges() {
    let manager = SessionManager::new(router());
    let session = manager
        .create_session("s", &agent(false), SessionOptions::default())
        .await;
    manager.set("s", session);
    manager
        .with_session("s", |session| {
            session.nudges_fired.push(JsNumber::from(1_i64));
        })
        .unwrap();
    assert!(manager.set_compaction_pending("s", Some(CompactionPending::Soft40)));
    assert!(manager.apply_compaction("s", Vec::new()));
    let session = manager.get("s").unwrap();
    assert!(session.history.is_empty());
    assert_eq!(session.compaction_count, 1);
    assert!(session.nudges_fired.is_empty());
    assert!(session.compaction_pending.is_none());
    assert!(!manager.apply_compaction("missing", Vec::new()));
    assert!(!manager.set_compaction_pending("missing", None));
}

#[tokio::test]
async fn unknown_route_is_returned_to_the_caller() {
    let manager = SessionManager::new(Router::new("missing"));
    let err = manager
        .get_or_create_session("k", &inbound())
        .await
        .unwrap_err();
    assert!(matches!(err, RouteError::UnknownAgent { .. }));
    assert!(err.to_string().contains("Unknown agent: \"missing\""));
}
