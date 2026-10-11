use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};

use parking_lot::Mutex;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use protocol::JsNumber;
use protocol::events::InboundMessage;
use protocol::js::{JsObject, JsString, JsValue, stringify};

use crate::error::MeshError;
use crate::model::{
    JoinNodeError, JoinedMeshNode, MeshNode, fill_random, mesh_node_from_join, mesh_nodes_json,
    timestamp_millis, timestamp_ms,
};
use crate::tls::{TlsMaterial, client_config, server_config};

const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);

pub type MessageFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type MessageHandler = Arc<dyn Fn(InboundMessage) -> MessageFuture + Send + Sync>;
pub type MeshNodesFuture = Pin<Box<dyn Future<Output = Result<Vec<MeshNode>, String>> + Send>>;
pub type MeshNodesFn = Arc<dyn Fn() -> MeshNodesFuture + Send + Sync>;
pub type MeshJoinFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type MeshJoinFn = Arc<dyn Fn(JoinedMeshNode) -> MeshJoinFuture + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerConfig {
    pub url: String,
    pub secret: Option<String>,
}

#[derive(Clone)]
pub struct AgentChannelConfig {
    pub agent_id: String,
    pub port: u16,
    pub host: String,
    pub secret: Option<String>,
    pub peers: Vec<(String, PeerConfig)>,
    pub tls: Option<TlsMaterial>,
    pub tls_rejected: Option<String>,
    pub get_mesh_nodes: Option<MeshNodesFn>,
    pub on_mesh_join: Option<MeshJoinFn>,
}

impl AgentChannelConfig {
    pub fn new(agent_id: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            port: 3100,
            host: "0.0.0.0".to_string(),
            secret: None,
            peers: Vec::new(),
            tls: None,
            tls_rejected: None,
            get_mesh_nodes: None,
            on_mesh_join: None,
        }
    }
}

struct ServerHandle {
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

struct Inner {
    config: AgentChannelConfig,
    handler: Mutex<Option<MessageHandler>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    bound_port: AtomicU16,
    server: Mutex<Option<ServerHandle>>,
    connections: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

#[derive(Clone)]
pub struct AgentChannel {
    inner: Arc<Inner>,
}

impl AgentChannel {
    pub fn new(config: AgentChannelConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                handler: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
                bound_port: AtomicU16::new(0),
                server: Mutex::new(None),
                connections: Arc::new(Mutex::new(Vec::new())),
            }),
        }
    }

    pub fn id(&self) -> String {
        format!("agent-{}", self.inner.config.agent_id)
    }

    pub fn platform(&self) -> &'static str {
        "agent"
    }

    pub fn bound_port(&self) -> u16 {
        self.inner.bound_port.load(Ordering::SeqCst)
    }

    pub fn on_message<F, Fut>(&self, handler: F)
    where
        F: Fn(InboundMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        let handler: MessageHandler = Arc::new(move |message| Box::pin(handler(message)));
        *self.inner.handler.lock() = Some(handler);
    }

    pub fn send(&self, channel_id: &str, text: &str) -> Option<String> {
        if text.is_empty() {
            return None;
        }
        let mut pending = self.inner.pending.lock();
        let sender = pending.remove(channel_id)?;
        let _ = sender.send(text.to_string());
        Some(channel_id.to_string())
    }

    pub async fn start(&self) -> Result<(), MeshError> {
        self.stop().await;
        if let Some(message) = &self.inner.config.tls_rejected {
            return Err(MeshError::message(message.clone()));
        }
        let acceptor = if let Some(material) = &self.inner.config.tls {
            let config = server_config(material).map_err(|err| {
                MeshError::message(format!("agent channel TLS setup failed: {err}"))
            })?;
            Some(TlsAcceptor::from(config))
        } else {
            None
        };
        let addr = format!("{}:{}", self.inner.config.host, self.inner.config.port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                return Err(MeshError::message(format!(
                    "Agent channel port {} is already in use",
                    self.inner.config.port
                )));
            }
            Err(err) => return Err(err.into()),
        };
        let bound = listener.local_addr()?.port();
        self.inner.bound_port.store(bound, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        let inner = Arc::clone(&self.inner);
        let task = tokio::spawn(async move {
            if let Some(acceptor) = acceptor {
                run_tls(inner, listener, acceptor, rx).await;
            } else {
                run_axum(inner, listener, rx).await;
            }
        });
        *self.inner.server.lock() = Some(ServerHandle {
            shutdown: Some(tx),
            task,
        });
        Ok(())
    }

    pub async fn stop(&self) {
        self.resolve_pending("[channel shutting down]");
        let server = self.inner.server.lock().take();
        if let Some(mut server) = server {
            abort_connections(&self.inner.connections);
            if let Some(tx) = server.shutdown.take() {
                let _ = tx.send(());
            }
            tokio::select! {
                _ = &mut server.task => {}
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    server.task.abort();
                    let _ = server.task.await;
                }
            }
            finish_connections(&self.inner.connections).await;
        }
    }

    pub fn create_message_tool(&self) -> AgentMessageTool {
        AgentMessageTool {
            channel: self.clone(),
        }
    }

    pub async fn send_to_peer(&self, peer: &PeerConfig, body: &Value) -> Result<JsValue, String> {
        let url = format!("{}/api/message", peer.url.trim_end_matches('/'));
        let abort_after = scheduled_timeout(body.get("timeoutMs"), 5_000.0);
        let mut builder = reqwest::Client::builder();
        if let Some(material) = &self.inner.config.tls {
            let config = client_config(material).map_err(|err| err.to_string())?;
            builder = builder.use_preconfigured_tls(config);
        }
        if let Some(ms) = abort_after {
            builder = builder.timeout(Duration::from_millis(ms));
        }
        let client = builder.build().map_err(|err| err.to_string())?;
        let mut request = client.post(&url).json(body);
        if self.inner.config.tls.is_none() {
            let secret = peer
                .secret
                .clone()
                .or_else(|| self.inner.config.secret.clone());
            let header = match secret {
                Some(secret) => format!("Bearer {secret}"),
                None => "Bearer undefined".to_string(),
            };
            request = request.header("authorization", header);
        }
        let response = request.send().await.map_err(|err| err.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            return Err(format!("HTTP {}: {text}", status.as_u16()));
        }
        let bytes = response.bytes().await.map_err(|err| err.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        protocol::js::parse(&text).map_err(|err| err.to_string())
    }

    fn resolve_pending(&self, text: &str) {
        let pending = std::mem::take(&mut *self.inner.pending.lock());
        for (_, sender) in pending {
            let _ = sender.send(text.to_string());
        }
    }
}

pub struct AgentMessageTool {
    channel: AgentChannel,
}

impl AgentMessageTool {
    pub fn name(&self) -> &'static str {
        "agent_message"
    }

    pub fn schema(&self) -> Value {
        serde_json::json!({
            "name": "agent_message",
            "description": "Send a message to another agent on a different instance. The message goes through the remote agent's full pipeline (memory, hooks, tools). Use for cross-instance collaboration — the remote agent sees it as a real message.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_agent": {
                        "type": "string",
                        "description": "Agent ID to message (must be configured as a peer)"
                    },
                    "message": {
                        "type": "string",
                        "description": "Message to send"
                    },
                    "wait_for_response": {
                        "type": "boolean",
                        "description": "Wait for the remote agent to respond (default: true)"
                    },
                    "timeout_ms": {
                        "type": "number",
                        "description": "Timeout in ms when waiting for response (default: none — waits until done)"
                    }
                },
                "required": ["to_agent", "message"]
            }
        })
    }

    pub async fn execute(&self, args: &Value) -> JsString {
        let to_agent = match args.get("to_agent") {
            None => "undefined".to_string(),
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) => "null".to_string(),
            Some(other) => other.to_string(),
        };
        let message = args.get("message").and_then(Value::as_str).unwrap_or("");
        let wait = wait_flag(args.get("wait_for_response"));
        let timeout_ms = forwarded_timeout(args.get("timeout_ms"));
        let Some((_, peer)) = self
            .channel
            .inner
            .config
            .peers
            .iter()
            .find(|(name, _)| name == &to_agent)
        else {
            let available = peer_names(&self.channel.inner.config.peers);
            return JsString::from(format!(
                "Error: Unknown peer agent \"{to_agent}\". Available peers: {available}"
            ));
        };
        let mut body = Map::new();
        body.insert(
            "fromAgent".to_string(),
            Value::String(self.channel.inner.config.agent_id.clone()),
        );
        body.insert("message".to_string(), Value::String(message.to_string()));
        let wait_value = match args.get("wait_for_response") {
            None | Some(Value::Null) => Value::Bool(true),
            Some(other) => other.clone(),
        };
        body.insert("waitForResponse".to_string(), wait_value);
        if let Some(timeout_ms) = timeout_ms {
            body.insert("timeoutMs".to_string(), timeout_ms);
        }
        match self.channel.send_to_peer(peer, &Value::Object(body)).await {
            Ok(response) => {
                if wait {
                    response_text(response.get("response"))
                } else {
                    let request_id = request_id_text(response.get("requestId"));
                    with_prefix(
                        &format!(
                            "Message sent to {to_agent} (async — no response expected). Request ID: "
                        ),
                        &request_id,
                    )
                }
            }
            Err(err) => JsString::from(format!("Error sending message to {to_agent}: {err}")),
        }
    }
}

fn response_text(value: Option<&JsValue>) -> JsString {
    match value {
        Some(JsValue::Null) | None => JsString::from("[no response]"),
        Some(other) => json_text(other),
    }
}

fn request_id_text(value: Option<&JsValue>) -> JsString {
    match value {
        None => JsString::from("undefined"),
        Some(JsValue::Null) => JsString::from("null"),
        Some(other) => json_text(other),
    }
}

fn json_text(value: &JsValue) -> JsString {
    match value {
        JsValue::String(text) => text.clone(),
        other => JsString::from(stringify(other)),
    }
}

fn with_prefix(prefix: &str, text: &JsString) -> JsString {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend_from_slice(text.units());
    JsString::from_units(units)
}

pub fn agent_channel_from_plugin_config(cfg: &Value) -> AgentChannel {
    let object = cfg.as_object();
    let agent_id = object
        .and_then(|map| map.get("agentId"))
        .and_then(Value::as_str)
        .or_else(|| {
            object
                .and_then(|map| map.get("agent_id"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string();
    let mut config = AgentChannelConfig::new(agent_id);
    if let Some(port) = object
        .and_then(|map| map.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
    {
        config.port = port;
    }
    if let Some(host) = object
        .and_then(|map| map.get("host"))
        .and_then(Value::as_str)
    {
        config.host = host.to_string();
    }
    if let Some(secret) = object
        .and_then(|map| map.get("secret"))
        .and_then(Value::as_str)
    {
        config.secret = Some(secret.to_string());
    }
    if let Some(peers) = object
        .and_then(|map| map.get("peers"))
        .and_then(Value::as_object)
    {
        for (name, peer) in peers {
            let Some(peer) = peer.as_object() else {
                continue;
            };
            let url = peer
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let secret = peer
                .get("secret")
                .and_then(Value::as_str)
                .map(str::to_string);
            config
                .peers
                .push((name.clone(), PeerConfig { url, secret }));
        }
    }
    if let Some(tls) = object.and_then(|map| map.get("tls")) {
        match tls_from_config(tls) {
            Ok(Some(material)) => config.tls = Some(material),
            Ok(None) => {}
            Err(message) => config.tls_rejected = Some(message),
        }
    }
    AgentChannel::new(config)
}

enum BodyReadError {
    Timeout,
    Failed,
}

impl Inner {
    async fn handle_hyper(&self, req: Request<Incoming>) -> Response<Full<Bytes>> {
        let (parts, body) = req.into_parts();
        let body_fut = read_incoming(body);
        to_hyper(
            self.finish(&parts.method, &parts.uri, &parts.headers, body_fut)
                .await,
        )
    }

    async fn handle_axum(&self, req: axum::extract::Request) -> axum::response::Response {
        let (parts, body) = req.into_parts();
        let body_fut = read_axum_body(body);
        to_axum(
            self.finish(&parts.method, &parts.uri, &parts.headers, body_fut)
                .await,
        )
    }

    async fn finish(
        &self,
        method: &hyper::Method,
        uri: &hyper::Uri,
        headers: &hyper::HeaderMap,
        body_fut: impl Future<Output = Result<Vec<u8>, BodyReadError>>,
    ) -> Reply {
        if headers.contains_key("origin") {
            return json_reply(
                StatusCode::FORBIDDEN,
                &error_body("browser requests are not accepted"),
            );
        }
        let path = request_path(uri);
        if is_join(method, &path)
            && let Some(reply) = self.join_precheck(headers)
        {
            return reply;
        }
        if needs_body(method, &path) {
            match body_fut.await {
                Ok(bytes) => self.route(method, &path, headers, Some(&bytes)).await,
                Err(BodyReadError::Timeout) => body_timeout(),
                Err(BodyReadError::Failed) => invalid_json(),
            }
        } else {
            self.route(method, &path, headers, None).await
        }
    }

    fn join_precheck(&self, headers: &hyper::HeaderMap) -> Option<Reply> {
        if let Some(reply) = self.check_auth(headers) {
            return Some(reply);
        }
        if self.config.on_mesh_join.is_none() {
            return Some(json_reply(
                StatusCode::NOT_IMPLEMENTED,
                &error_body("Mesh not enabled on this node"),
            ));
        }
        None
    }

    async fn route(
        &self,
        method: &hyper::Method,
        path: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> Reply {
        if method == hyper::Method::GET && path == "/health" {
            return json_reply(StatusCode::OK, &health_body(&self.config.agent_id));
        }
        if method == hyper::Method::POST && path == "/api/message" {
            return self.handle_message(body.unwrap_or_default()).await;
        }
        if method == hyper::Method::GET && path == "/api/mesh" {
            return self.handle_mesh_get(headers).await;
        }
        if method == hyper::Method::POST && path == "/api/mesh/join" {
            return self
                .handle_mesh_join(headers, body.unwrap_or_default())
                .await;
        }
        if method == hyper::Method::GET && path == "/api/mesh/ping" {
            return json_reply(StatusCode::OK, &ping_body(&self.config.agent_id));
        }
        json_reply(StatusCode::NOT_FOUND, &error_body("Not found"))
    }

    async fn handle_message(&self, bytes: &[u8]) -> Reply {
        let text = String::from_utf8_lossy(bytes);
        let parsed = match protocol::js::parse(&text) {
            Ok(value) => value,
            Err(_) => return invalid_json(),
        };
        let Some(body) = parsed.as_object() else {
            return json_reply(
                StatusCode::BAD_REQUEST,
                &error_body("Missing required fields: fromAgent, message"),
            );
        };
        let Some(from_agent) = js_truthy_string(body, "fromAgent") else {
            return json_reply(
                StatusCode::BAD_REQUEST,
                &error_body("Missing required fields: fromAgent, message"),
            );
        };
        let Some(message) = js_truthy_string(body, "message") else {
            return json_reply(
                StatusCode::BAD_REQUEST,
                &error_body("Missing required fields: fromAgent, message"),
            );
        };
        let from_agent = from_agent.clone();
        let message = message.clone();
        let conversation_id = body
            .get("conversationId")
            .and_then(JsValue::as_js_string)
            .cloned();
        let request_id = new_request_id();
        let inbound = inbound_message(
            &self.config.agent_id,
            &from_agent,
            &message,
            conversation_id.as_ref(),
            &request_id,
        );
        if waits_for_response(body) {
            let handler = self.handler.lock().clone();
            let Some(handler) = handler else {
                return json_reply(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &error_body("No message handler registered"),
                );
            };
            let (tx, rx) = oneshot::channel();
            self.pending.lock().insert(request_id.clone(), tx);
            let request_for_handler = request_id.clone();
            let handler_pending = Arc::clone(&self.pending);
            tokio::spawn(async move {
                if let Err(msg) = handler(inbound).await
                    && let Some(sender) = handler_pending.lock().remove(&request_for_handler)
                {
                    let _ = sender.send(format!("[error processing message: {msg}]"));
                }
            });
            let timeout_ms = scheduled_timeout_js(body.get("timeoutMs"), 0.0);
            let reply = wait_for_text(self.pending.as_ref(), &request_id, rx, timeout_ms).await;
            let mut response = JsObject::new();
            response.insert("response", JsValue::String(JsString::from_text(&reply)));
            response.insert("agent", JsValue::from_text(&self.config.agent_id));
            response.insert("fromAgent", JsValue::String(from_agent));
            response.insert("timestamp", JsValue::Number(timestamp_ms().as_f64()));
            text_reply(StatusCode::OK, stringify(&JsValue::Object(response)))
        } else {
            if let Some(handler) = self.handler.lock().clone() {
                tokio::spawn(async move {
                    let _ = handler(inbound).await;
                });
            }
            let mut response = Map::new();
            response.insert("status".to_string(), Value::String("accepted".to_string()));
            response.insert("requestId".to_string(), Value::String(request_id));
            response.insert(
                "agent".to_string(),
                Value::String(self.config.agent_id.clone()),
            );
            response.insert("timestamp".to_string(), number_value(timestamp_ms()));
            json_reply(StatusCode::ACCEPTED, &Value::Object(response))
        }
    }

    async fn handle_mesh_get(&self, headers: &hyper::HeaderMap) -> Reply {
        if let Some(reply) = self.check_auth(headers) {
            return reply;
        }
        let Some(getter) = &self.config.get_mesh_nodes else {
            return json_reply(
                StatusCode::NOT_IMPLEMENTED,
                &error_body("Mesh not enabled on this node"),
            );
        };
        match getter().await {
            Ok(nodes) => text_reply(StatusCode::OK, mesh_nodes_json(&nodes)),
            Err(msg) => json_reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                &error_body(&format!("Failed to get mesh nodes: {msg}")),
            ),
        }
    }

    async fn handle_mesh_join(&self, headers: &hyper::HeaderMap, bytes: &[u8]) -> Reply {
        if let Some(reply) = self.check_auth(headers) {
            return reply;
        }
        let Some(join) = self.config.on_mesh_join.clone() else {
            return json_reply(
                StatusCode::NOT_IMPLEMENTED,
                &error_body("Mesh not enabled on this node"),
            );
        };
        let text = match std::str::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return invalid_json(),
        };
        let parsed = match protocol::js::parse(text) {
            Ok(value) => value,
            Err(_) => return invalid_json(),
        };
        let node = match mesh_node_from_join(&parsed) {
            Ok(node) => node,
            Err(JoinNodeError::MissingFields) => {
                return json_reply(
                    StatusCode::BAD_REQUEST,
                    &error_body("Missing required fields: id, name, host"),
                );
            }
        };
        if let Err(msg) = join(node).await {
            return json_reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                &error_body(&format!("Failed to join mesh: {msg}")),
            );
        }
        let nodes = if let Some(getter) = &self.config.get_mesh_nodes {
            match getter().await {
                Ok(nodes) => nodes,
                Err(msg) => {
                    return json_reply(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &error_body(&format!("Failed to join mesh: {msg}")),
                    );
                }
            }
        } else {
            Vec::new()
        };
        text_reply(
            StatusCode::OK,
            format!(
                "{{\"status\":\"joined\",\"nodes\":{}}}",
                mesh_nodes_json(&nodes)
            ),
        )
    }

    fn check_auth(&self, headers: &hyper::HeaderMap) -> Option<Reply> {
        if self.config.tls.is_some() {
            return None;
        }
        let header = headers
            .get(hyper::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        let Some(header) = header else {
            return Some(json_reply(
                StatusCode::UNAUTHORIZED,
                &error_body("Missing or invalid authorization"),
            ));
        };
        let Some(token) = header.strip_prefix("Bearer ") else {
            return Some(json_reply(
                StatusCode::UNAUTHORIZED,
                &error_body("Missing or invalid authorization"),
            ));
        };
        if self.config.secret.as_deref() != Some(token) {
            return Some(json_reply(
                StatusCode::FORBIDDEN,
                &error_body("Invalid secret"),
            ));
        }
        None
    }
}

async fn wait_for_text(
    pending: &Mutex<HashMap<String, oneshot::Sender<String>>>,
    request_id: &str,
    rx: oneshot::Receiver<String>,
    timeout_ms: Option<u64>,
) -> String {
    match timeout_ms {
        Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), rx).await {
            Ok(Ok(text)) => text,
            Ok(Err(_)) => "[channel shutting down]".to_string(),
            Err(_) => {
                pending.lock().remove(request_id);
                "[timeout — agent did not respond in time]".to_string()
            }
        },
        None => match rx.await {
            Ok(text) => text,
            Err(_) => "[channel shutting down]".to_string(),
        },
    }
}

async fn run_axum(inner: Arc<Inner>, listener: TcpListener, shutdown: oneshot::Receiver<()>) {
    let app = axum::Router::new().fallback(axum_entry).with_state(inner);
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = shutdown.await;
    });
    let _ = server.await;
}

async fn axum_entry(
    axum::extract::State(inner): axum::extract::State<Arc<Inner>>,
    req: axum::extract::Request,
) -> axum::response::Response {
    inner.handle_axum(req).await
}

async fn run_tls(
    inner: Arc<Inner>,
    listener: TcpListener,
    acceptor: TlsAcceptor,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else {
                    break;
                };
                inner.connections.lock().retain(|task| !task.is_finished());
                let acceptor = acceptor.clone();
                let task_inner = Arc::clone(&inner);
                let tracked = TrackedConnection::arm(
                    Arc::clone(&inner.connections),
                    tokio::spawn(async move {
                        if let Err(err) = serve_tls(task_inner, acceptor, stream).await {
                            tracing::debug!("agent channel connection closed: {err}");
                        }
                    }),
                );
                drop(tracked);
            }
        }
    }
}

async fn serve_tls(
    inner: Arc<Inner>,
    acceptor: TlsAcceptor,
    stream: TcpStream,
) -> Result<(), String> {
    let tls = match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
        Ok(Ok(tls)) => tls,
        Ok(Err(err)) => return Err(err.to_string()),
        Err(_) => return Err("TLS handshake timed out".to_string()),
    };
    let io = TokioIo::new(tls);
    let service = service_fn(move |req| {
        let inner = Arc::clone(&inner);
        async move {
            let response = inner.handle_hyper(req).await;
            Ok::<_, Infallible>(response)
        }
    });
    http1::Builder::new()
        .serve_connection(io, service)
        .await
        .map_err(|err| err.to_string())
}

struct TrackedConnection {
    connections: Arc<Mutex<Vec<JoinHandle<()>>>>,
    task: Option<JoinHandle<()>>,
}

impl TrackedConnection {
    fn arm(connections: Arc<Mutex<Vec<JoinHandle<()>>>>, task: JoinHandle<()>) -> Self {
        Self {
            connections,
            task: Some(task),
        }
    }
}

impl Drop for TrackedConnection {
    fn drop(&mut self) {
        let Some(task) = self.task.take() else {
            return;
        };
        self.connections.lock().push(task);
    }
}

fn abort_connections(connections: &Mutex<Vec<JoinHandle<()>>>) {
    let tasks = connections.lock();
    for task in tasks.iter() {
        task.abort();
    }
}

async fn finish_connections(connections: &Mutex<Vec<JoinHandle<()>>>) {
    abort_connections(connections);
    loop {
        let task = connections.lock().pop();
        let Some(task) = task else {
            break;
        };
        let _ = task.await;
    }
}

async fn read_incoming(body: Incoming) -> Result<Vec<u8>, BodyReadError> {
    read_collected(body).await
}

async fn read_axum_body(body: axum::body::Body) -> Result<Vec<u8>, BodyReadError> {
    read_collected(body).await
}

async fn read_collected<B>(body: B) -> Result<Vec<u8>, BodyReadError>
where
    B: BodyExt,
{
    match tokio::time::timeout(BODY_READ_TIMEOUT, body.collect()).await {
        Ok(Ok(collected)) => Ok(collected.to_bytes().to_vec()),
        Ok(Err(_)) => Err(BodyReadError::Failed),
        Err(_) => Err(BodyReadError::Timeout),
    }
}

fn needs_body(method: &hyper::Method, path: &str) -> bool {
    method == hyper::Method::POST && (path == "/api/message" || path == "/api/mesh/join")
}

fn is_join(method: &hyper::Method, path: &str) -> bool {
    method == hyper::Method::POST && path == "/api/mesh/join"
}

fn request_path(uri: &hyper::Uri) -> String {
    uri.path_and_query()
        .map(|path| path.as_str().to_string())
        .unwrap_or_default()
}

fn to_hyper(reply: Reply) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(reply.body)));
    *response.status_mut() = reply.status;
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

fn to_axum(reply: Reply) -> axum::response::Response {
    let mut response = axum::response::Response::new(axum::body::Body::from(reply.body));
    *response.status_mut() = reply.status;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    response
}

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

fn json_reply(status: StatusCode, value: &Value) -> Reply {
    Reply {
        status,
        body: serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()),
    }
}

fn text_reply(status: StatusCode, body: impl Into<String>) -> Reply {
    Reply {
        status,
        body: body.into().into_bytes(),
    }
}

fn invalid_json() -> Reply {
    json_reply(StatusCode::BAD_REQUEST, &error_body("Invalid JSON body"))
}

fn body_timeout() -> Reply {
    json_reply(
        StatusCode::REQUEST_TIMEOUT,
        &error_body("Request body timed out"),
    )
}

fn error_body(message: &str) -> Value {
    let mut map = Map::new();
    map.insert("error".to_string(), Value::String(message.to_string()));
    Value::Object(map)
}

fn health_body(agent_id: &str) -> Value {
    let mut map = Map::new();
    map.insert("status".to_string(), Value::String("ok".to_string()));
    map.insert("agent".to_string(), Value::String(agent_id.to_string()));
    map.insert("timestamp".to_string(), number_value(timestamp_ms()));
    Value::Object(map)
}

fn ping_body(agent_id: &str) -> Value {
    let mut map = Map::new();
    map.insert("ok".to_string(), Value::Bool(true));
    map.insert("tls".to_string(), Value::Bool(true));
    map.insert("node".to_string(), Value::String(agent_id.to_string()));
    Value::Object(map)
}

fn number_value(number: JsNumber) -> Value {
    serde_json::to_value(number).unwrap_or(Value::Null)
}

fn js_truthy_string<'a>(body: &'a JsObject, key: &str) -> Option<&'a JsString> {
    body.get(key)
        .and_then(JsValue::as_js_string)
        .filter(|text| !text.is_empty())
}

fn waits_for_response(body: &JsObject) -> bool {
    !matches!(body.get("waitForResponse"), Some(JsValue::Bool(false)))
}

const JS_TIMEOUT_MAX_MS: f64 = 2_147_483_647.0;

fn scheduled_timeout(value: Option<&Value>, extra_ms: f64) -> Option<u64> {
    scheduled_millis(value.and_then(Value::as_f64), extra_ms)
}

fn scheduled_timeout_js(value: Option<&JsValue>, extra_ms: f64) -> Option<u64> {
    scheduled_millis(value.and_then(JsValue::as_f64), extra_ms)
}

fn scheduled_millis(number: Option<f64>, extra_ms: f64) -> Option<u64> {
    let number = number?;
    if !number.is_finite() || number == 0.0 {
        return None;
    }
    Some(js_timer_millis(number + extra_ms))
}

fn js_timer_millis(after: f64) -> u64 {
    if (1.0..=JS_TIMEOUT_MAX_MS).contains(&after) {
        after as u64
    } else if after > JS_TIMEOUT_MAX_MS {
        JS_TIMEOUT_MAX_MS as u64
    } else {
        1
    }
}

fn forwarded_timeout(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let number = value.as_f64()?;
    if !number.is_finite() {
        return None;
    }
    Some(value.clone())
}

fn wait_flag(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => match number.as_f64() {
            Some(number) => number != 0.0 && !number.is_nan(),
            None => true,
        },
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn peer_names(peers: &[(String, PeerConfig)]) -> String {
    if peers.is_empty() {
        "none".to_string()
    } else {
        peers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn pem_bytes(value: Option<&Value>) -> Option<Vec<u8>> {
    value
        .and_then(Value::as_str)
        .map(|text| text.as_bytes().to_vec())
}

fn tls_from_config(value: &Value) -> Result<Option<TlsMaterial>, String> {
    if tls_is_plaintext(value) {
        return Ok(None);
    }
    let Some(object) = value.as_object() else {
        return Err("agent channel TLS configuration is unusable".to_string());
    };
    match (
        pem_bytes(object.get("ca")),
        pem_bytes(object.get("cert")),
        pem_bytes(object.get("key")),
    ) {
        (Some(ca), Some(cert), Some(key)) => Ok(Some(TlsMaterial {
            ca_pem: ca,
            cert_pem: cert,
            key_pem: key,
        })),
        _ => Err(
            "agent channel TLS configuration is incomplete: ca, cert, and key PEM values are required"
                .to_string(),
        ),
    }
}

fn tls_is_plaintext(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::String(text) if text.is_empty() => true,
        Value::Number(number) => match number.as_f64() {
            Some(number) => number == 0.0 || number.is_nan(),
            None => false,
        },
        _ => false,
    }
}

fn new_request_id() -> String {
    format!("agent-msg-{}-{}", timestamp_millis(), random_base36(6))
}

fn random_base36(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut bytes = vec![0_u8; len];
    fill_random(&mut bytes);
    bytes
        .iter()
        .map(|byte| char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()]))
        .collect()
}

fn inbound_message(
    agent_id: &str,
    from_agent: &JsString,
    message: &JsString,
    conversation_id: Option<&JsString>,
    request_id: &str,
) -> InboundMessage {
    let mut metadata = JsObject::new();
    metadata.insert("fromAgent", JsValue::String(from_agent.clone()));
    if let Some(conversation_id) = conversation_id {
        metadata.insert("conversationId", JsValue::String(conversation_id.clone()));
    }
    metadata.insert("isAgentMessage", JsValue::Bool(true));
    InboundMessage {
        id: request_id.to_string(),
        user_id: with_prefix("agent:", from_agent),
        username: Some(from_agent.clone()),
        display_name: Some(with_prefix("Agent: ", from_agent)),
        channel_id: request_id.to_string(),
        chat_type: "agent".to_string(),
        text: message.clone(),
        platform: "agent".to_string(),
        agent: Some(agent_id.to_string()),
        reply_to_message_id: None,
        attachments: None,
        metadata: Some(metadata),
        timestamp: JsNumber::from(timestamp_millis() / 1000),
    }
}

#[cfg(test)]
mod timeout_delay {
    use super::js_timer_millis;
    use super::scheduled_timeout;
    use serde_json::json;

    #[test]
    fn zero_is_absent_and_negative_is_a_one_millisecond_timer() {
        let zero = json!(0);
        let negative = json!(-1);
        let half = json!(0.4);
        let thirty = json!(30);
        let just_under = json!(-5_000);
        let past_max = json!(2_147_483_647_i64);
        assert_eq!(scheduled_timeout(None, 0.0), None);
        assert_eq!(scheduled_timeout(Some(&json!(null)), 0.0), None);
        assert_eq!(scheduled_timeout(Some(&zero), 0.0), None);
        assert_eq!(scheduled_timeout(Some(&zero), 5_000.0), None);
        assert_eq!(scheduled_timeout(Some(&negative), 0.0), Some(1));
        assert_eq!(scheduled_timeout(Some(&negative), 5_000.0), Some(4_999));
        assert_eq!(scheduled_timeout(Some(&just_under), 5_000.0), Some(1));
        assert_eq!(scheduled_timeout(Some(&json!(-6_000)), 5_000.0), Some(1));
        assert_eq!(scheduled_timeout(Some(&half), 0.0), Some(1));
        assert_eq!(scheduled_timeout(Some(&thirty), 0.0), Some(30));
        assert_eq!(scheduled_timeout(Some(&thirty), 5_000.0), Some(5_030));
        assert_eq!(
            scheduled_timeout(Some(&past_max), 5_000.0),
            Some(2_147_483_647)
        );
        assert_eq!(js_timer_millis(1.9), 1);
        assert_eq!(js_timer_millis(0.0), 1);
        assert_eq!(js_timer_millis(-4.0), 1);
    }
}
