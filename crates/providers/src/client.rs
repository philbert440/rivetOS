use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::ThinkingLevel;
use reqwest::Method;
use serde_json::{Map, Value};

use crate::decode::{Decoder, Kind as DecKind};
use crate::error::ProviderError;
use crate::http::{
    HttpAttempt, build_client, connection_header, decode_response, read_limited, send, tail_headers,
};
use crate::jsonutil::{
    IdGen, encode_path_segment, encode_query, gemini_schema, is_claude_4, join_url, json_number,
    map_xai_reasoning_effort, splice_video_urls, thinking_name,
};
use crate::token::TokenSource;
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
    base_url: Mutex<String>,
    api_key: Mutex<Option<String>>,
    tokens: Option<Arc<TokenSource>>,
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
}

pub struct ManifestConfig {
    pub api_key: Option<String>,
    pub model: String,
    pub base_url: Option<String>,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub token_argv: Option<Vec<String>>,
    pub reasoning_effort: Option<String>,
    pub web_search: bool,
    pub x_search: bool,
    pub code_execution: bool,
    pub num_ctx: Option<u64>,
    pub probe_models: Option<bool>,
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
        let tokens = match config.token_argv {
            Some(argv) if !argv.is_empty() => {
                Some(Arc::new(TokenSource::new(argv).map_err(|err| {
                    ProviderError::new(err.0, 400, id_of(kind))
                })?))
            }
            _ => None,
        };
        let provider = Self::open(kind, config.api_key, model, base, tokens)?;
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
        let provider = Self {
            web_search: config.web_search,
            x_search: config.x_search,
            code_execution: config.code_execution,
            num_ctx: Mutex::new(config.num_ctx.unwrap_or(0)),
            probe_models: config.probe_models.unwrap_or(true),
            max_output,
            ..provider
        };
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
        Ok(Self {
            wire,
            id: id_of(wire).to_string(),
            name: name_of(wire).to_string(),
            model: Mutex::new(model),
            base_url: Mutex::new(base_url),
            api_key: Mutex::new(api_key.filter(|key| !key.is_empty())),
            tokens,
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
        })
    }

    pub fn base_url(&self) -> String {
        lock(&self.base_url).clone()
    }

    pub fn set_api_key(&self, key: Option<String>) {
        *lock(&self.api_key) = key.filter(|key| !key.is_empty());
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
        if let Some(source) = &self.tokens {
            let token = source
                .get_token()
                .await
                .map_err(|err| ProviderError::new(err.0, 0, &self.id))?;
            return Ok(Some(self.auth_header(&token, probe, true)));
        }
        let key = lock(&self.api_key).clone();
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
        lock(&self.base_url).trim_end_matches('/').to_string()
    }

    fn openai_root(&self) -> String {
        let root = self.root();
        root.strip_suffix("/v1")
            .unwrap_or(&root)
            .trim_end_matches('/')
            .to_string()
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
            Wire::Vllm | Wire::Llama => join_url(&self.openai_root(), "v1/chat/completions"),
            Wire::Ollama => join_url(&self.root(), "api/chat"),
        }
    }

    async fn probe_target(&self) -> Result<(Method, String, Option<Vec<u8>>), ProviderError> {
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
                Ok((
                    Method::POST,
                    join_url(&self.root(), "v1/messages"),
                    Some(to_bytes(&body)?),
                ))
            }
            Wire::Xai => Ok((Method::GET, join_url(&self.root(), "models"), None)),
            Wire::Google => {
                let key = self.probe_key().await?;
                let url = format!(
                    "{}/models/{}?key={}",
                    self.root(),
                    encode_path_segment(&model),
                    encode_query(&key)
                );
                Ok((Method::GET, url, None))
            }
            Wire::Vllm | Wire::Llama => Ok((
                Method::GET,
                join_url(&self.openai_root(), "v1/models"),
                None,
            )),
            Wire::Ollama => Ok((Method::GET, join_url(&self.root(), "api/tags"), None)),
        }
    }

    async fn probe_key(&self) -> Result<String, ProviderError> {
        if let Some(source) = &self.tokens {
            return source
                .get_token()
                .await
                .map_err(|err| ProviderError::new(err.0, 0, &self.id));
        }
        Ok(lock(&self.api_key).clone().unwrap_or_default())
    }

    async fn exchange(
        &self,
        ExchangeCall {
            method,
            url,
            mut headers,
            body,
            timeout,
            retry,
            auth,
        }: ExchangeCall,
    ) -> Result<crate::http::RawResponse, ProviderError> {
        let mut attempts = 0u32;
        let mut reminted = false;
        let mut current_auth = auth;
        loop {
            let attempt = HttpAttempt {
                method: method.clone(),
                url: url.clone(),
                headers: headers.clone(),
                body: body.clone(),
            };
            let response = send(&self.client, &attempt, timeout, &self.id).await?;
            let status = response.status;
            if status == 401 && self.tokens.is_some() && !reminted {
                if let Some((_, _, Some(token))) = &current_auth
                    && let Some(source) = &self.tokens
                {
                    source.invalidate(Some(token));
                }
                let _ = read_limited(response.response, 2048).await;
                reminted = true;
                if let Some(next) = self.auth(method == Method::GET && body.is_none()).await? {
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

    fn adopt_listing(&self, text: &str) {
        if self.discovered.swap(true, Ordering::Relaxed) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let Some(data) = value.get("data").and_then(Value::as_array) else {
            return;
        };
        let model = self.get_model();
        let chosen = if self.model_pinned {
            data.iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(model.as_str()))
        } else {
            data.first()
        };
        let Some(chosen) = chosen else {
            return;
        };
        if !self.model_pinned
            && let Some(id) = chosen.get("id").and_then(Value::as_str)
            && !id.is_empty()
        {
            *lock(&self.model) = id.to_string();
        }
        if *lock(&self.context_pinned) {
            return;
        }
        if let Some(len) = chosen.get("max_model_len").and_then(Value::as_u64) {
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
        let (method, url, body) = match self.probe_target().await {
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
                url,
                headers,
                body,
                timeout: PROBE_TIMEOUT,
                retry: false,
                auth,
            })
            .await
        {
            Ok(response) => {
                let status = response.status;
                if matches!(self.wire, Wire::Vllm | Wire::Llama) && (200..300).contains(&status) {
                    let text = read_limited(response.response, 1_000_000).await;
                    self.adopt_listing(&text);
                }
                if self.wire == Wire::Anthropic {
                    (200..300).contains(&status) || status == 429
                } else {
                    (200..300).contains(&status)
                }
            }
            Err(err) => {
                tracing::warn!(provider = %self.id, error = %err.message, "probe failed");
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
        *lock(&self.base_url) = url;
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
            TurnMessage::User { text } => {
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
            TurnMessage::User { text } => {
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
            TurnMessage::User { text } => {
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
    map.insert("messages".to_string(), openai_messages(request, true));
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
    map.insert("messages".to_string(), openai_messages(request, false));
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

fn openai_messages(request: &ChatRequest, reasoning_field: bool) -> Value {
    let mut out = Vec::new();
    if !request.system.is_empty() {
        out.push(obj(vec![
            ("role", Value::from("system")),
            ("content", Value::from(request.system.clone())),
        ]));
    }
    for message in &request.messages {
        match message {
            TurnMessage::User { text } => {
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
