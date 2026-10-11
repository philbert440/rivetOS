use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use protocol::{
    CompactionPending, HookEventName, InboundMessage, JsNumber, Message, SessionState,
    ThinkingLevel,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::loader::WorkspaceLoader;
use crate::lock::with_lock;
use crate::prompt::{VOICE_MODE_PROMPT, recent_activity_message};
use crate::router::{AgentConfig, RouteError, Router};
use crate::timefmt::now_millis;

pub const RECENT_ACTIVITY_QUERY: &str = "recent activity summary";
pub const RECENT_ACTIVITY_MAX_TOKENS: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub prompt: i64,
    pub completion: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBook {
    pub agent_id: String,
    pub turn_count: i64,
    pub total_tokens: TokenTotals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSessionSettings {
    pub thinking: String,
    pub reasoning_visible: bool,
    pub tools_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedSessionSettings {
    pub thinking: Option<String>,
    pub reasoning_visible: Option<bool>,
    pub tools_visible: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionOptions {
    pub platform: Option<String>,
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionStartContext {
    pub event: &'static str,
    pub agent_id: String,
    pub session_id: String,
    pub platform: Option<String>,
    pub user_id: Option<String>,
    pub timestamp: JsNumber,
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionEndContext {
    pub event: &'static str,
    pub agent_id: Option<String>,
    pub session_id: String,
    pub turn_count: Option<i64>,
    pub total_tokens: Option<TokenTotals>,
    pub timestamp: JsNumber,
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct SessionStoreError {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct LifecycleError {
    pub message: String,
}

impl SessionStoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl LifecycleError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn get_context_for_turn(
        &self,
        query: &str,
        agent_id: &str,
        max_tokens: u32,
        user_id: Option<&str>,
    ) -> Result<String, SessionStoreError>;

    async fn load_session_settings(
        &self,
        _session_id: &str,
    ) -> Result<Option<LoadedSessionSettings>, SessionStoreError> {
        Ok(None)
    }

    async fn save_session_settings(
        &self,
        _session_id: &str,
        _settings: &SavedSessionSettings,
    ) -> Result<(), SessionStoreError> {
        Ok(())
    }
}

#[async_trait]
pub trait SessionLifecycle: Send + Sync {
    async fn on_start(&self, ctx: &SessionStartContext) -> Result<(), LifecycleError>;
    async fn on_end(&self, ctx: &SessionEndContext) -> Result<(), LifecycleError>;
}

pub fn session_key(channel_id: &str, user_id: &str) -> String {
    format!("{channel_id}:{user_id}")
}

pub fn session_settings_from_json(value: &Value) -> Option<LoadedSessionSettings> {
    let Value::Object(map) = value else {
        return None;
    };
    Some(LoadedSessionSettings {
        thinking: match map.get("thinking") {
            Some(Value::String(text)) => Some(text.clone()),
            _ => None,
        },
        reasoning_visible: match map.get("reasoningVisible") {
            Some(Value::Bool(flag)) => Some(*flag),
            _ => None,
        },
        tools_visible: match map.get("toolsVisible") {
            Some(Value::Bool(flag)) => Some(*flag),
            _ => None,
        },
    })
}

pub fn apply_loaded_settings(
    thinking: &mut String,
    reasoning_visible: &mut bool,
    tools_visible: &mut bool,
    settings: &LoadedSessionSettings,
) {
    if let Some(text) = settings.thinking.clone() {
        *thinking = text;
    }
    if let Some(value) = settings.reasoning_visible {
        *reasoning_visible = value;
    }
    if let Some(value) = settings.tools_visible {
        *tools_visible = value;
    }
}

struct Maps {
    order: Vec<String>,
    sessions: HashMap<String, SharedSession>,
    books: HashMap<String, SessionBook>,
}

#[derive(Clone, Debug)]
pub struct SharedSession {
    inner: Arc<Mutex<SessionState>>,
}

impl SharedSession {
    fn new(state: SessionState) -> Self {
        Self {
            inner: Arc::new(Mutex::new(state)),
        }
    }

    pub fn with<R>(&self, body: impl FnOnce(&SessionState) -> R) -> R {
        with_lock(&self.inner, |state| body(state))
    }

    pub fn with_mut<R>(&self, body: impl FnOnce(&mut SessionState) -> R) -> R {
        with_lock(&self.inner, body)
    }

    pub fn snapshot(&self) -> SessionState {
        self.with(Clone::clone)
    }

    pub fn ptr_eq(left: &Self, right: &Self) -> bool {
        Arc::ptr_eq(&left.inner, &right.inner)
    }
}

pub struct SessionManager {
    router: Router,
    maps: Mutex<Maps>,
    store: Mutex<Option<Arc<dyn SessionStore>>>,
    lifecycle: Mutex<Option<Arc<dyn SessionLifecycle>>>,
}

impl SessionManager {
    pub fn new(router: Router) -> Self {
        Self {
            router,
            maps: Mutex::new(Maps {
                order: Vec::new(),
                sessions: HashMap::new(),
                books: HashMap::new(),
            }),
            store: Mutex::new(None),
            lifecycle: Mutex::new(None),
        }
    }

    pub fn set_store(&self, store: Arc<dyn SessionStore>) {
        with_lock(&self.store, |slot| *slot = Some(store));
    }

    pub fn set_lifecycle(&self, lifecycle: Arc<dyn SessionLifecycle>) {
        with_lock(&self.lifecycle, |slot| *slot = Some(lifecycle));
    }

    pub async fn get_or_create_session(
        &self,
        session_key: &str,
        message: &InboundMessage,
    ) -> Result<SharedSession, RouteError> {
        if let Some(existing) = self.get(session_key) {
            return Ok(existing);
        }
        let route = self.router.route(message)?;
        let session = self
            .create_session(
                session_key,
                &route.agent,
                SessionOptions {
                    platform: Some(message.platform.clone()),
                    user_id: Some(message.user_id.clone()),
                },
            )
            .await;
        self.set(session_key, session.clone());
        Ok(session)
    }

    pub fn get(&self, session_key: &str) -> Option<SharedSession> {
        with_lock(&self.maps, |maps| maps.sessions.get(session_key).cloned())
    }

    pub fn set(&self, session_key: &str, session: SharedSession) {
        with_lock(&self.maps, |maps| {
            if !maps.order.iter().any(|key| key == session_key) {
                maps.order.push(session_key.to_string());
            }
            maps.sessions.insert(session_key.to_string(), session);
        });
    }

    pub fn has(&self, session_key: &str) -> bool {
        with_lock(&self.maps, |maps| maps.sessions.contains_key(session_key))
    }

    pub fn delete(&self, session_key: &str) {
        with_lock(&self.maps, |maps| remove_key(maps, session_key));
    }

    pub fn book(&self, session_key: &str) -> Option<SessionBook> {
        with_lock(&self.maps, |maps| maps.books.get(session_key).cloned())
    }

    pub async fn end_session(&self, session_key: &str) {
        self.emit_end(session_key).await;
        with_lock(&self.maps, |maps| remove_key(maps, session_key));
    }

    pub async fn end_all_sessions(&self) {
        let keys = with_lock(&self.maps, |maps| maps.order.clone());
        for key in keys {
            self.end_session(&key).await;
        }
    }

    pub fn record_turn(&self, session_key: &str, usage: Option<TokenTotals>) {
        with_lock(&self.maps, |maps| {
            let Some(book) = maps.books.get_mut(session_key) else {
                return;
            };
            book.turn_count = book.turn_count.saturating_add(1);
            if let Some(usage) = usage {
                book.total_tokens.prompt = book.total_tokens.prompt.saturating_add(usage.prompt);
                book.total_tokens.completion = book
                    .total_tokens
                    .completion
                    .saturating_add(usage.completion);
            }
        });
    }

    pub async fn create_session(
        &self,
        session_key: &str,
        agent: &AgentConfig,
        options: SessionOptions,
    ) -> SharedSession {
        let mut history = Vec::new();
        let store = with_lock(&self.store, |slot| slot.clone());
        if let Some(store) = &store
            && let Ok(context) = store
                .get_context_for_turn(
                    RECENT_ACTIVITY_QUERY,
                    &agent.id,
                    RECENT_ACTIVITY_MAX_TOKENS,
                    options.user_id.as_deref(),
                )
                .await
            && let Some(message) = recent_activity_message(&context)
        {
            history.push(message);
        }

        let mut thinking = agent
            .default_thinking
            .unwrap_or(ThinkingLevel::Medium)
            .as_str()
            .to_string();
        let mut reasoning_visible = agent.local;
        let mut tools_visible = false;
        if let Some(store) = &store
            && let Ok(Some(settings)) = store.load_session_settings(session_key).await
        {
            apply_loaded_settings(
                &mut thinking,
                &mut reasoning_visible,
                &mut tools_visible,
                &settings,
            );
        }

        let session = SessionState {
            id: session_key.to_string(),
            thinking,
            reasoning_visible,
            tools_visible,
            history,
            system_prompt: None,
            compaction_count: JsNumber::from(0_i64),
            compaction_pending: None,
            nudges_fired: Vec::new(),
        };

        with_lock(&self.maps, |maps| {
            maps.books.insert(
                session_key.to_string(),
                SessionBook {
                    agent_id: agent.id.clone(),
                    turn_count: 0,
                    total_tokens: TokenTotals {
                        prompt: 0,
                        completion: 0,
                    },
                },
            );
        });

        if let Some(lifecycle) = with_lock(&self.lifecycle, |slot| slot.clone()) {
            let ctx = SessionStartContext {
                event: HookEventName::SessionStart.as_str(),
                agent_id: agent.id.clone(),
                session_id: session_key.to_string(),
                platform: options.platform.clone(),
                user_id: options.user_id.clone(),
                timestamp: JsNumber::from(now_millis()),
                metadata: Map::new(),
            };
            let _ = lifecycle.on_start(&ctx).await;
        }

        SharedSession::new(session)
    }

    pub async fn ensure_system_prompt(
        &self,
        session: &SharedSession,
        loader: &WorkspaceLoader,
        agent_id: &str,
        message: &InboundMessage,
    ) -> String {
        if let Some(existing) = session.with(|state| state.system_prompt.clone())
            && !existing.is_empty()
        {
            return existing;
        }
        let mut prompt = loader
            .build_system_prompt(Some(agent_id), Some(message.user_id.as_str()))
            .await;
        if message.chat_type == "voice" {
            prompt.push_str(VOICE_MODE_PROMPT);
        }
        if let Some(metadata) = &message.metadata
            && let Some(Value::String(extra)) = metadata.get("systemPrompt")
        {
            let trimmed = protocol::js::js_trim(extra);
            if !trimmed.is_empty() {
                prompt.push_str("\n\n");
                prompt.push_str(trimmed);
            }
        }
        session.with_mut(|state| {
            if let Some(existing) = state.system_prompt.clone()
                && !existing.is_empty()
            {
                return existing;
            }
            state.system_prompt = Some(prompt.clone());
            prompt
        })
    }

    pub async fn save_session_settings(&self, session: &SharedSession) {
        let Some(store) = with_lock(&self.store, |slot| slot.clone()) else {
            return;
        };
        let settings = session.with(|state| SavedSessionSettings {
            thinking: state.thinking.clone(),
            reasoning_visible: state.reasoning_visible,
            tools_visible: state.tools_visible,
        });
        let session_id = session.with(|state| state.id.clone());
        let _ = store.save_session_settings(&session_id, &settings).await;
    }

    pub fn with_session<R>(
        &self,
        session_key: &str,
        body: impl FnOnce(&mut SessionState) -> R,
    ) -> Option<R> {
        let session = with_lock(&self.maps, |maps| maps.sessions.get(session_key).cloned());
        session.map(|session| session.with_mut(body))
    }

    pub fn apply_compaction(&self, session_key: &str, history: Vec<Message>) -> bool {
        let Some(session) = self.get(session_key) else {
            return false;
        };
        session.with_mut(|state| {
            state.history = sanitize_compacted_history(history);
            let next = state.compaction_count.as_f64() + 1.0;
            state.compaction_count = JsNumber::from(next);
            state.nudges_fired.clear();
        });
        true
    }

    pub fn set_compaction_pending(
        &self,
        session_key: &str,
        pending: Option<CompactionPending>,
    ) -> bool {
        let Some(session) = self.get(session_key) else {
            return false;
        };
        session.with_mut(|state| state.compaction_pending = pending);
        true
    }

    async fn emit_end(&self, session_key: &str) {
        let Some(lifecycle) = with_lock(&self.lifecycle, |slot| slot.clone()) else {
            return;
        };
        let book = with_lock(&self.maps, |maps| {
            let present =
                maps.sessions.contains_key(session_key) || maps.books.contains_key(session_key);
            if !present {
                return None;
            }
            Some(maps.books.get(session_key).cloned())
        });
        let Some(book) = book else {
            return;
        };
        let ctx = SessionEndContext {
            event: HookEventName::SessionEnd.as_str(),
            agent_id: book.as_ref().map(|info| info.agent_id.clone()),
            session_id: session_key.to_string(),
            turn_count: book.as_ref().map(|info| info.turn_count),
            total_tokens: book.as_ref().map(|info| info.total_tokens),
            timestamp: JsNumber::from(now_millis()),
            metadata: Map::new(),
        };
        let _ = lifecycle.on_end(&ctx).await;
    }
}

fn sanitize_compacted_history(history: Vec<Message>) -> Vec<Message> {
    history
        .into_iter()
        .filter(|message| message.role != protocol::MessageRole::Tool)
        .map(|mut message| {
            if message.role == protocol::MessageRole::Assistant && message.tool_calls.is_some() {
                message.tool_calls = None;
            }
            message
        })
        .collect()
}

fn remove_key(maps: &mut Maps, session_key: &str) {
    maps.sessions.remove(session_key);
    maps.books.remove(session_key);
    maps.order.retain(|key| key != session_key);
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use serde_json::{Map, Value};

    use super::SessionManager;
    use crate::error::ProviderError;
    use crate::loader::WorkspaceLoader;
    use crate::prompt::VOICE_MODE_PROMPT;
    use crate::router::{AgentConfig, LlmProvider, Router};
    use crate::sessions::{SessionOptions, session_key};

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

    fn router() -> Router {
        let router = Router::new("opus");
        router.register_agent(AgentConfig::new("opus", "Opus", "mock", None, None, false));
        router.register_provider(Arc::new(Stub));
        router
    }

    fn message(chat_type: &str, extra: Option<&str>) -> protocol::InboundMessage {
        let metadata = extra.map(|text| {
            let mut map = Map::new();
            map.insert("systemPrompt".to_string(), Value::String(text.to_string()));
            map
        });
        protocol::InboundMessage {
            id: "m1".to_string(),
            user_id: "alice".to_string(),
            username: None,
            display_name: None,
            channel_id: "ch".to_string(),
            chat_type: chat_type.to_string(),
            text: "hello".to_string(),
            platform: "test".to_string(),
            agent: None,
            reply_to_message_id: None,
            attachments: None,
            metadata,
            timestamp: protocol::JsNumber::from(0_i64),
        }
    }

    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "rr-6w-session-{}-{}",
                std::process::id(),
                now_token()
            ));
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("AGENT.md"), "agent identity").unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn now_token() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0)
    }

    fn loader(dir: &std::path::Path, ticks: &Arc<Mutex<i64>>) -> WorkspaceLoader {
        let ticks = Arc::clone(ticks);
        WorkspaceLoader::with_clock(
            dir.to_string_lossy().into_owned(),
            Arc::new(move || {
                let seconds = match ticks.lock() {
                    Ok(guard) => *guard,
                    Err(poisoned) => *poisoned.into_inner(),
                };
                DateTime::from_timestamp(seconds, 0).unwrap_or_else(Utc::now)
            }),
        )
    }

    #[tokio::test]
    async fn system_prompt_freezes_on_the_session() {
        let dir = TempDir::new();
        let ticks = Arc::new(Mutex::new(1_791_647_112_i64));
        let loader = loader(dir.path.as_path(), &ticks);
        let manager = SessionManager::new(router());
        let key = session_key("ch", "alice");
        let first_message = message("dm", None);
        let session = manager
            .get_or_create_session(&key, &first_message)
            .await
            .unwrap();
        let first = manager
            .ensure_system_prompt(&session, &loader, "opus", &first_message)
            .await;
        assert!(first.contains("11:45:12 AM"));
        assert!(!first.contains('\u{202f}'));
        assert!(!first.contains("VOICE MODE"));
        *ticks.lock().unwrap() = 1_768_491_912;
        let later = message("voice", Some("  be terse  "));
        let second = manager
            .ensure_system_prompt(&session, &loader, "opus", &later)
            .await;
        assert_eq!(first, second);
        assert_eq!(
            manager
                .get(&key)
                .unwrap()
                .snapshot()
                .system_prompt
                .as_deref(),
            Some(first.as_str())
        );

        let voice_key = session_key("ch", "voice");
        let voice_message = message("voice", Some("  be terse  "));
        let voice_session = manager
            .create_session(
                &voice_key,
                &AgentConfig::new("opus", "Opus", "mock", None, None, false),
                SessionOptions {
                    platform: Some("test".to_string()),
                    user_id: Some("alice".to_string()),
                },
            )
            .await;
        manager.set(&voice_key, voice_session.clone());
        let voice = manager
            .ensure_system_prompt(&voice_session, &loader, "opus", &voice_message)
            .await;
        assert!(voice.contains("11:45:12 AM") || voice.contains("10:45:12 AM"));
        assert!(voice.contains(VOICE_MODE_PROMPT));
        assert!(voice.contains("\n\nbe terse"));
        let frozen = voice.clone();
        *ticks.lock().unwrap() = 1_791_647_112;
        let text_later = message("dm", Some("different"));
        let again = manager
            .ensure_system_prompt(&voice_session, &loader, "opus", &text_later)
            .await;
        assert_eq!(again, frozen);
        assert!(!again.contains("different"));
    }
}
