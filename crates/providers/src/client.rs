use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::ThinkingLevel;
use reqwest::Method;
use serde_json::{Map, Value};

use crate::catalog::{FetchIds, ModelCatalog};
use crate::decode::{Decoder, Kind as DecKind};
use crate::error::{ProviderError, now_ms};
use crate::fold::{FoldContent, FoldMessage, split_and_fold_system};
use crate::http::{
    HttpAttempt, build_client, connection_header, decode_response, read_limited, send, tail_headers,
};
use crate::jsonutil::{
    IdGen, encode_path_segment, encode_query, gemini_schema, is_claude_4, join_url, json_number,
    map_xai_reasoning_effort, splice_video_urls, thinking_name,
};
use crate::token::{
    ParsedArgv, TokenCommandInput, TokenEntry, TokenSource, parse_token_command_argv,
};
use crate::types::{
    BoxFuture, ChatRequest, ChatStream, PROBE_TIMEOUT, Provider, ReplayTool, TURN_TIMEOUT_MS,
    ToolDef, TurnMessage, UA_ANTHROPIC, UA_GOOGLE, UA_OLLAMA, UA_OPENAI, UA_PROBE, UA_XAI,
    XAI_TIMEOUT_MS, lock,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wire {
    Anthropic,
    Xai,
    Google,
    Vllm,
    Llama,
    Ollama,
}

pub struct HttpProvider {
    wire: Wire,
    id: String,
    name: String,
    model: Mutex<String>,
    base_url: Arc<Mutex<String>>,
    api_key: Arc<Mutex<Option<String>>>,
    tokens: Arc<Mutex<Option<Arc<TokenSource>>>>,
    client: reqwest::Client,
    ids: Arc<IdGen>,
    context: Mutex<u64>,
    context_pinned: Mutex<bool>,
    max_output: u64,
    temperature: Value,
    top_p: Value,
    probe_models: bool,
    model_pinned: bool,
    discovered: AtomicBool,
    reasoning_effort: Mutex<Option<String>>,
    web_search: bool,
    x_search: bool,
    code_execution: bool,
    provider_timeout_ms: u64,
    num_ctx: Mutex<u64>,
    extras: Mutex<Map<String, Value>>,
    api_prefix: Arc<Mutex<String>>,
    models_url: Arc<Mutex<Option<String>>>,
    pending_ids: Arc<Mutex<Option<Vec<String>>>>,
    catalog: Option<ModelCatalog>,
    warnings: Arc<Mutex<Vec<String>>>,
    verify_model: bool,
}

#[derive(Default)]
pub struct ManifestConfig {
    pub api_key: Option<String>,
    pub model: String,
    pub base_url: Option<String>,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub token_argv: Option<Vec<String>>,
    pub token_command: Option<TokenCommandInput>,
    pub token_runner: Option<crate::token::Runner>,
    pub token_ttl_ms: Option<i64>,
    pub token_timeout_ms: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub web_search: bool,
    pub x_search: bool,
    pub code_execution: bool,
    pub num_ctx: Option<u64>,
    pub probe_models: Option<bool>,
    pub env: HashMap<String, String>,
    pub api_prefix: Option<String>,
    pub models_url: Option<String>,
    pub models: Option<Vec<String>>,
    pub models_ttl_ms: Option<i64>,
    pub verify_model_on_init: bool,
}

impl HttpProvider {
    pub fn anthropic(
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        Self::open(
            Wire::Anthropic,
            Some(api_key.into()),
            model.into(),
            "https://api.anthropic.com".to_string(),
            None,
        )
    }

    pub fn xai(
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let model = model.into();
        let model = if model.is_empty() {
            "grok-4.20-reasoning".to_string()
        } else {
            model
        };
        Self::open(
            Wire::Xai,
            Some(api_key.into()),
            model,
            "https://api.x.ai/v1".to_string(),
            None,
        )
    }

    pub fn google(
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let model = model.into();
        let model = if model.is_empty() {
            "gemini-2.5-pro".to_string()
        } else {
            model
        };
        Self::open(
            Wire::Google,
            Some(api_key.into()),
            model,
            "https://generativelanguage.googleapis.com/v1beta".to_string(),
            None,
        )
    }

    pub fn vllm(
        api_key: Option<String>,
        model: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        Self::open(Wire::Vllm, api_key, model.into(), base_url.into(), None)
    }

    pub fn llama(
        api_key: Option<String>,
        model: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        Self::open(Wire::Llama, api_key, model.into(), base_url.into(), None)
    }

    pub fn ollama(
        model: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let model = model.into();
        let model = if model.is_empty() {
            "llama3.1".to_string()
        } else {
            model
        };
        Self::open(Wire::Ollama, None, model, base_url.into(), None)
    }

    pub fn from_manifest(wire: &str, config: ManifestConfig) -> Result<Self, ProviderError> {
        let kind = match wire {
            "anthropic" => Wire::Anthropic,
            "xai" => Wire::Xai,
            "google" => Wire::Google,
            "vllm" => Wire::Vllm,
            "llama-server" => Wire::Llama,
            "ollama" => Wire::Ollama,
            other => {
                return Err(ProviderError::new(
                    format!("unknown provider {other}"),
                    400,
                    other,
                ));
            }
        };
        if kind == Wire::Anthropic && config.model.is_empty() {
            return Err(ProviderError::new(
                "Model is required. Set config.model to a Claude model name (e.g. \"claude-opus-4-7\")",
                400,
                "anthropic",
            ));
        }
        let base = match kind {
            Wire::Anthropic => "https://api.anthropic.com".to_string(),
            Wire::Xai => "https://api.x.ai/v1".to_string(),
            Wire::Google => "https://generativelanguage.googleapis.com/v1beta".to_string(),
            Wire::Vllm | Wire::Llama | Wire::Ollama => config
                .base_url
                .clone()
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| default_base(kind).to_string()),
        };
        let model = if config.model.is_empty() {
            default_model(kind).to_string()
        } else {
            config.model.clone()
        };
        let mut register_warnings = Vec::new();
        let parsed = match &config.token_command {
            Some(raw) => parse_token_command_argv(Some(raw.clone())),
            None => match &config.token_argv {
                Some(argv) => parse_token_command_argv(Some(TokenCommandInput::Array(
                    argv.iter().cloned().map(TokenEntry::String).collect(),
                ))),
                None => ParsedArgv::Unset,
            },
        };
        let tokens = match parsed {
            ParsedArgv::Unset => None,
            ParsedArgv::Invalid(message) => {
                register_warnings.push(message.to_string());
                None
            }
            ParsedArgv::Argv(argv) => {
                match TokenSource::build(
                    argv,
                    config.token_ttl_ms,
                    config.token_timeout_ms,
                    None,
                    config.token_runner.clone(),
                    None,
                ) {
                    Ok(source) => Some(Arc::new(source)),
                    Err(err) => {
                        register_warnings.push(err.0);
                        None
                    }
                }
            }
        };
        let resolved = match &config.api_key {
            Some(key) => key.clone(),
            None => env_key(kind)
                .and_then(|name| config.env.get(name).cloned())
                .unwrap_or_default(),
        };
        if kind == Wire::Anthropic && resolved.is_empty() && tokens.is_none() {
            register_warnings.push(
                "No Anthropic API key found. Set ANTHROPIC_API_KEY or providers.anthropic.api_key"
                    .to_string(),
            );
        }
        let key = if resolved.is_empty() {
            None
        } else {
            Some(resolved)
        };
        let provider = Self::open(kind, key, model, base, tokens)?;
        if let Some(window) = config.context_window
            && window > 0
        {
            *lock(&provider.context) = window;
            *lock(&provider.context_pinned) = true;
        }
        if let Some(effort) = config.reasoning_effort {
            *lock(&provider.reasoning_effort) = Some(effort);
        }
        let max_output = config.max_output_tokens.unwrap_or(provider.max_output);
        let probe_models = config.probe_models.unwrap_or(true);
        let mut provider = Self {
            web_search: config.web_search,
            x_search: config.x_search,
            code_execution: config.code_execution,
            num_ctx: Mutex::new(config.num_ctx.unwrap_or(0)),
            probe_models,
            max_output,
            verify_model: config.verify_model_on_init,
            ..provider
        };
        *lock(provider.api_prefix.as_ref()) = if kind == Wire::Vllm {
            normalize_api_prefix(config.api_prefix.as_deref())
        } else {
            "/v1".to_string()
        };
        *lock(provider.models_url.as_ref()) =
            config.models_url.clone().filter(|url| !url.is_empty());
        if matches!(kind, Wire::Vllm | Wire::Llama) {
            let floor = if let Some(models) = config.models.clone() {
                models
            } else if provider.model_pinned {
                vec![provider.get_model()]
            } else {
                Vec::new()
            };
            let ttl = config.models_ttl_ms;
            provider.catalog = Some(provider.make_catalog(floor, ttl));
        }
        if kind == Wire::Vllm && !probe_models && !provider.model_pinned {
            register_warnings.push(format!(
                "[{}] probe_models is false and model is unset/default; the literal \"default\" will be sent as the model id. Set \"model\" in config.",
                provider.id
            ));
        }
        for message in register_warnings {
            provider.note(message);
        }
        provider.warm();
        Ok(provider)
    }

    fn open(
        wire: Wire,
        api_key: Option<String>,
        model: String,
        base_url: String,
        tokens: Option<Arc<TokenSource>>,
    ) -> Result<Self, ProviderError> {
        if wire == Wire::Anthropic && model.is_empty() {
            return Err(ProviderError::new(
                "Model is required. Set config.model to a Claude model name (e.g. \"claude-opus-4-7\")",
                400,
                "anthropic",
            ));
        }
        let model = if model.is_empty() {
            default_model(wire).to_string()
        } else {
            model
        };
        let client =
            build_client().map_err(|err| ProviderError::new(err.message, 0, id_of(wire)))?;
        let pinned = !model.is_empty() && model != "default";
        let mut provider = Self {
            wire,
            id: id_of(wire).to_string(),
            name: name_of(wire).to_string(),
            model: Mutex::new(model),
            base_url: Arc::new(Mutex::new(base_url)),
            api_key: Arc::new(Mutex::new(api_key.filter(|key| !key.is_empty()))),
            tokens: Arc::new(Mutex::new(tokens)),
            client,
            ids: Arc::new(IdGen::new()),
            context: Mutex::new(0),
            context_pinned: Mutex::new(false),
            max_output: default_max_output(wire),
            temperature: json_number("0.7"),
            top_p: json_number("0.95"),
            probe_models: true,
            model_pinned: pinned,
            discovered: AtomicBool::new(false),
            reasoning_effort: Mutex::new(None),
            web_search: false,
            x_search: false,
            code_execution: false,
            provider_timeout_ms: if wire == Wire::Xai {
                XAI_TIMEOUT_MS
            } else {
                TURN_TIMEOUT_MS
            },
            num_ctx: Mutex::new(0),
            extras: Mutex::new(Map::new()),
            api_prefix: Arc::new(Mutex::new("/v1".to_string())),
            models_url: Arc::new(Mutex::new(None)),
            pending_ids: Arc::new(Mutex::new(None)),
            catalog: None,
            warnings: Arc::new(Mutex::new(Vec::new())),
            verify_model: false,
        };
        if matches!(wire, Wire::Vllm | Wire::Llama) {
            let floor = if provider.model_pinned {
                vec![provider.get_model()]
            } else {
                Vec::new()
            };
            provider.catalog = Some(provider.make_catalog(floor, None));
        }
        Ok(provider)
    }

    pub fn base_url(&self) -> String {
        lock(self.base_url.as_ref()).clone()
    }

    pub fn api_key(&self) -> Option<String> {
        lock(self.api_key.as_ref()).clone()
    }

    pub fn warnings(&self) -> Vec<String> {
        lock(self.warnings.as_ref()).clone()
    }

    pub fn set_api_key(&self, key: Option<String>) {
        *lock(self.api_key.as_ref()) = key.filter(|key| !key.is_empty());
    }

    pub fn set_token_source(&self, source: Option<Arc<TokenSource>>) {
        *lock(self.tokens.as_ref()) = source;
    }

    pub fn set_probe_models(&mut self, probe: bool) {
        self.probe_models = probe;
        if self.wire == Wire::Vllm && !probe && !self.model_pinned {
            self.note(format!(
                "[{}] probe_models is false and model is unset/default; the literal \"default\" will be sent as the model id. Set \"model\" in config.",
                self.id
            ));
        }
    }

    pub fn set_api_prefix(&self, prefix: Option<&str>) {
        *lock(self.api_prefix.as_ref()) = normalize_api_prefix(prefix);
    }

    pub fn set_models_url(&self, url: Option<String>) {
        *lock(self.models_url.as_ref()) = url.filter(|item| !item.is_empty());
    }

    pub fn set_verify_model(&mut self, verify: bool) {
        self.verify_model = verify;
    }

    pub async fn unload_model(&self, model: Option<String>) -> Result<(), ProviderError> {
        if self.wire != Wire::Ollama {
            return Ok(());
        }
        let model = model.unwrap_or_else(|| self.get_model());
        let mut map = Map::new();
        map.insert("model".to_string(), Value::from(model));
        map.insert("messages".to_string(), Value::Array(Vec::new()));
        map.insert("keep_alive".to_string(), Value::from("0"));
        let body = serde_json::to_vec(&Value::Object(map))
            .map_err(|err| ProviderError::new(err.to_string(), 0, &self.id))?;
        let response = send(
            &self.client,
            &HttpAttempt {
                method: Method::POST,
                url: join_url(&self.root(), "api/chat"),
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: Some(body),
            },
            PROBE_TIMEOUT,
            &self.id,
        )
        .await?;
        let _ = read_limited(response.response, 2048).await;
        Ok(())
    }

    pub fn set_num_ctx(&self, num_ctx: u64) {
        *lock(&self.num_ctx) = num_ctx;
    }

    pub fn set_server_tools(&mut self, web: bool, x: bool, code: bool) {
        self.web_search = web;
        self.x_search = x;
        self.code_execution = code;
    }

    pub fn set_reasoning_effort(&self, effort: Option<String>) {
        *lock(&self.reasoning_effort) = effort;
    }

    pub fn set_extra(&self, key: impl Into<String>, value: Value) {
        lock(&self.extras).insert(key.into(), value);
    }

    fn token_source(&self) -> Option<Arc<TokenSource>> {
        lock(self.tokens.as_ref()).clone()
    }

    fn note(&self, message: String) {
        tracing::warn!(provider = %self.id, "{message}");
        lock(self.warnings.as_ref()).push(message);
    }

    fn warm(&self) {
        let Some(source) = self.token_source() else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let warnings = Arc::clone(&self.warnings);
        handle.spawn(async move {
            if let Err(err) = source.get_token().await {
                let message = TokenSource::warm_log(&err);
                tracing::warn!("{message}");
                lock(warnings.as_ref()).push(message);
            }
        });
    }

    fn make_catalog(&self, floor: Vec<String>, ttl_ms: Option<i64>) -> ModelCatalog {
        let shared = CatalogShared {
            pending: Arc::clone(&self.pending_ids),
            base_url: Arc::clone(&self.base_url),
            api_prefix: Arc::clone(&self.api_prefix),
            models_url: Arc::clone(&self.models_url),
            tokens: Arc::clone(&self.tokens),
            api_key: Arc::clone(&self.api_key),
            client: self.client.clone(),
            id: self.id.clone(),
            wire: self.wire,
        };
        let fetch: FetchIds = Arc::new(move || {
            let shared = shared.clone();
            Box::pin(async move { shared.fetch_ids().await })
        });
        let warnings = Arc::clone(&self.warnings);
        ModelCatalog::new(
            floor,
            fetch,
            ttl_ms,
            None,
            Some(Arc::new(now_ms)),
            Some(Arc::new(move |message| {
                tracing::warn!("{message}");
                lock(warnings.as_ref()).push(message);
            })),
            Some(self.id.clone()),
        )
    }

    fn dec_kind(&self) -> DecKind {
        match self.wire {
            Wire::Anthropic => DecKind::Anthropic,
            Wire::Xai => DecKind::Xai,
            Wire::Google => DecKind::Google,
            Wire::Vllm | Wire::Llama => DecKind::OpenAi,
            Wire::Ollama => DecKind::Ollama,
        }
    }

    fn chat_timeout(&self, requested: Duration) -> Duration {
        if self.wire == Wire::Xai {
            requested.min(Duration::from_millis(self.provider_timeout_ms))
        } else {
            requested
        }
    }

    async fn auth(
        &self,
        probe: bool,
    ) -> Result<Option<(String, String, Option<String>)>, ProviderError> {
        if self.wire == Wire::Ollama || (self.wire == Wire::Google && probe) {
            return Ok(None);
        }
        if let Some(source) = self.token_source() {
            let token = source
                .get_token()
                .await
                .map_err(|err| ProviderError::new(err.0, 0, &self.id))?;
            return Ok(Some(self.auth_header(&token, probe, true)));
        }
        let key = lock(self.api_key.as_ref()).clone();
        let Some(key) = key else {
            return Ok(None);
        };
        Ok(Some(self.auth_header(&key, probe, false)))
    }

    fn auth_header(
        &self,
        secret: &str,
        probe: bool,
        from_token: bool,
    ) -> (String, String, Option<String>) {
        let rejected = if from_token {
            Some(secret.to_string())
        } else {
            None
        };
        match self.wire {
            Wire::Anthropic => ("x-api-key".to_string(), secret.to_string(), rejected),
            Wire::Google => ("x-goog-api-key".to_string(), secret.to_string(), rejected),
            _ => {
                let name = if probe {
                    "Authorization"
                } else {
                    "authorization"
                };
                (name.to_string(), format!("Bearer {secret}"), rejected)
            }
        }
    }

    fn chat_headers(
        &self,
        request: &ChatRequest,
        auth: Option<(String, String, Option<String>)>,
    ) -> Vec<(String, String)> {
        let mut headers = vec![connection_header()];
        let ua = match self.wire {
            Wire::Anthropic => UA_ANTHROPIC,
            Wire::Xai => UA_XAI,
            Wire::Google => UA_GOOGLE,
            Wire::Vllm | Wire::Llama => UA_OPENAI,
            Wire::Ollama => UA_OLLAMA,
        };
        match self.wire {
            Wire::Anthropic => {
                headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
                headers.push(("content-type".to_string(), "application/json".to_string()));
                headers.push(("user-agent".to_string(), ua.to_string()));
                if let Some((name, value, _)) = auth {
                    headers.push((name, value));
                }
                headers.extend(tail_headers());
            }
            Wire::Xai => {
                if let Some((name, value, _)) = auth {
                    headers.push((name, value));
                }
                headers.push(("content-type".to_string(), "application/json".to_string()));
                headers.push(("user-agent".to_string(), ua.to_string()));
                if let Some(session) = &request.session_id {
                    headers.push(("x-grok-conv-id".to_string(), session.clone()));
                }
                headers.extend(tail_headers());
            }
            Wire::Google => {
                headers.push(("content-type".to_string(), "application/json".to_string()));
                headers.push(("user-agent".to_string(), ua.to_string()));
                if let Some((name, value, _)) = auth {
                    headers.push((name, value));
                }
                headers.extend(tail_headers());
            }
            Wire::Vllm | Wire::Llama => {
                if let Some((name, value, _)) = auth {
                    headers.push((name, value));
                }
                headers.push(("content-type".to_string(), "application/json".to_string()));
                headers.push(("user-agent".to_string(), ua.to_string()));
                headers.extend(tail_headers());
            }
            Wire::Ollama => {
                headers.push(("content-type".to_string(), "application/json".to_string()));
                headers.push(("user-agent".to_string(), ua.to_string()));
                headers.extend(tail_headers());
            }
        }
        headers
    }

    fn probe_headers(
        &self,
        auth: Option<(String, String, Option<String>)>,
    ) -> Vec<(String, String)> {
        let mut headers = vec![connection_header()];
        if self.wire == Wire::Anthropic {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
            if let Some((name, value, _)) = auth {
                headers.push((name, value));
            }
            headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
            headers.extend(probe_tail());
            return headers;
        }
        if let Some((name, value, _)) = auth {
            headers.push((name, value));
        }
        headers.extend(probe_tail());
        headers
    }

    fn root(&self) -> String {
        lock(self.base_url.as_ref())
            .trim_end_matches('/')
            .to_string()
    }

    fn stored_base(&self) -> String {
        lock(self.base_url.as_ref()).clone()
    }

    fn prefix(&self) -> String {
        lock(self.api_prefix.as_ref()).clone()
    }

    fn chat_url(&self, model: &str) -> String {
        match self.wire {
            Wire::Anthropic => join_url(&self.root(), "v1/messages"),
            Wire::Xai => join_url(&self.root(), "responses"),
            Wire::Google => format!(
                "{}/models/{}:streamGenerateContent?alt=sse",
                self.root(),
                encode_path_segment(model)
            ),
            Wire::Vllm => chat_completions_url(&self.stored_base(), &self.prefix()),
            Wire::Llama => chat_completions_url(&self.stored_base(), "/v1"),
            Wire::Ollama => join_url(&self.root(), "api/chat"),
        }
    }

    fn models_endpoint(&self) -> String {
        let override_url = lock(self.models_url.as_ref()).clone();
        match self.wire {
            Wire::Llama => models_probe_url(&self.stored_base(), "/v1", None),
            _ => models_probe_url(&self.stored_base(), &self.prefix(), override_url.as_deref()),
        }
    }

    async fn probe_target(&self) -> Result<ProbeTarget, ProviderError> {
        let model = self.get_model();
        match self.wire {
            Wire::Anthropic => {
                let body = obj(vec![
                    ("model", Value::from(model)),
                    ("max_tokens", Value::from(16u64)),
                    (
                        "messages",
                        Value::Array(vec![obj(vec![
                            ("role", Value::from("user")),
                            ("content", Value::from("ping")),
                        ])]),
                    ),
                    ("stream", Value::Bool(false)),
                ]);
                Ok(ProbeTarget {
                    method: Method::POST,
                    url: join_url(&self.root(), "v1/messages"),
                    body: Some(to_bytes(&body)?),
                    query_token: None,
                })
            }
            Wire::Xai => Ok(ProbeTarget {
                method: Method::GET,
                url: join_url(&self.root(), "models"),
                body: None,
                query_token: None,
            }),
            Wire::Google => {
                let key = self.probe_key().await?;
                let url = format!(
                    "{}/models/{}?key={}",
                    self.root(),
                    encode_path_segment(&model),
                    encode_query(&key)
                );
                Ok(ProbeTarget {
                    method: Method::GET,
                    url,
                    body: None,
                    query_token: if self.token_source().is_some() {
                        Some(key)
                    } else {
                        None
                    },
                })
            }
            Wire::Vllm | Wire::Llama => Ok(ProbeTarget {
                method: Method::GET,
                url: self.models_endpoint(),
                body: None,
                query_token: None,
            }),
            Wire::Ollama => Ok(ProbeTarget {
                method: Method::GET,
                url: join_url(&self.root(), "api/tags"),
                body: None,
                query_token: None,
            }),
        }
    }

    async fn probe_key(&self) -> Result<String, ProviderError> {
        if let Some(source) = self.token_source() {
            return source
                .get_token()
                .await
                .map_err(|err| ProviderError::new(err.0, 0, &self.id));
        }
        Ok(lock(self.api_key.as_ref()).clone().unwrap_or_default())
    }

    async fn exchange(
        &self,
        ExchangeCall {
            method,
            mut url,
            mut headers,
            body,
            timeout,
            retry,
            auth,
            query_token,
        }: ExchangeCall,
    ) -> Result<crate::http::RawResponse, ProviderError> {
        let mut attempts = 0u32;
        let mut reminted = false;
        let mut current_auth = auth;
        let mut query_token = query_token;
        let probe_auth = method == Method::GET && body.is_none();
        loop {
            let attempt = HttpAttempt {
                method: method.clone(),
                url: url.clone(),
                headers: headers.clone(),
                body: body.clone(),
            };
            let response = send(&self.client, &attempt, timeout, &self.id).await?;
            let status = response.status;
            if status == 401 && self.token_source().is_some() && !reminted {
                let rejected = current_auth
                    .as_ref()
                    .and_then(|(_, _, token)| token.clone())
                    .or_else(|| query_token.clone());
                if let Some(token) = rejected.as_deref()
                    && let Some(source) = self.token_source()
                {
                    source.invalidate(Some(token));
                }
                let _ = read_limited(response.response, 2048).await;
                reminted = true;
                if query_token.is_some() {
                    let next = self.probe_key().await?;
                    url = replace_query_key(&url, &next);
                    query_token = Some(next);
                }
                if let Some(next) = self.auth(probe_auth).await? {
                    replace_auth(&mut headers, &next);
                    current_auth = Some(next);
                }
                continue;
            }
            let probe = !retry;
            if self.wire == Wire::Anthropic && probe && status == 429 {
                return Ok(response);
            }
            if retry && matches!(status, 429 | 503 | 529) && attempts < 2 {
                attempts += 1;
                let _ = read_limited(response.response, 2048).await;
                continue;
            }
            if !(200..300).contains(&status) {
                let text = read_limited(response.response, 500).await;
                let message = if text.is_empty() {
                    format!("{} {status}", self.name)
                } else {
                    format!("{} {status}: {text}", self.name)
                };
                return Err(ProviderError::new(message, i64::from(status), &self.id));
            }
            return Ok(response);
        }
    }

    fn apply_discovery(&self, models: &[ListedModel]) {
        if models.is_empty() || self.discovered.swap(true, Ordering::Relaxed) {
            return;
        }
        if !self.model_pinned
            && let Some(picked) = models.first().map(|model| model.id.clone())
            && !picked.is_empty()
        {
            *lock(&self.model) = picked.clone();
            if self.wire == Wire::Vllm && models.len() > 1 {
                let others = models
                    .iter()
                    .skip(1)
                    .map(|model| model.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                self.note(format!(
                    "[{}] auto-selected model \"{picked}\" (also available: {others}). Set \"model\" in config to choose another.",
                    self.id
                ));
            } else {
                self.note(format!(
                    "[{}] auto-selected served model \"{picked}\".",
                    self.id
                ));
            }
        }
        if *lock(&self.context_pinned) {
            return;
        }
        let current = self.get_model();
        let chosen = models
            .iter()
            .find(|model| model.id == current)
            .or_else(|| models.first());
        if let Some(len) = chosen.and_then(|model| model.max_model_len) {
            *lock(&self.context) = len;
        }
    }

    async fn chat_inner(&self, request: ChatRequest) -> Result<ChatStream, ProviderError> {
        let model = request
            .model_override
            .clone()
            .unwrap_or_else(|| self.get_model());
        if self.wire == Wire::Anthropic && model.is_empty() {
            return Err(ProviderError::new(
                "Model is required. Set config.model to a Claude model name (e.g. \"claude-opus-4-7\")",
                400,
                "anthropic",
            ));
        }
        let mut body = chat_body(self, &request, &model);
        if self.wire == Wire::Vllm {
            splice_video_urls(&mut body);
        }
        let bytes = to_bytes(&body)?;
        let auth = self.auth(false).await?;
        let headers = self.chat_headers(&request, auth.clone());
        let timeout = self.chat_timeout(request.timeout);
        let response = self
            .exchange(ExchangeCall {
                method: Method::POST,
                url: self.chat_url(&model),
                headers,
                body: Some(bytes),
                timeout,
                retry: true,
                auth,
                query_token: None,
            })
            .await?;
        let deadline = Instant::now() + timeout;
        Ok(decode_response(
            response.response,
            Box::new(Decoder::new(self.dec_kind(), Arc::clone(&self.ids))),
            deadline,
            &self.id,
            timeout.as_millis() as u64,
        ))
    }

    async fn available_inner(&self) -> bool {
        if matches!(self.wire, Wire::Vllm | Wire::Llama) && !self.probe_models {
            return true;
        }
        let auth = match self.auth(true).await {
            Ok(auth) => auth,
            Err(err) => {
                tracing::warn!(provider = %self.id, error = %err.message, "probe auth failed");
                return false;
            }
        };
        let ProbeTarget {
            method,
            url,
            body,
            query_token,
        } = match self.probe_target().await {
            Ok(parts) => parts,
            Err(err) => {
                tracing::warn!(provider = %self.id, error = %err.message, "probe target failed");
                return false;
            }
        };
        let headers = self.probe_headers(auth.clone());
        match self
            .exchange(ExchangeCall {
                method,
                url: url.clone(),
                headers,
                body,
                timeout: PROBE_TIMEOUT,
                retry: false,
                auth,
                query_token,
            })
            .await
        {
            Ok(response) => {
                let status = response.status;
                if matches!(self.wire, Wire::Vllm | Wire::Llama) && (200..300).contains(&status) {
                    let text = read_limited(response.response, 1_000_000).await;
                    let models = parse_listed_models(&text);
                    let ids: Vec<String> = models.iter().map(|model| model.id.clone()).collect();
                    self.apply_discovery(&models);
                    *lock(self.pending_ids.as_ref()) = Some(ids.clone());
                    if let Some(catalog) = &self.catalog {
                        catalog.refresh();
                    }
                    if self.verify_model && self.model_pinned {
                        let model = self.get_model();
                        if !ids.iter().any(|id| id == &model) {
                            let served = if ids.is_empty() {
                                "none".to_string()
                            } else {
                                ids.join(", ")
                            };
                            let where_shown = if self.wire == Wire::Llama {
                                "/v1/models".to_string()
                            } else {
                                url
                            };
                            self.note(format!(
                                "[{}] configured model \"{model}\" not in {where_shown} (served: {served}).",
                                self.id
                            ));
                            return false;
                        }
                    }
                }
                if self.wire == Wire::Anthropic {
                    (200..300).contains(&status) || status == 429
                } else {
                    (200..300).contains(&status)
                }
            }
            Err(err) => {
                if matches!(self.wire, Wire::Vllm | Wire::Llama) {
                    if err.status == 0 {
                        let hint = if self.wire == Wire::Vllm {
                            "For local vLLM: vllm serve <model> --port <port>."
                        } else {
                            "For llama.cpp: llama-server -m <model.gguf> --port <port>."
                        };
                        self.note(format!(
                            "[{}] cannot reach {url} ({}). Is the server running? {hint}",
                            self.id, err.message
                        ));
                    } else {
                        let hint = if matches!(err.status, 401 | 403) {
                            if self.wire == Wire::Vllm {
                                " — set api_key (vLLM: pass --api-key and match it here)."
                            } else {
                                " — set api_key (llama-server: pass --api-key and match it here)."
                            }
                        } else {
                            ""
                        };
                        self.note(format!(
                            "[{}] {url} returned HTTP {}{hint}",
                            self.id, err.status
                        ));
                    }
                } else {
                    tracing::warn!(provider = %self.id, error = %err.message, "probe failed");
                }
                false
            }
        }
    }
}

impl Provider for HttpProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn get_model(&self) -> String {
        lock(&self.model).clone()
    }

    fn set_model(&self, model: String) {
        *lock(&self.model) = model;
    }

    fn set_base_url(&self, url: String) {
        *lock(self.base_url.as_ref()) = url;
    }

    fn context_window(&self) -> u64 {
        *lock(&self.context)
    }

    fn max_output_tokens(&self) -> u64 {
        self.max_output
    }

    fn stream_chat<'a>(
        &'a self,
        request: ChatRequest,
    ) -> BoxFuture<'a, Result<ChatStream, ProviderError>> {
        Box::pin(self.chat_inner(request))
    }

    fn is_available<'a>(&'a self) -> BoxFuture<'a, bool> {
        Box::pin(self.available_inner())
    }

    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, ProviderError>> {
        if let Some(catalog) = &self.catalog {
            let models = catalog.refresh();
            Box::pin(async move { Ok(models) })
        } else {
            let model = self.get_model();
            Box::pin(async move { Ok(vec![model]) })
        }
    }
}

fn id_of(wire: Wire) -> &'static str {
    match wire {
        Wire::Anthropic => "anthropic",
        Wire::Xai => "xai",
        Wire::Google => "google",
        Wire::Vllm => "vllm",
        Wire::Llama => "llama-server",
        Wire::Ollama => "ollama",
    }
}

fn name_of(wire: Wire) -> &'static str {
    match wire {
        Wire::Anthropic => "Anthropic Claude",
        Wire::Xai => "xAI Grok",
        Wire::Google => "Google Gemini",
        Wire::Vllm => "vLLM",
        Wire::Llama => "llama.cpp server",
        Wire::Ollama => "Ollama",
    }
}

fn default_base(wire: Wire) -> &'static str {
    match wire {
        Wire::Anthropic => "https://api.anthropic.com",
        Wire::Xai => "https://api.x.ai/v1",
        Wire::Google => "https://generativelanguage.googleapis.com/v1beta",
        Wire::Vllm => "http://127.0.0.1:8000",
        Wire::Llama => "http://127.0.0.1:8080",
        Wire::Ollama => "http://localhost:11434",
    }
}

struct ExchangeCall {
    method: Method,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    timeout: Duration,
    retry: bool,
    auth: Option<(String, String, Option<String>)>,
    query_token: Option<String>,
}

struct ProbeTarget {
    method: Method,
    url: String,
    body: Option<Vec<u8>>,
    query_token: Option<String>,
}

struct ListedModel {
    id: String,
    max_model_len: Option<u64>,
}

#[derive(Clone)]
struct CatalogShared {
    pending: Arc<Mutex<Option<Vec<String>>>>,
    base_url: Arc<Mutex<String>>,
    api_prefix: Arc<Mutex<String>>,
    models_url: Arc<Mutex<Option<String>>>,
    tokens: Arc<Mutex<Option<Arc<TokenSource>>>>,
    api_key: Arc<Mutex<Option<String>>>,
    client: reqwest::Client,
    id: String,
    wire: Wire,
}

impl CatalogShared {
    async fn fetch_ids(&self) -> Result<Vec<String>, String> {
        if let Some(ids) = lock(self.pending.as_ref()).take() {
            return Ok(ids);
        }
        let base = lock(self.base_url.as_ref()).clone();
        let prefix = lock(self.api_prefix.as_ref()).clone();
        let override_url = lock(self.models_url.as_ref()).clone();
        let url = if self.wire == Wire::Llama {
            models_probe_url(&base, "/v1", None)
        } else {
            models_probe_url(&base, &prefix, override_url.as_deref())
        };
        let (header, sent) = self.auth_header().await?;
        let mut response = self.get(&url, header.as_ref()).await?;
        if response.status == 401 && sent.is_some() {
            if let Some(source) = lock(self.tokens.as_ref()).clone() {
                source.invalidate(sent.as_deref());
            }
            let _ = read_limited(response.response, 2048).await;
            let (header, _) = self.auth_header().await?;
            response = self.get(&url, header.as_ref()).await?;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!("HTTP {}", response.status));
        }
        let text = read_limited(response.response, 1_000_000).await;
        Ok(parse_listed_models(&text)
            .into_iter()
            .map(|model| model.id)
            .collect())
    }

    async fn auth_header(&self) -> Result<(Option<(String, String)>, Option<String>), String> {
        let source = lock(self.tokens.as_ref()).clone();
        if let Some(source) = source {
            let token = source.get_token().await.map_err(|err| err.0)?;
            return Ok((
                Some(("Authorization".to_string(), format!("Bearer {token}"))),
                Some(token),
            ));
        }
        let key = lock(self.api_key.as_ref()).clone();
        if let Some(key) = key {
            return Ok((
                Some(("Authorization".to_string(), format!("Bearer {key}"))),
                None,
            ));
        }
        Ok((None, None))
    }

    async fn get(
        &self,
        url: &str,
        auth: Option<&(String, String)>,
    ) -> Result<crate::http::RawResponse, String> {
        let mut headers = vec![connection_header()];
        if let Some((name, value)) = auth {
            headers.push((name.clone(), value.clone()));
        }
        headers.extend(probe_tail());
        send(
            &self.client,
            &HttpAttempt {
                method: Method::GET,
                url: url.to_string(),
                headers,
                body: None,
            },
            Duration::from_millis(crate::catalog::DEFAULT_CATALOG_TIMEOUT_MS),
            &self.id,
        )
        .await
        .map_err(|err| err.message)
    }
}

fn env_key(wire: Wire) -> Option<&'static str> {
    match wire {
        Wire::Anthropic => Some("ANTHROPIC_API_KEY"),
        Wire::Xai => Some("XAI_API_KEY"),
        Wire::Google => Some("GOOGLE_API_KEY"),
        Wire::Vllm => Some("VLLM_API_KEY"),
        Wire::Llama => Some("LLAMA_SERVER_API_KEY"),
        Wire::Ollama => None,
    }
}

pub fn process_env(keys: &[&str]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for key in keys {
        if let Ok(value) = std::env::var(key) {
            map.insert((*key).to_string(), value);
        }
    }
    map
}

pub fn normalize_api_prefix(api_prefix: Option<&str>) -> String {
    let Some(api_prefix) = api_prefix else {
        return "/v1".to_string();
    };
    let trimmed = api_prefix.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let with_leading = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    with_leading.trim_end_matches('/').to_string()
}

pub fn strip_openai_base(base_url: &str) -> String {
    let root = base_url.trim_end_matches('/');
    root.strip_suffix("/v1")
        .unwrap_or(root)
        .trim_end_matches('/')
        .to_string()
}

pub fn chat_completions_url(base_url: &str, api_prefix: &str) -> String {
    format!(
        "{}{api_prefix}/chat/completions",
        strip_openai_base(base_url)
    )
}

pub fn models_probe_url(base_url: &str, api_prefix: &str, models_url: Option<&str>) -> String {
    if let Some(url) = models_url.filter(|url| !url.is_empty()) {
        return url.to_string();
    }
    format!("{}{api_prefix}/models", strip_openai_base(base_url))
}

fn replace_query_key(url: &str, key: &str) -> String {
    let encoded = encode_query(key);
    if let Some(index) = url.find("?key=") {
        return format!("{}?key={encoded}", &url[..index]);
    }
    if let Some(index) = url.find("&key=") {
        return format!("{}&key={encoded}", &url[..index]);
    }
    url.to_string()
}

fn parse_listed_models(text: &str) -> Vec<ListedModel> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(data) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            if id.is_empty() {
                return None;
            }
            Some(ListedModel {
                id,
                max_model_len: json_len(item.get("max_model_len")),
            })
        })
        .collect()
}

fn json_len(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(number) = value.as_u64()
        && number > 0
    {
        return Some(number);
    }
    let number = value.as_f64()?;
    if number.is_finite() && number > 0.0 {
        Some(number as u64)
    } else {
        None
    }
}

fn default_model(wire: Wire) -> &'static str {
    match wire {
        Wire::Xai => "grok-4.20-reasoning",
        Wire::Google => "gemini-2.5-pro",
        Wire::Ollama => "llama3.1",
        _ => "default",
    }
}

fn default_max_output(wire: Wire) -> u64 {
    match wire {
        Wire::Vllm | Wire::Llama => 4096,
        _ => 0,
    }
}

fn probe_tail() -> Vec<(String, String)> {
    vec![
        ("accept".to_string(), "*/*".to_string()),
        ("accept-language".to_string(), "*".to_string()),
        ("sec-fetch-mode".to_string(), "cors".to_string()),
        ("user-agent".to_string(), UA_PROBE.to_string()),
        ("accept-encoding".to_string(), "gzip, deflate".to_string()),
    ]
}

fn replace_auth(headers: &mut Vec<(String, String)>, auth: &(String, String, Option<String>)) {
    if let Some(slot) = headers
        .iter_mut()
        .find(|(name, _)| name.eq_ignore_ascii_case(&auth.0))
    {
        slot.1.clone_from(&auth.1);
    } else {
        headers.insert(1, (auth.0.clone(), auth.1.clone()));
    }
}

fn to_bytes(value: &Value) -> Result<Vec<u8>, ProviderError> {
    serde_json::to_vec(value).map_err(|err| ProviderError::new(err.to_string(), 0, "providers"))
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    crate::jsonutil::obj(pairs)
}

fn chat_body(provider: &HttpProvider, request: &ChatRequest, model: &str) -> Value {
    match provider.wire {
        Wire::Anthropic => anthropic_body(request, model),
        Wire::Xai => xai_body(provider, request, model),
        Wire::Google => google_body(request, model),
        Wire::Vllm => openai_body(provider, request, model, true),
        Wire::Llama => openai_body(provider, request, model, false),
        Wire::Ollama => ollama_body(provider, request, model),
    }
}

fn anthropic_body(request: &ChatRequest, model: &str) -> Value {
    let mut map = Map::new();
    map.insert("model".to_string(), Value::from(model));
    map.insert(
        "max_tokens".to_string(),
        Value::from(anthropic_max_tokens(model, request.thinking)),
    );
    if request.thinking != ThinkingLevel::Off {
        if is_claude_4(model) {
            map.insert(
                "thinking".to_string(),
                obj(vec![("type", Value::from("adaptive"))]),
            );
            map.insert(
                "output_config".to_string(),
                obj(vec![(
                    "effort",
                    Value::from(thinking_name(request.thinking)),
                )]),
            );
        } else if let Some(budget) = anthropic_budget(request.thinking) {
            map.insert(
                "thinking".to_string(),
                obj(vec![
                    ("type", Value::from("enabled")),
                    ("budget_tokens", Value::from(budget)),
                ]),
            );
        }
    }
    map.insert(
        "cache_control".to_string(),
        obj(vec![("type", Value::from("ephemeral"))]),
    );
    if !request.system.is_empty() {
        map.insert(
            "system".to_string(),
            Value::Array(vec![obj(vec![
                ("type", Value::from("text")),
                ("text", Value::from(request.system.clone())),
            ])]),
        );
    }
    map.insert("messages".to_string(), anthropic_messages(request));
    if !request.tools.is_empty() {
        map.insert("tools".to_string(), anthropic_tools(&request.tools));
        map.insert(
            "tool_choice".to_string(),
            obj(vec![("type", Value::from("auto"))]),
        );
    }
    map.insert("stream".to_string(), Value::Bool(true));
    Value::Object(map)
}

fn anthropic_max_tokens(model: &str, level: ThinkingLevel) -> u64 {
    if is_claude_4(model) {
        4096
    } else {
        4096 + anthropic_budget(level).unwrap_or(0)
    }
}

fn anthropic_budget(level: ThinkingLevel) -> Option<u64> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Low => Some(2000),
        ThinkingLevel::Medium => Some(10_000),
        ThinkingLevel::High | ThinkingLevel::XHigh => Some(50_000),
    }
}

fn anthropic_messages(request: &ChatRequest) -> Value {
    let mut out = Vec::new();
    let mut pending_results: Vec<&TurnMessage> = Vec::new();
    let flush = |out: &mut Vec<Value>, pending: &mut Vec<&TurnMessage>| {
        if pending.is_empty() {
            return;
        }
        let mut blocks = Vec::new();
        for message in pending.drain(..) {
            if let TurnMessage::ToolResult { id, content, .. } = message {
                blocks.push(obj(vec![
                    ("type", Value::from("tool_result")),
                    ("tool_use_id", Value::from(id.clone())),
                    ("content", Value::from(content.clone())),
                ]));
            }
        }
        out.push(obj(vec![
            ("role", Value::from("user")),
            ("content", Value::Array(blocks)),
        ]));
    };
    for message in &request.messages {
        match message {
            TurnMessage::System { text } | TurnMessage::User { text } => {
                flush(&mut out, &mut pending_results);
                out.push(obj(vec![
                    ("role", Value::from("user")),
                    (
                        "content",
                        Value::Array(vec![obj(vec![
                            ("type", Value::from("text")),
                            ("text", Value::from(text.clone())),
                        ])]),
                    ),
                ]));
            }
            TurnMessage::Assistant {
                text,
                reasoning,
                anthropic_signature,
                tool_calls,
                ..
            } => {
                flush(&mut out, &mut pending_results);
                let mut blocks = Vec::new();
                if !reasoning.is_empty() || anthropic_signature.is_some() {
                    let mut block = Map::new();
                    block.insert("type".to_string(), Value::from("thinking"));
                    block.insert("thinking".to_string(), Value::from(reasoning.clone()));
                    if let Some(signature) = anthropic_signature {
                        block.insert("signature".to_string(), Value::from(signature.clone()));
                    }
                    blocks.push(Value::Object(block));
                }
                if !text.is_empty() {
                    blocks.push(obj(vec![
                        ("type", Value::from("text")),
                        ("text", Value::from(text.clone())),
                    ]));
                }
                for tool in tool_calls {
                    blocks.push(obj(vec![
                        ("type", Value::from("tool_use")),
                        ("id", Value::from(tool.id.clone())),
                        ("name", Value::from(tool.name.clone())),
                        ("input", tool.arguments.clone()),
                    ]));
                }
                out.push(obj(vec![
                    ("role", Value::from("assistant")),
                    ("content", Value::Array(blocks)),
                ]));
            }
            TurnMessage::ToolResult { .. } => pending_results.push(message),
        }
    }
    flush(&mut out, &mut pending_results);
    Value::Array(out)
}

fn anthropic_tools(tools: &[ToolDef]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                obj(vec![
                    ("name", Value::from(tool.name.clone())),
                    ("description", Value::from(tool.description.clone())),
                    ("input_schema", tool.parameters.clone()),
                    ("eager_input_streaming", Value::Bool(true)),
                ])
            })
            .collect(),
    )
}

fn xai_body(provider: &HttpProvider, request: &ChatRequest, model: &str) -> Value {
    let mut map = Map::new();
    map.insert("model".to_string(), Value::from(model));
    if request.contains_images {
        map.insert("store".to_string(), Value::Bool(false));
    }
    map.insert("input".to_string(), xai_input(request));
    if !request.tools.is_empty()
        || provider.web_search
        || provider.x_search
        || provider.code_execution
    {
        map.insert("tools".to_string(), xai_tools(provider, &request.tools));
        map.insert("tool_choice".to_string(), Value::from("auto"));
    }
    let configured = lock(&provider.reasoning_effort);
    if let Some(effort) =
        map_xai_reasoning_effort(model, Some(request.thinking), configured.as_deref())
    {
        map.insert(
            "reasoning".to_string(),
            obj(vec![("effort", Value::from(effort))]),
        );
    }
    map.insert("stream".to_string(), Value::Bool(true));
    Value::Object(map)
}

fn xai_input(request: &ChatRequest) -> Value {
    let mut input = Vec::new();
    if !request.system.is_empty() {
        input.push(obj(vec![
            ("role", Value::from("system")),
            ("content", Value::from(request.system.clone())),
        ]));
    }
    for message in &request.messages {
        match message {
            TurnMessage::System { text } | TurnMessage::User { text } => {
                input.push(obj(vec![
                    ("role", Value::from("user")),
                    (
                        "content",
                        Value::Array(vec![obj(vec![
                            ("type", Value::from("input_text")),
                            ("text", Value::from(text.clone())),
                        ])]),
                    ),
                ]));
            }
            TurnMessage::Assistant {
                text,
                reasoning,
                xai_reasoning_id,
                tool_calls,
                ..
            } => {
                if let Some(id) = xai_reasoning_id
                    && !reasoning.is_empty()
                {
                    input.push(obj(vec![
                        ("type", Value::from("reasoning")),
                        ("id", Value::from(id.clone())),
                        (
                            "summary",
                            Value::Array(vec![obj(vec![
                                ("type", Value::from("summary_text")),
                                ("text", Value::from(reasoning.clone())),
                            ])]),
                        ),
                        ("status", Value::from("completed")),
                    ]));
                }
                if !text.is_empty() && tool_calls.is_empty() {
                    input.push(obj(vec![
                        ("role", Value::from("assistant")),
                        (
                            "content",
                            Value::Array(vec![obj(vec![
                                ("type", Value::from("output_text")),
                                ("text", Value::from(text.clone())),
                            ])]),
                        ),
                    ]));
                }
                for tool in tool_calls {
                    input.push(obj(vec![
                        ("type", Value::from("function_call")),
                        ("id", Value::from(tool.id.clone())),
                        ("call_id", Value::from(tool.id.clone())),
                        ("name", Value::from(tool.name.clone())),
                        ("arguments", Value::from(tool.arguments_json.clone())),
                        ("status", Value::from("completed")),
                    ]));
                }
            }
            TurnMessage::ToolResult { id, content, .. } => {
                input.push(obj(vec![
                    ("type", Value::from("function_call_output")),
                    ("call_id", Value::from(id.clone())),
                    ("output", Value::from(content.clone())),
                ]));
            }
        }
    }
    Value::Array(input)
}

fn xai_tools(provider: &HttpProvider, tools: &[ToolDef]) -> Value {
    let mut out: Vec<Value> = tools
        .iter()
        .map(|tool| {
            obj(vec![
                ("type", Value::from("function")),
                ("name", Value::from(tool.name.clone())),
                ("description", Value::from(tool.description.clone())),
                ("parameters", tool.parameters.clone()),
            ])
        })
        .collect();
    if provider.web_search {
        out.push(obj(vec![("type", Value::from("web_search"))]));
    }
    if provider.x_search {
        out.push(obj(vec![("type", Value::from("x_search"))]));
    }
    if provider.code_execution {
        out.push(obj(vec![("type", Value::from("code_interpreter"))]));
    }
    Value::Array(out)
}

fn google_body(request: &ChatRequest, _model: &str) -> Value {
    let mut map = Map::new();
    map.insert(
        "generationConfig".to_string(),
        google_generation(request.thinking),
    );
    map.insert("contents".to_string(), google_contents(request));
    if !request.system.is_empty() {
        map.insert(
            "systemInstruction".to_string(),
            obj(vec![(
                "parts",
                Value::Array(vec![obj(vec![(
                    "text",
                    Value::from(request.system.clone()),
                )])]),
            )]),
        );
    }
    if !request.tools.is_empty() {
        map.insert(
            "tools".to_string(),
            Value::Array(vec![obj(vec![(
                "functionDeclarations",
                Value::Array(
                    request
                        .tools
                        .iter()
                        .map(|tool| {
                            obj(vec![
                                ("name", Value::from(tool.name.clone())),
                                ("description", Value::from(tool.description.clone())),
                                ("parameters", gemini_schema(&tool.parameters)),
                            ])
                        })
                        .collect(),
                ),
            )])]),
        );
        map.insert(
            "toolConfig".to_string(),
            obj(vec![(
                "functionCallingConfig",
                obj(vec![("mode", Value::from("AUTO"))]),
            )]),
        );
    }
    Value::Object(map)
}

fn google_generation(level: ThinkingLevel) -> Value {
    let Some(budget) = google_budget(level) else {
        return Value::Object(Map::new());
    };
    obj(vec![(
        "thinkingConfig",
        obj(vec![
            ("thinkingBudget", Value::from(budget)),
            ("includeThoughts", Value::Bool(true)),
        ]),
    )])
}

fn google_budget(level: ThinkingLevel) -> Option<u64> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Low => Some(1024),
        ThinkingLevel::Medium => Some(8192),
        ThinkingLevel::High | ThinkingLevel::XHigh => Some(32768),
    }
}

fn google_contents(request: &ChatRequest) -> Value {
    let mut out = Vec::new();
    let mut pending: Vec<&TurnMessage> = Vec::new();
    let flush = |out: &mut Vec<Value>, pending: &mut Vec<&TurnMessage>| {
        if pending.is_empty() {
            return;
        }
        let mut parts = Vec::new();
        for message in pending.drain(..) {
            if let TurnMessage::ToolResult { id, name, content } = message {
                parts.push(obj(vec![(
                    "functionResponse",
                    obj(vec![
                        ("id", Value::from(id.clone())),
                        ("name", Value::from(name.clone())),
                        (
                            "response",
                            obj(vec![
                                ("name", Value::from(name.clone())),
                                ("content", Value::from(content.clone())),
                            ]),
                        ),
                    ]),
                )]));
            }
        }
        out.push(obj(vec![
            ("role", Value::from("user")),
            ("parts", Value::Array(parts)),
        ]));
    };
    for message in &request.messages {
        match message {
            TurnMessage::System { text } | TurnMessage::User { text } => {
                flush(&mut out, &mut pending);
                out.push(obj(vec![
                    ("role", Value::from("user")),
                    (
                        "parts",
                        Value::Array(vec![obj(vec![("text", Value::from(text.clone()))])]),
                    ),
                ]));
            }
            TurnMessage::Assistant {
                text,
                reasoning,
                tool_calls,
                ..
            } => {
                flush(&mut out, &mut pending);
                let mut parts = Vec::new();
                if !reasoning.is_empty() {
                    let mut part = Map::new();
                    part.insert("text".to_string(), Value::from(reasoning.clone()));
                    part.insert("thought".to_string(), Value::Bool(true));
                    parts.push(Value::Object(part));
                }
                if tool_calls.is_empty() && !text.is_empty() {
                    parts.push(obj(vec![("text", Value::from(text.clone()))]));
                }
                for tool in tool_calls {
                    parts.push(google_function_part(tool));
                }
                out.push(obj(vec![
                    ("role", Value::from("model")),
                    ("parts", Value::Array(parts)),
                ]));
            }
            TurnMessage::ToolResult { .. } => pending.push(message),
        }
    }
    flush(&mut out, &mut pending);
    Value::Array(out)
}

fn google_function_part(tool: &ReplayTool) -> Value {
    let mut part = Map::new();
    part.insert(
        "functionCall".to_string(),
        obj(vec![
            ("id", Value::from(tool.id.clone())),
            ("name", Value::from(tool.name.clone())),
            ("args", tool.arguments.clone()),
        ]),
    );
    if let Some(signature) = &tool.thought_signature {
        part.insert(
            "thoughtSignature".to_string(),
            Value::from(signature.clone()),
        );
    }
    Value::Object(part)
}

fn openai_body(provider: &HttpProvider, request: &ChatRequest, model: &str, vllm: bool) -> Value {
    let mut map = Map::new();
    map.insert("model".to_string(), Value::from(model));
    map.insert("max_tokens".to_string(), Value::from(4096u64));
    map.insert("temperature".to_string(), provider.temperature.clone());
    map.insert("top_p".to_string(), provider.top_p.clone());
    map.insert("messages".to_string(), openai_messages(request, true, true));
    if !request.tools.is_empty() {
        map.insert("tools".to_string(), openai_tools(&request.tools));
        map.insert("tool_choice".to_string(), Value::from("auto"));
    }
    map.insert("stream".to_string(), Value::Bool(true));
    map.insert(
        "stream_options".to_string(),
        obj(vec![("include_usage", Value::Bool(true))]),
    );
    for (key, value) in lock(&provider.extras).iter() {
        map.insert(key.clone(), value.clone());
    }
    if vllm && request.thinking == ThinkingLevel::Off {
        map.insert(
            "chat_template_kwargs".to_string(),
            obj(vec![("enable_thinking", Value::Bool(false))]),
        );
    }
    Value::Object(map)
}

fn ollama_body(provider: &HttpProvider, request: &ChatRequest, model: &str) -> Value {
    let mut map = Map::new();
    map.insert("model".to_string(), Value::from(model));
    map.insert(
        "messages".to_string(),
        openai_messages(request, false, false),
    );
    map.insert(
        "think".to_string(),
        Value::Bool(request.thinking != ThinkingLevel::Off),
    );
    if !request.tools.is_empty() {
        map.insert("tools".to_string(), openai_tools(&request.tools));
        map.insert("tool_choice".to_string(), Value::from("auto"));
    }
    map.insert("stream".to_string(), Value::Bool(true));
    let num_ctx = *lock(&provider.num_ctx);
    if num_ctx > 0 {
        map.insert(
            "options".to_string(),
            obj(vec![("num_ctx", Value::from(num_ctx))]),
        );
    }
    Value::Object(map)
}

fn openai_tools(tools: &[ToolDef]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                obj(vec![
                    ("type", Value::from("function")),
                    (
                        "function",
                        obj(vec![
                            ("name", Value::from(tool.name.clone())),
                            ("description", Value::from(tool.description.clone())),
                            ("parameters", tool.parameters.clone()),
                        ]),
                    ),
                ])
            })
            .collect(),
    )
}

fn openai_messages(request: &ChatRequest, reasoning_field: bool, fold: bool) -> Value {
    let (system, messages) = folded_request(request, fold);
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(obj(vec![
            ("role", Value::from("system")),
            ("content", Value::from(system)),
        ]));
    }
    for message in &messages {
        match message {
            TurnMessage::System { text } | TurnMessage::User { text } => {
                out.push(obj(vec![
                    ("role", Value::from("user")),
                    ("content", Value::from(text.clone())),
                ]));
            }
            TurnMessage::Assistant {
                text,
                reasoning,
                tool_calls,
                ..
            } => {
                let mut map = Map::new();
                map.insert("role".to_string(), Value::from("assistant"));
                if tool_calls.is_empty() {
                    map.insert("content".to_string(), Value::from(text.clone()));
                } else if reasoning_field {
                    map.insert("content".to_string(), Value::Null);
                } else {
                    map.insert("content".to_string(), Value::from(text.clone()));
                }
                if reasoning_field && !reasoning.is_empty() {
                    map.insert(
                        "reasoning_content".to_string(),
                        Value::from(reasoning.clone()),
                    );
                }
                if !reasoning_field && !reasoning.is_empty() {
                    map.insert("thinking".to_string(), Value::from(reasoning.clone()));
                }
                if !tool_calls.is_empty() {
                    map.insert(
                        "tool_calls".to_string(),
                        Value::Array(
                            tool_calls
                                .iter()
                                .map(|tool| {
                                    let arguments = if reasoning_field {
                                        Value::from(tool.arguments_json.clone())
                                    } else {
                                        tool.arguments.clone()
                                    };
                                    obj(vec![
                                        ("id", Value::from(tool.id.clone())),
                                        ("type", Value::from("function")),
                                        (
                                            "function",
                                            obj(vec![
                                                ("name", Value::from(tool.name.clone())),
                                                ("arguments", arguments),
                                            ]),
                                        ),
                                    ])
                                })
                                .collect(),
                        ),
                    );
                }
                out.push(Value::Object(map));
            }
            TurnMessage::ToolResult { id, content, .. } => {
                out.push(obj(vec![
                    ("role", Value::from("tool")),
                    ("tool_call_id", Value::from(id.clone())),
                    ("content", Value::from(content.clone())),
                ]));
            }
        }
    }
    Value::Array(out)
}

fn folded_request(request: &ChatRequest, fold: bool) -> (String, Vec<TurnMessage>) {
    if !fold {
        return (request.system.clone(), request.messages.clone());
    }
    let mut input = Vec::new();
    if !request.system.is_empty() {
        input.push(FoldMessage {
            role: "system".to_string(),
            content: FoldContent::Text(request.system.clone()),
            data: None,
        });
    }
    for message in &request.messages {
        match message {
            TurnMessage::System { text } => input.push(FoldMessage {
                role: "system".to_string(),
                content: FoldContent::Text(text.clone()),
                data: None,
            }),
            other => input.push(FoldMessage {
                role: "keep".to_string(),
                content: FoldContent::Text(String::new()),
                data: Some(other.clone()),
            }),
        }
    }
    let (system, rest) = split_and_fold_system(&input);
    let messages = rest
        .into_iter()
        .map(|item| match item.data {
            Some(message) => message,
            None => match item.content {
                FoldContent::Text(text) => TurnMessage::User { text },
                FoldContent::Parts(parts) => TurnMessage::User {
                    text: parts.concat(),
                },
            },
        })
        .collect();
    (system, messages)
}
